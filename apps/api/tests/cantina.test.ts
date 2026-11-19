// Cantina: catálogo, estoque, pedidos, relatórios (+CSV), resumo do dia,
// auditoria por perfil e conexão OAuth com o Mercado Pago.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { descriptografar } from '../src/infra/cripto.js';
import type { ClienteOAuthMp, TokensOAuthMp } from '../src/infra/mercadopago.js';
import { usarClienteOAuth } from '../src/modulos/admin/mercadopago.servico.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { dataNaEscola } from '../src/dominio/periodos.js';
import { conectarMercadoPago, creditar, criarAluno, criarEscola, definirEstoque, divergencias, estoqueAtual, logarEquipe, novaChave, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;
let cantina: Awaited<ReturnType<typeof logarEquipe>>;
let operador: Awaited<ReturnType<typeof logarEquipe>>;
let diretoria: Awaited<ReturnType<typeof logarEquipe>>;

beforeEach(async () => {
  escola = await criarEscola();
  cantina = await logarEquipe(app, escola.adminEmail);
  operador = await logarEquipe(app, escola.operadorEmail);
  diretoria = await logarEquipe(app, escola.diretoriaEmail);
});

const HOJE = dataNaEscola(new Date(), 'America/Sao_Paulo');
const comprar = (qr: string, itens: { produtoId: number; quantidade: number }[], operadorId = escola.operadorId) =>
  realizarCompra({ escolaId: escola.escolaId, operadorId, idempotencyKey: novaChave(), identificacao: { tipo: 'CARTEIRINHA', qrConteudo: qr }, itens });

describe('catálogo', () => {
  it('categorias e produtos: criar, listar, editar preço (com auditoria) e nome repetido → 409', async () => {
    const cat = await cantina.post('/v1/admin/categorias', { nome: 'Salgados' });
    expect(cat.status).toBe(201);
    expect((await cantina.post('/v1/admin/categorias', { nome: 'Salgados' })).body.erro.codigo).toBe('NOME_JA_EXISTE');

    const p = await cantina.post('/v1/admin/produtos', { nome: 'Coxinha', categoriaId: cat.body.categoria.id, precoCentavos: 700 });
    expect(p.status).toBe(201);
    expect(p.body.produto).toMatchObject({ nome: 'Coxinha', precoCentavos: 700, ativo: true, controlaEstoque: false, estoqueAtual: null, categoria: { nome: 'Salgados' } });
    expect((await cantina.post('/v1/admin/produtos', { nome: 'Coxinha', categoriaId: cat.body.categoria.id, precoCentavos: 800 })).status).toBe(409);

    const ed = await cantina.patch(`/v1/admin/produtos/${p.body.produto.id}`, { precoCentavos: 750 });
    expect(ed.body.produto.precoCentavos).toBe(750);
    const aud = await db('auditoria_lanchei').where({ acao: 'PRODUTO_EDITAR', entidade_id: p.body.produto.id }).first();
    expect([aud.antes, aud.depois]).toEqual([{ preco_centavos: 700 }, { preco_centavos: 750 }]);

    const lista = await cantina.get(`/v1/admin/produtos?categoriaId=${cat.body.categoria.id}&ativo=true`);
    expect(lista.body.itens).toHaveLength(1);
    const cats = await cantina.get('/v1/admin/categorias');
    expect(cats.body.itens.find((c: { nome: string }) => c.nome === 'Salgados').qtdProdutosAtivos).toBe(1);
  });

  it('preço inválido (zero, negativo, com centavos quebrados) → 400; categoria de outra escola → 404', async () => {
    for (const precoCentavos of [0, -100, 7.5]) {
      expect((await cantina.post('/v1/admin/produtos', { nome: 'X', categoriaId: escola.categorias.doces, precoCentavos })).status).toBe(400);
    }
    const outra = await criarEscola();
    expect((await cantina.post('/v1/admin/produtos', { nome: 'X', categoriaId: outra.categorias.doces, precoCentavos: 100 })).status).toBe(404);
    expect((await cantina.patch(`/v1/admin/produtos/${outra.produtos.suco}`, { precoCentavos: 1 })).status).toBe(404);
  });

  it('mudar o preço não altera pedidos antigos (snapshot no item)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const p = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    if (p.status !== 'CONFIRMADO') throw new Error('compra deveria passar');
    await cantina.patch(`/v1/admin/produtos/${escola.produtos.suco}`, { precoCentavos: 900, nome: 'Suco natural' });
    const det = await cantina.get(`/v1/admin/pedidos/${p.pedido.id}`);
    expect(det.body.pedido.itens).toEqual([{ produtoId: escola.produtos.suco, nome: 'Suco', quantidade: 1, precoUnitarioCentavos: 600, subtotalCentavos: 600 }]);
  });

  it('desligar o controle de estoque com itens → 422 ZERAR_ESTOQUE_ANTES; depois de zerar, desliga', async () => {
    await definirEstoque(escola, escola.produtos.refri, 4);
    const r = await cantina.patch(`/v1/admin/produtos/${escola.produtos.refri}`, { controlaEstoque: false });
    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({ codigo: 'ZERAR_ESTOQUE_ANTES', detalhes: { estoqueAtual: 4 } });

    await cantina.post('/v1/estoque/movimentos', { produtoId: escola.produtos.refri, tipo: 'AJUSTE', quantidade: 0, motivo: 'Produto saiu de linha' });
    const ok = await cantina.patch(`/v1/admin/produtos/${escola.produtos.refri}`, { controlaEstoque: false });
    expect(ok.body.produto).toMatchObject({ controlaEstoque: false, estoqueAtual: null, estoqueMinimo: null });
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });
});

describe('estoque', () => {
  const mov = (quem: typeof cantina, corpo: object) => quem.post('/v1/estoque/movimentos', { produtoId: escola.produtos.refri, ...corpo });

  it('entrada, perda e contagem (AJUSTE calcula a diferença); o operador também lança', async () => {
    expect((await mov(operador, { tipo: 'ENTRADA', quantidade: 24 })).body.movimento).toMatchObject({ quantidade: 24, estoqueAtual: 24 });
    expect((await mov(operador, { tipo: 'PERDA', quantidade: 2, motivo: 'Lata amassada' })).body.movimento).toMatchObject({ quantidade: -2, estoqueAtual: 22 });
    // "Contei e tem 20": a API lança -2.
    const aj = await mov(cantina, { tipo: 'AJUSTE', quantidade: 20, motivo: 'Contagem de sexta' });
    expect(aj.body.movimento).toMatchObject({ quantidade: -2, estoqueAtual: 20 });
    expect(await estoqueAtual(escola.produtos.refri)).toBe(20);

    const hist = await cantina.get(`/v1/estoque/movimentos?produtoId=${escola.produtos.refri}`);
    expect(hist.body.itens.map((m: { tipo: string; quantidade: number }) => [m.tipo, m.quantidade])).toEqual([['AJUSTE', -2], ['PERDA', -2], ['ENTRADA', 24]]);
    expect(hist.body.itens[0].usuario.id).toBe(escola.adminId);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('regras: contagem igual → SEM_DIFERENCA; ajuste sem motivo; perda maior que o estoque; produto sem controle; outra escola', async () => {
    await mov(cantina, { tipo: 'ENTRADA', quantidade: 5 });
    expect((await mov(cantina, { tipo: 'AJUSTE', quantidade: 5, motivo: 'Contagem' })).body.erro.codigo).toBe('SEM_DIFERENCA');
    expect((await mov(cantina, { tipo: 'AJUSTE', quantidade: 3 })).body.erro.codigo).toBe('MOTIVO_OBRIGATORIO');
    expect((await mov(cantina, { tipo: 'PERDA', quantidade: 6 })).status).toBe(409);
    expect((await mov(cantina, { tipo: 'ENTRADA', quantidade: 0 })).body.erro.codigo).toBe('QUANTIDADE_INVALIDA');
    expect((await mov(cantina, { tipo: 'ENTRADA', quantidade: -3 })).status).toBe(400);
    expect((await cantina.post('/v1/estoque/movimentos', { produtoId: escola.produtos.suco, tipo: 'ENTRADA', quantidade: 1 })).body.erro.codigo).toBe('SEM_CONTROLE_ESTOQUE');
    const outra = await criarEscola();
    expect((await cantina.post('/v1/estoque/movimentos', { produtoId: outra.produtos.refri, tipo: 'ENTRADA', quantidade: 1 })).status).toBe(404);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(5);
  });

  it('contagem disputando com vendas: o estoque final bate com os movimentos', async () => {
    await definirEstoque(escola, escola.produtos.refri, 20);
    const alunos = await Promise.all(Array.from({ length: 6 }, () => criarAluno(escola, { saldoCentavos: 5000, responsaveis: 1 })));
    await Promise.all([
      mov(cantina, { tipo: 'AJUSTE', quantidade: 10, motivo: 'Contagem no meio do recreio' }),
      ...alunos.map((a) => comprar(a.qr, [{ produtoId: escola.produtos.refri, quantidade: 1 }]).catch((e: unknown) => e)),
    ]);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
    expect(await estoqueAtual(escola.produtos.refri)).toBeGreaterThanOrEqual(4);
  });

  it('lista com alerta de mínimo (os que estão acabando primeiro) e filtro ?baixo=true', async () => {
    await cantina.patch(`/v1/admin/produtos/${escola.produtos.refri}`, { estoqueMinimo: 5 });
    await definirEstoque(escola, escola.produtos.refri, 5);
    const todos = await operador.get('/v1/estoque');
    expect(todos.body.itens).toEqual([{ id: escola.produtos.refri, nome: 'Refrigerante', estoqueAtual: 5, estoqueMinimo: 5, abaixoDoMinimo: true }]);
    await definirEstoque(escola, escola.produtos.refri, 1);
    expect((await operador.get('/v1/estoque?baixo=true')).body.itens).toHaveLength(0);
  });
});

describe('pedidos, relatórios e resumo', () => {
  async function cenario() {
    const a = await criarAluno(escola, { saldoCentavos: 2000 });
    await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 2 }]); // 1200 (operador)
    await comprar(a.qr, [{ produtoId: escola.produtos.chocolate, quantidade: 1 }], escola.adminId); // 400 (admin)
    await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]); // recusado: saldo 400 < 600
    return a;
  }

  it('lista com filtros e cursor; detalhe com itens', async () => {
    const a = await cenario();
    const todos = await cantina.get('/v1/admin/pedidos?limite=2');
    expect(todos.body.itens.map((p: { status: string }) => p.status)).toEqual(['RECUSADO', 'CONFIRMADO']);
    const p2 = await cantina.get(`/v1/admin/pedidos?limite=2&cursor=${todos.body.proximoCursor}`);
    expect(p2.body.itens).toHaveLength(1);
    expect(p2.body.proximoCursor).toBeNull();

    const recusados = await cantina.get(`/v1/admin/pedidos?status=RECUSADO&alunoId=${a.alunoId}&de=${HOJE}&ate=${HOJE}`);
    expect(recusados.body.itens).toEqual([expect.objectContaining({ motivoRecusa: 'SALDO_INSUFICIENTE', modoIdentificacao: 'CARTEIRINHA', totalCentavos: 600 })]);
    expect((await cantina.get(`/v1/admin/pedidos?operadorId=${escola.adminId}`)).body.itens).toHaveLength(1);
    expect((await cantina.get('/v1/admin/pedidos?de=2020-01-01&ate=2020-01-31')).body.itens).toHaveLength(0);
    expect((await cantina.get('/v1/admin/pedidos?de=2026-02-30')).status).toBe(400);
  });

  it('vendas por dia, produto, categoria e operador: só CONFIRMADOS, totais iguais em todos os agrupamentos', async () => {
    await cenario();
    const rel = (agrupar: string) => cantina.get(`/v1/admin/relatorios/vendas?de=${HOJE}&ate=${HOJE}&agrupar=${agrupar}`);

    const dia = await rel('dia');
    expect(dia.body.totais).toEqual({ totalCentavos: 1600, pedidos: 2, ticketMedioCentavos: 800 });
    expect(dia.body.linhas).toEqual([expect.objectContaining({ chave: HOJE, totalCentavos: 1600, quantidade: 2 })]);

    const produto = await rel('produto');
    expect(produto.body.linhas.map((l: { rotulo: string; totalCentavos: number; quantidade: number }) => [l.rotulo, l.totalCentavos, l.quantidade])).toEqual([
      ['Suco', 1200, 2],
      ['Chocolate', 400, 1],
    ]);
    const categoria = await rel('categoria');
    expect(categoria.body.linhas.map((l: { rotulo: string; totalCentavos: number }) => [l.rotulo, l.totalCentavos])).toEqual([['Bebidas', 1200], ['Doces', 400]]);
    const op = await rel('operador');
    expect(op.body.linhas.map((l: { rotulo: string; totalCentavos: number }) => [l.rotulo, l.totalCentavos])).toEqual([['Tia da Cantina', 1200], ['Admin', 400]]);
  });

  it('estornado sai do relatório', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 2000 });
    const p = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    if (p.status !== 'CONFIRMADO') throw new Error('compra deveria passar');
    await cantina.post(`/v1/admin/pedidos/${p.pedido.id}/estorno`, { motivo: 'Item errado', devolverEstoque: false });
    const r = await cantina.get(`/v1/admin/relatorios/vendas?de=${HOJE}&ate=${HOJE}`);
    expect(r.body.totais).toEqual({ totalCentavos: 0, pedidos: 0, ticketMedioCentavos: 0 });
  });

  it('CSV de vendas (Excel pt-BR) e validação do período', async () => {
    await cenario();
    const csv = await cantina.get(`/v1/admin/relatorios/vendas?de=${HOJE}&ate=${HOJE}&agrupar=produto&formato=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.trimEnd().split('\r\n')).toEqual(['﻿produto;unidades;total_reais', 'Suco;2;12,00', 'Chocolate;1;4,00', 'TOTAL;;16,00']);

    expect((await cantina.get('/v1/admin/relatorios/vendas')).status).toBe(400); // período obrigatório
    expect((await cantina.get('/v1/admin/relatorios/vendas?de=2026-05-10&ate=2026-05-01')).body.erro.codigo).toBe('PERIODO_INVALIDO');
    expect((await cantina.get('/v1/admin/relatorios/vendas?de=2024-01-01&ate=2026-01-01')).body.erro.codigo).toBe('PERIODO_GRANDE_DEMAIS');
  });

  it('depósitos (bruto, taxa, líquido) e saldos em aberto (+CSV auditado)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const b = await criarAluno(escola);
    await creditar(escola.escolaId, b.contaId, b.responsavelIds[0]!, 2500);
    await db('depositos_lanchei').where({ conta_id: a.contaId }).update({ taxa_centavos: 50 });

    const dep = await cantina.get(`/v1/admin/relatorios/depositos?de=${HOJE}&ate=${HOJE}`);
    expect(dep.body.totais).toEqual({ brutoCentavos: 7500, taxaCentavos: 50, quantidade: 2, liquidoCentavos: 7450 });
    expect(dep.body.linhas).toEqual([{ data: HOJE, brutoCentavos: 7500, taxaCentavos: 50, liquidoCentavos: 7450, quantidade: 2 }]);

    const saldos = await cantina.get('/v1/admin/relatorios/saldos');
    expect(saldos.body).toEqual({ totalCentavos: 7500, contasComSaldo: 2, maiorSaldoCentavos: 5000 });
    const csv = await cantina.get('/v1/admin/relatorios/saldos?formato=csv');
    expect(csv.text).toContain(';50,00');
    expect(csv.text.trimEnd().split('\r\n').at(-1)).toBe('TOTAL;;;;75,00');
    expect(await db('auditoria_lanchei').where({ acao: 'SALDOS_EXPORTAR', escola_id: escola.escolaId }).first()).toBeTruthy();
  });

  it('resumo do dia: vendas, ticket médio, depósitos, recusas por motivo, estoque baixo e alertas', async () => {
    await cenario();
    await cantina.patch(`/v1/admin/produtos/${escola.produtos.refri}`, { estoqueMinimo: 3 });
    const r = await cantina.get('/v1/admin/resumo');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      data: HOJE,
      vendas: { totalCentavos: 1600, pedidos: 2, ticketMedioCentavos: 800 },
      depositos: { totalCentavos: 2000, quantidade: 1 },
      recusasPorMotivo: [{ motivo: 'SALDO_INSUFICIENTE', quantidade: 1 }],
      estoqueBaixo: [expect.objectContaining({ nome: 'Refrigerante', estoqueAtual: 0 })],
    });
    expect(r.body.alertas.map((a: { tipo: string }) => a.tipo)).toEqual(['MP_DESCONECTADO']);

    await conectarMercadoPago(escola.escolaId);
    expect((await cantina.get('/v1/admin/resumo')).body.alertas).toEqual([]);
    await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ token_expira_em: new Date(Date.now() + 5 * 86_400_000) });
    expect((await cantina.get('/v1/admin/resumo')).body.alertas[0].tipo).toBe('MP_EXPIRANDO');
    // Dia sem movimento.
    expect((await cantina.get('/v1/admin/resumo?data=2020-01-01')).body.vendas).toEqual({ totalCentavos: 0, pedidos: 0, ticketMedioCentavos: 0 });
  });
});

describe('auditoria por perfil', () => {
  it('a Cantina vê vendas/saldo; a Diretoria vê alunos/carteirinhas; ações comuns aparecem para os dois', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    await cantina.post(`/v1/admin/alunos/${a.alunoId}/ajustes`, { valorCentavos: 100, descricao: 'Cortesia de aniversário' });
    await diretoria.post(`/v1/admin/alunos/${a.alunoId}/carteirinhas`, { motivo: 'Perdeu' });
    await diretoria.get(`/v1/admin/alunos/${a.alunoId}/extrato`);

    const acoes = async (quem: typeof cantina) => (await quem.get(`/v1/admin/auditoria?alunoId=${a.alunoId}`)).body.itens.map((i: { acao: string }) => i.acao);
    expect(await acoes(cantina)).toEqual(['HISTORICO_VISUALIZAR', 'AJUSTE_SALDO']);
    expect(await acoes(diretoria)).toEqual(['HISTORICO_VISUALIZAR', 'CARTEIRINHA_EMITIR']);

    const item = (await cantina.get('/v1/admin/auditoria?acao=AJUSTE_SALDO')).body.itens[0];
    expect(item).toMatchObject({ ator: { tipo: 'USUARIO', id: escola.adminId, nome: 'Admin' }, depois: { valorCentavos: 100 } });
    expect(item.ip).toBeUndefined();
    // Filtrar por uma ação do outro perfil não "fura" a separação.
    expect((await cantina.get('/v1/admin/auditoria?acao=CARTEIRINHA_EMITIR')).body.itens).toEqual([]);
  });

  it('não mostra a auditoria de outra escola', async () => {
    const outra = await criarEscola();
    const cantinaOutra = await logarEquipe(app, outra.adminEmail);
    const b = await criarAluno(outra, { saldoCentavos: 1000 });
    await cantinaOutra.post(`/v1/admin/alunos/${b.alunoId}/ajustes`, { valorCentavos: 100, descricao: 'Ajuste da outra escola' });
    expect((await cantina.get('/v1/admin/auditoria')).body.itens).toEqual([]);
    expect((await cantina.get(`/v1/admin/auditoria?alunoId=${b.alunoId}`)).body.itens).toEqual([]);
  });
});

describe('Mercado Pago (OAuth)', () => {
  // Cliente falso: nenhuma chamada sai para o Mercado Pago de verdade.
  const tokens = (mpUserId: string): TokensOAuthMp => ({
    accessToken: `APP_USR-acesso-${mpUserId}`,
    refreshToken: `TG-refresh-${mpUserId}`,
    mpUserId,
    publicKey: 'APP_USR-chave-publica',
    expiraEm: new Date(Date.now() + 180 * 86_400_000),
  });
  let trocas: { code: string; redirectUri: string }[];
  const clienteFalso = (resposta: () => Promise<TokensOAuthMp>): ClienteOAuthMp => ({
    urlAutorizacao: ({ state, redirectUri }) => `https://auth.mercadopago.com/authorization?client_id=123&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    trocarCodigo: async (p) => {
      trocas.push(p);
      return resposta();
    },
    renovar: resposta,
  });
  const mpId = () => `mp${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  beforeEach(() => {
    trocas = [];
  });
  afterEach(() => usarClienteOAuth(undefined));

  const stateDe = async (quem: typeof cantina) => new URL((await quem.post('/v1/admin/mercadopago/conectar')).body.url).searchParams.get('state')!;
  const callback = (q: Record<string, string>) => request(app).get('/v1/mercadopago/oauth/callback').query(q);
  const destino = (r: { headers: Record<string, string> }) => new URL(r.headers.location!);

  it('sem a aplicação do MP configurada: status mostra e conectar devolve 409', async () => {
    usarClienteOAuth(null);
    expect((await cantina.get('/v1/admin/mercadopago/status')).body).toEqual({ conectado: false, configurado: false });
    expect((await cantina.post('/v1/admin/mercadopago/conectar')).body.erro.codigo).toBe('MP_NAO_CONFIGURADO');
  });

  it('fluxo completo: URL com state → callback troca o code → tokens CRIPTOGRAFADOS no banco → volta ao painel', async () => {
    const id = mpId();
    usarClienteOAuth(clienteFalso(async () => tokens(id)));
    const state = await stateDe(cantina);

    const r = await callback({ code: 'TG-codigo-123', state });
    expect(r.status).toBe(303);
    expect(destino(r).pathname).toBe('/painel/cantina/configuracoes');
    expect(destino(r).searchParams.get('mp')).toBe('conectado');
    expect(trocas).toEqual([{ code: 'TG-codigo-123', redirectUri: expect.stringContaining('/v1/mercadopago/oauth/callback') }]);

    const linha = await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first();
    expect(linha.mp_user_id).toBe(id);
    // No banco, nada em texto puro...
    expect(Buffer.from(linha.access_token_enc).toString('latin1')).not.toContain('APP_USR');
    // ...mas a API consegue ler de volta com a chave do ambiente.
    expect(descriptografar(linha.access_token_enc)).toBe(`APP_USR-acesso-${id}`);
    expect(descriptografar(linha.refresh_token_enc)).toBe(`TG-refresh-${id}`);

    const status = await cantina.get('/v1/admin/mercadopago/status');
    expect(status.body).toMatchObject({ conectado: true, configurado: true, mpUserId: id, expirando: false });
    expect(JSON.stringify(status.body)).not.toContain('APP_USR'); // o token nunca sai pela API

    const aud = await db('auditoria_lanchei').where({ acao: 'MP_CONECTAR', escola_id: escola.escolaId }).first();
    expect(aud.depois).toEqual({ mpUserId: id });
    expect(aud.ator_usuario_id).toBe(escola.adminId);
  });

  it('reconectar troca a conta e os tokens da MESMA escola (uma linha só)', async () => {
    const [id1, id2] = [mpId(), mpId()];
    usarClienteOAuth(clienteFalso(async () => tokens(id1)));
    await callback({ code: 'c1', state: await stateDe(cantina) });
    usarClienteOAuth(clienteFalso(async () => tokens(id2)));
    await callback({ code: 'c2', state: await stateDe(cantina) });
    const linhas = await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId });
    expect(linhas.map((l) => l.mp_user_id)).toEqual([id2]);
  });

  it('state inválido, adulterado, vencido ou que é um token de acesso → não conecta e não chama o MP', async () => {
    usarClienteOAuth(clienteFalso(async () => tokens(mpId())));
    const vencido = jwt.sign({ escolaId: escola.escolaId, usuarioId: escola.adminId }, process.env.JWT_SECRET!, { issuer: 'lanchei', audience: 'mp-oauth', expiresIn: -10 });
    const outroSegredo = jwt.sign({ escolaId: escola.escolaId, usuarioId: escola.adminId }, 'segredo-do-atacante-com-mais-de-32-caracteres', { issuer: 'lanchei', audience: 'mp-oauth', expiresIn: 600 });
    for (const state of ['lixo', vencido, outroSegredo, cantina.token]) {
      const r = await callback({ code: 'codigo', state });
      expect(destino(r).searchParams.get('motivo')).toBe('MP_STATE_INVALIDO');
    }
    expect(trocas).toEqual([]);
    expect(await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).toBeUndefined();
  });

  it('o state não serve como token de acesso', async () => {
    usarClienteOAuth(clienteFalso(async () => tokens(mpId())));
    const state = await stateDe(cantina);
    expect((await request(app).get('/v1/admin/escola').set('Authorization', `Bearer ${state}`)).status).toBe(401);
  });

  it('admin desativado depois de pedir a URL não conclui a conexão', async () => {
    usarClienteOAuth(clienteFalso(async () => tokens(mpId())));
    const state = await stateDe(cantina);
    await db('usuarios_lanchei').where({ id: escola.adminId }).update({ ativo: false });
    expect(destino(await callback({ code: 'codigo', state })).searchParams.get('motivo')).toBe('SEM_PERMISSAO');
    expect(trocas).toEqual([]);
  });

  it('conta MP já conectada a OUTRA escola → MP_CONTA_EM_USO, e a outra escola não é alterada', async () => {
    const outra = await criarEscola();
    const idDaOutra = await conectarMercadoPago(outra.escolaId);
    const antes = await db('escola_mercadopago_lanchei').where({ escola_id: outra.escolaId }).first();

    usarClienteOAuth(clienteFalso(async () => tokens(idDaOutra)));
    const r = await callback({ code: 'codigo', state: await stateDe(cantina) });
    expect(destino(r).searchParams.get('motivo')).toBe('MP_CONTA_EM_USO');

    const depois = await db('escola_mercadopago_lanchei').where({ escola_id: outra.escolaId }).first();
    expect(Buffer.from(depois.access_token_enc).equals(Buffer.from(antes.access_token_enc))).toBe(true);
    expect(await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).toBeUndefined();
  });

  it('admin cancelou no MP, resposta sem code, e MP fora do ar → volta ao painel com o motivo', async () => {
    usarClienteOAuth(clienteFalso(async () => { throw new Error('MP oauth/token falhou: HTTP 500'); }));
    const state = await stateDe(cantina);
    expect(destino(await callback({ error: 'access_denied', state })).searchParams.get('motivo')).toBe('AUTORIZACAO_NEGADA');
    expect(destino(await callback({ state })).searchParams.get('motivo')).toBe('RESPOSTA_INVALIDA');
    expect(destino(await callback({ code: 'codigo', state })).searchParams.get('motivo')).toBe('GATEWAY_INDISPONIVEL');
    expect(await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).toBeUndefined();
  });
});
