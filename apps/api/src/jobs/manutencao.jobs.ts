// Jobs diários de manutenção: reconciliação e limpeza.
import { db } from '../infra/db.js';
import { enviarEmailEmSegundoPlano } from '../infra/email.js';
import { modelos } from '../infra/emailModelos.js';
import { logger } from '../infra/logger.js';

/**
 * Reconciliação: confere se o saldo de cada conta é igual à soma do ledger,
 * e o estoque de cada produto igual à soma dos movimentos. As duas views
 * devem estar SEMPRE vazias. Se aparecer qualquer linha, é bug (ou alguém
 * mexeu no banco na mão): avisa o superadmin por e-mail na hora.
 */
export async function reconciliar() {
  const contar = async (view: string) => Number((await db(view).count<{ n: number }[]>({ n: '*' }))[0]?.n ?? 0);
  const contasDivergentes = await contar('vw_contas_divergentes_lanchei');
  const estoqueDivergente = await contar('vw_estoque_divergente_lanchei');
  if (contasDivergentes + estoqueDivergente === 0) return { contasDivergentes, estoqueDivergente, alertados: 0 };

  logger.error({ contasDivergentes, estoqueDivergente }, 'RECONCILIAÇÃO: divergência encontrada');
  const superadmins = await db('usuarios_lanchei').where({ papel: 'SUPERADMIN', ativo: true }).pluck<string[]>('email');
  for (const para of superadmins) {
    enviarEmailEmSegundoPlano({ para, ...modelos.alertaReconciliacao({ contasDivergentes, estoqueDivergente }) }, 'alerta-reconciliacao');
  }
  return { contasDivergentes, estoqueDivergente, alertados: superadmins.length };
}

/**
 * Limpeza. O usuário da API em produção NÃO tem DELETE nessas tabelas
 * (grants.sql), de propósito. Então "limpar" aqui é marcar o que venceu:
 * sessões vencidas viram revogadas e tokens de e-mail vencidos viram usados.
 * Na prática eles já não funcionavam (a API confere a validade); isso só
 * deixa o estado do banco explícito. Apagar dados antigos de verdade
 * (política de retenção da LGPD) é uma tarefa administrativa, feita com o
 * usuário administrador do banco, não pela API.
 * Convites vencidos NÃO são mexidos: eles aparecem nas pendências da
 * secretaria como "convite vencido" (para reenviar).
 */
export async function limpar(agora = new Date()) {
  const sessoes = await db('sessoes_lanchei').whereNull('revogada_em').where('expira_em', '<', agora).update({ revogada_em: agora });
  const tokens = await db('tokens_email_lanchei').whereNull('usado_em').where('expira_em', '<', agora).update({ usado_em: agora });
  return { sessoesExpiradas: sessoes, tokensExpirados: tokens };
}
