// Pedidos para o painel da Cantina: lista com filtros e detalhe com itens.
// (O estorno reutiliza estornarPedido, de caixa/estorno.servico.ts.)
import { z } from 'zod';
import { db } from '../../infra/db.js';
import { intervaloDeDatas } from '../../dominio/periodos.js';
import { erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { fusoDaEscola } from './acesso.js';

export interface FiltrosPedidos {
  de?: string | undefined;
  ate?: string | undefined;
  status?: 'CONFIRMADO' | 'RECUSADO' | 'ESTORNADO' | undefined;
  alunoId?: number | undefined;
  operadorId?: number | undefined;
  limite: number;
  cursor?: string | undefined;
}

interface LinhaPedido {
  id: number;
  status: string;
  motivo_recusa: string | null;
  modo_identificacao: string;
  total_centavos: number;
  created_at: Date;
  aluno_id: number;
  aluno_nome: string;
  turma_nome: string | null;
  operador_id: number;
  operador_nome: string;
}

function consulta(escolaId: number) {
  return db('pedidos_lanchei as p')
    .join('alunos_lanchei as a', 'a.id', 'p.aluno_id')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .join('usuarios_lanchei as u', 'u.id', 'p.operador_id')
    .where('p.escola_id', escolaId)
    .select(
      'p.id', 'p.status', 'p.motivo_recusa', 'p.modo_identificacao', 'p.total_centavos', 'p.created_at',
      'a.id as aluno_id', 'a.nome as aluno_nome', 't.nome as turma_nome', 'u.id as operador_id', 'u.nome as operador_nome',
    );
}

const paraApi = (p: LinhaPedido) => ({
  id: p.id,
  status: p.status,
  motivoRecusa: p.motivo_recusa,
  modoIdentificacao: p.modo_identificacao, // CARTEIRINHA | PIN | MANUAL
  totalCentavos: p.total_centavos,
  // Para a venda MANUAL, é quando a venda aconteceu (ver vendaManual.servico.ts).
  criadoEm: p.created_at,
  aluno: { id: p.aluno_id, nome: p.aluno_nome, turma: p.turma_nome },
  operador: { id: p.operador_id, nome: p.operador_nome },
});

// O cursor é o id do último pedido (mais novo primeiro).
const zCursor = z.number().int().positive();

export async function listarPedidos(escolaId: number, f: FiltrosPedidos) {
  const { inicio, fim } = intervaloDeDatas(f.de, f.ate, await fusoDaEscola(db, escolaId));
  const q = consulta(escolaId).orderBy('p.id', 'desc').limit(f.limite + 1);
  if (inicio) q.andWhere('p.created_at', '>=', inicio);
  if (fim) q.andWhere('p.created_at', '<', fim);
  if (f.status) q.andWhere('p.status', f.status);
  if (f.alunoId) q.andWhere('p.aluno_id', f.alunoId);
  if (f.operadorId) q.andWhere('p.operador_id', f.operadorId);
  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) q.andWhere('p.id', '<', cursor);

  const { itens, proximoCursor } = paginar((await q) as LinhaPedido[], f.limite, (u) => u.id);
  return { itens: itens.map(paraApi), proximoCursor };
}

export async function detalheDoPedido(escolaId: number, pedidoId: number) {
  const p = (await consulta(escolaId)
    .andWhere('p.id', pedidoId)
    .leftJoin('usuarios_lanchei as e', 'e.id', 'p.estornado_por_usuario_id')
    .select('p.observacao', 'p.ocorrido_em', 'p.estornado_em', 'p.motivo_estorno', 'e.id as estornador_id', 'e.nome as estornador_nome')
    .first()) as
    | (LinhaPedido & {
        observacao: string | null; ocorrido_em: Date | null; estornado_em: Date | null; motivo_estorno: string | null;
        estornador_id: number | null; estornador_nome: string | null;
      })
    | undefined;
  if (!p) throw erros.naoEncontrado('Pedido não encontrado.');

  const itens = await db('pedido_itens_lanchei')
    .where({ pedido_id: pedidoId })
    .orderBy('id')
    .select<{ produto_id: number; nome_produto: string; quantidade: number; preco_unitario_centavos: number; subtotal_centavos: number }[]>(
      'produto_id', 'nome_produto', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos',
    );
  return {
    ...paraApi(p),
    itens: itens.map((i) => ({
      produtoId: i.produto_id,
      nome: i.nome_produto, // nome e preço do momento da venda (snapshot)
      quantidade: i.quantidade,
      precoUnitarioCentavos: i.preco_unitario_centavos,
      subtotalCentavos: i.subtotal_centavos,
    })),
    observacao: p.observacao,
    ocorridoEm: p.ocorrido_em,
    estorno: p.estornado_em === null ? null : { em: p.estornado_em, motivo: p.motivo_estorno, por: { id: p.estornador_id, nome: p.estornador_nome } },
  };
}
