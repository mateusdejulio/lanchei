// Rate limits (em memória: suficiente com UMA instância no Render).
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

const resposta = {
  erro: { codigo: 'MUITAS_TENTATIVAS', mensagem: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
};
const ip = (req: Request) => ipKeyGenerator(req.ip ?? '');
const desligadoEmTeste = () => env.NODE_ENV === 'test';

/** Login: 5 tentativas a cada 15 min por e-mail + IP. */
export const limiteLogin = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ip(req)}:${String(req.body?.email ?? '').toLowerCase()}`,
  message: resposta,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: desligadoEmTeste,
});

/** Refresh: generoso, só contra abuso. */
export const limiteRefresh = rateLimit({
  windowMs: 60_000,
  limit: 30,
  keyGenerator: ip,
  message: resposta,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: desligadoEmTeste,
});

/** Caixa: protege contra força bruta de PIN/QR. Por usuário logado. */
export const limiteCaixa = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) => `caixa:${req.auth?.id ?? ip(req)}`,
  message: resposta,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: desligadoEmTeste,
});
