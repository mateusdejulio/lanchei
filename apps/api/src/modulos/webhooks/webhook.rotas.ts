// POST /v1/webhooks/mercadopago
// 1. valida assinatura  2. grava evento bruto  3. responde 200 NA HORA
// 4. processa em segundo plano (consulta o pagamento no MP antes de creditar)
import { Router } from 'express';
import { env } from '../../config/env.js';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { validarAssinaturaMp } from '../../infra/mercadopago.js';
import { logger } from '../../infra/logger.js';
import { processarEventoWebhook } from './webhook.servico.js';

export const rotasWebhooks = Router();

rotasWebhooks.post('/mercadopago', async (req, res) => {
  const corpo = (req.body ?? {}) as { type?: string; data?: { id?: string | number }; user_id?: string | number };
  const dataId = String(req.query['data.id'] ?? corpo.data?.id ?? '') || undefined;
  const tipo = String(req.query['type'] ?? corpo.type ?? req.query['topic'] ?? '') || null;
  const requestId = req.get('x-request-id');

  const assinaturaValida = env.MP_WEBHOOK_SECRET
    ? validarAssinaturaMp({ xSignature: req.get('x-signature'), xRequestId: requestId, dataId, segredo: env.MP_WEBHOOK_SECRET })
    : env.NODE_ENV !== 'production'; // sem segredo configurado, só aceita fora de produção

  const mpUserId = corpo.user_id != null ? String(corpo.user_id) : null;
  const escola = mpUserId
    ? await db('escola_mercadopago_lanchei').where({ mp_user_id: mpUserId }).first<{ escola_id: number } | undefined>('escola_id')
    : undefined;

  let eventoId: number;
  try {
    [eventoId] = (await db('webhook_eventos_lanchei').insert({
      provedor: 'MERCADO_PAGO',
      request_id: requestId ?? null,
      escola_id: escola?.escola_id ?? null,
      tipo,
      recurso_id: dataId ?? null,
      assinatura_valida: assinaturaValida,
      payload: JSON.stringify(corpo),
    })) as [number];
  } catch (e) {
    if (ehChaveDuplicada(e)) {
      res.status(200).json({ ok: true, duplicado: true }); // reenvio do MP: já temos
      return;
    }
    throw e;
  }

  if (!assinaturaValida) {
    logger.warn({ eventoId }, 'webhook MP com assinatura inválida');
    res.status(401).json({ erro: { codigo: 'ASSINATURA_INVALIDA', mensagem: 'Assinatura inválida.' } });
    return;
  }

  res.status(200).json({ ok: true });
  setImmediate(() => void processarEventoWebhook(eventoId));
});
