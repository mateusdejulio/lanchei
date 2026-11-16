// Access token (JWT, 15 min) + refresh token (opaco, 30 dias, rotativo).
//
// Rotação com detecção de reuso: cada refresh revoga o token usado e emite
// um novo. Se alguém apresentar um refresh JÁ REVOGADO, é sinal de que ele
// vazou (o dono legítimo já trocou por outro) — então revogamos TODAS as
// sessões daquela pessoa e ela precisa logar de novo.
//
// Obs. para os clientes (web/mobile): nunca façam dois refresh em paralelo;
// enfileirem as requisições enquanto um refresh está em andamento.
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { db, type Db } from '../../infra/db.js';
import { sha256, tokenAleatorio } from '../../infra/cripto.js';
import { erros } from '../../erros.js';
import { logger } from '../../infra/logger.js';

export const ACCESS_TTL_SEGUNDOS = 15 * 60;
export const REFRESH_TTL_DIAS = 30;

/**
 * SUPERADMIN: dono da plataforma. ADMIN: administração da CANTINA.
 * ESCOLA: diretoria/secretaria. OPERADOR: atendente do caixa.
 * Matriz de permissões: docs/etapa6-painel.md §2.
 */
export type Papel = 'SUPERADMIN' | 'ADMIN' | 'ESCOLA' | 'OPERADOR';

export type Sujeito =
  | { tipo: 'USUARIO'; id: number; papel: Papel; escolaId: number | null }
  | { tipo: 'RESPONSAVEL'; id: number };

interface PayloadJwt {
  sub: string;
  tipo: 'USUARIO' | 'RESPONSAVEL';
  papel?: Papel;
  escolaId?: number | null;
}

export function gerarAccessToken(s: Sujeito): string {
  const payload: PayloadJwt =
    s.tipo === 'USUARIO'
      ? { sub: String(s.id), tipo: 'USUARIO', papel: s.papel, escolaId: s.escolaId }
      : { sub: String(s.id), tipo: 'RESPONSAVEL' };
  return jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SEGUNDOS, issuer: 'lanchei' });
}

export function verificarAccessToken(token: string): Sujeito {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'lanchei' }) as PayloadJwt;
    const id = Number(p.sub);
    if (p.tipo === 'USUARIO' && p.papel) return { tipo: 'USUARIO', id, papel: p.papel, escolaId: p.escolaId ?? null };
    if (p.tipo === 'RESPONSAVEL') return { tipo: 'RESPONSAVEL', id };
    throw erros.naoAutenticado();
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw erros.tokenExpirado();
    throw erros.naoAutenticado();
  }
}

const colunaDono = (s: Pick<Sujeito, 'tipo'>) => (s.tipo === 'USUARIO' ? 'usuario_id' : 'responsavel_id');

export interface InfoCliente {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** Cria uma sessão nova e devolve o par de tokens. */
export async function emitirSessao(conn: Db, s: Sujeito, cliente: InfoCliente = {}) {
  const refreshToken = tokenAleatorio(32);
  await conn('sessoes_lanchei').insert({
    [colunaDono(s)]: s.id,
    token_hash: sha256(refreshToken),
    expira_em: new Date(Date.now() + REFRESH_TTL_DIAS * 86_400_000),
    user_agent: cliente.userAgent?.slice(0, 255) ?? null,
    ip: cliente.ip ?? null,
  });
  return { accessToken: gerarAccessToken(s), refreshToken };
}

/** Troca um refresh token válido por um par novo. */
export async function rotacionarRefresh(refreshToken: string, cliente: InfoCliente = {}) {
  const hash = sha256(refreshToken);
  const resultado = await db.transaction(async (trx) => {
    const sessao = await trx('sessoes_lanchei').where({ token_hash: hash }).forUpdate().first<
      | { id: number; usuario_id: number | null; responsavel_id: number | null; expira_em: Date; revogada_em: Date | null }
      | undefined
    >();
    if (!sessao) return { erro: 'invalido' as const };

    if (sessao.revogada_em) {
      // REUSO: derruba todas as sessões dessa pessoa.
      const dono = sessao.usuario_id !== null ? { usuario_id: sessao.usuario_id } : { responsavel_id: sessao.responsavel_id };
      await trx('sessoes_lanchei').where(dono).whereNull('revogada_em').update({ revogada_em: new Date() });
      logger.warn({ sessaoId: sessao.id }, 'refresh token reutilizado: todas as sessões revogadas');
      return { erro: 'reuso' as const };
    }
    if (sessao.expira_em <= new Date()) return { erro: 'invalido' as const };

    const sujeito = await carregarSujeitoAtivo(trx, sessao);
    if (!sujeito) return { erro: 'invalido' as const };

    await trx('sessoes_lanchei').where({ id: sessao.id }).update({ revogada_em: new Date() });
    return { tokens: await emitirSessao(trx, sujeito, cliente) };
  });

  // Erros lançados FORA da transação para que a revogação em massa seja gravada.
  if ('erro' in resultado) throw erros.naoAutenticado('Sessão inválida. Faça login novamente.');
  return resultado.tokens;
}

export async function revogarSessao(refreshToken: string): Promise<void> {
  await db('sessoes_lanchei').where({ token_hash: sha256(refreshToken) }).whereNull('revogada_em').update({ revogada_em: new Date() });
}

export async function revogarTodasSessoes(conn: Db, s: Pick<Sujeito, 'tipo' | 'id'>): Promise<void> {
  await conn('sessoes_lanchei').where({ [colunaDono(s)]: s.id }).whereNull('revogada_em').update({ revogada_em: new Date() });
}

/** Recarrega papel/escola do banco (o papel pode ter mudado desde o login). */
async function carregarSujeitoAtivo(
  conn: Db,
  sessao: { usuario_id: number | null; responsavel_id: number | null },
): Promise<Sujeito | null> {
  if (sessao.usuario_id !== null) {
    const u = await conn('usuarios_lanchei')
      .where({ id: sessao.usuario_id, ativo: true })
      .first<{ id: number; papel: Papel; escola_id: number | null } | undefined>('id', 'papel', 'escola_id');
    return u ? { tipo: 'USUARIO', id: u.id, papel: u.papel, escolaId: u.escola_id } : null;
  }
  const r = await conn('responsaveis_lanchei')
    .where({ id: sessao.responsavel_id, ativo: true })
    .first<{ id: number } | undefined>('id');
  return r ? { tipo: 'RESPONSAVEL', id: r.id } : null;
}
