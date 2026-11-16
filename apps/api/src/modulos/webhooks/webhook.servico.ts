import { db } from '../../infra/db.js';
import { clienteMercadoPago, type ClienteMercadoPago } from '../../infra/mercadopago.js';
import { logger } from '../../infra/logger.js';
import { sincronizarPagamento } from '../depositos/pagamento.servico.js';

/**
 * Processa um evento já gravado em webhook_eventos_lanchei.
 * Também é chamado pelo job de reprocessamento (eventos com erro).
 */
export async function processarEventoWebhook(eventoId: number, cliente: ClienteMercadoPago = clienteMercadoPago) {
  const ev = await db('webhook_eventos_lanchei').where({ id: eventoId }).first<
    | { id: number; escola_id: number | null; tipo: string | null; recurso_id: string | null; assinatura_valida: boolean; processado_em: Date | null }
    | undefined
  >();
  if (!ev || ev.processado_em || !ev.assinatura_valida) return;

  try {
    if (ev.tipo === 'payment' && ev.escola_id && ev.recurso_id) {
      const acao = await sincronizarPagamento(ev.escola_id, ev.recurso_id, cliente);
      logger.info({ eventoId, acao }, 'webhook MP processado');
    }
    await db('webhook_eventos_lanchei').where({ id: eventoId }).update({ processado_em: new Date(), erro: null });
  } catch (e) {
    logger.error({ eventoId, err: e }, 'falha ao processar webhook MP');
    await db('webhook_eventos_lanchei')
      .where({ id: eventoId })
      .update({ erro: String(e instanceof Error ? e.message : e).slice(0, 2000) });
  }
}
