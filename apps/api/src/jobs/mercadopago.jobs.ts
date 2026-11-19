// Jobs do Mercado Pago: a rede de segurança do Pix.
//
// O caminho normal do dinheiro é o WEBHOOK (o MP nos avisa na hora). Mas
// avisos se perdem: a API estava reiniciando, o MP teve instabilidade...
// Estes jobs garantem que nenhum Pix pago fique sem crédito e nenhum
// depósito fique "pendente para sempre".
import { db } from '../infra/db.js';
import { criptografar, descriptografar } from '../infra/cripto.js';
import { logger } from '../infra/logger.js';
import type { ClienteMercadoPago, ClienteOAuthMp } from '../infra/mercadopago.js';
import { travarConta } from '../dominio/ledger.js';
import { registrarAuditoria } from '../dominio/auditoria.js';
import { processarEventoWebhook } from '../modulos/webhooks/webhook.servico.js';
import { sincronizarPagamento } from '../modulos/depositos/pagamento.servico.js';

const MINUTO = 60_000;
const DIA = 86_400_000;

/**
 * A cada 1 min: webhooks gravados mas não processados (deu erro, ou a API
 * caiu entre gravar e processar). Só os com mais de 1 min (o processamento
 * normal acontece logo depois de gravar) e dos últimos 3 dias.
 */
export async function reprocessarWebhooks(cliente: ClienteMercadoPago, agora = new Date()) {
  const ids = await db('webhook_eventos_lanchei')
    .where({ assinatura_valida: true })
    .whereNull('processado_em')
    .where('recebido_em', '<', new Date(agora.getTime() - MINUTO))
    .where('recebido_em', '>', new Date(agora.getTime() - 3 * DIA))
    .orderBy('id')
    .limit(50)
    .pluck<number[]>('id');
  for (const id of ids) await processarEventoWebhook(id, cliente);
  return { reprocessados: ids.length };
}

/** Margem depois do vencimento: o MP pode levar alguns segundos para atualizar o status. */
const MARGEM_VENCIMENTO_MS = 2 * MINUTO;

/**
 * A cada 5 min: depósitos PENDENTES já vencidos. Consulta o pagamento no MP
 * (se foi pago e o webhook se perdeu, credita AGORA) e, se ele continua sem
 * pagamento, marca CANCELADO. Se mais tarde o MP disser que foi pago,
 * aplicarPagamento credita mesmo assim (o dinheiro entrou).
 */
export async function sincronizarDepositosVencidos(cliente: ClienteMercadoPago, agora = new Date()) {
  const vencidos = await db('depositos_lanchei')
    .where({ status: 'PENDENTE' })
    .where('expira_em', '<', new Date(agora.getTime() - MARGEM_VENCIMENTO_MS))
    .orderBy('id')
    .limit(50)
    .select<{ id: number; escola_id: number; conta_id: number; mp_payment_id: string | null }[]>('id', 'escola_id', 'conta_id', 'mp_payment_id');

  const stats = { verificados: vencidos.length, cancelados: 0, falhas: 0 };
  for (const d of vencidos) {
    try {
      if (d.mp_payment_id) await sincronizarPagamento(d.escola_id, d.mp_payment_id, cliente);
      // Mesmo padrão de lock do resto do sistema: conta → depósito.
      const cancelou = await db.transaction(async (trx) => {
        await travarConta(trx, d.escola_id, d.conta_id);
        const atual = await trx('depositos_lanchei').where({ id: d.id }).forUpdate().first<{ status: string }>('status');
        if (atual?.status !== 'PENDENTE') return false;
        await trx('depositos_lanchei').where({ id: d.id }).update({ status: 'CANCELADO' });
        return true;
      });
      if (cancelou) stats.cancelados++;
    } catch (err) {
      // Não conseguiu consultar o MP: NÃO cancela (pode ter sido pago). Tenta no próximo ciclo.
      stats.falhas++;
      logger.error({ depositoId: d.id, motivo: (err as Error).message }, 'falha ao sincronizar depósito vencido');
    }
  }
  return stats;
}

/** Renova tokens que expiram em menos de 30 dias (o access token do MP vale 180). */
export const DIAS_ANTECEDENCIA_RENOVACAO = 30;

/**
 * Diário: renova o token OAuth de cada cantina antes de vencer.
 * Cuidado especial: a cada renovação o MP devolve um refresh token NOVO e
 * o antigo deixa de valer. Por isso a gravação é imediata, e só acontece se
 * o refresh que usamos ainda é o que está no banco ("trava otimista"): se a
 * cantina reconectou no meio do caminho, a conexão nova não é sobrescrita.
 */
export async function renovarTokensMp(oauth: ClienteOAuthMp | null, agora = new Date()) {
  if (!oauth) return { renovados: 0, falhas: 0 };
  const linhas = await db('escola_mercadopago_lanchei')
    .where('token_expira_em', '<', new Date(agora.getTime() + DIAS_ANTECEDENCIA_RENOVACAO * DIA))
    .select<{ escola_id: number; mp_user_id: string; refresh_token_enc: Buffer }[]>('escola_id', 'mp_user_id', 'refresh_token_enc');

  const stats = { renovados: 0, falhas: 0 };
  for (const l of linhas) {
    try {
      const t = await oauth.renovar(descriptografar(l.refresh_token_enc));
      if (t.mpUserId !== l.mp_user_id) throw new Error('o MP devolveu tokens de outra conta');
      const alteradas = await db('escola_mercadopago_lanchei')
        .where({ escola_id: l.escola_id, refresh_token_enc: l.refresh_token_enc })
        .update({
          access_token_enc: criptografar(t.accessToken),
          refresh_token_enc: criptografar(t.refreshToken),
          public_key: t.publicKey,
          token_expira_em: t.expiraEm,
        });
      if (alteradas === 0) continue; // a cantina reconectou enquanto renovávamos: a conexão nova vale
      await registrarAuditoria(db, {
        escolaId: l.escola_id,
        ator: { tipo: 'SISTEMA' },
        acao: 'MP_TOKEN_RENOVAR',
        entidade: 'escola_mercadopago',
        entidadeId: l.escola_id,
        depois: { expiraEm: t.expiraEm.toISOString() },
      });
      stats.renovados++;
    } catch (err) {
      // O painel mostra o alerta MP_EXPIRANDO; se vencer, a cantina reconecta.
      stats.falhas++;
      logger.error({ escolaId: l.escola_id, motivo: (err as Error).message }, 'falha ao renovar token do Mercado Pago');
    }
  }
  return stats;
}
