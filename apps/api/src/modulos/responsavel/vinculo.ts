// O "porteiro" de TODA rota /me/filhos/:alunoId/*.
//
// O responsável só enxerga um aluno se existir um vínculo ATIVO entre os
// dois (desvinculado_em IS NULL). Sem vínculo: 404, nunca 403, para não
// confirmar que aquele id de aluno existe (etapa3 §1).
//
// Repare que a escola NÃO vem do token: responsáveis são globais (um pai
// pode ter filhos em escolas diferentes). A escola é descoberta pelo vínculo.
import type { Db } from '../../infra/db.js';
import { erros } from '../../erros.js';

export interface FilhoVinculado {
  alunoId: number;
  escolaId: number;
  contaId: number;
  nome: string;
  status: 'ATIVO' | 'INATIVO' | 'ENCERRADO';
  timezone: string;
}

export async function garantirVinculo(conn: Db, responsavelId: number, alunoId: number): Promise<FilhoVinculado> {
  const v = await conn('aluno_responsaveis_lanchei as ar')
    .join('alunos_lanchei as a', 'a.id', 'ar.aluno_id')
    .join('contas_lanchei as c', 'c.aluno_id', 'a.id')
    .join('escolas_lanchei as e', 'e.id', 'a.escola_id')
    .where({ 'ar.responsavel_id': responsavelId, 'ar.aluno_id': alunoId })
    .whereNull('ar.desvinculado_em')
    .first<{ aluno_id: number; escola_id: number; conta_id: number; nome: string; status: FilhoVinculado['status']; timezone: string } | undefined>(
      'a.id as aluno_id', 'a.escola_id', 'c.id as conta_id', 'a.nome', 'a.status', 'e.timezone',
    );
  if (!v) throw erros.naoEncontrado('Aluno não encontrado.');
  return { alunoId: v.aluno_id, escolaId: v.escola_id, contaId: v.conta_id, nome: v.nome, status: v.status, timezone: v.timezone };
}

/** Ações que mudam algo (regras, PIN, depósito...) não valem para aluno encerrado. Consultar, vale. */
export function exigirContaAberta(f: FilhoVinculado) {
  if (f.status === 'ENCERRADO') throw erros.regra('ALUNO_ENCERRADO', 'A conta deste aluno foi encerrada pela escola.');
}
