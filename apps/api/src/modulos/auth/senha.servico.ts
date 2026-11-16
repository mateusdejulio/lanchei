// "Esqueci a senha" e redefinição (também usada pela equipe para criar a
// senha no primeiro acesso: o convite é um token REDEFINIR_SENHA de 72 h).
import { db } from '../../infra/db.js';
import { hashSenha } from '../../infra/cripto.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { link, urlAppPais, urlPainel } from '../../config/urls.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { revogarTodasSessoes } from './tokens.js';
import { consumirTokenEmail, criarTokenEmail, VALIDADE } from './tokensEmail.js';
import { tokenInvalido } from './cadastro.servico.js';
import type { InfoCliente } from './tokens.js';

export type Perfil = 'EQUIPE' | 'RESPONSAVEL';

/**
 * Manda o link de redefinição, se a conta existir e estiver ativa.
 * A rota responde 202 SEMPRE (não revela quem tem conta) e o e-mail sai em
 * segundo plano, para o tempo de resposta também não revelar.
 */
export async function esqueciSenha(email: string, perfil: Perfil): Promise<void> {
  if (perfil === 'EQUIPE') {
    const u = await db('usuarios_lanchei as u')
      .leftJoin('escolas_lanchei as e', 'e.id', 'u.escola_id')
      .where({ 'u.email': email, 'u.ativo': true })
      // superadmin não tem escola; os demais precisam de escola ativa
      .andWhere((q) => q.whereNull('u.escola_id').orWhere('e.ativo', true))
      .first<{ id: number; nome: string } | undefined>('u.id', 'u.nome');
    if (!u) return;
    const token = await criarTokenEmail(db, { tipo: 'USUARIO', id: u.id }, 'REDEFINIR_SENHA', VALIDADE.REDEFINIR_SENHA);
    enviarEmailEmSegundoPlano(
      { para: email, ...modelos.redefinirSenha({ nome: u.nome, link: link(urlPainel, '/redefinir-senha', { token }) }) },
      'redefinir-senha',
    );
    return;
  }

  const r = await db('responsaveis_lanchei').where({ email, ativo: true }).first<{ id: number; nome: string } | undefined>('id', 'nome');
  if (!r) return;
  const token = await criarTokenEmail(db, { tipo: 'RESPONSAVEL', id: r.id }, 'REDEFINIR_SENHA', VALIDADE.REDEFINIR_SENHA);
  enviarEmailEmSegundoPlano(
    { para: email, ...modelos.redefinirSenha({ nome: r.nome, link: link(urlAppPais, '/redefinir-senha', { token }) }) },
    'redefinir-senha',
  );
}

/**
 * Troca a senha usando o token do e-mail. Na mesma transação:
 * consome o token, grava o hash novo, derruba TODAS as sessões (quem estava
 * logado com a senha antiga, inclusive um invasor, precisa entrar de novo)
 * e registra na auditoria.
 */
export async function redefinirSenha(token: string, novaSenha: string, cliente: InfoCliente = {}): Promise<void> {
  // argon2 é lento de propósito: calcula ANTES de abrir a transação, para não
  // segurar o lock do token enquanto isso.
  const novoHash = await hashSenha(novaSenha);

  const ok = await db.transaction(async (trx) => {
    const dono = await consumirTokenEmail(trx, token, 'REDEFINIR_SENHA');
    if (!dono) return false;

    let escolaId: number | null = null;
    if (dono.tipo === 'USUARIO') {
      const u = await trx('usuarios_lanchei').where({ id: dono.id, ativo: true }).first<{ escola_id: number | null } | undefined>('escola_id');
      if (!u) return false;
      escolaId = u.escola_id;
      await trx('usuarios_lanchei').where({ id: dono.id }).update({ senha_hash: novoHash });
    } else {
      const r = await trx('responsaveis_lanchei').where({ id: dono.id, ativo: true }).first<{ id: number } | undefined>('id');
      if (!r) return false;
      await trx('responsaveis_lanchei').where({ id: dono.id }).update({ senha_hash: novoHash });
      // Quem abriu o link recebido por e-mail provou que o e-mail é dele:
      // aproveitamos para marcá-lo como verificado (se ainda não estava).
      await trx('responsaveis_lanchei').where({ id: dono.id }).whereNull('email_verificado_em').update({ email_verificado_em: new Date() });
    }

    await revogarTodasSessoes(trx, dono);
    await registrarAuditoria(trx, {
      escolaId,
      ator: dono,
      acao: 'SENHA_REDEFINIR',
      entidade: dono.tipo === 'USUARIO' ? 'usuarios' : 'responsaveis',
      entidadeId: dono.id,
      ip: cliente.ip ?? null,
      userAgent: cliente.userAgent ?? null,
    });
    return true;
  });

  if (!ok) throw tokenInvalido();
}
