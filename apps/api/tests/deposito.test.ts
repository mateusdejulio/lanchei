// Depósito via Pix: o crédito só entra quando o MP confirma, UMA vez,
// mesmo com webhooks duplicados chegando em paralelo.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import request from 'supertest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aplicarPagamento, sincronizarPagamento } from '../src/modulos/depositos/pagamento.servico.js';
import { processarEventoWebhook } from '../src/modulos/webhooks/webhook.servico.js';
import type { ClienteMercadoPago, PagamentoMp } from '../src/infra/mercadopago.js';
import { conectarMercadoPago, criarAluno, criarEscola, divergencias, saldo, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

let escola: Escola;
beforeEach(async () => {
  escola = await criarEscola();
});

async function depositoPendente(valorCentavos = 5000) {
  const a = await criarAluno(escola);
  const [depositoId] = await db('depositos_lanchei').insert({
    escola_id: escola.escolaId,
    conta_id: a.contaId,
    responsavel_id: a.responsavelIds[0],
    valor_centavos: valorCentavos,
    idempotency_key: randomUUID(),
    status: 'PENDENTE',
    mp_payment_id: `pay-${depositoId_seq++}`,
  });
  const dep = await db('depositos_lanchei').where({ id: depositoId }).first();
  return { a, depositoId: depositoId!, mpPaymentId: dep.mp_payment_id as string };
}
let depositoId_seq = Date.now();

const pagamento = (mpPaymentId: string, depositoId: number, status: PagamentoMp['status'], valorCentavos = 5000): PagamentoMp => ({
  id: mpPaymentId,
  status,
  externalReference: String(depositoId),
  valorCentavos,
  taxaCentavos: 50,
});

describe('aplicarPagamento', () => {
  it('approved credita o valor BRUTO (cantina absorve a taxa) e avisa os responsáveis', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente(5000);
    expect(await aplicarPagamento(escola.escolaId, pagamento(mpPaymentId, depositoId, 'approved'))).toBe('CREDITADO');
    expect(await saldo(a.contaId)).toBe(5000);
    const dep = await db('depositos_lanchei').where({ id: depositoId }).first();
    expect(dep).toMatchObject({ status: 'APROVADO', taxa_centavos: 50 });
    expect(await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'DEPOSITO_CONFIRMADO' })).toHaveLength(2);
  });

  it('pending não credita', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    expect(await aplicarPagamento(escola.escolaId, pagamento(mpPaymentId, depositoId, 'pending'))).toBe('SEM_MUDANCA');
    expect(await saldo(a.contaId)).toBe(0);
  });

  it('o mesmo approved processado 2x credita UMA vez', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    const pg = pagamento(mpPaymentId, depositoId, 'approved');
    expect(await aplicarPagamento(escola.escolaId, pg)).toBe('CREDITADO');
    expect(await aplicarPagamento(escola.escolaId, pg)).toBe('JA_PROCESSADO');
    expect(await saldo(a.contaId)).toBe(5000);
  });

  it('10 webhooks do mesmo pagamento EM PARALELO => crédito UMA vez', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    const pg = pagamento(mpPaymentId, depositoId, 'approved');
    const acoes = await Promise.all(Array.from({ length: 10 }, () => aplicarPagamento(escola.escolaId, pg)));
    expect(acoes.filter((x) => x === 'CREDITADO')).toHaveLength(1);
    expect(await saldo(a.contaId)).toBe(5000);
    expect(await db('transacoes_lanchei').where({ deposito_id: depositoId })).toHaveLength(1);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('valor divergente NÃO credita e gera auditoria', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente(5000);
    expect(await aplicarPagamento(escola.escolaId, pagamento(mpPaymentId, depositoId, 'approved', 100))).toBe('IGNORADO');
    expect(await saldo(a.contaId)).toBe(0);
    expect(await db('auditoria_lanchei').where({ acao: 'DEPOSITO_VALOR_DIVERGENTE', entidade_id: depositoId })).toHaveLength(1);
  });

  it('depósito de OUTRA escola é ignorado', async () => {
    const { depositoId, mpPaymentId } = await depositoPendente();
    const outra = await criarEscola();
    expect(await aplicarPagamento(outra.escolaId, pagamento(mpPaymentId, depositoId, 'approved'))).toBe('IGNORADO');
  });

  it('refunded após aprovado => DEVOLVIDO, sem mexer no saldo (admin decide)', async () => {
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    await aplicarPagamento(escola.escolaId, pagamento(mpPaymentId, depositoId, 'approved'));
    expect(await aplicarPagamento(escola.escolaId, pagamento(mpPaymentId, depositoId, 'refunded'))).toBe('DEVOLVIDO');
    expect(await saldo(a.contaId)).toBe(5000);
    expect(await db('auditoria_lanchei').where({ acao: 'DEPOSITO_DEVOLVIDO', entidade_id: depositoId })).toHaveLength(1);
  });

  it('cancelled/rejected em pendente', async () => {
    const d1 = await depositoPendente();
    expect(await aplicarPagamento(escola.escolaId, pagamento(d1.mpPaymentId, d1.depositoId, 'cancelled'))).toBe('CANCELADO');
    const d2 = await depositoPendente();
    expect(await aplicarPagamento(escola.escolaId, pagamento(d2.mpPaymentId, d2.depositoId, 'rejected'))).toBe('REJEITADO');
  });
});

describe('sincronizarPagamento', () => {
  it('busca o pagamento com o token DESCRIPTOGRAFADO da cantina', async () => {
    await conectarMercadoPago(escola.escolaId);
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    const tokensUsados: string[] = [];
    const fake: ClienteMercadoPago = {
      async buscarPagamento(token, id) {
        tokensUsados.push(token);
        return pagamento(id, depositoId, 'approved');
      },
      criarPix: () => Promise.reject(new Error('não usado')),
    };
    expect(await sincronizarPagamento(escola.escolaId, mpPaymentId, fake)).toBe('CREDITADO');
    expect(tokensUsados).toEqual(['TOKEN-DA-CANTINA']);
    expect(await saldo(a.contaId)).toBe(5000);
  });
});

describe('POST /v1/webhooks/mercadopago', () => {
  const app = criarApp();
  const segredo = process.env.MP_WEBHOOK_SECRET!;
  const assinar = (dataId: string, requestId: string, ts = '1700000000') =>
    `ts=${ts},v1=${createHmac('sha256', segredo).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex')}`;

  it('grava o evento, responde 200 e ignora reenvio com o mesmo x-request-id', async () => {
    const mpUserId = await conectarMercadoPago(escola.escolaId);
    const requestId = randomUUID();
    const enviar = () =>
      request(app)
        .post('/v1/webhooks/mercadopago?data.id=123456&type=payment')
        .set('x-request-id', requestId)
        .set('x-signature', assinar('123456', requestId))
        .send({ type: 'payment', data: { id: '123456' }, user_id: mpUserId });

    const r1 = await enviar();
    expect(r1.status).toBe(200);
    const ev = await db('webhook_eventos_lanchei').where({ request_id: requestId }).first();
    expect(ev).toMatchObject({ escola_id: escola.escolaId, tipo: 'payment', recurso_id: '123456', assinatura_valida: true });

    const r2 = await enviar();
    expect(r2.body).toEqual({ ok: true, duplicado: true });
  });

  it('assinatura inválida => 401 (evento gravado como inválido, nunca processado)', async () => {
    const requestId = randomUUID();
    const r = await request(app)
      .post('/v1/webhooks/mercadopago?data.id=1&type=payment')
      .set('x-request-id', requestId)
      .set('x-signature', 'ts=1,v1=deadbeef')
      .send({ type: 'payment', data: { id: '1' } });
    expect(r.status).toBe(401);
    const ev = await db('webhook_eventos_lanchei').where({ request_id: requestId }).first();
    expect(ev.assinatura_valida).toBe(false);
  });

  it('processarEventoWebhook ponta a ponta: evento -> consulta MP -> crédito -> marca processado', async () => {
    const mpUserId = await conectarMercadoPago(escola.escolaId);
    const { a, depositoId, mpPaymentId } = await depositoPendente();
    const [eventoId] = await db('webhook_eventos_lanchei').insert({
      provedor: 'MERCADO_PAGO',
      request_id: randomUUID(),
      escola_id: escola.escolaId,
      tipo: 'payment',
      recurso_id: mpPaymentId,
      assinatura_valida: true,
      payload: JSON.stringify({ user_id: mpUserId }),
    });
    const fake: ClienteMercadoPago = {
      buscarPagamento: async (_t, id) => pagamento(id, depositoId, 'approved'),
      criarPix: () => Promise.reject(new Error('não usado')),
    };
    await processarEventoWebhook(eventoId!, fake);
    expect(await saldo(a.contaId)).toBe(5000);
    const ev = await db('webhook_eventos_lanchei').where({ id: eventoId }).first();
    expect(ev.processado_em).not.toBeNull();
    expect(ev.erro).toBeNull();
  });

  it('falha do MP fica registrada no evento (para o job reprocessar)', async () => {
    await conectarMercadoPago(escola.escolaId);
    const [eventoId] = await db('webhook_eventos_lanchei').insert({
      provedor: 'MERCADO_PAGO',
      request_id: randomUUID(),
      escola_id: escola.escolaId,
      tipo: 'payment',
      recurso_id: '999',
      assinatura_valida: true,
      payload: '{}',
    });
    const fora: ClienteMercadoPago = {
      buscarPagamento: () => Promise.reject(new Error('MP fora do ar')),
      criarPix: () => Promise.reject(new Error('não usado')),
    };
    await processarEventoWebhook(eventoId!, fora);
    const ev = await db('webhook_eventos_lanchei').where({ id: eventoId }).first();
    expect(ev.processado_em).toBeNull();
    expect(ev.erro).toContain('MP fora do ar');
  });
});
