// Caixa restante, refresh em cookie (modo web), fronts servidos pela API,
// CSP e rotas públicas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { criarAluno, criarEscola, definirEstoque, logarEquipe, novaChave, SENHA, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp({ fronts: {} }); // sem fronts: só a API
let escola: Escola;
let operador: Awaited<ReturnType<typeof logarEquipe>>;
beforeEach(async () => {
  escola = await criarEscola();
  operador = await logarEquipe(app, escola.operadorEmail);
});

describe('caixa', () => {
  it('catálogo por categoria: estoque só para quem controla, sem inativos, e NUNCA saldo', async () => {
    await definirEstoque(escola, escola.produtos.refri, 3);
    await db('produtos_lanchei').where({ id: escola.produtos.refri }).update({ estoque_minimo: 5 });
    await db('produtos_lanchei').where({ id: escola.produtos.chocolate }).update({ ativo: false });
    const r = await operador.get('/v1/caixa/catalogo');
    expect(r.body.categorias).toEqual([
      {
        id: escola.categorias.bebidas,
        nome: 'Bebidas',
        produtos: [
          { id: escola.produtos.refri, nome: 'Refrigerante', precoCentavos: 500, estoqueDisponivel: 3, estoqueMinimo: 5 },
          { id: escola.produtos.suco, nome: 'Suco', precoCentavos: 600, estoqueDisponivel: null, estoqueMinimo: null },
        ],
      },
    ]); // "Doces" some: a categoria ficou sem produto ativo
  });

  it('busca: mínimo 3 letras, começo do nome ou de um sobrenome, só ATIVOS, sem saldo, com "aceitaPin"', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, pin: '4821', regras: { permite_sem_carteirinha: true } });
    const nome = (await db('alunos_lanchei').where({ id: a.alunoId }).first()).nome as string; // "João <sufixo> Silva"
    const b = await criarAluno(escola);
    await db('alunos_lanchei').where({ id: b.alunoId }).update({ status: 'INATIVO' });

    expect((await operador.get('/v1/caixa/alunos/busca?q=Jo')).status).toBe(400);
    const porSobrenome = await operador.get(`/v1/caixa/alunos/busca?q=${encodeURIComponent(nome.split(' ')[1]!)}`);
    expect(porSobrenome.body.itens).toEqual([{ id: a.alunoId, nome, turma: '3A', aceitaPin: true }]);
    expect(JSON.stringify(porSobrenome.body)).not.toContain('saldo');
    const todos = await operador.get('/v1/caixa/alunos/busca?q=Joã');
    expect(todos.body.itens.map((x: { id: number }) => x.id)).toEqual([a.alunoId]); // o INATIVO não aparece
    // Aluno de outra escola nunca aparece.
    const outra = await criarEscola();
    await criarAluno(outra);
    expect((await operador.get('/v1/caixa/alunos/busca?q=Joã')).body.itens).toHaveLength(1);
  });

  it('vendas de hoje: só deste operador, primeiro nome + turma', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const comprar = (operadorId: number) =>
      realizarCompra({ escolaId: escola.escolaId, operadorId, idempotencyKey: novaChave(), identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }] });
    await comprar(escola.operadorId);
    await comprar(escola.adminId);
    await realizarCompra({
      escolaId: escola.escolaId, operadorId: escola.operadorId, idempotencyKey: novaChave(), agora: new Date(Date.now() - 2 * 86_400_000),
      identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }],
    });
    const r = await operador.get('/v1/caixa/pedidos/hoje');
    expect(r.body.itens).toEqual([expect.objectContaining({ totalCentavos: 600, status: 'CONFIRMADO', aluno: { id: a.alunoId, primeiroNome: 'João', turma: '3A' } })]);
  });

  it('foto no caixa é auditada; a Diretoria não usa o caixa', async () => {
    const a = await criarAluno(escola);
    expect((await operador.get(`/v1/caixa/alunos/${a.alunoId}/foto`)).status).toBe(404); // sem foto
    const diretoria = await logarEquipe(app, escola.diretoriaEmail);
    expect((await diretoria.get('/v1/caixa/catalogo')).status).toBe(403);
  });
});

describe('refresh em cookie (X-Cliente: web)', () => {
  const login = (agente: ReturnType<typeof request.agent>, cliente = 'web') =>
    agente.post('/v1/auth/equipe/login').set('X-Cliente', cliente).send({ email: escola.adminEmail, senha: SENHA });

  it('o refresh vai num cookie HttpOnly, SameSite=Strict, só para /v1/auth, e SAI do JSON', async () => {
    const r = await login(request.agent(app));
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.body.refreshToken).toBeUndefined();
    const cookie = r.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/^lanchei_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/v1\/auth/);
    expect(cookie).toMatch(/Max-Age=2592000/); // 30 dias
  });

  it('refresh pelo cookie rotaciona; logout limpa o cookie e revoga a sessão', async () => {
    const agente = request.agent(app);
    await login(agente);
    const r1 = await agente.post('/v1/auth/refresh').set('X-Cliente', 'web');
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).toBeUndefined();
    expect(r1.headers['set-cookie']![0]).toMatch(/^lanchei_rt=/);
    expect((await agente.post('/v1/auth/refresh').set('X-Cliente', 'web')).status).toBe(200);

    const sair = await agente.post('/v1/auth/logout').set('X-Cliente', 'web');
    expect(sair.status).toBe(204);
    expect(sair.headers['set-cookie']![0]).toMatch(/lanchei_rt=;/);
    expect((await agente.post('/v1/auth/refresh').set('X-Cliente', 'web')).status).toBe(401);
  });

  it('cookie roubado e usado depois do dono: detecção de reuso derruba tudo', async () => {
    const agente = request.agent(app);
    const r = await login(agente);
    const roubado = r.headers['set-cookie']![0]!.split(';')[0]!; // "lanchei_rt=..."
    await agente.post('/v1/auth/refresh').set('X-Cliente', 'web'); // o dono renova
    const ataque = await request(app).post('/v1/auth/refresh').set('X-Cliente', 'web').set('Cookie', roubado);
    expect(ataque.status).toBe(401);
    expect((await agente.post('/v1/auth/refresh').set('X-Cliente', 'web')).status).toBe(401); // o dono também cai
  });

  it('sem o header o cookie é ignorado (modo JSON); app dos pais usa outro cookie', async () => {
    const agente = request.agent(app);
    await login(agente);
    expect((await agente.post('/v1/auth/refresh').send({})).status).toBe(401);
    const pais = await login(request.agent(app), 'pais');
    expect(pais.headers['set-cookie']![0]).toMatch(/^lanchei_rt_pais=/);
  });
});

describe('fronts servidos pela API', () => {
  let appComFronts: ReturnType<typeof criarApp>;
  beforeAll(() => {
    const raiz = mkdtempSync(join(tmpdir(), 'lanchei-fronts-'));
    const web = join(raiz, 'web');
    const pais = join(raiz, 'pais');
    for (const [pasta, nome] of [[web, 'PAINEL'], [pais, 'PAIS']] as const) {
      mkdirSync(join(pasta, 'assets'), { recursive: true });
      writeFileSync(join(pasta, 'index.html'), `<!doctype html><title>${nome}</title>`);
      writeFileSync(join(pasta, 'assets', 'app-abc123.js'), `console.log('${nome}')`);
      writeFileSync(join(pasta, 'sw.js'), '// service worker');
    }
    appComFronts = criarApp({ fronts: { web, pais } });
  });
  const html = (rota: string) => request(appComFronts).get(rota).set('Accept', 'text/html');

  it('painel em "/" e rotas do React (SPA) devolvem o index sem cache', async () => {
    for (const rota of ['/', '/painel/cantina', '/caixa/login']) {
      const r = await html(rota);
      expect(r.status).toBe(200);
      expect(r.text).toContain('PAINEL');
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('app dos pais em "/app" (nunca cai no index do painel)', async () => {
    for (const rota of ['/app', '/app/', '/app/filhos/7/extrato']) expect((await html(rota)).text).toContain('PAIS');
    expect((await request(appComFronts).get('/app/sw.js')).headers['cache-control']).toBe('no-cache');
  });

  it('assets com hash: cache de 1 ano; arquivo inexistente e rota da API inexistente → 404 JSON', async () => {
    expect((await request(appComFronts).get('/assets/app-abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(appComFronts).get('/app/assets/app-abc123.js')).text).toContain('PAIS');
    const semArquivo = await html('/assets/nao-existe.js');
    expect(semArquivo.status).toBe(404);
    const api = await html('/v1/nao-existe');
    expect(api.status).toBe(404);
    expect(api.body.erro.codigo).toBe('NAO_ENCONTRADO');
    expect((await request(appComFronts).get('/health')).body).toEqual({ status: 'ok' });
  });

  it('CSP: só a própria origem, com blob: (foto) e wasm (leitor de QR)', async () => {
    const csp = (await html('/')).headers['content-security-policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('rotas públicas', () => {
  it('termo vigente e chave de push (503 enquanto o VAPID não está configurado)', async () => {
    expect((await request(app).get('/v1/termos/atual')).body).toEqual({ versao: '2026-11-v1', url: expect.stringContaining('/app/termos') });
    const push = await request(app).get('/v1/push/chave-publica');
    expect(push.status).toBe(503);
    expect(push.body.erro.codigo).toBe('PUSH_NAO_CONFIGURADO');
  });
});
