// ÚNICO lugar do sistema que altera saldo. Toda mudança de saldo é:
//   INSERT no ledger (transacoes_lanchei) + UPDATE do saldo materializado,
// na MESMA transação de banco, com a conta travada (FOR UPDATE).
import type { Trx } from '../infra/db.js';
import { erros } from '../erros.js';

export type TipoTransacao = 'DEPOSITO' | 'COMPRA' | 'ESTORNO' | 'REEMBOLSO' | 'AJUSTE';

export interface Lancamento {
  escolaId: number;
  contaId: number;
  tipo: TipoTransacao;
  /** > 0 crédito, < 0 débito */
  valorCentavos: number;
  pedidoId?: number;
  depositoId?: number;
  reembolsoId?: number;
  usuarioId?: number;
  descricao?: string;
  criadoEm?: Date;
}

export interface ResultadoLancamento {
  transacaoId: number;
  saldoAntesCentavos: number;
  saldoAposCentavos: number;
}

/** Trava a conta até o fim da transação e devolve o saldo atual. */
export async function travarConta(trx: Trx, escolaId: number, contaId: number) {
  const conta = await trx('contas_lanchei')
    .where({ id: contaId, escola_id: escolaId })
    .forUpdate()
    .first<{ id: number; aluno_id: number; saldo_centavos: number } | undefined>('id', 'aluno_id', 'saldo_centavos');
  if (!conta) throw erros.naoEncontrado('Conta não encontrada.');
  return conta;
}

export async function lancarTransacao(trx: Trx, l: Lancamento): Promise<ResultadoLancamento> {
  if (!Number.isSafeInteger(l.valorCentavos) || l.valorCentavos === 0) {
    throw new Error('valorCentavos deve ser inteiro e diferente de zero');
  }
  // Travar de novo dentro da mesma transação é inofensivo (o lock já é nosso)
  // e protege contra quem esquecer de travar antes.
  const conta = await travarConta(trx, l.escolaId, l.contaId);
  const saldoAntes = conta.saldo_centavos;
  const saldoApos = saldoAntes + l.valorCentavos;
  if (saldoApos < 0) {
    // O CHECK do banco também barraria, mas aqui o erro sai legível.
    throw erros.regra('SALDO_INSUFICIENTE', 'Saldo insuficiente para este lançamento.');
  }

  const [transacaoId] = await trx('transacoes_lanchei').insert({
    escola_id: l.escolaId,
    conta_id: l.contaId,
    tipo: l.tipo,
    valor_centavos: l.valorCentavos,
    saldo_apos_centavos: saldoApos,
    pedido_id: l.pedidoId ?? null,
    deposito_id: l.depositoId ?? null,
    reembolso_id: l.reembolsoId ?? null,
    usuario_id: l.usuarioId ?? null,
    descricao: l.descricao ?? null,
    ...(l.criadoEm ? { created_at: l.criadoEm } : {}),
  });
  await trx('contas_lanchei').where({ id: l.contaId }).update({ saldo_centavos: saldoApos });

  return { transacaoId: transacaoId!, saldoAntesCentavos: saldoAntes, saldoAposCentavos: saldoApos };
}
