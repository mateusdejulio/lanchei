// App dos responsáveis (/v1/me): vínculo por código, filhos, regras,
// bloqueios, PIN, carteirinha, desvínculo, notificações, perfil e LGPD.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { criarAluno, criarConvite, criarEscola, criarResponsavel, logarEquipe, logarResponsavel, novaChave, SENHA, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
const TERMO = '2026-11-v1';
let escola: Escola;
beforeEach(async () => {
  escola = await criarEscola();
});

const emailDe = async (responsavelId: number) => (await db('responsaveis_lanchei').where({ id: responsavelId }).first()).email as string;
/** Aluno com 2 responsáveis já vinculados; devolve os dois logados. */
async function familia(op: Parameters<typeof criarAluno>[1] = {}) {
  const a = await criarAluno(escola, op);
  const mae = await logarResponsavel(app, await emailDe(a.responsavelIds[0]!));
  const pai = await logarResponsavel(app, await emailDe(a.responsavelIds[1]!));
  return { a, mae, pai };
}
const comprar = (qr: string, produtoId: number) =>
  realizarCompra({
    escolaId: escola.escolaId, operadorId: escola.operadorId, idempotencyKey: novaChave(),
    identificacao: { tipo: 'CARTEIRINHA', qrConteudo: qr }, itens: [{ produtoId, quantidade: 1 }],
  });

describe('vínculo por código', () => {
  it('código certo + e-mail igual + termo: vincula, grava o consentimento (ACEITE) e usa o convite', async () => {
    const a = await criarAluno(escola, { responsaveis: 0 });
    const r = await criarResponsavel();
    const c = await criarConvite(escola, a.alunoId, r.email);
    const resp = await logarResponsavel(app, r.email);

    // aceita minúsculas e hífen, como a pessoa digitaria
    const v = await resp.post('/v1/me/vinculos', { codigo: `${c.codigo.slice(0, 4).toLowerCase()}-${c.codigo.slice(4)}`, aceiteTermo: { versao: TERMO } });
    expect(v.status).toBe(201);
    expect(v.body.filho).toMatchObject({ id: a.alunoId, escola: { id: escola.escolaId }, saldoCentavos: 0 });

    const consent = await db('consentimentos_lanchei').where({ responsavel_id: r.id, aluno_id: a.alunoId });
    expect(consent).toEqual([expect.objectContaining({ evento: 'ACEITE', versao_termo: TERMO })]);
    expect(consent[0].ip).toBeTruthy();
    expect((await db('convites_responsavel_lanchei').where({ id: c.id }).first()).usado_por_responsavel_id).toBe(r.id);
    expect((await resp.get('/v1/me/filhos')).body.itens).toHaveLength(1);

    // De novo: código já usado
    expect((await resp.post('/v1/me/vinculos', { codigo: c.codigo, aceiteTermo: { versao: TERMO } })).body.erro.codigo).toBe('CODIGO_INVALIDO');
  });

  it('exige e-mail verificado e o termo vigente', async () => {
    const a = await criarAluno(escola, { responsaveis: 0 });
    const naoVerificado = await criarResponsavel({ verificado: false });
    const c1 = await criarConvite(escola, a.alunoId, naoVerificado.email);
    const r1 = await (await logarResponsavel(app, naoVerificado.email)).post('/v1/me/vinculos', { codigo: c1.codigo, aceiteTermo: { versao: TERMO } });
    expect(r1.body.erro.codigo).toBe('EMAIL_NAO_VERIFICADO');

    const r = await criarResponsavel();
    const c2 = await criarConvite(escola, a.alunoId, r.email);
    const r2 = await (await logarResponsavel(app, r.email)).post('/v1/me/vinculos', { codigo: c2.codigo, aceiteTermo: { versao: '2020-01-v0' } });
    expect(r2.body.erro).toMatchObject({ codigo: 'TERMO_DESATUALIZADO', detalhes: { versaoAtual: TERMO } });
  });

  it('código certo com OUTRO e-mail conta tentativa no convite; na 5ª, o convite é invalidado (mesma resposta sempre)', async () => {
    const a = await criarAluno(escola, { responsaveis: 0 });
    const dono = await criarResponsavel();
    const c = await criarConvite(escola, a.alunoId, dono.email);
    const invasores = await Promise.all(Array.from({ length: 5 }, () => criarResponsavel()));
    for (const inv of invasores) {
      const r = await (await logarResponsavel(app, inv.email)).post('/v1/me/vinculos', { codigo: c.codigo, aceiteTermo: { versao: TERMO } });
      expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    }
    const conv = await db('convites_responsavel_lanchei').where({ id: c.id }).first();
    expect(conv.tentativas_falhas).toBe(5);
    expect(conv.revogado_em).not.toBeNull();
    // Agora nem o dono consegue: a escola precisa reenviar.
    const r = await (await logarResponsavel(app, dono.email)).post('/v1/me/vinculos', { codigo: c.codigo, aceiteTermo: { versao: TERMO } });
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
  });

  it('5 erros em 1 hora → 429 (nem o código certo passa até a janela acabar)', async () => {
    const a = await criarAluno(escola, { responsaveis: 0 });
    const r = await criarResponsavel();
    const c = await criarConvite(escola, a.alunoId, r.email);
    const resp = await logarResponsavel(app, r.email);
    for (let i = 0; i < 5; i++) {
      expect((await resp.post('/v1/me/vinculos', { codigo: 'ZZZZ2222', aceiteTermo: { versao: TERMO } })).status).toBe(422);
    }
    const bloqueado = await resp.post('/v1/me/vinculos', { codigo: c.codigo, aceiteTermo: { versao: TERMO } });
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.erro.codigo).toBe('MUITAS_TENTATIVAS');
  });

  it('quem se desvinculou volta com um convite novo (o vínculo é reativado)', async () => {
    const { a, mae } = await familia();
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/desvincular`, { confirmacao: true })).status).toBe(204);
    const c = await criarConvite(escola, a.alunoId, await emailDe(mae.id));
    expect((await mae.post('/v1/me/vinculos', { codigo: c.codigo, aceiteTermo: { versao: TERMO } })).status).toBe(201);
    const v = await db('aluno_responsaveis_lanchei').where({ aluno_id: a.alunoId, responsavel_id: mae.id }).first();
    expect([v.desvinculado_em, v.convite_id]).toEqual([null, c.id]);
  });
});

describe('garantirVinculo: filho de outra pessoa = 404', () => {
  it('em toda rota /me/filhos/:id', async () => {
    const { mae } = await familia();
    const outro = await criarAluno(escola);
    const rotas = [
      () => mae.get(`/v1/me/filhos/${outro.alunoId}`),
      () => mae.get(`/v1/me/filhos/${outro.alunoId}/extrato`),
      () => mae.get(`/v1/me/filhos/${outro.alunoId}/foto`),
      () => mae.get(`/v1/me/filhos/${outro.alunoId}/regras`),
      () => mae.get(`/v1/me/filhos/${outro.alunoId}/catalogo`),
      () => mae.put(`/v1/me/filhos/${outro.alunoId}/bloqueios`, { categoriaIds: [], produtoIds: [] }),
      () => mae.post(`/v1/me/filhos/${outro.alunoId}/carteirinha/bloquear`),
      () => mae.post(`/v1/me/filhos/${outro.alunoId}/depositos`, { valorCentavos: 5000 }).set('Idempotency-Key', novaChave()),
    ];
    for (const r of rotas) expect((await r()).status).toBe(404);
    expect((await db('carteirinhas_lanchei').where({ id: outro.carteirinhaId }).first()).status).toBe('ATIVA');
  });

  it('a equipe não acessa /me (403)', async () => {
    const admin = await logarEquipe(app, escola.adminEmail);
    expect((await admin.get('/v1/me/filhos')).status).toBe(403);
  });
});

describe('filhos, extrato e compras', () => {
  it('lista com saldo (os pais veem), detalhe com outros responsáveis só pelo nome', async () => {
    const { a, mae } = await familia({ saldoCentavos: 3000 });
    const lista = await mae.get('/v1/me/filhos');
    expect(lista.body.itens[0]).toMatchObject({ id: a.alunoId, saldoCentavos: 3000, carteirinha: { status: 'ATIVA' }, turma: '3A' });
    const det = await mae.get(`/v1/me/filhos/${a.alunoId}`);
    expect(det.body.filho.outrosResponsaveis).toEqual([{ nome: 'Responsável 1' }]);
    expect(det.body.filho.regras).toMatchObject({ temPin: false, permiteSemCarteirinha: false });
  });

  it('extrato com compras e recusas; detalhe da compra (inclui a recusada, com motivo)', async () => {
    const { a, mae } = await familia({ saldoCentavos: 1000 });
    await comprar(a.qr, escola.produtos.suco); // 600
    const recusa = await comprar(a.qr, escola.produtos.suco); // saldo 400
    if (recusa.status !== 'RECUSADO') throw new Error('deveria recusar');

    const ex = await mae.get(`/v1/me/filhos/${a.alunoId}/extrato`);
    expect(ex.body.itens.map((l: { tipo: string }) => l.tipo)).toEqual(['RECUSADA', 'COMPRA', 'DEPOSITO']);
    const det = await mae.get(`/v1/me/filhos/${a.alunoId}/pedidos/${recusa.pedidoId}`);
    expect(det.body.pedido).toMatchObject({ status: 'RECUSADO', motivoRecusa: 'SALDO_INSUFICIENTE', itens: [{ nome: 'Suco', quantidade: 1 }] });
    // Os pais NÃO geram auditoria de "histórico visualizado" (é o próprio dado deles).
    expect(await db('auditoria_lanchei').where({ acao: 'HISTORICO_VISUALIZAR', aluno_id: a.alunoId }).first()).toBeUndefined();
  });

  it('pedido de OUTRO aluno pelo id do meu filho → 404', async () => {
    const { a, mae } = await familia({ saldoCentavos: 1000 });
    const outro = await criarAluno(escola, { saldoCentavos: 1000 });
    const p = await comprar(outro.qr, escola.produtos.suco);
    if (p.status !== 'CONFIRMADO') throw new Error('deveria passar');
    expect((await mae.get(`/v1/me/filhos/${a.alunoId}/pedidos/${p.pedido.id}`)).status).toBe(404);
  });

  it('foto do filho, auditada com o responsável como ator', async () => {
    const { a, mae } = await familia();
    const foto = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    await db('fotos_alunos_lanchei').insert({ aluno_id: a.alunoId, escola_id: escola.escolaId, conteudo: foto, tamanho_bytes: foto.length, sha256: Buffer.alloc(32, 1) });
    const r = await mae.get(`/v1/me/filhos/${a.alunoId}/foto`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(await db('auditoria_lanchei').where({ acao: 'FOTO_VISUALIZAR', aluno_id: a.alunoId, ator_responsavel_id: mae.id }).first()).toBeTruthy();
  });
});

describe('regras e bloqueios', () => {
  const regras = (extra: object = {}) => ({
    limiteDiarioCentavos: 1500, limiteSemanalCentavos: null, limiteMensalCentavos: 20000,
    diasPermitidos: ['SEG', 'TER', 'QUA', 'QUI', 'SEX'], alertaSaldoBaixoCentavos: 1000, permiteSemCarteirinha: false, ...extra,
  });

  it('grava, audita antes/depois e avisa SÓ o outro responsável', async () => {
    const { a, mae, pai } = await familia();
    const r = await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras());
    expect(r.status).toBe(200);
    expect(r.body.regras).toMatchObject({ limiteDiarioCentavos: 1500, diasPermitidos: ['SEG', 'TER', 'QUA', 'QUI', 'SEX'], ultimaAlteracao: { por: 'Responsável 0' } });
    expect((await db('regras_aluno_lanchei').where({ aluno_id: a.alunoId }).first()).dias_permitidos).toBe(31);

    const aud = await db('auditoria_lanchei').where({ acao: 'REGRAS_ATUALIZAR', aluno_id: a.alunoId }).first();
    expect(aud.antes).toMatchObject({ limiteDiarioCentavos: null, diasPermitidos: ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'] });
    expect(aud.depois).toMatchObject({ limiteDiarioCentavos: 1500 });

    const avisos = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'REGRAS_ALTERADAS' });
    expect(avisos.map((n) => n.responsavel_id)).toEqual([pai.id]);
    expect(avisos[0].corpo).toContain('Responsável alterou as regras');

    // Mesmas regras de novo: nada muda, nada é avisado.
    await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras());
    expect(await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'REGRAS_ALTERADAS' })).toHaveLength(1);
  });

  it('a regra vale na hora no caixa (limite diário)', async () => {
    const { a, mae } = await familia({ saldoCentavos: 5000 });
    await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras({ limiteDiarioCentavos: 500, diasPermitidos: ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'] }));
    const r = await comprar(a.qr, escola.produtos.suco);
    expect(r).toMatchObject({ status: 'RECUSADO', motivo: 'LIMITE_DIARIO' });
  });

  it('compra sem carteirinha exige PIN; valores inválidos → 400', async () => {
    const { a, mae } = await familia();
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras({ permiteSemCarteirinha: true }))).body.erro.codigo).toBe('PIN_NECESSARIO');
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras({ limiteDiarioCentavos: 0 }))).status).toBe(400);
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras({ limiteDiarioCentavos: 12.5 }))).status).toBe(400);
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, regras({ diasPermitidos: ['SEGUNDA'] }))).status).toBe(400);
  });

  it('bloqueios: substitui o conjunto, o caixa recusa o item, e id de outra escola → 404 sem gravar nada', async () => {
    const { a, mae, pai } = await familia({ saldoCentavos: 5000 });
    const r = await mae.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [escola.categorias.doces], produtoIds: [escola.produtos.refri, escola.produtos.refri] });
    expect(r.body.bloqueios).toEqual({ categoriaIds: [escola.categorias.doces], produtoIds: [escola.produtos.refri] });
    expect(await comprar(a.qr, escola.produtos.chocolate)).toMatchObject({ status: 'RECUSADO', motivo: 'ITEM_BLOQUEADO' });

    const cat = await pai.get(`/v1/me/filhos/${a.alunoId}/catalogo`);
    const doces = cat.body.categorias.find((c: { nome: string }) => c.nome === 'Doces');
    expect(doces).toMatchObject({ bloqueado: true, produtos: [expect.objectContaining({ nome: 'Chocolate', bloqueadoPelaCategoria: true })] });

    const outra = await criarEscola();
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [outra.categorias.doces], produtoIds: [] })).status).toBe(404);
    expect(await db('bloqueios_categoria_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(1);

    // Desbloquear tudo apaga os bloqueios (o histórico fica na auditoria).
    await mae.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [], produtoIds: [] });
    expect(await db('bloqueios_produto_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(0);
    const aud = await db('auditoria_lanchei').where({ acao: 'BLOQUEIOS_ATUALIZAR', aluno_id: a.alunoId }).orderBy('id', 'desc').first();
    expect(aud.antes).toEqual({ categoriaIds: [escola.categorias.doces], produtoIds: [escola.produtos.refri] });
  });

  it('pai e mãe salvando bloqueios ao mesmo tempo: os dois terminam sem erro e o resultado é um dos conjuntos', async () => {
    const { a, mae, pai } = await familia();
    const [r1, r2] = await Promise.all([
      mae.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [escola.categorias.doces], produtoIds: [] }),
      pai.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [escola.categorias.bebidas], produtoIds: [] }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await db('bloqueios_categoria_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(1);
  });
});

describe('PIN e carteirinha', () => {
  it('PIN óbvio e senha errada são recusados; PIN bom libera a compra sem carteirinha', async () => {
    const { a, mae } = await familia({ saldoCentavos: 5000 });
    for (const pin of ['1234', '0000', '4321', '1212']) {
      expect((await mae.put(`/v1/me/filhos/${a.alunoId}/pin`, { pin, senhaResponsavel: SENHA })).body.erro.codigo).toBe('PIN_FRACO');
    }
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/pin`, { pin: '4821', senhaResponsavel: 'errada' })).body.erro.codigo).toBe('SENHA_INCORRETA');
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/pin`, { pin: '4821', senhaResponsavel: SENHA })).status).toBe(204);

    const aud = await db('auditoria_lanchei').where({ acao: 'PIN_DEFINIR', aluno_id: a.alunoId }).first();
    expect(JSON.stringify(aud)).not.toContain('4821'); // o PIN nunca vai para a auditoria

    await mae.put(`/v1/me/filhos/${a.alunoId}/regras`, {
      limiteDiarioCentavos: null, limiteSemanalCentavos: null, limiteMensalCentavos: null,
      diasPermitidos: ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'], alertaSaldoBaixoCentavos: null, permiteSemCarteirinha: true,
    });
    const r = await realizarCompra({
      escolaId: escola.escolaId, operadorId: escola.operadorId, idempotencyKey: novaChave(),
      identificacao: { tipo: 'PIN', alunoId: a.alunoId, pin: '4821' }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }],
    });
    expect(r.status).toBe('CONFIRMADO');

    // Remover o PIN desliga a compra sem carteirinha.
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/pin/remover`, { senhaResponsavel: SENHA })).status).toBe(204);
    expect((await mae.get(`/v1/me/filhos/${a.alunoId}/regras`)).body.regras).toMatchObject({ temPin: false, permiteSemCarteirinha: false });
  });

  it('bloquear a carteirinha: efeito imediato no caixa; o outro responsável é avisado; desbloquear volta', async () => {
    const { a, mae, pai } = await familia({ saldoCentavos: 5000 });
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/carteirinha/bloquear`, { motivo: 'PERDIDA' })).body.carteirinha.status).toBe('BLOQUEADA');
    expect(await comprar(a.qr, escola.produtos.suco)).toMatchObject({ status: 'RECUSADO', motivo: 'CARTEIRINHA_BLOQUEADA' });
    const aviso = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'CARTEIRINHA', responsavel_id: pai.id }).first();
    expect(aviso.corpo).toContain('bloqueou');
    await pai.post(`/v1/me/filhos/${a.alunoId}/carteirinha/desbloquear`);
    expect((await comprar(a.qr, escola.produtos.suco)).status).toBe('CONFIRMADO');
  });
});

describe('desvínculo, aluno encerrado e notificações', () => {
  it('desvincular grava REVOGACAO (LGPD) e o aluno some do app', async () => {
    const { a, mae } = await familia();
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/desvincular`, {})).status).toBe(400); // exige confirmação
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/desvincular`, { confirmacao: true })).status).toBe(204);
    expect(await db('consentimentos_lanchei').where({ responsavel_id: mae.id, aluno_id: a.alunoId, evento: 'REVOGACAO' }).first()).toBeTruthy();
    expect((await mae.get('/v1/me/filhos')).body.itens).toEqual([]);
    expect((await mae.get(`/v1/me/filhos/${a.alunoId}`)).status).toBe(404);
  });

  it('aluno encerrado: os pais ainda veem o extrato, mas não mudam nada', async () => {
    const { a, mae } = await familia();
    await db('alunos_lanchei').where({ id: a.alunoId }).update({ status: 'ENCERRADO', encerrado_em: new Date() });
    expect((await mae.get(`/v1/me/filhos/${a.alunoId}/extrato`)).status).toBe(200);
    expect((await mae.post(`/v1/me/filhos/${a.alunoId}/carteirinha/bloquear`)).body.erro.codigo).toBe('ALUNO_ENCERRADO');
    expect((await mae.put(`/v1/me/filhos/${a.alunoId}/bloqueios`, { categoriaIds: [], produtoIds: [] })).body.erro.codigo).toBe('ALUNO_ENCERRADO');
  });

  it('caixa de entrada: lista, não lidas, marcar uma e todas; a notificação de outro → 404', async () => {
    const { a, mae, pai } = await familia({ saldoCentavos: 5000 });
    await comprar(a.qr, escola.produtos.suco);
    await comprar(a.qr, escola.produtos.suco);
    const n = await mae.get('/v1/me/notificacoes?naoLidas=true');
    expect(n.body.naoLidas).toBe(2);
    expect(n.body.itens[0]).toMatchObject({ tipo: 'COMPRA', alunoId: a.alunoId, lida: false });

    const doPai = (await pai.get('/v1/me/notificacoes')).body.itens[0].id;
    expect((await mae.post(`/v1/me/notificacoes/${doPai}/lida`)).status).toBe(404);
    await mae.post(`/v1/me/notificacoes/${n.body.itens[0].id}/lida`);
    expect((await mae.get('/v1/me/notificacoes')).body.naoLidas).toBe(1);
    await mae.post('/v1/me/notificacoes/lidas');
    expect((await mae.get('/v1/me/notificacoes?naoLidas=true')).body.itens).toEqual([]);
  });
});

describe('perfil, aparelhos e LGPD', () => {
  it('editar perfil; trocar senha derruba as outras sessões e devolve uma nova', async () => {
    const { mae } = await familia();
    const email = await emailDe(mae.id);
    const outraSessao = await request(app).post('/v1/auth/responsavel/login').send({ email, senha: SENHA });
    expect((await mae.patch('/v1/me', { nome: 'Maria Souza', telefone: '(19) 99999-0000' })).body.responsavel).toMatchObject({ nome: 'Maria Souza', telefone: '(19) 99999-0000' });

    expect((await mae.post('/v1/me/senha', { senhaAtual: 'errada', novaSenha: 'senha-nova-123' })).body.erro.codigo).toBe('SENHA_INCORRETA');
    const r = await mae.post('/v1/me/senha', { senhaAtual: SENHA, novaSenha: 'senha-nova-123' });
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    // A sessão nova funciona...
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: r.body.refreshToken })).status).toBe(200);
    // ...e a outra foi revogada. (Usar um refresh revogado é "reuso": derruba
    // TODAS as sessões, por isso esta checagem vem por último.)
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: outraSessao.body.refreshToken })).status).toBe(401);
  });

  it('aparelho de push: upsert pelo endpoint e TRANSFERÊNCIA para quem logou por último', async () => {
    const { mae, pai } = await familia();
    const sub = { endpoint: `https://fcm.googleapis.com/fcm/send/${novaChave()}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
    const r1 = await mae.post('/v1/me/dispositivos', { canal: 'WEB', subscription: sub, plataforma: 'ANDROID' });
    expect(r1.status).toBe(201);
    await mae.post('/v1/me/dispositivos', { canal: 'WEB', subscription: sub, plataforma: 'ANDROID' }); // de novo: mesma linha
    const r2 = await pai.post('/v1/me/dispositivos', { canal: 'WEB', subscription: sub, plataforma: 'ANDROID' }); // celular passou para o pai
    expect(r2.body.dispositivo.id).toBe(r1.body.dispositivo.id);
    const linhas = await db('dispositivos_push_lanchei').where({ web_endpoint: sub.endpoint });
    expect(linhas).toEqual([expect.objectContaining({ responsavel_id: pai.id, ativo: true })]);

    // A mãe não consegue desativar o aparelho que agora é do pai; o pai consegue.
    await mae.post('/v1/me/dispositivos/desativar', { endpoint: sub.endpoint });
    expect((await db('dispositivos_push_lanchei').where({ id: r1.body.dispositivo.id }).first()).ativo).toBe(true);
    await pai.post('/v1/me/dispositivos/desativar', { endpoint: sub.endpoint });
    expect((await db('dispositivos_push_lanchei').where({ id: r1.body.dispositivo.id }).first()).ativo).toBe(false);

    expect((await mae.post('/v1/me/dispositivos', { canal: 'WEB', subscription: { ...sub, endpoint: 'http://inseguro.com/x' }, plataforma: 'ANDROID' })).status).toBe(400);
  });

  it('exportar meus dados (JSON com filhos e extrato, sem chaves de push) e auditoria', async () => {
    const { a, mae } = await familia({ saldoCentavos: 2000 });
    await comprar(a.qr, escola.produtos.suco);
    const r = await mae.get('/v1/me/dados');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('meus-dados-lanchei.json');
    expect(r.body.responsavel.id).toBe(mae.id);
    expect(r.body.filhos[0].aluno).toMatchObject({ id: a.alunoId, saldoCentavos: 1400 });
    expect(r.body.filhos[0].compras[0].itens).toEqual([{ nome: 'Suco', quantidade: 1 }]);
    expect(JSON.stringify(r.body)).not.toMatch(/senha_hash|web_p256dh|web_auth/);
    expect(await db('auditoria_lanchei').where({ acao: 'DADOS_EXPORTAR', ator_responsavel_id: mae.id }).first()).toBeTruthy();
  });

  it('solicitação LGPD vai por e-mail para a Diretoria (a controladora), com auditoria', async () => {
    const { mae } = await familia();
    const r = await mae.post('/v1/me/solicitacoes-lgpd', { tipo: 'CORRECAO', mensagem: 'O nome do meu filho está escrito errado.' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ escolas: 1, destinatarios: 1 });
    await aguardarEmailsPendentes();
    expect(emailsPara(escola.diretoriaEmail).at(-1)!.texto).toContain('O nome do meu filho está escrito errado.');
    expect(emailsPara(escola.adminEmail)).toHaveLength(0);
    expect(await db('auditoria_lanchei').where({ acao: 'SOLICITACAO_LGPD', ator_responsavel_id: mae.id }).first()).toBeTruthy();
  });
});
