// Estoque para a "tia da cantina" e para o admin: consulta, lançamentos
// (entrada, perda, contagem) e histórico.
//
// O estoque só muda por movimentarEstoque() (dominio/estoque.ts), que grava o
// movimento e atualiza o estoque_atual na mesma transação. O livro de
// movimentos é imutável e guarda quem fez: ele já É a trilha de auditoria.
import { z } from 'zod';
import { db } from '../../infra/db.js';
import { movimentarEstoque, travarProdutosComEstoque } from '../../dominio/estoque.js';
import { intervaloDeDatas } from '../../dominio/periodos.js';
import { erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { fusoDaEscola } from '../admin/acesso.js';

export async function listarEstoque(escolaId: number, soBaixo: boolean) {
  const linhas = await db('produtos_lanchei')
    .where({ escola_id: escolaId, controla_estoque: true, ativo: true })
    .orderBy('nome')
    .select<{ id: number; nome: string; estoque_atual: number; estoque_minimo: number | null }[]>('id', 'nome', 'estoque_atual', 'estoque_minimo');
  const itens = linhas.map((p) => ({
    id: p.id,
    nome: p.nome,
    estoqueAtual: p.estoque_atual,
    estoqueMinimo: p.estoque_minimo,
    // "Acabando": chegou no mínimo (ou abaixo). Sem mínimo definido, nunca alerta.
    abaixoDoMinimo: p.estoque_minimo !== null && p.estoque_atual <= p.estoque_minimo,
  }));
  // Os que estão acabando vêm primeiro (a ordenação é estável: mantém a ordem por nome).
  itens.sort((a, b) => Number(b.abaixoDoMinimo) - Number(a.abaixoDoMinimo));
  return soBaixo ? itens.filter((i) => i.abaixoDoMinimo) : itens;
}

export interface NovoMovimento {
  produtoId: number;
  tipo: 'ENTRADA' | 'PERDA' | 'AJUSTE';
  /** ENTRADA e PERDA: quanto entrou/saiu (positivo). AJUSTE: a CONTAGEM REAL da prateleira. */
  quantidade: number;
  motivo?: string | undefined;
}

export async function lancarMovimento(escolaId: number, usuarioId: number, m: NovoMovimento) {
  if (m.tipo === 'AJUSTE' && !m.motivo) throw erros.regra('MOTIVO_OBRIGATORIO', 'Informe o motivo do ajuste (ex.: "contagem do mês").');
  if (m.tipo !== 'AJUSTE' && m.quantidade === 0) throw erros.regra('QUANTIDADE_INVALIDA', 'Informe uma quantidade maior que zero.');

  return db.transaction(async (trx) => {
    // Trava o produto ANTES de calcular: no AJUSTE, a diferença depende do
    // estoque atual, e uma venda simultânea mudaria esse número no meio do caminho.
    const travados = await travarProdutosComEstoque(trx, escolaId, [m.produtoId]);
    const atual = travados.get(m.produtoId);

    let delta: number;
    if (m.tipo === 'ENTRADA') delta = m.quantidade;
    else if (m.tipo === 'PERDA') delta = -m.quantidade;
    else {
      if (atual === undefined) {
        // Produto inexistente ou sem controle: movimentarEstoque devolve o erro certo (404 ou 422).
        delta = 1;
      } else {
        delta = m.quantidade - atual;
        if (delta === 0) throw erros.regra('SEM_DIFERENCA', 'A contagem é igual ao estoque do sistema. Nada a ajustar.');
      }
    }

    const { estoqueApos } = await movimentarEstoque(trx, {
      escolaId,
      produtoId: m.produtoId,
      tipo: m.tipo,
      quantidade: delta,
      usuarioId,
      ...(m.motivo ? { motivo: m.motivo } : {}),
    });
    return { produtoId: m.produtoId, tipo: m.tipo, quantidade: delta, estoqueAtual: estoqueApos };
  });
}

const zCursor = z.number().int().positive();

export async function listarMovimentos(
  escolaId: number,
  f: { produtoId?: number | undefined; de?: string | undefined; ate?: string | undefined; limite: number; cursor?: string | undefined },
) {
  const { inicio, fim } = intervaloDeDatas(f.de, f.ate, await fusoDaEscola(db, escolaId));
  const q = db('estoque_movimentos_lanchei as m')
    .join('produtos_lanchei as p', 'p.id', 'm.produto_id')
    .leftJoin('usuarios_lanchei as u', 'u.id', 'm.usuario_id')
    .where('m.escola_id', escolaId)
    .select('m.id', 'm.produto_id', 'p.nome as produto_nome', 'm.tipo', 'm.quantidade', 'm.estoque_apos', 'm.pedido_id', 'm.motivo', 'm.created_at', 'u.id as usuario_id', 'u.nome as usuario_nome')
    .orderBy('m.id', 'desc')
    .limit(f.limite + 1);
  if (f.produtoId) q.andWhere('m.produto_id', f.produtoId);
  if (inicio) q.andWhere('m.created_at', '>=', inicio);
  if (fim) q.andWhere('m.created_at', '<', fim);
  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) q.andWhere('m.id', '<', cursor);

  type Linha = {
    id: number; produto_id: number; produto_nome: string; tipo: string; quantidade: number; estoque_apos: number;
    pedido_id: number | null; motivo: string | null; created_at: Date; usuario_id: number | null; usuario_nome: string | null;
  };
  const { itens, proximoCursor } = paginar((await q) as Linha[], f.limite, (u) => u.id);
  return {
    itens: itens.map((l) => ({
      id: l.id,
      produto: { id: l.produto_id, nome: l.produto_nome },
      tipo: l.tipo,
      quantidade: l.quantidade, // com sinal: + entrou, - saiu
      estoqueApos: l.estoque_apos,
      pedidoId: l.pedido_id,
      motivo: l.motivo,
      usuario: l.usuario_id === null ? null : { id: l.usuario_id, nome: l.usuario_nome },
      criadoEm: l.created_at,
    })),
    proximoCursor,
  };
}
