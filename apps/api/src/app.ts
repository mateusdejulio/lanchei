import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { rotaNaoEncontrada, tratarErros } from './middlewares/erros.js';
import { rotasSaude } from './modulos/saude/saude.rotas.js';
import { rotasAuth } from './modulos/auth/auth.rotas.js';
import { rotasCaixa } from './modulos/caixa/caixa.rotas.js';
import { rotasWebhooks } from './modulos/webhooks/webhook.rotas.js';

export function criarApp() {
  const app = express();

  // Render fica atrás de um proxy: necessário para req.ip correto (rate limit).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGENS.split(',').map((o) => o.trim()), credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.use(rotasSaude);
  app.use('/v1/auth', rotasAuth);
  app.use('/v1/caixa', rotasCaixa);
  app.use('/v1/webhooks', rotasWebhooks);
  // A IMPLEMENTAR: /v1/plataforma, /v1/admin, /v1/estoque, /v1/me,
  // /v1/termos, /v1/mercadopago/oauth/callback (ver docs/etapa4-backend.md)

  app.use(rotaNaoEncontrada);
  app.use(tratarErros);
  return app;
}
