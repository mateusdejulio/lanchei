// Rotas implementadas aqui: login (equipe e responsável), refresh, logout.
// A IMPLEMENTAR (ver docs/etapa4-backend.md): cadastro e verificação de
// e-mail do responsável, esqueci/redefinir senha.
import { Router } from 'express';
import { z } from 'zod';
import { loginEquipe, loginResponsavel } from './auth.servico.js';
import { revogarSessao, rotacionarRefresh } from './tokens.js';
import { limiteLogin, limiteRefresh } from '../../middlewares/limites.js';

const credenciais = z.object({ email: z.email().max(254), senha: z.string().min(1).max(200) });
const refresh = z.object({ refreshToken: z.string().min(20).max(200) });

export const rotasAuth = Router();
const cliente = (req: { ip?: string | undefined; get(h: string): string | undefined }) => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

rotasAuth.post('/equipe/login', limiteLogin, async (req, res) => {
  const { email, senha } = credenciais.parse(req.body);
  res.json(await loginEquipe(email, senha, cliente(req)));
});

rotasAuth.post('/responsavel/login', limiteLogin, async (req, res) => {
  const { email, senha } = credenciais.parse(req.body);
  res.json(await loginResponsavel(email, senha, cliente(req)));
});

rotasAuth.post('/refresh', limiteRefresh, async (req, res) => {
  const { refreshToken } = refresh.parse(req.body);
  res.json(await rotacionarRefresh(refreshToken, cliente(req)));
});

rotasAuth.post('/logout', async (req, res) => {
  const { refreshToken } = refresh.parse(req.body);
  await revogarSessao(refreshToken);
  res.status(204).end();
});
