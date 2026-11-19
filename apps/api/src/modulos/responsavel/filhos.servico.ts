// Leitura do app dos pais: lista de filhos, detalhe, catálogo com
// bloqueios, extrato e detalhe de uma compra.
import { db } from '../../infra/db.js';
import { mascaraParaDias } from '../../dominio/diasPermitidos.js';
import { erros } from '../../erros.js';
import { paginaDoExtrato, type FiltrosPagina } from '../admin/extrato.servico.js';
import { garantirVinculo } from './vinculo.js';

export async function listarFilhos(responsavelId: number) {
  const linhas = await db('aluno_responsaveis_lanchei as ar')
    .join('alunos_lanchei as a', 'a.id', 'ar.aluno_id')
    .join('contas_lanchei as c', 'c.aluno_id', 'a.id')
    .join('escolas_lanchei as e', 'e.id', 'a.escola_id')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where('ar.responsavel_id', responsavelId)
    .whereNull('ar.desvinculado_em')
    .orderBy('a.nome')
    .select<
      { id: number; nome: string; status: string; escola_id: number; escola_nome: string; turma: string | null; saldo_centavos: number; carteirinha_status: string | null; tem_foto: number }[]
    >(
      'a.id', 'a.nome', 'a.status', 'e.id as escola_id', 'e.nome as escola_nome', 't.nome as turma', 'c.saldo_centavos',
      db.raw('(SELECT cv.status FROM carteirinhas_lanchei cv WHERE cv.aluno_vivo = a.id) AS carteirinha_status'),
      db.raw('EXISTS (SELECT 1 FROM fotos_alunos_lanchei f WHERE f.aluno_id = a.id) AS tem_foto'),
    );
  return linhas.map((a) => ({
    id: a.id,
    nome: a.nome,
    status: a.status,
    escola: { id: a.escola_id, nome: a.escola_nome },
    turma: a.turma,
    saldoCentavos: a.saldo_centavos, // os PAIS veem o saldo; o caixa, nunca
    carteirinha: { status: a.carteirinha_status }, // ATIVA | BLOQUEADA | null (sem carteirinha)
    temFoto: Boolean(a.tem_foto),
  }));
}

export async function regrasDoFilho(alunoId: number) {
  const r = await db('regras_aluno_lanchei as r')
    .join('alunos_lanchei as a', 'a.id', 'r.aluno_id')
    .where('r.aluno_id', alunoId)
    .first<{
      limite_diario_centavos: number | null; limite_semanal_centavos: number | null; limite_mensal_centavos: number | null; dias_permitidos: number;
      alerta_saldo_baixo_centavos: number | null; permite_sem_carteirinha: boolean; tem_pin: number; pin_bloqueado_ate: Date | null;
    }>(
      'r.limite_diario_centavos', 'r.limite_semanal_centavos', 'r.limite_mensal_centavos', 'r.dias_permitidos', 'r.alerta_saldo_baixo_centavos',
      'r.permite_sem_carteirinha', db.raw('a.pin_hash IS NOT NULL AS tem_pin'), 'a.pin_bloqueado_ate',
    );
  // "Última alteração: Maria, 05/11 às 10:12" (os responsáveis veem as alterações um do outro).
  const ultima = await db('auditoria_lanchei as au')
    .join('responsaveis_lanchei as rs', 'rs.id', 'au.ator_responsavel_id')
    .where('au.aluno_id', alunoId)
    .whereIn('au.acao', ['REGRAS_ATUALIZAR', 'BLOQUEIOS_ATUALIZAR'])
    .orderBy('au.id', 'desc')
    .first<{ nome: string; created_at: Date; acao: string } | undefined>('rs.nome', 'au.created_at', 'au.acao');
  return {
    limiteDiarioCentavos: r.limite_diario_centavos,
    limiteSemanalCentavos: r.limite_semanal_centavos,
    limiteMensalCentavos: r.limite_mensal_centavos,
    diasPermitidos: mascaraParaDias(r.dias_permitidos),
    alertaSaldoBaixoCentavos: r.alerta_saldo_baixo_centavos,
    permiteSemCarteirinha: r.permite_sem_carteirinha,
    temPin: Boolean(r.tem_pin),
    pinBloqueadoAte: r.pin_bloqueado_ate && r.pin_bloqueado_ate > new Date() ? r.pin_bloqueado_ate : null,
    ultimaAlteracao: ultima ? { por: ultima.nome, em: ultima.created_at, oQue: ultima.acao === 'REGRAS_ATUALIZAR' ? 'REGRAS' : 'BLOQUEIOS' } : null,
  };
}

export async function detalheDoFilho(responsavelId: number, alunoId: number) {
  await garantirVinculo(db, responsavelId, alunoId);
  const filho = (await listarFilhos(responsavelId)).find((f) => f.id === alunoId)!;
  const bloqueios = {
    categoriaIds: await db('bloqueios_categoria_lanchei').where({ aluno_id: alunoId }).pluck<number[]>('categoria_id'),
    produtoIds: await db('bloqueios_produto_lanchei').where({ aluno_id: alunoId }).pluck<number[]>('produto_id'),
  };
  // Outros responsáveis: só o NOME (sem e-mail: não é necessário para o app).
  const outros = await db('aluno_responsaveis_lanchei as ar')
    .join('responsaveis_lanchei as r', 'r.id', 'ar.responsavel_id')
    .where('ar.aluno_id', alunoId)
    .whereNull('ar.desvinculado_em')
    .whereNot('ar.responsavel_id', responsavelId)
    .pluck<string[]>('r.nome');
  return { ...filho, regras: await regrasDoFilho(alunoId), bloqueios, outrosResponsaveis: outros.map((nome) => ({ nome })) };
}

/** Catálogo da escola com o que está bloqueado para este aluno (tela de Bloqueios). */
export async function catalogoDoFilho(responsavelId: number, alunoId: number) {
  const f = await garantirVinculo(db, responsavelId, alunoId);
  const [catBloq, prodBloq] = await Promise.all([
    db('bloqueios_categoria_lanchei').where({ aluno_id: alunoId }).pluck<number[]>('categoria_id'),
    db('bloqueios_produto_lanchei').where({ aluno_id: alunoId }).pluck<number[]>('produto_id'),
  ]);
  const produtos = await db('produtos_lanchei as p')
    .join('categorias_lanchei as c', 'c.id', 'p.categoria_id')
    .where({ 'p.escola_id': f.escolaId, 'p.ativo': true, 'c.ativo': true })
    .orderBy([{ column: 'c.nome' }, { column: 'p.nome' }])
    .select<{ id: number; nome: string; preco_centavos: number; categoria_id: number; categoria_nome: string }[]>(
      'p.id', 'p.nome', 'p.preco_centavos', 'c.id as categoria_id', 'c.nome as categoria_nome',
    );
  const cats = new Map<number, { id: number; nome: string; bloqueado: boolean; produtos: unknown[] }>();
  for (const p of produtos) {
    if (!cats.has(p.categoria_id)) {
      cats.set(p.categoria_id, { id: p.categoria_id, nome: p.categoria_nome, bloqueado: catBloq.includes(p.categoria_id), produtos: [] });
    }
    cats.get(p.categoria_id)!.produtos.push({
      id: p.id,
      nome: p.nome,
      precoCentavos: p.preco_centavos,
      bloqueado: prodBloq.includes(p.id),
      // Bloqueado pela categoria (a chave do produto fica travada no app).
      bloqueadoPelaCategoria: catBloq.includes(p.categoria_id),
    });
  }
  return { categorias: [...cats.values()] };
}

export async function extratoDoFilho(responsavelId: number, alunoId: number, f: FiltrosPagina) {
  const filho = await garantirVinculo(db, responsavelId, alunoId);
  return paginaDoExtrato(filho.contaId, filho.timezone, f);
}

/** Detalhe de uma compra (inclui recusadas, com o motivo). Pedido de OUTRO aluno = 404. */
export async function pedidoDoFilho(responsavelId: number, alunoId: number, pedidoId: number) {
  await garantirVinculo(db, responsavelId, alunoId);
  const p = await db('pedidos_lanchei')
    .where({ id: pedidoId, aluno_id: alunoId })
    .first<
      | { id: number; status: string; motivo_recusa: string | null; modo_identificacao: string; total_centavos: number; created_at: Date; estornado_em: Date | null; motivo_estorno: string | null }
      | undefined
    >('id', 'status', 'motivo_recusa', 'modo_identificacao', 'total_centavos', 'created_at', 'estornado_em', 'motivo_estorno');
  if (!p) throw erros.naoEncontrado('Compra não encontrada.');
  const itens = await db('pedido_itens_lanchei')
    .where({ pedido_id: pedidoId })
    .orderBy('id')
    .select<{ nome_produto: string; quantidade: number; preco_unitario_centavos: number; subtotal_centavos: number }[]>(
      'nome_produto', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos',
    );
  return {
    id: p.id,
    status: p.status,
    motivoRecusa: p.motivo_recusa,
    // CARTEIRINHA | PIN (sem carteirinha) | MANUAL (lançada depois pela cantina)
    modoIdentificacao: p.modo_identificacao,
    totalCentavos: p.total_centavos,
    criadoEm: p.created_at,
    estorno: p.estornado_em ? { em: p.estornado_em, motivo: p.motivo_estorno } : null,
    itens: itens.map((i) => ({ nome: i.nome_produto, quantidade: i.quantidade, precoUnitarioCentavos: i.preco_unitario_centavos, subtotalCentavos: i.subtotal_centavos })),
    // Nome do operador não é mostrado aos pais (não é necessário).
  };
}
