// Equipe da escola (/admin/usuarios) e o convite "crie sua senha".
//
// Cada perfil cuida da PRÓPRIA equipe (etapa6 §2):
//   ADMIN  (Cantina)   → cadastra e edita ADMIN e OPERADOR
//   ESCOLA (Diretoria) → cadastra e edita ESCOLA
// O SUPERADMIN (plataforma) usa criarUsuarioDaEscola para o primeiro ADMIN/ESCOLA.
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { hashSenha, tokenAleatorio } from '../../infra/cripto.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { link, urlPainel } from '../../config/urls.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import { criarTokenEmail, VALIDADE } from '../auth/tokensEmail.js';
import { revogarTodasSessoes } from '../auth/tokens.js';
import type { PapelPainel } from './acesso.js';

export type PapelEquipe = 'ADMIN' | 'ESCOLA' | 'OPERADOR';

/** Quais papéis cada perfil do painel pode gerenciar. */
export const PAPEIS_GERENCIAVEIS: Record<PapelPainel, PapelEquipe[]> = {
  ADMIN: ['ADMIN', 'OPERADOR'],
  ESCOLA: ['ESCOLA'],
};

/**
 * Cria o usuário e manda o convite "crie sua senha" (token REDEFINIR_SENHA de 72 h).
 * A senha inicial é aleatória e ninguém a conhece: a conta só ganha senha
 * utilizável quando a pessoa abre o link do e-mail.
 */
export async function criarUsuarioDaEscola(escolaId: number, d: { nome: string; email: string; papel: PapelEquipe }, ator: AtorUsuario) {
  const senhaInutilizavel = await hashSenha(tokenAleatorio(32));

  let r: { usuarioId: number; token: string; escolaNome: string };
  try {
    r = await db.transaction(async (trx) => {
      const escola = await trx('escolas_lanchei').where({ id: escolaId }).first<{ nome: string } | undefined>('nome');
      if (!escola) throw erros.naoEncontrado('Escola não encontrada.');

      const [usuarioId] = await trx('usuarios_lanchei').insert({ escola_id: escolaId, papel: d.papel, nome: d.nome, email: d.email, senha_hash: senhaInutilizavel });
      const token = await criarTokenEmail(trx, { tipo: 'USUARIO', id: usuarioId! }, 'REDEFINIR_SENHA', VALIDADE.CONVITE_EQUIPE);
      await auditarUsuario(trx, ator, { escolaId, acao: 'USUARIO_CRIAR', entidade: 'usuarios', entidadeId: usuarioId!, depois: { papel: d.papel } });
      return { usuarioId: usuarioId!, token, escolaNome: escola.nome };
    });
  } catch (e) {
    // E-mail da equipe é único em toda a plataforma. Só usuários logados da
    // equipe chegam aqui, então dizer que o e-mail existe não é enumeração pública.
    if (ehChaveDuplicada(e)) throw erros.conflito('EMAIL_JA_CADASTRADO', 'Já existe um usuário da equipe com este e-mail.');
    throw e;
  }

  // Depois do COMMIT.
  enviarEmailEmSegundoPlano(
    { para: d.email, ...modelos.conviteEquipe({ nome: d.nome, papel: d.papel, escola: r.escolaNome, link: link(urlPainel, '/definir-senha', { token: r.token }) }) },
    'convite-equipe',
  );
  return { id: r.usuarioId, nome: d.nome, email: d.email, papel: d.papel, ativo: true, ultimoLoginEm: null };
}

export async function listarEquipe(escolaId: number, papelAtor: PapelPainel) {
  const linhas = await db('usuarios_lanchei')
    .where({ escola_id: escolaId })
    .whereIn('papel', PAPEIS_GERENCIAVEIS[papelAtor])
    .orderBy([{ column: 'ativo', order: 'desc' }, { column: 'nome' }])
    .select<{ id: number; nome: string; email: string; papel: PapelEquipe; ativo: boolean; ultimo_login_em: Date | null }[]>(
      'id', 'nome', 'email', 'papel', 'ativo', 'ultimo_login_em',
    );
  return linhas.map((u) => ({ id: u.id, nome: u.nome, email: u.email, papel: u.papel, ativo: u.ativo, ultimoLoginEm: u.ultimo_login_em }));
}

export async function convidarParaEquipe(escolaId: number, papelAtor: PapelPainel, d: { nome: string; email: string; papel: PapelEquipe }, ator: AtorUsuario) {
  if (!PAPEIS_GERENCIAVEIS[papelAtor].includes(d.papel)) {
    throw erros.semPermissao(`Seu perfil não pode cadastrar usuários com o papel ${d.papel}.`);
  }
  return criarUsuarioDaEscola(escolaId, d, ator);
}

export async function editarMembro(
  escolaId: number,
  papelAtor: PapelPainel,
  usuarioId: number,
  d: { nome?: string | undefined; papel?: PapelEquipe | undefined; ativo?: boolean | undefined },
  ator: AtorUsuario,
) {
  const gerenciaveis = PAPEIS_GERENCIAVEIS[papelAtor];
  await db.transaction(async (trx) => {
    const antes = await trx('usuarios_lanchei')
      .where({ id: usuarioId, escola_id: escolaId })
      .forUpdate()
      .first<{ nome: string; papel: PapelEquipe; ativo: boolean } | undefined>('nome', 'papel', 'ativo');
    // Usuário de outra escola ou de outro perfil: para quem pergunta, "não existe".
    if (!antes || !gerenciaveis.includes(antes.papel)) throw erros.naoEncontrado('Usuário não encontrado.');

    if (usuarioId === ator.id && d.ativo === false) {
      throw erros.regra('NAO_PODE_DESATIVAR_A_SI_MESMO', 'Você não pode desativar o seu próprio usuário.');
    }
    if (usuarioId === ator.id && d.papel !== undefined && d.papel !== antes.papel) {
      throw erros.regra('NAO_PODE_MUDAR_PROPRIO_PAPEL', 'Você não pode mudar o seu próprio papel.');
    }
    if (d.papel !== undefined && !gerenciaveis.includes(d.papel)) {
      throw erros.semPermissao(`Seu perfil não pode atribuir o papel ${d.papel}.`);
    }

    const mudancas: Record<string, unknown> = {};
    if (d.nome !== undefined && d.nome !== antes.nome) mudancas.nome = d.nome;
    if (d.papel !== undefined && d.papel !== antes.papel) mudancas.papel = d.papel;
    if (d.ativo !== undefined && d.ativo !== antes.ativo) mudancas.ativo = d.ativo;
    if (Object.keys(mudancas).length === 0) return;

    await trx('usuarios_lanchei').where({ id: usuarioId }).update(mudancas);
    // Desativou ou mudou de papel: as sessões abertas carregam o papel antigo
    // no token; derrubamos para que o próximo login já venha com o certo.
    if (mudancas.ativo === false || mudancas.papel !== undefined) {
      await revogarTodasSessoes(trx, { tipo: 'USUARIO', id: usuarioId });
    }
    await auditarUsuario(trx, ator, { escolaId, acao: 'USUARIO_EDITAR', entidade: 'usuarios', entidadeId: usuarioId, antes, depois: mudancas });
  });
  const u = (await listarEquipe(escolaId, papelAtor)).find((x) => x.id === usuarioId);
  return u!;
}
