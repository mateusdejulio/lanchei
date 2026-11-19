// Papéis do painel (matriz completa em docs/etapa6-painel.md §2):
//   ADMIN  = Cantina (vendas, estoque, produtos, pagamentos, saldo)
//   ESCOLA = Diretoria (alunos, turmas, carteirinhas, responsáveis)
// Cada rota declara quem pode, com um destes atalhos.
import type { Request } from 'express';
import { exigirPapel, usuarioDaEscola } from '../../middlewares/autenticacao.js';
import { erros } from '../../erros.js';
import type { Db } from '../../infra/db.js';
import type { AtorUsuario } from '../../dominio/auditoria.js';

export const soCantina = exigirPapel('ADMIN');
export const soDiretoria = exigirPapel('ESCOLA');
export const cantinaOuDiretoria = exigirPapel('ADMIN', 'ESCOLA');

export type PapelPainel = 'ADMIN' | 'ESCOLA';

/** Usuário do painel: escolaId vem SEMPRE do token. */
export function usuarioDoPainel(req: Request): AtorUsuario & { papel: PapelPainel; escolaId: number } {
  const u = usuarioDaEscola(req);
  // As rotas já passaram por exigirPapel; isto é só uma rede de segurança.
  if (u.papel !== 'ADMIN' && u.papel !== 'ESCOLA') throw erros.semPermissao();
  return { id: u.id, papel: u.papel, escolaId: u.escolaId, ip: req.ip, userAgent: req.get('user-agent') };
}

export type UsuarioPainel = ReturnType<typeof usuarioDoPainel>;

export interface AlunoBasico {
  id: number;
  nome: string;
  matricula: string;
  status: 'ATIVO' | 'INATIVO' | 'ENCERRADO';
  turma_id: number | null;
  turma_nome: string | null;
}

/**
 * Busca o aluno DA ESCOLA do token. De outra escola (ou inexistente) = 404:
 * não confirmamos que o id existe (etapa3 §1).
 * forUpdate: trava a linha do aluno até o fim da transação.
 */
export async function alunoDaEscola(conn: Db, escolaId: number, alunoId: number, forUpdate = false): Promise<AlunoBasico> {
  // O lock vai numa consulta só da tabela de alunos: com o JOIN, o
  // FOR UPDATE travaria também a linha da turma, sem necessidade.
  if (forUpdate) {
    const travado = await conn('alunos_lanchei').where({ id: alunoId, escola_id: escolaId }).forUpdate().first('id');
    if (!travado) throw erros.naoEncontrado('Aluno não encontrado.');
  }
  const a = (await conn('alunos_lanchei as a')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where({ 'a.id': alunoId, 'a.escola_id': escolaId })
    .first('a.id', 'a.nome', 'a.matricula', 'a.status', 'a.turma_id', 't.nome as turma_nome')) as AlunoBasico | undefined;
  if (!a) throw erros.naoEncontrado('Aluno não encontrado.');
  return a;
}

export function exigirNaoEncerrado(a: AlunoBasico) {
  if (a.status === 'ENCERRADO') throw erros.regra('ALUNO_ENCERRADO', 'Este aluno está encerrado; nada pode ser alterado.');
}

/** Nome da escola (para os e-mails). */
export const nomeDaEscola = async (conn: Db, escolaId: number) =>
  (await conn('escolas_lanchei').where({ id: escolaId }).first<{ nome: string }>('nome')).nome;

/** Fuso horário da escola ("hoje", períodos e relatórios são sempre no fuso dela). */
export const fusoDaEscola = async (conn: Db, escolaId: number) =>
  (await conn('escolas_lanchei').where({ id: escolaId }).first<{ timezone: string }>('timezone')).timezone;
