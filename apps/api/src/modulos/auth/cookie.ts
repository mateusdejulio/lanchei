// Refresh token em COOKIE para os fronts web (docs/etapa5-caixa.md §7).
//
// Por quê: no navegador, tudo que o JavaScript consegue ler, um script
// malicioso injetado (XSS) também consegue. O access token (15 min) fica só
// na memória da página; o refresh (30 dias, o valioso) vai num cookie
// HttpOnly, que o JavaScript NÃO lê: o navegador só o envia para /v1/auth.
//
// Quando: a requisição de login/refresh/logout traz o header
//   X-Cliente: web   (caixa + painel, em "/")  → cookie lanchei_rt
//   X-Cliente: pais  (app dos pais, em "/app") → cookie lanchei_rt_pais
// Dois cookies separados porque os dois apps ficam na MESMA origem: um pai
// que também é da equipe não é deslogado de um ao entrar no outro.
// Sem o header (app de loja, fase 2), o refresh continua indo no JSON.
//
// E o CSRF? Um site malicioso não consegue usar o cookie da vítima aqui:
//   - SameSite=Strict: o navegador nem envia o cookie em requisição vinda de outro site;
//   - o header X-Cliente é "não simples": de outra origem, ele exige um
//     preflight de CORS, que a API não autoriza em produção.
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { REFRESH_TTL_DIAS } from './tokens.js';

const COOKIES = { web: 'lanchei_rt', pais: 'lanchei_rt_pais' } as const;

/** Nome do cookie se a requisição pediu o modo cookie; null = modo JSON. */
export function cookieDoCliente(req: Request): string | null {
  const cliente = req.get('X-Cliente')?.trim().toLowerCase();
  return cliente && cliente in COOKIES ? COOKIES[cliente as keyof typeof COOKIES] : null;
}

const opcoes = (): CookieOptions => ({
  httpOnly: true,
  // Em dev (http://localhost) o navegador recusaria um cookie Secure.
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/v1/auth', // só as rotas de auth recebem o cookie
});

/** Lê o refresh: do cookie (modo web) ou do corpo (modo JSON). */
export function refreshDaRequisicao(req: Request): string | undefined {
  const nome = cookieDoCliente(req);
  if (nome) return (req.cookies as Record<string, string> | undefined)?.[nome];
  const doCorpo = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof doCorpo === 'string' ? doCorpo : undefined;
}

/**
 * Responde um par de tokens. No modo cookie, o refresh vai no Set-Cookie e
 * SAI do JSON (o JavaScript da página nunca o vê).
 */
export function responderComTokens<T extends { refreshToken: string }>(req: Request, res: Response, corpo: T, status = 200) {
  const nome = cookieDoCliente(req);
  if (!nome) return res.status(status).json(corpo);
  const { refreshToken, ...resto } = corpo;
  res.cookie(nome, refreshToken, { ...opcoes(), maxAge: REFRESH_TTL_DIAS * 86_400_000 });
  return res.status(status).json(resto);
}

export function limparCookie(req: Request, res: Response) {
  const nome = cookieDoCliente(req);
  if (nome) res.clearCookie(nome, opcoes());
}
