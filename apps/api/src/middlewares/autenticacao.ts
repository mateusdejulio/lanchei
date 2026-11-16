import type { NextFunction, Request, Response } from 'express';
import { erros } from '../erros.js';
import { verificarAccessToken, type Papel, type Sujeito } from '../modulos/auth/tokens.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: Sujeito;
  }
}

/** Exige "Authorization: Bearer <access token>" válido. */
export function autenticar(req: Request, _res: Response, next: NextFunction) {
  const [tipo, token] = (req.headers.authorization ?? '').split(' ');
  if (tipo !== 'Bearer' || !token) throw erros.naoAutenticado();
  req.auth = verificarAccessToken(token);
  next();
}

/** Só usuários da equipe com um dos papéis informados. */
export function exigirPapel(...papeis: Papel[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) throw erros.naoAutenticado();
    if (a.tipo !== 'USUARIO' || !papeis.includes(a.papel)) throw erros.semPermissao();
    next();
  };
}

export function exigirResponsavel(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) throw erros.naoAutenticado();
  if (req.auth.tipo !== 'RESPONSAVEL') throw erros.semPermissao();
  next();
}

export type PapelEscola = Exclude<Papel, 'SUPERADMIN'>;

/** Usuário da equipe COM escola (admin, escola, operador). O escolaId vem SEMPRE do token. */
export function usuarioDaEscola(req: Request) {
  const a = req.auth;
  if (!a || a.tipo !== 'USUARIO' || a.escolaId === null || a.papel === 'SUPERADMIN') throw erros.semPermissao();
  return { id: a.id, papel: a.papel as PapelEscola, escolaId: a.escolaId };
}
