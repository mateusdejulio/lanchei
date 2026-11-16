// Tokens enviados por e-mail (tabela tokens_email_lanchei):
//   VERIFICAR_EMAIL : confirma o e-mail do responsável (24 h)
//   REDEFINIR_SENHA : "esqueci a senha" (1 h) e "crie sua senha" da equipe (72 h)
//
// Mesmo padrão do refresh token: o e-mail leva o token, o banco guarda só o
// SHA-256. Quem ler o banco (backup vazado, por exemplo) não consegue usar os links.
//
// Regras:
//   - um token só vale UMA vez (usado_em);
//   - gerar um token novo invalida os anteriores do mesmo tipo e da mesma
//     pessoa, então só o link do e-mail mais recente funciona;
//   - a API não tem DELETE nesta tabela (grants.sql), então "invalidar" é
//     preencher usado_em; a limpeza dos vencidos é do job diário.
import type { Db, Trx } from '../../infra/db.js';
import { sha256, tokenAleatorio } from '../../infra/cripto.js';

export type TipoTokenEmail = 'VERIFICAR_EMAIL' | 'REDEFINIR_SENHA';
export type DonoToken = { tipo: 'USUARIO'; id: number } | { tipo: 'RESPONSAVEL'; id: number };

export const VALIDADE = {
  VERIFICAR_EMAIL: 24 * 3_600_000,
  REDEFINIR_SENHA: 3_600_000,
  CONVITE_EQUIPE: 72 * 3_600_000,
} as const;

const colunaDono = (d: DonoToken) => (d.tipo === 'USUARIO' ? 'usuario_id' : 'responsavel_id');

/** Cria um token novo (invalidando os anteriores do mesmo tipo) e devolve o token em texto. */
export async function criarTokenEmail(
  conn: Db,
  dono: DonoToken,
  tipo: TipoTokenEmail,
  validadeMs: number,
  agora = new Date(),
): Promise<string> {
  await conn('tokens_email_lanchei')
    .where({ [colunaDono(dono)]: dono.id, tipo })
    .whereNull('usado_em')
    .update({ usado_em: agora });

  const token = tokenAleatorio(32); // 256 bits: impossível de adivinhar
  await conn('tokens_email_lanchei').insert({
    [colunaDono(dono)]: dono.id,
    tipo,
    token_hash: sha256(token),
    expira_em: new Date(agora.getTime() + validadeMs),
  });
  return token;
}

/**
 * Valida e CONSOME o token dentro da transação recebida.
 * Devolve o dono, ou null se o token não existe, já foi usado, venceu ou é de outro tipo.
 *
 * O FOR UPDATE trava a linha: se o mesmo link for aberto duas vezes ao mesmo
 * tempo (clique duplo), a segunda requisição espera a primeira e encontra o
 * token já usado.
 */
export async function consumirTokenEmail(trx: Trx, token: string, tipo: TipoTokenEmail, agora = new Date()): Promise<DonoToken | null> {
  const t = await trx('tokens_email_lanchei')
    .where({ token_hash: sha256(token), tipo })
    .forUpdate()
    .first<{ id: number; usuario_id: number | null; responsavel_id: number | null; expira_em: Date; usado_em: Date | null } | undefined>();

  if (!t || t.usado_em !== null || t.expira_em <= agora) return null;

  await trx('tokens_email_lanchei').where({ id: t.id }).update({ usado_em: agora });
  return t.usuario_id !== null ? { tipo: 'USUARIO', id: t.usuario_id } : { tipo: 'RESPONSAVEL', id: t.responsavel_id! };
}
