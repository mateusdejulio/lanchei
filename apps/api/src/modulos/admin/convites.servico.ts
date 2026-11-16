// Convites (códigos de ativação) dos responsáveis e desvínculo.
//
// Fluxo: a Diretoria informa o e-mail do responsável → geramos um código de
// 8 caracteres (só o hash vai para o banco) → o e-mail sai DEPOIS do COMMIT
// → o responsável usa o código no app (POST /me/vinculos, etapa 4D).
// O código só vale para o e-mail convidado, por 7 dias, uma vez.
import { db, type Db, type Trx } from '../../infra/db.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { link, urlAppPais } from '../../config/urls.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { formatarCodigo, gerarCodigoAtivacao, hashCodigo, VALIDADE_CONVITE_MS } from '../../dominio/codigoAtivacao.js';
import { primeiroNome } from '../../dominio/notificacoes.js';
import { erros } from '../../erros.js';
import { alunoDaEscola, exigirNaoEncerrado, nomeDaEscola } from './acesso.js';

export interface ConviteGerado {
  conviteId: number;
  alunoId: number;
  email: string;
  codigo: string; // em texto: existe só na memória, até o e-mail sair
}

/**
 * Cria convites em lote (usado pelo cadastro individual e pela importação).
 * Não envia e-mail: quem chama manda com enviarConvites() depois do COMMIT.
 */
export async function inserirConvites(
  trx: Trx,
  escolaId: number,
  usuarioId: number,
  pedidos: { alunoId: number; email: string }[],
  agora = new Date(),
): Promise<ConviteGerado[]> {
  if (pedidos.length === 0) return [];
  const comCodigo = pedidos.map((p) => ({ ...p, codigo: gerarCodigoAtivacao() }));
  // Colisão de código (2 iguais em ~852 bilhões) é tão improvável que não
  // vale um laço de nova tentativa: o UNIQUE do banco recusaria e a
  // operação inteira desfaria, sem nenhum dado inconsistente.
  for (let i = 0; i < comCodigo.length; i += 500) {
    await trx('convites_responsavel_lanchei').insert(
      comCodigo.slice(i, i + 500).map((c) => ({
        escola_id: escolaId,
        aluno_id: c.alunoId,
        email: c.email,
        codigo_hash: hashCodigo(c.codigo),
        expira_em: new Date(agora.getTime() + VALIDADE_CONVITE_MS),
        criado_por_usuario_id: usuarioId,
      })),
    );
  }
  // O INSERT em lote não devolve todos os ids: buscamos pelo hash (único).
  const ids = new Map<string, number>();
  for (let i = 0; i < comCodigo.length; i += 500) {
    const hashes = comCodigo.slice(i, i + 500).map((c) => hashCodigo(c.codigo));
    const linhas = await trx('convites_responsavel_lanchei').whereIn('codigo_hash', hashes).select<{ id: number; codigo_hash: Buffer }[]>('id', 'codigo_hash');
    for (const l of linhas) ids.set(l.codigo_hash.toString('hex'), l.id);
  }
  return comCodigo.map((c) => ({ conviteId: ids.get(hashCodigo(c.codigo).toString('hex'))!, alunoId: c.alunoId, email: c.email, codigo: c.codigo }));
}

/**
 * Manda os códigos por e-mail (em segundo plano). `enviado_em` só é gravado
 * quando o e-mail sai de verdade: se o SMTP falhar (ex.: limite diário do
 * plano gratuito), o convite aparece nas pendências como "não enviado" e a
 * secretaria usa "Reenviar".
 */
export function enviarConvites(convites: ConviteGerado[], nomesAlunos: ReadonlyMap<number, string>, escola: string) {
  for (const c of convites) {
    const primeiroNomeAluno = primeiroNome(nomesAlunos.get(c.alunoId) ?? '');
    enviarEmailEmSegundoPlano(
      {
        para: c.email,
        ...modelos.codigoAtivacao({
          primeiroNomeAluno,
          escola,
          codigo: formatarCodigo(c.codigo),
          link: link(urlAppPais, '/vincular', { codigo: c.codigo }),
        }),
      },
      'codigo-ativacao',
      () => db('convites_responsavel_lanchei').where({ id: c.conviteId }).update({ enviado_em: new Date() }),
    );
  }
}

/** Revoga convites pendentes (não usados) do mesmo aluno + e-mail: só o mais novo vale. */
async function revogarPendentes(trx: Db, alunoId: number, email: string, agora: Date) {
  await trx('convites_responsavel_lanchei')
    .where({ aluno_id: alunoId, email })
    .whereNull('usado_em')
    .whereNull('revogado_em')
    .update({ revogado_em: agora });
}

/** POST /admin/alunos/:id/convites */
export async function convidarResponsavel(escolaId: number, alunoId: number, email: string, ator: AtorUsuario) {
  const agora = new Date();
  const { convite, nomeAluno } = await db.transaction(async (trx) => {
    const aluno = await alunoDaEscola(trx, escolaId, alunoId, true);
    exigirNaoEncerrado(aluno);

    const jaVinculado = await trx('aluno_responsaveis_lanchei as ar')
      .join('responsaveis_lanchei as r', 'r.id', 'ar.responsavel_id')
      .where({ 'ar.aluno_id': alunoId, 'r.email': email })
      .whereNull('ar.desvinculado_em')
      .first('ar.responsavel_id');
    if (jaVinculado) throw erros.conflito('RESPONSAVEL_JA_VINCULADO', 'Este e-mail já está vinculado ao aluno.');

    await revogarPendentes(trx, alunoId, email, agora);
    const [convite] = await inserirConvites(trx, escolaId, ator.id, [{ alunoId, email }], agora);
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'CONVITE_CRIAR',
      entidade: 'convites_responsavel',
      entidadeId: convite!.conviteId,
      alunoId,
    });
    return { convite: convite!, nomeAluno: aluno.nome };
  });

  enviarConvites([convite], new Map([[alunoId, nomeAluno]]), await nomeDaEscola(db, escolaId));
  return conviteParaApi(convite.conviteId);
}

/** Convite da escola do token, travado. 404 se for de outra escola. */
async function conviteDaEscola(trx: Trx, escolaId: number, conviteId: number) {
  const c = await trx('convites_responsavel_lanchei')
    .where({ id: conviteId, escola_id: escolaId })
    .forUpdate()
    .first<{ id: number; aluno_id: number; email: string; usado_em: Date | null; revogado_em: Date | null } | undefined>(
      'id', 'aluno_id', 'email', 'usado_em', 'revogado_em',
    );
  if (!c) throw erros.naoEncontrado('Convite não encontrado.');
  if (c.usado_em) throw erros.conflito('CONVITE_JA_USADO', 'Este convite já foi usado: o responsável está vinculado.');
  return c;
}

/** POST /admin/convites/:id/reenviar: revoga o código anterior e manda um novo. */
export async function reenviarConvite(escolaId: number, conviteId: number, ator: AtorUsuario) {
  const agora = new Date();
  const { novo, nomeAluno } = await db.transaction(async (trx) => {
    const antigo = await conviteDaEscola(trx, escolaId, conviteId);
    const aluno = await alunoDaEscola(trx, escolaId, antigo.aluno_id);
    exigirNaoEncerrado(aluno);
    await revogarPendentes(trx, antigo.aluno_id, antigo.email, agora);
    const [novo] = await inserirConvites(trx, escolaId, ator.id, [{ alunoId: antigo.aluno_id, email: antigo.email }], agora);
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'CONVITE_REENVIAR',
      entidade: 'convites_responsavel',
      entidadeId: novo!.conviteId,
      alunoId: antigo.aluno_id,
      antes: { conviteId: antigo.id },
    });
    return { novo: novo!, nomeAluno: aluno.nome };
  });
  enviarConvites([novo], new Map([[novo.alunoId, nomeAluno]]), await nomeDaEscola(db, escolaId));
  return conviteParaApi(novo.conviteId);
}

/** POST /admin/convites/:id/revogar (repetir não dá erro). */
export async function revogarConvite(escolaId: number, conviteId: number, ator: AtorUsuario) {
  await db.transaction(async (trx) => {
    const c = await conviteDaEscola(trx, escolaId, conviteId);
    if (c.revogado_em) return;
    await trx('convites_responsavel_lanchei').where({ id: c.id }).update({ revogado_em: new Date() });
    await auditarUsuario(trx, ator, { escolaId, acao: 'CONVITE_REVOGAR', entidade: 'convites_responsavel', entidadeId: c.id, alunoId: c.aluno_id });
  });
}

/**
 * POST /admin/alunos/:id/responsaveis/:responsavelId/desvincular
 * Ex.: guarda judicial alterada. O responsável deixa de ver o aluno e é avisado por e-mail.
 */
export async function desvincularResponsavel(escolaId: number, alunoId: number, responsavelId: number, motivo: string, ator: AtorUsuario) {
  const r = await db.transaction(async (trx) => {
    const aluno = await alunoDaEscola(trx, escolaId, alunoId, true);
    const vinculo = await trx('aluno_responsaveis_lanchei as ar')
      .join('responsaveis_lanchei as r', 'r.id', 'ar.responsavel_id')
      .where({ 'ar.aluno_id': alunoId, 'ar.responsavel_id': responsavelId })
      .whereNull('ar.desvinculado_em')
      .first<{ nome: string; email: string } | undefined>('r.nome', 'r.email');
    if (!vinculo) throw erros.naoEncontrado('Vínculo não encontrado.');

    await trx('aluno_responsaveis_lanchei').where({ aluno_id: alunoId, responsavel_id: responsavelId }).update({ desvinculado_em: new Date() });
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'VINCULO_DESVINCULAR',
      entidade: 'aluno_responsaveis',
      entidadeId: responsavelId,
      alunoId,
      depois: { motivo },
    });
    return { ...vinculo, nomeAluno: aluno.nome };
  });

  enviarEmailEmSegundoPlano(
    {
      para: r.email,
      ...modelos.vinculoEncerrado({ nomeResponsavel: r.nome, primeiroNomeAluno: primeiroNome(r.nomeAluno), escola: await nomeDaEscola(db, escolaId) }),
    },
    'vinculo-encerrado',
  );
}

export function statusConvite(c: { usado_em: Date | null; revogado_em: Date | null; expira_em: Date }, agora = new Date()) {
  if (c.usado_em) return 'USADO' as const;
  if (c.revogado_em) return 'REVOGADO' as const;
  if (c.expira_em <= agora) return 'VENCIDO' as const;
  return 'PENDENTE' as const;
}

async function conviteParaApi(conviteId: number) {
  const c = await db('convites_responsavel_lanchei')
    .where({ id: conviteId })
    .first<{ id: number; email: string; expira_em: Date; enviado_em: Date | null; usado_em: Date | null; revogado_em: Date | null }>();
  return { id: c.id, email: c.email, expiraEm: c.expira_em, enviadoEm: c.enviado_em, status: statusConvite(c) };
}
