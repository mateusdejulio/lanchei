// Consultas da tela do caixa (docs/etapa5-caixa.md): catálogo, busca de
// aluno para a compra sem carteirinha e as vendas de hoje do operador.
//
// Regra de ouro do caixa: NENHUMA resposta daqui traz saldo do aluno.
import { db } from '../../infra/db.js';
import { intervaloDoPeriodo } from '../../dominio/periodos.js';
import { primeiroNome } from '../../dominio/notificacoes.js';
import { fusoDaEscola } from '../admin/acesso.js';

export async function catalogoDoCaixa(escolaId: number) {
  const produtos = await db('produtos_lanchei as p')
    .join('categorias_lanchei as c', 'c.id', 'p.categoria_id')
    .where({ 'p.escola_id': escolaId, 'p.ativo': true, 'c.ativo': true })
    .orderBy([{ column: 'c.nome' }, { column: 'p.nome' }])
    .select<
      { id: number; nome: string; preco_centavos: number; controla_estoque: boolean; estoque_atual: number; estoque_minimo: number | null; categoria_id: number; categoria_nome: string }[]
    >('p.id', 'p.nome', 'p.preco_centavos', 'p.controla_estoque', 'p.estoque_atual', 'p.estoque_minimo', 'c.id as categoria_id', 'c.nome as categoria_nome');

  // Agrupa por categoria (as abas da tela), mantendo a ordem alfabética.
  const categorias = new Map<number, { id: number; nome: string; produtos: unknown[] }>();
  for (const p of produtos) {
    if (!categorias.has(p.categoria_id)) categorias.set(p.categoria_id, { id: p.categoria_id, nome: p.categoria_nome, produtos: [] });
    categorias.get(p.categoria_id)!.produtos.push({
      id: p.id,
      nome: p.nome,
      precoCentavos: p.preco_centavos,
      // null = não controla estoque (lanche feito na hora): nunca "esgota".
      estoqueDisponivel: p.controla_estoque ? p.estoque_atual : null,
      // Para o selo "Restam N" quando chega no mínimo.
      estoqueMinimo: p.controla_estoque ? p.estoque_minimo : null,
    });
  }
  return { categorias: [...categorias.values()] };
}

/** Escapa % e _ para o LIKE. */
const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Busca para a compra sem carteirinha: só alunos ATIVOS, até 20, sem foto
 * na lista (a foto vem depois, de um aluno só, com auditoria).
 *
 * Casa com o COMEÇO do nome ("Jo" → João) e com o começo de qualquer
 * sobrenome ("Sil" → João Silva). O primeiro caso usa o índice
 * ix_alunos_busca; o segundo não, mas numa escola são poucos milhares de alunos.
 */
export async function buscarAlunosNoCaixa(escolaId: number, q: string, turmaId?: number) {
  const termo = escaparLike(q.trim());
  const consulta = db('alunos_lanchei as a')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .join('regras_aluno_lanchei as r', 'r.aluno_id', 'a.id')
    .where({ 'a.escola_id': escolaId, 'a.status': 'ATIVO' })
    .andWhere((w) => w.where('a.nome', 'like', `${termo}%`).orWhere('a.nome', 'like', `% ${termo}%`))
    .orderBy('a.nome')
    .limit(20)
    .select<{ id: number; nome: string; turma: string | null; permite_sem_carteirinha: boolean; tem_pin: number }[]>(
      'a.id', 'a.nome', 't.nome as turma', 'r.permite_sem_carteirinha', db.raw('a.pin_hash IS NOT NULL AS tem_pin'),
    );
  if (turmaId) consulta.andWhere('a.turma_id', turmaId);
  const linhas = await consulta;
  return {
    itens: linhas.map((a) => ({
      id: a.id,
      nome: a.nome,
      turma: a.turma,
      // Só aceita PIN se o responsável ligou a opção E definiu o PIN.
      aceitaPin: a.permite_sem_carteirinha && Boolean(a.tem_pin),
    })),
  };
}

/** GET /caixa/pedidos/hoje: os pedidos de HOJE (fuso da escola) feitos por ESTE operador. */
export async function pedidosDeHoje(escolaId: number, operadorId: number, agora = new Date()) {
  const { inicio, fim } = intervaloDoPeriodo(agora, await fusoDaEscola(db, escolaId), 'DIA');
  const linhas = await db('pedidos_lanchei as p')
    .join('alunos_lanchei as a', 'a.id', 'p.aluno_id')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where({ 'p.escola_id': escolaId, 'p.operador_id': operadorId })
    .where('p.created_at', '>=', inicio)
    .where('p.created_at', '<', fim)
    .orderBy('p.id', 'desc')
    .select<
      { id: number; status: string; motivo_recusa: string | null; modo_identificacao: string; total_centavos: number; created_at: Date; aluno_id: number; nome: string; turma: string | null }[]
    >('p.id', 'p.status', 'p.motivo_recusa', 'p.modo_identificacao', 'p.total_centavos', 'p.created_at', 'a.id as aluno_id', 'a.nome', 't.nome as turma');
  return {
    itens: linhas.map((p) => ({
      id: p.id,
      criadoEm: p.created_at,
      // Na gaveta lateral basta o primeiro nome + turma (menos dados expostos na tela).
      aluno: { id: p.aluno_id, primeiroNome: primeiroNome(p.nome), turma: p.turma },
      totalCentavos: p.total_centavos,
      status: p.status,
      motivoRecusa: p.motivo_recusa,
      modoIdentificacao: p.modo_identificacao,
    })),
  };
}
