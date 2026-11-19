import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { rotaNaoEncontrada, tratarErros } from './middlewares/erros.js';
import { rotasSaude } from './modulos/saude/saude.rotas.js';
import { rotasAuth } from './modulos/auth/auth.rotas.js';
import { rotasCaixa } from './modulos/caixa/caixa.rotas.js';
import { rotasWebhooks } from './modulos/webhooks/webhook.rotas.js';
import { rotasPlataforma } from './modulos/plataforma/plataforma.rotas.js';
import { rotasAdmin } from './modulos/admin/admin.rotas.js';
import { rotasCantina } from './modulos/admin/cantina.rotas.js';
import { rotasMercadoPago } from './modulos/admin/mercadopago.rotas.js';
import { rotasEstoque } from './modulos/estoque/estoque.rotas.js';

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
  app.use('/v1/plataforma', rotasPlataforma);
  // /v1/admin tem dois routers: Diretoria (admin.rotas) e Cantina (cantina.rotas).
  app.use('/v1/admin', rotasAdmin);
  app.use('/v1/admin', rotasCantina);
  app.use('/v1/estoque', rotasEstoque);
  app.use('/v1/mercadopago', rotasMercadoPago);
  app.use('/v1/caixa', rotasCaixa);
  app.use('/v1/webhooks', rotasWebhooks);
  // A IMPLEMENTAR (4D): /v1/me, /v1/termos, /v1/push e o restante de /v1/caixa

  app.use(rotaNaoEncontrada);
  app.use(tratarErros);
  return app;
}
