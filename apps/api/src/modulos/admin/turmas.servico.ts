// Turmas: listar, criar, renomear/desativar e "virada de ano" (mover alunos).
// Sem DELETE: turma desativada continua existindo no histórico.
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';

const turmaDuplicada = () => erros.conflito('TURMA_JA_EXISTE', 'Já existe uma turma com este nome neste ano letivo.');

export async function listarTurmas(escolaId: number, anoLetivo?: number) {
  const q = db('turmas_lanchei as t')
    .where('t.escola_id', escolaId)
    .select(
      't.id', 't.nome', 't.ano_letivo', 't.ativo',
      db.raw("(SELECT COUNT(*) FROM alunos_lanchei a WHERE a.turma_id = t.id AND a.status <> 'ENCERRADO') AS qtd_alunos"),
    )
    .orderBy([{ column: 't.ano_letivo', order: 'desc' }, { column: 't.nome' }]);
  if (anoLetivo) q.andWhere('t.ano_letivo', anoLetivo);
  const linhas = (await q) as { id: number; nome: string; ano_letivo: number; ativo: boolean; qtd_alunos: number }[];
  return linhas.map((t) => ({ id: t.id, nome: t.nome, anoLetivo: t.ano_letivo, ativo: t.ativo, qtdAlunos: Number(t.qtd_alunos) }));
}

async function turmaParaApi(escolaId: number, id: number) {
  const t = (await listarTurmas(escolaId)).find((x) => x.id === id);
  if (!t) throw erros.naoEncontrado('Turma não encontrada.');
  return t;
}

export async function criarTurma(escolaId: number, d: { nome: string; anoLetivo: number }, ator: AtorUsuario) {
  let id: number;
  try {
    id = await db.transaction(async (trx) => {
      const [id] = await trx('turmas_lanchei').insert({ escola_id: escolaId, nome: d.nome, ano_letivo: d.anoLetivo });
      await auditarUsuario(trx, ator, { escolaId, acao: 'TURMA_CRIAR', entidade: 'turmas', entidadeId: id!, depois: d });
      return id!;
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw turmaDuplicada();
    throw e;
  }
  return turmaParaApi(escolaId, id);
}

export async function editarTurma(escolaId: number, turmaId: number, d: { nome?: string | undefined; ativo?: boolean | undefined }, ator: AtorUsuario) {
  try {
    await db.transaction(async (trx) => {
      const antes = await trx('turmas_lanchei').where({ id: turmaId, escola_id: escolaId }).forUpdate().first<{ nome: string; ativo: boolean } | undefined>('nome', 'ativo');
      if (!antes) throw erros.naoEncontrado('Turma não encontrada.');

      if (d.ativo === false && antes.ativo) {
        // Desativar com alunos dentro deixaria esses alunos numa turma "fantasma".
        const comAlunos = await trx('alunos_lanchei').where({ turma_id: turmaId }).whereNot('status', 'ENCERRADO').first('id');
        if (comAlunos) throw erros.regra('TURMA_COM_ALUNOS', 'Mova os alunos para outra turma antes de desativar esta.');
      }
      const mudancas: Record<string, unknown> = {};
      if (d.nome !== undefined && d.nome !== antes.nome) mudancas.nome = d.nome;
      if (d.ativo !== undefined && d.ativo !== antes.ativo) mudancas.ativo = d.ativo;
      if (Object.keys(mudancas).length === 0) return;

      await trx('turmas_lanchei').where({ id: turmaId }).update(mudancas);
      await auditarUsuario(trx, ator, { escolaId, acao: 'TURMA_EDITAR', entidade: 'turmas', entidadeId: turmaId, antes, depois: mudancas });
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw turmaDuplicada();
    throw e;
  }
  return turmaParaApi(escolaId, turmaId);
}

/**
 * PATCH /admin/turmas/mover-alunos ("virada de ano").
 * Sem alunoIds: move TODOS os alunos (não encerrados) da turma de origem.
 */
export async function moverAlunos(escolaId: number, d: { deTurmaId: number; paraTurmaId: number; alunoIds?: number[] | undefined }, ator: AtorUsuario) {
  if (d.deTurmaId === d.paraTurmaId) throw erros.regra('MESMA_TURMA', 'A turma de destino é a mesma de origem.');
  return db.transaction(async (trx) => {
    const turmas = await trx('turmas_lanchei').where({ escola_id: escolaId }).whereIn('id', [d.deTurmaId, d.paraTurmaId]).select<{ id: number; ativo: boolean }[]>('id', 'ativo');
    const destino = turmas.find((t) => t.id === d.paraTurmaId);
    if (!turmas.some((t) => t.id === d.deTurmaId) || !destino) throw erros.naoEncontrado('Turma não encontrada.');
    if (!destino.ativo) throw erros.regra('TURMA_INATIVA', 'A turma de destino está desativada.');

    const q = trx('alunos_lanchei').where({ escola_id: escolaId, turma_id: d.deTurmaId }).whereNot('status', 'ENCERRADO');
    if (d.alunoIds) {
      // Algum id não é desta turma/escola? Recusa tudo (nada de mover pela metade).
      const encontrados = await q.clone().whereIn('id', d.alunoIds).pluck<number[]>('id');
      if (encontrados.length !== new Set(d.alunoIds).size) throw erros.naoEncontrado('Algum aluno não pertence à turma de origem.');
      q.whereIn('id', d.alunoIds);
    }
    const movidos = await q.update({ turma_id: d.paraTurmaId });
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'TURMA_MOVER_ALUNOS',
      entidade: 'turmas',
      entidadeId: d.paraTurmaId,
      depois: { deTurmaId: d.deTurmaId, paraTurmaId: d.paraTurmaId, quantidade: movidos },
    });
    return { movidos };
  });
}
