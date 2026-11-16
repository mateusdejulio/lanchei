import { db } from '../../infra/db.js';
import { verificarSenha, verificarSenhaFicticia } from '../../infra/cripto.js';
import { erros } from '../../erros.js';
import { emitirSessao, type InfoCliente, type Papel } from './tokens.js';

const credenciaisInvalidas = () => erros.naoAutenticado('E-mail ou senha incorretos.');

export async function loginEquipe(email: string, senha: string, cliente: InfoCliente) {
  const u = await db('usuarios_lanchei as u')
    .leftJoin('escolas_lanchei as e', 'e.id', 'u.escola_id')
    .where('u.email', email.toLowerCase())
    .first<
      | {
          id: number;
          nome: string;
          papel: Papel;
          escola_id: number | null;
          senha_hash: string;
          ativo: boolean;
          escola_nome: string | null;
          escola_ativa: boolean | null;
        }
      | undefined
    >('u.id', 'u.nome', 'u.papel', 'u.escola_id', 'u.senha_hash', 'u.ativo', 'e.nome as escola_nome', 'e.ativo as escola_ativa');

  // Mesmo tempo de resposta exista ou não o e-mail.
  if (!u) throw (await verificarSenhaFicticia(senha), credenciaisInvalidas());
  if (!(await verificarSenha(u.senha_hash, senha))) throw credenciaisInvalidas();
  if (!u.ativo || (u.escola_id !== null && !u.escola_ativa)) throw credenciaisInvalidas();

  await db('usuarios_lanchei').where({ id: u.id }).update({ ultimo_login_em: new Date() });
  const tokens = await emitirSessao(db, { tipo: 'USUARIO', id: u.id, papel: u.papel, escolaId: u.escola_id }, cliente);
  return {
    ...tokens,
    usuario: {
      id: u.id,
      nome: u.nome,
      papel: u.papel,
      escola: u.escola_id === null ? null : { id: u.escola_id, nome: u.escola_nome },
    },
  };
}

export async function loginResponsavel(email: string, senha: string, cliente: InfoCliente) {
  const r = await db('responsaveis_lanchei')
    .where({ email: email.toLowerCase() })
    .first<
      { id: number; nome: string; senha_hash: string; ativo: boolean; email_verificado_em: Date | null } | undefined
    >('id', 'nome', 'senha_hash', 'ativo', 'email_verificado_em');

  if (!r) throw (await verificarSenhaFicticia(senha), credenciaisInvalidas());
  if (!(await verificarSenha(r.senha_hash, senha)) || !r.ativo) throw credenciaisInvalidas();

  const tokens = await emitirSessao(db, { tipo: 'RESPONSAVEL', id: r.id }, cliente);
  // Login permitido sem e-mail verificado; o VÍNCULO com o filho é que exige.
  return { ...tokens, responsavel: { id: r.id, nome: r.nome, emailVerificado: r.email_verificado_em !== null } };
}
