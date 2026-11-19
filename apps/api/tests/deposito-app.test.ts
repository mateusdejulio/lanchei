// Depósito Pix pelo app dos pais (POST /me/filhos/:id/depositos) e os jobs
// que garantem o crédito mesmo sem webhook. O Mercado Pago é SIMULADO.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import type { ClienteMercadoPago, NovoPix, PagamentoMp } from '../src/infra/mercadopago.js';
import { usarClienteMercadoPago } from '../src/modulos/depositos/deposito.servico.js';
import { reprocessarWebhooks, sincronizarDepositosVencidos } from '../src/jobs/mercadopago.jobs.js';
import { conectarMercadoPago, criarAluno, criarEscola, divergencias, logarResponsavel, novaChave, saldo, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;

/** MP falso: guarda os Pix criados e responde a consulta com o status que o teste mandar. */
function mpFalso() {
  const pix: NovoPix[] = [];
  const status = new Map<string, PagamentoMp['status']>();
  let falhar = false;
  let atrasoMs = 0;
  const cliente: ClienteMercadoPago = {
    async criarPix(n) {
      if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
      if (falhar) throw new Error('MP criarPix falhou: HTTP 500');
      // Idempotência do MP: mesma X-Idempotency-Key = mesmo pagamento.
      const i = pix.findIndex((p) => p.idempotencyKey === n.idempotencyKey);
      if (i === -1) pix.push(n);
      const id = `pay-${n.externalReference}`;
      return { mpPaymentId: id, pixCopiaCola: `00020126PIX-${id}` };
    },
    async buscarPagamento(_token, paymentId) {
      const p = pix.find((x) => `pay-${x.externalReference}` === paymentId);
      if (!p) throw new Error('MP buscarPagamento falhou: HTTP 404');
      return { id: paymentId, status: status.get(paymentId) ?? 'pending', externalReference: p.externalReference, valorCentavos: p.valorCentavos, taxaCentavos: 50 };
    },
  };
  return { cliente, pix, status, falhar: (v: boolean) => (falhar = v), atrasar: (ms: number) => (atrasoMs = ms) };
}

let mp: ReturnType<typeof mpFalso>;
beforeEach(async () => {
  escola = await criarEscola();
  mp = mpFalso();
  usarClienteMercadoPago(mp.cliente);
});
afterEach(() => usarClienteMercadoPago(undefined));

async function mae() {
  const a = await criarAluno(escola);
  const email = (await db('responsaveis_lanchei').where({ id: a.responsavelIds[0] }).first()).email;
  return { a, resp: await logarResponsavel(app, email) };
}
const depositar = (resp: Awaited<ReturnType<typeof logarResponsavel>>, alunoId: number, valorCentavos: number, chave = novaChave()) =>
  resp.post(`/v1/me/filhos/${alunoId}/depositos`, { valorCentavos }).set('Idempotency-Key', chave);

describe('criar depósito', () => {
  it('cria o Pix na conta DA CANTINA, com a nossa chave, external_reference e validade de 30 min', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    const chave = novaChave();
    const r = await depositar(resp, a.alunoId, 5000, chave);
    expect(r.status).toBe(201);
    expect(r.body.deposito).toMatchObject({ status: 'PENDENTE', valorCentavos: 5000, pixCopiaCola: expect.stringContaining('PIX'), alunoId: a.alunoId });
    expect(r.body.deposito.recebedor).toContain('Cantina');

    expect(mp.pix).toHaveLength(1);
    expect(mp.pix[0]).toMatchObject({
      accessToken: 'TOKEN-DA-CANTINA', // descriptografado na hora de usar
      idempotencyKey: chave,
      valorCentavos: 5000,
      externalReference: String(r.body.deposito.id),
    });
    expect(mp.pix[0]!.descricao).not.toMatch(/João/); // sem o nome do aluno
    const minutos = (new Date(r.body.deposito.expiraEm).getTime() - Date.now()) / 60_000;
    expect(minutos).toBeGreaterThan(29);
    expect(minutos).toBeLessThanOrEqual(30);
    // Criar o Pix não mexe no saldo: só o pagamento confirmado credita.
    expect(await saldo(a.contaId)).toBe(0);
  });

  it('mesma Idempotency-Key: devolve o MESMO depósito (200), sem criar outro Pix', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    const chave = novaChave();
    const r1 = await depositar(resp, a.alunoId, 5000, chave);
    const r2 = await depositar(resp, a.alunoId, 5000, chave);
    expect(r2.status).toBe(200);
    expect(r2.body.deposito).toEqual(r1.body.deposito);
    expect(await db('depositos_lanchei').where({ idempotency_key: chave })).toHaveLength(1);
  });

  it('6 envios SIMULTÂNEOS com a mesma chave: 1 depósito; os outros recebem o mesmo ou "em processamento"', async () => {
    await conectarMercadoPago(escola.escolaId);
    mp.atrasar(150);
    const { a, resp } = await mae();
    const chave = novaChave();
    const respostas = await Promise.all(Array.from({ length: 6 }, () => depositar(resp, a.alunoId, 5000, chave)));
    expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respostas.every((r) => [200, 201].includes(r.status) || r.body.erro?.codigo === 'DEPOSITO_EM_PROCESSAMENTO')).toBe(true);
    expect(await db('depositos_lanchei').where({ idempotency_key: chave })).toHaveLength(1);
    expect(mp.pix).toHaveLength(1);
  });

  it('chave de outro responsável ou de outro filho → 409', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    const outro = await mae();
    const chave = novaChave();
    await depositar(resp, a.alunoId, 5000, chave);
    expect((await depositar(outro.resp, outro.a.alunoId, 5000, chave)).body.erro.codigo).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
  });

  it('valor fora do mínimo/máximo da escola → 422 com os limites; sem Idempotency-Key → 422', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    for (const valor of [2499, 50001]) {
      const r = await depositar(resp, a.alunoId, valor);
      expect(r.body.erro).toMatchObject({ codigo: 'VALOR_FORA_DO_LIMITE', detalhes: { minCentavos: 2500, maxCentavos: 50000 } });
    }
    expect((await resp.post(`/v1/me/filhos/${a.alunoId}/depositos`, { valorCentavos: 5000 })).body.erro.codigo).toBe('IDEMPOTENCY_KEY_OBRIGATORIA');
    expect(mp.pix).toHaveLength(0);
  });

  it('cantina sem Mercado Pago (ou com o token vencido) → 409 MP_NAO_CONECTADO', async () => {
    const { a, resp } = await mae();
    expect((await depositar(resp, a.alunoId, 5000)).body.erro.codigo).toBe('MP_NAO_CONECTADO');
    await conectarMercadoPago(escola.escolaId);
    await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ token_expira_em: new Date(Date.now() - 1000) });
    expect((await depositar(resp, a.alunoId, 5000)).body.erro.codigo).toBe('MP_NAO_CONECTADO');
  });

  it('MP fora do ar → depósito CANCELADO e 502; repetir a mesma chave devolve o CANCELADO (o app gera outra chave)', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    mp.falhar(true);
    const chave = novaChave();
    const r = await depositar(resp, a.alunoId, 5000, chave);
    expect(r.status).toBe(502);
    expect(r.body.erro.codigo).toBe('GATEWAY_INDISPONIVEL');
    expect((await db('depositos_lanchei').where({ idempotency_key: chave }).first()).status).toBe('CANCELADO');
    const de_novo = await depositar(resp, a.alunoId, 5000, chave);
    expect(de_novo.body.deposito).toMatchObject({ status: 'CANCELADO', pixCopiaCola: null });
  });

  it('aluno ENCERRADO não recebe depósito', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    await db('alunos_lanchei').where({ id: a.alunoId }).update({ status: 'ENCERRADO', encerrado_em: new Date() });
    expect((await depositar(resp, a.alunoId, 5000)).body.erro.codigo).toBe('ALUNO_ENCERRADO');
  });

  it('status: só o próprio responsável vê; histórico do filho mostra quem fez', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    const r = await depositar(resp, a.alunoId, 5000);
    expect((await resp.get(`/v1/me/depositos/${r.body.deposito.id}`)).body.deposito.status).toBe('PENDENTE');
    const intruso = await mae();
    expect((await intruso.resp.get(`/v1/me/depositos/${r.body.deposito.id}`)).status).toBe(404);
    const hist = await resp.get(`/v1/me/filhos/${a.alunoId}/depositos`);
    expect(hist.body.itens[0]).toMatchObject({ id: r.body.deposito.id, feitoPorMim: true, feitoPor: 'Responsável' });
  });
});

describe('jobs: o Pix chega ao saldo mesmo sem webhook', () => {
  beforeEach(async () => {
    // O job olha os pendentes de TODAS as escolas, e o banco de teste é
    // compartilhado (e não é recriado na rodada com o usuário restrito):
    // pendentes deixados por outros testes não entram nesta conta.
    await db('depositos_lanchei').where({ status: 'PENDENTE' }).update({ status: 'CANCELADO' });
  });

  async function pixVencido(statusNoMp: PagamentoMp['status'] | null) {
    await conectarMercadoPago(escola.escolaId);
    const { a, resp } = await mae();
    const r = await depositar(resp, a.alunoId, 5000);
    const id = r.body.deposito.id as number;
    if (statusNoMp) mp.status.set(`pay-${id}`, statusNoMp);
    await db('depositos_lanchei').where({ id }).update({ expira_em: new Date(Date.now() - 10 * 60_000) });
    return { a, id, resp };
  }

  it('pago no MP e o webhook se perdeu → o job credita; o app vê APROVADO', async () => {
    const { a, id, resp } = await pixVencido('approved');
    const stats = await sincronizarDepositosVencidos(mp.cliente);
    expect(stats).toMatchObject({ verificados: 1, cancelados: 0, falhas: 0 });
    expect(await saldo(a.contaId)).toBe(5000);
    expect((await resp.get(`/v1/me/depositos/${id}`)).body.deposito).toMatchObject({ status: 'APROVADO', pixCopiaCola: null });
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('não pago → CANCELADO; e se o pagamento aparecer depois, ainda credita', async () => {
    const { a, id } = await pixVencido(null);
    expect((await sincronizarDepositosVencidos(mp.cliente)).cancelados).toBe(1);
    expect((await db('depositos_lanchei').where({ id }).first()).status).toBe('CANCELADO');
    // A família pagou no último segundo e o MP confirmou depois:
    mp.status.set(`pay-${id}`, 'approved');
    const { sincronizarPagamento } = await import('../src/modulos/depositos/pagamento.servico.js');
    await sincronizarPagamento(escola.escolaId, `pay-${id}`, mp.cliente);
    expect(await saldo(a.contaId)).toBe(5000);
  });

  it('MP fora do ar na consulta → NÃO cancela (pode ter sido pago); tenta no próximo ciclo', async () => {
    const { id } = await pixVencido(null);
    const quebrado: ClienteMercadoPago = { ...mp.cliente, buscarPagamento: async () => { throw new Error('MP buscarPagamento falhou: HTTP 503'); } };
    expect(await sincronizarDepositosVencidos(quebrado)).toMatchObject({ falhas: 1, cancelados: 0 });
    expect((await db('depositos_lanchei').where({ id }).first()).status).toBe('PENDENTE');
  });

  it('job e webhook ao mesmo tempo no mesmo pagamento: crédito UMA vez', async () => {
    const { a, id } = await pixVencido('approved');
    const { sincronizarPagamento } = await import('../src/modulos/depositos/pagamento.servico.js');
    await Promise.all([
      sincronizarDepositosVencidos(mp.cliente),
      ...Array.from({ length: 5 }, () => sincronizarPagamento(escola.escolaId, `pay-${id}`, mp.cliente)),
    ]);
    expect(await saldo(a.contaId)).toBe(5000);
    expect(await db('transacoes_lanchei').where({ deposito_id: id })).toHaveLength(1);
  });

  it('reprocessa webhook gravado e não processado (API caiu no meio)', async () => {
    const { a, id } = await pixVencido('approved');
    const mpUserId = (await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).mp_user_id;
    const [eventoId] = await db('webhook_eventos_lanchei').insert({
      provedor: 'MERCADO_PAGO', request_id: novaChave(), escola_id: escola.escolaId, tipo: 'payment', recurso_id: `pay-${id}`,
      assinatura_valida: true, payload: JSON.stringify({ user_id: mpUserId }), recebido_em: new Date(Date.now() - 5 * 60_000),
    });
    const stats = await reprocessarWebhooks(mp.cliente);
    expect(stats.reprocessados).toBeGreaterThanOrEqual(1);
    expect((await db('webhook_eventos_lanchei').where({ id: eventoId }).first()).processado_em).not.toBeNull();
    expect(await saldo(a.contaId)).toBe(5000);
  });
});
