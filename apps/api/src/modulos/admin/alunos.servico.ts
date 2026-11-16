// Alunos: cadastro, listagem com pendências, ficha e edição.
//
// LGPD / menor privilégio: a ficha muda conforme o papel.
//   ESCOLA (Diretoria): dados, saldo, regras (leitura), responsáveis, convites, carteirinha.
//   ADMIN (Cantina): dados, saldo e carteirinha. Não vê e-mails dos
//   responsáveis nem as regras definidas pelos pais (não precisa para o trabalho dela).
import { db, ehChaveDuplicada, type Trx } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { mascaraParaDias } from '../../dominio/diasPermitidos.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { link, urlPainel } from '../../config/urls.js';
import { erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { z } from 'zod';
import { alunoDaEscola, exigirNaoEncerrado, nomeDaEscola, type PapelPainel } from './acesso.js';
import { enviarConvites, inserirConvites, statusConvite, type ConviteGerado } from './convites.servico.js';

export interface NovoAluno {
  nome: string;
  matricula: string;
  turmaId: number;
  emails: string[];
}

/**
 * Insere alunos + regras (padrão: seg-sex, alerta de saldo baixo de R$ 10) +
 * conta + convites, em LOTE, dentro da transação recebida.
 * Usado pelo cadastro individual (1 aluno) e pela importação (até 2000).
 * Lote importa: no Aiven, cada consulta atravessa a rede; 2000 alunos com
 * 5 INSERTs cada, um por um, levariam minutos.
 */
export async function inserirAlunos(trx: Trx, escolaId: number, usuarioId: number, novos: NovoAluno[], agora = new Date()) {
  const LOTE = 500;
  const idPorMatricula = new Map<string, number>();

  for (let i = 0; i < novos.length; i += LOTE) {
    const lote = novos.slice(i, i + LOTE);
    await trx('alunos_lanchei').insert(lote.map((a) => ({ escola_id: escolaId, turma_id: a.turmaId, nome: a.nome, matricula: a.matricula })));
    // O INSERT em lote não devolve todos os ids; a matrícula é única por escola.
    const linhas = await trx('alunos_lanchei')
      .where({ escola_id: escolaId })
      .whereIn('matricula', lote.map((a) => a.matricula))
      .select<{ id: number; matricula: string }[]>('id', 'matricula');
    for (const l of linhas) idPorMatricula.set(l.matricula, l.id);

    const ids = lote.map((a) => idPorMatricula.get(a.matricula)!);
    await trx('regras_aluno_lanchei').insert(ids.map((id) => ({ aluno_id: id }))); // padrões do schema
    await trx('contas_lanchei').insert(ids.map((id) => ({ escola_id: escolaId, aluno_id: id })));
  }

  const pedidosConvite = novos.flatMap((a) => a.emails.map((email) => ({ alunoId: idPorMatricula.get(a.matricula)!, email })));
  const convites = await inserirConvites(trx, escolaId, usuarioId, pedidosConvite, agora);
  const nomes = new Map(novos.map((a) => [idPorMatricula.get(a.matricula)!, a.nome]));
  return { idPorMatricula, convites, nomes };
}

/** Turma da escola, ativa. Outra escola = 404 (não confirma que existe). */
export async function exigirTurmaAtiva(conn: Trx | typeof db, escolaId: number, turmaId: number) {
  const t = await conn('turmas_lanchei').where({ id: turmaId, escola_id: escolaId }).first<{ ativo: boolean } | undefined>('ativo');
  if (!t) throw erros.naoEncontrado('Turma não encontrada.');
  if (!t.ativo) throw erros.regra('TURMA_INATIVA', 'Esta turma está desativada.');
}

const matriculaDuplicada = () => erros.conflito('MATRICULA_JA_EXISTE', 'Já existe um aluno com esta matrícula na escola.');

export async function criarAluno(escolaId: number, d: NovoAluno, ator: AtorUsuario) {
  const emails = [...new Set(d.emails)];
  let resultado: { alunoId: number; convites: ConviteGerado[]; nomes: Map<number, string> };
  try {
    resultado = await db.transaction(async (trx) => {
      await exigirTurmaAtiva(trx, escolaId, d.turmaId);
      const r = await inserirAlunos(trx, escolaId, ator.id, [{ ...d, emails }]);
      const alunoId = r.idPorMatricula.get(d.matricula)!;
      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'ALUNO_CRIAR',
        entidade: 'alunos',
        entidadeId: alunoId,
        alunoId,
        depois: { nome: d.nome, matricula: d.matricula, turmaId: d.turmaId, convites: emails.length },
      });
      return { alunoId, convites: r.convites, nomes: r.nomes };
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw matriculaDuplicada();
    throw e;
  }
  // Depois do COMMIT.
  enviarConvites(resultado.convites, resultado.nomes, await nomeDaEscola(db, escolaId));
  return fichaDoAluno(escolaId, resultado.alunoId, 'ESCOLA');
}

export async function editarAluno(
  escolaId: number,
  alunoId: number,
  d: { nome?: string | undefined; matricula?: string | undefined; turmaId?: number | undefined; status?: 'ATIVO' | 'INATIVO' | undefined },
  ator: AtorUsuario,
) {
  try {
    await db.transaction(async (trx) => {
      const antes = await alunoDaEscola(trx, escolaId, alunoId, true);
      exigirNaoEncerrado(antes);
      if (d.turmaId !== undefined && d.turmaId !== antes.turma_id) await exigirTurmaAtiva(trx, escolaId, d.turmaId);

      const mudancas: Record<string, unknown> = {};
      if (d.nome !== undefined && d.nome !== antes.nome) mudancas.nome = d.nome;
      if (d.matricula !== undefined && d.matricula !== antes.matricula) mudancas.matricula = d.matricula;
      if (d.turmaId !== undefined && d.turmaId !== antes.turma_id) mudancas.turma_id = d.turmaId;
      if (d.status !== undefined && d.status !== antes.status) mudancas.status = d.status;
      if (Object.keys(mudancas).length === 0) return;

      await trx('alunos_lanchei').where({ id: alunoId }).update(mudancas);
      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'ALUNO_EDITAR',
        entidade: 'alunos',
        entidadeId: alunoId,
        alunoId,
        antes: { nome: antes.nome, matricula: antes.matricula, turmaId: antes.turma_id, status: antes.status },
        depois: mudancas,
      });
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw matriculaDuplicada();
    throw e;
  }
  return fichaDoAluno(escolaId, alunoId, 'ESCOLA');
}

// ---------------------------------------------------------------- listagem

export const PENDENCIAS = ['SEM_CARTEIRINHA', 'SEM_FOTO', 'SEM_RESPONSAVEL', 'CONVITE_VENCIDO', 'CONVITE_NAO_ENVIADO'] as const;
export type Pendencia = (typeof PENDENCIAS)[number];

export interface FiltrosAlunos {
  busca?: string | undefined;
  turmaId?: number | undefined;
  status?: 'ATIVO' | 'INATIVO' | 'ENCERRADO' | undefined;
  pendencia?: Pendencia | undefined;
  limite: number;
  cursor?: string | undefined;
}

// Subconsultas reaproveitadas pela lista e pelo resumo de pendências.
// Todas usam índices: carteirinha viva (uq_carteirinhas_viva), foto (PK),
// vínculo (PK aluno_id + responsavel_id), convites (ix_convites_aluno).
const SQL = {
  temCarteirinha: 'EXISTS (SELECT 1 FROM carteirinhas_lanchei cv WHERE cv.aluno_vivo = a.id)',
  temFoto: 'EXISTS (SELECT 1 FROM fotos_alunos_lanchei f WHERE f.aluno_id = a.id)',
  temResponsavel: 'EXISTS (SELECT 1 FROM aluno_responsaveis_lanchei ar WHERE ar.aluno_id = a.id AND ar.desvinculado_em IS NULL)',
  conviteVencido:
    'EXISTS (SELECT 1 FROM convites_responsavel_lanchei cr WHERE cr.aluno_id = a.id AND cr.usado_em IS NULL AND cr.revogado_em IS NULL AND cr.expira_em <= ?)',
  conviteNaoEnviado:
    'EXISTS (SELECT 1 FROM convites_responsavel_lanchei cr WHERE cr.aluno_id = a.id AND cr.usado_em IS NULL AND cr.revogado_em IS NULL AND cr.expira_em > ? AND cr.enviado_em IS NULL)',
};

/** Aplica o filtro de pendência (só alunos ATIVOS têm pendência). */
export function filtrarPendencia(q: ReturnType<typeof db>, p: Pendencia, agora: Date) {
  q.andWhere('a.status', 'ATIVO');
  if (p === 'SEM_CARTEIRINHA') q.whereRaw(`NOT ${SQL.temCarteirinha}`);
  if (p === 'SEM_FOTO') q.whereRaw(`NOT ${SQL.temFoto}`);
  if (p === 'SEM_RESPONSAVEL') q.whereRaw(`NOT ${SQL.temResponsavel}`);
  if (p === 'CONVITE_VENCIDO') q.whereRaw(SQL.conviteVencido, [agora]);
  if (p === 'CONVITE_NAO_ENVIADO') q.whereRaw(SQL.conviteNaoEnviado, [agora]);
  return q;
}

/** Escapa % e _ para o LIKE (senão "%" na busca casaria com tudo). */
const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const zCursorAlunos = z.tuple([z.string(), z.number().int()]);

export async function listarAlunos(escolaId: number, f: FiltrosAlunos, agora = new Date()) {
  const q = db('alunos_lanchei as a')
    .join('contas_lanchei as c', 'c.aluno_id', 'a.id')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where('a.escola_id', escolaId)
    .select(
      'a.id', 'a.nome', 'a.matricula', 'a.status', 'a.turma_id', 't.nome as turma_nome', 'c.saldo_centavos',
      db.raw(`${SQL.temFoto} AS tem_foto`),
      db.raw('(SELECT cv.status FROM carteirinhas_lanchei cv WHERE cv.aluno_vivo = a.id) AS carteirinha_status'),
      db.raw('(SELECT COUNT(*) FROM aluno_responsaveis_lanchei ar WHERE ar.aluno_id = a.id AND ar.desvinculado_em IS NULL) AS qtd_responsaveis'),
      db.raw(
        '(SELECT COUNT(*) FROM convites_responsavel_lanchei cr WHERE cr.aluno_id = a.id AND cr.usado_em IS NULL AND cr.revogado_em IS NULL AND cr.expira_em > ?) AS qtd_convites_pendentes',
        [agora],
      ),
    );

  if (f.busca) {
    const termo = f.busca.trim();
    q.andWhere((w) => w.where('a.nome', 'like', `%${escaparLike(termo)}%`).orWhere('a.matricula', termo));
  }
  if (f.turmaId) q.andWhere('a.turma_id', f.turmaId);
  if (f.status) q.andWhere('a.status', f.status);
  if (f.pendencia) filtrarPendencia(q, f.pendencia, agora);

  // Ordem alfabética estável: (nome, id). O cursor guarda os dois.
  const cursor = decodificarCursor(f.cursor, zCursorAlunos);
  if (cursor) {
    const [nome, id] = cursor;
    q.andWhere((w) => w.where('a.nome', '>', nome).orWhere((w2) => w2.where('a.nome', nome).andWhere('a.id', '>', id)));
  }
  q.orderBy([{ column: 'a.nome' }, { column: 'a.id' }]).limit(f.limite + 1);

  type Linha = {
    id: number; nome: string; matricula: string; status: string; turma_id: number | null; turma_nome: string | null;
    saldo_centavos: number; tem_foto: number; carteirinha_status: string | null; qtd_responsaveis: number; qtd_convites_pendentes: number;
  };
  const { itens, proximoCursor } = paginar((await q) as Linha[], f.limite, (u) => [u.nome, u.id]);
  return {
    itens: itens.map((a) => ({
      id: a.id,
      nome: a.nome,
      matricula: a.matricula,
      turma: a.turma_id === null ? null : { id: a.turma_id, nome: a.turma_nome },
      status: a.status,
      temFoto: Boolean(a.tem_foto),
      carteirinha: a.carteirinha_status, // ATIVA | BLOQUEADA | null (sem carteirinha viva)
      saldoCentavos: a.saldo_centavos,
      qtdResponsaveis: Number(a.qtd_responsaveis),
      qtdConvitesPendentes: Number(a.qtd_convites_pendentes),
    })),
    proximoCursor,
  };
}

/** GET /admin/pendencias: o "o que falta fazer" da secretaria (etapa6 §5.1). */
export async function resumoPendencias(escolaId: number, agora = new Date()) {
  const r = await db('alunos_lanchei as a')
    .where({ 'a.escola_id': escolaId, 'a.status': 'ATIVO' })
    .first(
      db.raw('COUNT(*) AS ativos'),
      db.raw(`SUM(NOT ${SQL.temCarteirinha}) AS sem_carteirinha`),
      db.raw(`SUM(NOT ${SQL.temFoto}) AS sem_foto`),
      db.raw(`SUM(NOT ${SQL.temResponsavel}) AS sem_responsavel`),
      db.raw(`SUM(${SQL.conviteVencido}) AS convite_vencido`, [agora]),
      db.raw(`SUM(${SQL.conviteNaoEnviado}) AS convite_nao_enviado`, [agora]),
    );
  const n = (v: unknown) => Number(v ?? 0);
  return {
    alunosAtivos: n(r.ativos),
    semCarteirinha: n(r.sem_carteirinha),
    semFoto: n(r.sem_foto),
    semResponsavel: n(r.sem_responsavel),
    convitesVencidos: n(r.convite_vencido),
    convitesNaoEnviados: n(r.convite_nao_enviado),
  };
}

// ---------------------------------------------------------------- ficha

export async function fichaDoAluno(escolaId: number, alunoId: number, papel: PapelPainel, agora = new Date()) {
  const a = await alunoDaEscola(db, escolaId, alunoId);
  const extra = await db('alunos_lanchei as a')
    .join('contas_lanchei as c', 'c.aluno_id', 'a.id')
    .where('a.id', alunoId)
    .first<{ saldo_centavos: number; encerrado_em: Date | null; created_at: Date; tem_foto: number }>(
      'c.saldo_centavos', 'a.encerrado_em', 'a.created_at', db.raw(`${SQL.temFoto} AS tem_foto`),
    );
  const cart = await db('carteirinhas_lanchei')
    .where({ aluno_vivo: alunoId })
    .first<{ id: number; status: string; emitida_em: Date } | undefined>('id', 'status', 'emitida_em');

  const base = {
    aluno: {
      id: a.id,
      nome: a.nome,
      matricula: a.matricula,
      turma: a.turma_id === null ? null : { id: a.turma_id, nome: a.turma_nome },
      status: a.status,
      temFoto: Boolean(extra.tem_foto),
      criadoEm: extra.created_at,
      encerradoEm: extra.encerrado_em,
    },
    saldoCentavos: extra.saldo_centavos,
    carteirinha: cart ? { id: cart.id, status: cart.status, emitidaEm: cart.emitida_em } : null,
  };
  if (papel === 'ADMIN') return base;

  const regras = await db('regras_aluno_lanchei as r')
    .join('alunos_lanchei as a', 'a.id', 'r.aluno_id')
    .where('r.aluno_id', alunoId)
    .first<{
      limite_diario_centavos: number | null; limite_semanal_centavos: number | null; limite_mensal_centavos: number | null;
      dias_permitidos: number; permite_sem_carteirinha: boolean; alerta_saldo_baixo_centavos: number | null; tem_pin: number;
    }>(
      'r.limite_diario_centavos', 'r.limite_semanal_centavos', 'r.limite_mensal_centavos', 'r.dias_permitidos',
      'r.permite_sem_carteirinha', 'r.alerta_saldo_baixo_centavos', db.raw('a.pin_hash IS NOT NULL AS tem_pin'),
    );
  const categorias = await db('bloqueios_categoria_lanchei as b')
    .join('categorias_lanchei as c', 'c.id', 'b.categoria_id')
    .where('b.aluno_id', alunoId)
    .select<{ id: number; nome: string }[]>('c.id', 'c.nome');
  const produtos = await db('bloqueios_produto_lanchei as b')
    .join('produtos_lanchei as p', 'p.id', 'b.produto_id')
    .where('b.aluno_id', alunoId)
    .select<{ id: number; nome: string }[]>('p.id', 'p.nome');
  const responsaveis = await db('aluno_responsaveis_lanchei as ar')
    .join('responsaveis_lanchei as r', 'r.id', 'ar.responsavel_id')
    .where('ar.aluno_id', alunoId)
    .whereNull('ar.desvinculado_em')
    .orderBy('ar.vinculado_em')
    .select<{ id: number; nome: string; email: string; vinculado_em: Date }[]>('r.id', 'r.nome', 'r.email', 'ar.vinculado_em');
  // Convites não usados e não revogados (pendentes e vencidos), o mais novo primeiro.
  const convites = await db('convites_responsavel_lanchei')
    .where({ aluno_id: alunoId })
    .whereNull('usado_em')
    .whereNull('revogado_em')
    .orderBy('id', 'desc')
    .select<{ id: number; email: string; expira_em: Date; enviado_em: Date | null; usado_em: null; revogado_em: null }[]>(
      'id', 'email', 'expira_em', 'enviado_em', 'usado_em', 'revogado_em',
    );

  return {
    ...base,
    regras: {
      limiteDiarioCentavos: regras.limite_diario_centavos,
      limiteSemanalCentavos: regras.limite_semanal_centavos,
      limiteMensalCentavos: regras.limite_mensal_centavos,
      diasPermitidos: mascaraParaDias(regras.dias_permitidos),
      alertaSaldoBaixoCentavos: regras.alerta_saldo_baixo_centavos,
      permiteSemCarteirinha: regras.permite_sem_carteirinha,
      temPin: Boolean(regras.tem_pin),
    },
    bloqueios: { categorias, produtos },
    responsaveis: responsaveis.map((r) => ({ id: r.id, nome: r.nome, email: r.email, vinculadoEm: r.vinculado_em })),
    convites: convites.map((c) => ({ id: c.id, email: c.email, expiraEm: c.expira_em, enviadoEm: c.enviado_em, status: statusConvite(c, agora) })),
  };
}

// ---------------------------------------------------------------- encerramento

/**
 * POST /admin/alunos/:id/solicitar-encerramento (Diretoria).
 * Quem encerra é a Cantina (é a conta dela que devolve o saldo): aqui só
 * avisamos os ADMIN por e-mail e deixamos o rastro na auditoria.
 */
export async function solicitarEncerramento(escolaId: number, alunoId: number, motivo: string, ator: AtorUsuario) {
  const a = await alunoDaEscola(db, escolaId, alunoId);
  exigirNaoEncerrado(a);
  const solicitante = (await db('usuarios_lanchei').where({ id: ator.id }).first<{ nome: string }>('nome')).nome;
  await auditarUsuario(db, ator, { escolaId, acao: 'ENCERRAMENTO_SOLICITAR', entidade: 'alunos', entidadeId: alunoId, alunoId, depois: { motivo } });

  const admins = await db('usuarios_lanchei').where({ escola_id: escolaId, papel: 'ADMIN', ativo: true }).pluck<string[]>('email');
  for (const email of admins) {
    enviarEmailEmSegundoPlano(
      {
        para: email,
        ...modelos.solicitacaoEncerramento({
          nomeAluno: a.nome,
          matricula: a.matricula,
          motivo,
          solicitante,
          link: link(urlPainel, `/painel/cantina/alunos/${alunoId}`),
        }),
      },
      'solicitacao-encerramento',
    );
  }
  return { adminsAvisados: admins.length };
}
