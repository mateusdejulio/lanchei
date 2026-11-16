// ÚNICO lugar do sistema que altera estoque. Mesmo padrão do ledger:
// INSERT do movimento + UPDATE do estoque_atual, com o produto travado.
import type { Trx } from '../infra/db.js';
import { erros } from '../erros.js';

export type TipoMovimento = 'ENTRADA' | 'VENDA' | 'ESTORNO' | 'PERDA' | 'AJUSTE';

export interface Movimento {
  escolaId: number;
  produtoId: number;
  tipo: TipoMovimento;
  /** com sinal: + entra, - sai */
  quantidade: number;
  pedidoId?: number;
  usuarioId?: number;
  motivo?: string;
  criadoEm?: Date;
}

/**
 * Trava produtos com controle de estoque, SEMPRE em ordem crescente de id.
 * A ordem fixa evita deadlock entre dois caixas vendendo os mesmos itens.
 */
export async function travarProdutosComEstoque(trx: Trx, escolaId: number, produtoIds: number[]) {
  const ids = [...new Set(produtoIds)].sort((a, b) => a - b);
  if (ids.length === 0) return new Map<number, number>();
  const linhas = await trx('produtos_lanchei')
    .where({ escola_id: escolaId, controla_estoque: true })
    .whereIn('id', ids)
    .orderBy('id')
    .forUpdate()
    .select<{ id: number; estoque_atual: number }[]>('id', 'estoque_atual');
  return new Map(linhas.map((l) => [l.id, l.estoque_atual]));
}

export async function movimentarEstoque(trx: Trx, m: Movimento): Promise<{ estoqueApos: number }> {
  if (!Number.isSafeInteger(m.quantidade) || m.quantidade === 0) {
    throw new Error('quantidade deve ser inteira e diferente de zero');
  }
  const produto = await trx('produtos_lanchei')
    .where({ id: m.produtoId, escola_id: m.escolaId })
    .forUpdate()
    .first<{ controla_estoque: boolean; estoque_atual: number } | undefined>('controla_estoque', 'estoque_atual');
  if (!produto) throw erros.naoEncontrado('Produto não encontrado.');
  if (!produto.controla_estoque) throw erros.regra('SEM_CONTROLE_ESTOQUE', 'Este produto não controla estoque.');

  const estoqueApos = produto.estoque_atual + m.quantidade;
  if (estoqueApos < 0) {
    throw erros.conflito('ESTOQUE_INSUFICIENTE', 'Estoque insuficiente.', {
      itens: [{ produtoId: m.produtoId, disponivel: produto.estoque_atual }],
    });
  }

  await trx('estoque_movimentos_lanchei').insert({
    escola_id: m.escolaId,
    produto_id: m.produtoId,
    tipo: m.tipo,
    quantidade: m.quantidade,
    estoque_apos: estoqueApos,
    pedido_id: m.pedidoId ?? null,
    usuario_id: m.usuarioId ?? null,
    motivo: m.motivo ?? null,
    ...(m.criadoEm ? { created_at: m.criadoEm } : {}),
  });
  await trx('produtos_lanchei').where({ id: m.produtoId }).update({ estoque_atual: estoqueApos });
  return { estoqueApos };
}
