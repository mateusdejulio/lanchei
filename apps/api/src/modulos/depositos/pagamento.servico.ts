// Aplica no nosso banco o estado de um pagamento Pix do Mercado Pago.
// Chamado pelo processamento do webhook e pelo job que reconcilia
// depósitos pendentes. É IDEMPOTENTE: rodar 1 ou 10 vezes (inclusive em
// paralelo) com o mesmo pagamento dá o mesmo resultado, crédito UMA vez.
//
// Ordem dos locks (igual à compra): conta -> depósito.
import { db } from '../../infra/db.js';
import { descriptografar } from '../../infra/cripto.js';
import type { ClienteMercadoPago, PagamentoMp } from '../../infra/mercadopago.js';
import { lancarTransacao, travarConta } from '../../dominio/ledger.js';
import { notificarResponsaveis, primeiroNome, reais } from '../../dominio/notificacoes.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { logger } from '../../infra/logger.js';

export type AcaoPagamento =
  | 'CREDITADO'
  | 'JA_PROCESSADO'
  | 'REJEITADO'
  | 'CANCELADO'
  | 'DEVOLVIDO'
  | 'SEM_MUDANCA'
  | 'IGNORADO';

type StatusDeposito = 'PENDENTE' | 'APROVADO' | 'CANCELADO' | 'REJEITADO' | 'DEVOLVIDO';

export async function aplicarPagamento(escolaId: number, pg: PagamentoMp, agora = new Date()): Promise<AcaoPagamento> {
  const depositoId = Number(pg.externalReference);
  if (!Number.isSafeInteger(depositoId) || depositoId <= 0) {
    logger.warn({ mpPaymentId: pg.id }, 'pagamento sem external_reference válido');
    return 'IGNORADO';
  }

  return db.transaction(async (trx) => {
    const ref = await trx('depositos_lanchei')
      .where({ id: depositoId, escola_id: escolaId })
      .first<{ conta_id: number } | undefined>('conta_id');
    if (!ref) {
      logger.warn({ depositoId, escolaId }, 'depósito do pagamento não encontrado nesta escola');
      return 'IGNORADO';
    }
    await travarConta(trx, escolaId, ref.conta_id);
    const dep = await trx('depositos_lanchei').where({ id: depositoId }).forUpdate().first<{
      id: number;
      conta_id: number;
      valor_centavos: number;
      status: StatusDeposito;
      mp_payment_id: string | null;
    }>();
    if (!dep) return 'IGNORADO';

    if (dep.mp_payment_id && dep.mp_payment_id !== pg.id) {
      logger.error({ depositoId, mpPaymentId: pg.id }, 'pagamento MP não corresponde ao depósito');
      return 'IGNORADO';
    }
    // Defesa: o valor pago TEM que ser o valor do depósito.
    if (pg.valorCentavos !== dep.valor_centavos) {
      await registrarAuditoria(trx, {
        escolaId,
        ator: { tipo: 'SISTEMA' },
        acao: 'DEPOSITO_VALOR_DIVERGENTE',
        entidade: 'depositos',
        entidadeId: dep.id,
        depois: { esperado: dep.valor_centavos, recebido: pg.valorCentavos, mpPaymentId: pg.id },
      });
      logger.error({ depositoId }, 'valor do pagamento diverge do depósito; não creditado');
      return 'IGNORADO';
    }

    switch (pg.status) {
      case 'approved': {
        if (dep.status === 'APROVADO' || dep.status === 'DEVOLVIDO') return 'JA_PROCESSADO';
        // Também aceita CANCELADO/REJEITADO: se o dinheiro entrou, credita.
        await trx('depositos_lanchei').where({ id: dep.id }).update({
          status: 'APROVADO',
          aprovado_em: agora,
          mp_payment_id: pg.id,
          taxa_centavos: pg.taxaCentavos,
        });
        await lancarTransacao(trx, {
          escolaId,
          contaId: dep.conta_id,
          tipo: 'DEPOSITO',
          valorCentavos: dep.valor_centavos,
          depositoId: dep.id,
          descricao: 'Depósito via Pix',
          criadoEm: agora,
        });
        const aluno = await trx('contas_lanchei as c')
          .join('alunos_lanchei as a', 'a.id', 'c.aluno_id')
          .where('c.id', dep.conta_id)
          .first<{ id: number; nome: string }>('a.id', 'a.nome');
        await notificarResponsaveis(trx, {
          alunoId: aluno!.id,
          tipo: 'DEPOSITO_CONFIRMADO',
          titulo: 'Depósito confirmado',
          corpo: `${reais(dep.valor_centavos)} creditados para ${primeiroNome(aluno!.nome)}.`,
          dados: { depositoId: dep.id },
          criadoEm: agora,
        });
        return 'CREDITADO';
      }
      case 'rejected':
        if (dep.status !== 'PENDENTE') return 'SEM_MUDANCA';
        await trx('depositos_lanchei').where({ id: dep.id }).update({ status: 'REJEITADO', mp_payment_id: pg.id });
        return 'REJEITADO';
      case 'cancelled':
        if (dep.status !== 'PENDENTE') return 'SEM_MUDANCA';
        await trx('depositos_lanchei').where({ id: dep.id }).update({ status: 'CANCELADO', mp_payment_id: pg.id });
        return 'CANCELADO';
      case 'refunded':
      case 'charged_back':
        if (dep.status !== 'APROVADO') return 'SEM_MUDANCA';
        // NÃO mexe no saldo (o filho pode já ter gastado). O admin decide e,
        // se for o caso, lança um AJUSTE. Ver "Limitação conhecida" na Etapa 2.
        await trx('depositos_lanchei').where({ id: dep.id }).update({ status: 'DEVOLVIDO' });
        await registrarAuditoria(trx, {
          escolaId,
          ator: { tipo: 'SISTEMA' },
          acao: 'DEPOSITO_DEVOLVIDO',
          entidade: 'depositos',
          entidadeId: dep.id,
          depois: { mpStatus: pg.status, mpPaymentId: pg.id },
        });
        return 'DEVOLVIDO';
      default:
        return 'SEM_MUDANCA'; // pending, in_process, etc.
    }
  });
}

/** Busca o pagamento no MP com o token DA CANTINA e aplica. */
export async function sincronizarPagamento(
  escolaId: number,
  mpPaymentId: string,
  cliente: ClienteMercadoPago,
): Promise<AcaoPagamento> {
  const conta = await db('escola_mercadopago_lanchei')
    .where({ escola_id: escolaId })
    .first<{ access_token_enc: Buffer } | undefined>('access_token_enc');
  if (!conta) throw new Error(`Escola ${escolaId} sem Mercado Pago conectado`);
  const pagamento = await cliente.buscarPagamento(descriptografar(conta.access_token_enc), mpPaymentId);
  return aplicarPagamento(escolaId, pagamento);
}
