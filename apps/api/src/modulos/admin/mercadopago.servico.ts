// Conexão da conta Mercado Pago DA CANTINA (OAuth).
//
// Por que OAuth: o Pix dos pais precisa cair direto na conta da cantina (a
// plataforma só registra, não guarda dinheiro de ninguém). Com o OAuth, a
// cantina autoriza a aplicação Lanchei, e nós recebemos um token para criar
// cobranças NA CONTA DELA. Os tokens ficam criptografados (AES-256-GCM) no
// banco; a chave fica só na variável de ambiente.
//
// Fluxo:
//   1. ADMIN chama POST /admin/mercadopago/conectar → devolvemos a URL do MP
//      com um "state" assinado (JWT de 10 min com escolaId + usuarioId).
//   2. O admin faz login no MP com a conta da cantina e autoriza.
//   3. O MP redireciona o NAVEGADOR para GET /v1/mercadopago/oauth/callback
//      ?code=...&state=... (rota pública: quem chega é o navegador, sem o
//      nosso token). O state prova quem começou o fluxo e para qual escola.
//   4. Trocamos o code pelos tokens, gravamos e voltamos ao painel.
//
// O "state" é o que impede o ataque clássico do OAuth (CSRF): sem ele,
// alguém poderia montar um link de callback com o code da PRÓPRIA conta MP
// e fazer a cantina conectar a conta errada (o dinheiro dos pais iria para
// o atacante). Só um ADMIN logado consegue um state, e ele vale apenas para
// a escola do token de quem pediu.
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { criptografar } from '../../infra/cripto.js';
import { criarClienteOAuthMp, type ClienteOAuthMp } from '../../infra/mercadopago.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { ErroApi, erros } from '../../erros.js';
import { logger } from '../../infra/logger.js';

const VALIDADE_STATE_SEGUNDOS = 10 * 60;
// "audience" próprio: um state nunca é aceito como token de acesso, nem o contrário.
const AUDIENCIA_STATE = 'mp-oauth';
/** Avisar no painel quando faltar menos que isto para o token expirar. */
export const DIAS_AVISO_EXPIRACAO = 30;

export const redirectUriMp = () =>
  env.MP_REDIRECT_URI ?? `${(env.URL_PUBLICA_API ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '')}/v1/mercadopago/oauth/callback`;

let clientePadrao: ClienteOAuthMp | null | undefined;
/** Cliente real, ou null se a aplicação do MP ainda não foi configurada (MP_CLIENT_ID/SECRET). */
export function clienteOAuthPadrao(): ClienteOAuthMp | null {
  if (clientePadrao === undefined) {
    clientePadrao =
      env.MP_CLIENT_ID && env.MP_CLIENT_SECRET
        ? criarClienteOAuthMp({ clientId: env.MP_CLIENT_ID, clientSecret: env.MP_CLIENT_SECRET })
        : null;
  }
  return clientePadrao;
}

/** Só para testes: troca o cliente OAuth por um falso (undefined volta ao padrão do ambiente). */
export function usarClienteOAuth(cliente: ClienteOAuthMp | null | undefined) {
  clientePadrao = cliente;
}

const naoConfigurado = () =>
  erros.conflito('MP_NAO_CONFIGURADO', 'A integração com o Mercado Pago ainda não foi configurada na plataforma.');

export async function statusMercadoPago(escolaId: number, agora = new Date()) {
  const mp = await db('escola_mercadopago_lanchei')
    .where({ escola_id: escolaId })
    .first<{ mp_user_id: string; token_expira_em: Date; conectado_em: Date } | undefined>('mp_user_id', 'token_expira_em', 'conectado_em');
  const configurado = clienteOAuthPadrao() !== null;
  if (!mp) return { conectado: false as const, configurado };
  return {
    conectado: true as const,
    configurado,
    mpUserId: mp.mp_user_id,
    conectadoEm: mp.conectado_em,
    tokenExpiraEm: mp.token_expira_em,
    // O job diário renova sozinho; isto só fica true se a renovação estiver falhando.
    expirando: mp.token_expira_em.getTime() - agora.getTime() < DIAS_AVISO_EXPIRACAO * 86_400_000,
  };
}

/** Passo 1: URL de autorização do MP com o state assinado. */
export function urlDeConexao(escolaId: number, usuarioId: number, cliente: ClienteOAuthMp | null = clienteOAuthPadrao()) {
  if (!cliente) throw naoConfigurado();
  const state = jwt.sign({ escolaId, usuarioId }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: VALIDADE_STATE_SEGUNDOS,
    issuer: 'lanchei',
    audience: AUDIENCIA_STATE,
  });
  return { url: cliente.urlAutorizacao({ state, redirectUri: redirectUriMp() }) };
}

function lerState(state: string): { escolaId: number; usuarioId: number } {
  try {
    const p = jwt.verify(state, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'lanchei', audience: AUDIENCIA_STATE }) as {
      escolaId?: unknown;
      usuarioId?: unknown;
    };
    if (typeof p.escolaId !== 'number' || typeof p.usuarioId !== 'number') throw new Error('state incompleto');
    return { escolaId: p.escolaId, usuarioId: p.usuarioId };
  } catch {
    throw erros.regra('MP_STATE_INVALIDO', 'A autorização expirou ou é inválida. Comece de novo pelo painel.');
  }
}

/**
 * Passos 3 e 4: valida o state, troca o code pelos tokens e grava.
 * Erros saem como ErroApi com um código que a rota coloca na URL de volta ao painel.
 */
export async function concluirConexao(
  p: { code: string; state: string; ip?: string | undefined; userAgent?: string | undefined },
  cliente: ClienteOAuthMp | null = clienteOAuthPadrao(),
) {
  if (!cliente) throw naoConfigurado();
  const { escolaId, usuarioId } = lerState(p.state);

  // Entre pedir a URL e voltar do MP podem passar minutos: confere de novo
  // se quem começou ainda é ADMIN ativo desta escola.
  const admin = await db('usuarios_lanchei as u')
    .join('escolas_lanchei as e', 'e.id', 'u.escola_id')
    .where({ 'u.id': usuarioId, 'u.escola_id': escolaId, 'u.papel': 'ADMIN', 'u.ativo': true, 'e.ativo': true })
    .first('u.id');
  if (!admin) throw erros.semPermissao();

  let tokens;
  try {
    tokens = await cliente.trocarCodigo({ code: p.code, redirectUri: redirectUriMp() });
  } catch (e) {
    // Só a mensagem (que não tem token nem corpo de resposta), nunca o objeto inteiro.
    logger.error({ escolaId, motivo: (e as Error).message }, 'falha ao trocar o code do Mercado Pago');
    throw new ErroApi(502, 'GATEWAY_INDISPONIVEL', 'Não foi possível concluir a conexão com o Mercado Pago. Tente de novo.');
  }

  const ator: AtorUsuario = { id: usuarioId, ip: p.ip, userAgent: p.userAgent };
  const dados = {
    mp_user_id: tokens.mpUserId,
    access_token_enc: criptografar(tokens.accessToken),
    refresh_token_enc: criptografar(tokens.refreshToken),
    public_key: tokens.publicKey,
    token_expira_em: tokens.expiraEm,
    conectado_em: new Date(),
  };
  const contaEmUso = () =>
    erros.conflito('MP_CONTA_EM_USO', 'Esta conta do Mercado Pago já está conectada a outra escola no Lanchei.');

  try {
    await db.transaction(async (trx) => {
      // Não usamos "INSERT ... ON DUPLICATE KEY UPDATE" aqui de propósito: a
      // tabela tem DUAS chaves únicas (escola_id e mp_user_id). Se a conta MP
      // já fosse de outra escola, o MySQL atualizaria a linha DA OUTRA escola.
      const atual = await trx('escola_mercadopago_lanchei').where({ escola_id: escolaId }).forUpdate().first<{ mp_user_id: string } | undefined>('mp_user_id');
      const deOutra = await trx('escola_mercadopago_lanchei').where({ mp_user_id: tokens.mpUserId }).whereNot({ escola_id: escolaId }).first('escola_id');
      if (deOutra) throw contaEmUso();

      if (atual) await trx('escola_mercadopago_lanchei').where({ escola_id: escolaId }).update(dados);
      else await trx('escola_mercadopago_lanchei').insert({ escola_id: escolaId, ...dados });

      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'MP_CONECTAR',
        entidade: 'escola_mercadopago',
        entidadeId: escolaId,
        // Só o id da conta (não é segredo). Tokens NUNCA vão para a auditoria.
        antes: atual ? { mpUserId: atual.mp_user_id } : undefined,
        depois: { mpUserId: tokens.mpUserId },
      });
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw contaEmUso(); // duas conexões ao mesmo tempo
    throw e;
  }
  return { escolaId, mpUserId: tokens.mpUserId };
}
