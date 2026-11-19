import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { rotaNaoEncontrada, tratarErros } from './middlewares/erros.js';
import { pastasPadrao, servirFronts, type PastasFront } from './infra/fronts.js';
import { rotasSaude } from './modulos/saude/saude.rotas.js';
import { rotasAuth } from './modulos/auth/auth.rotas.js';
import { rotasCaixa } from './modulos/caixa/caixa.rotas.js';
import { rotasWebhooks } from './modulos/webhooks/webhook.rotas.js';
import { rotasPlataforma } from './modulos/plataforma/plataforma.rotas.js';
import { rotasAdmin } from './modulos/admin/admin.rotas.js';
import { rotasCantina } from './modulos/admin/cantina.rotas.js';
import { rotasMercadoPago } from './modulos/admin/mercadopago.rotas.js';
import { rotasEstoque } from './modulos/estoque/estoque.rotas.js';
import { rotasResponsavel } from './modulos/responsavel/responsavel.rotas.js';
import { rotasPublicas } from './modulos/responsavel/publico.rotas.js';

export interface OpcoesApp {
  /** Pastas dos builds dos fronts (padrão: apps/web/dist e apps/pais/dist). Os testes passam outras. */
  fronts?: PastasFront;
}

export function criarApp(opcoes: OpcoesApp = {}) {
  const app = express();

  // Render fica atrás de um proxy: necessário para req.ip correto (rate limit).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Content-Security-Policy: o navegador só executa/carrega o que vem da
  // PRÓPRIA origem. Mesmo que alguém consiga injetar HTML (XSS), um
  // <script src="https://site-do-atacante"> é bloqueado. Exceções (etapa5 §11):
  //   - blob: nas imagens/mídia: a foto do aluno vira um objectURL na tela;
  //   - 'wasm-unsafe-eval': o leitor de QR em WebAssembly (iPad, sem BarcodeDetector).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // Em dev (http://localhost) não força HTTPS.
          upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
        },
      },
    }),
  );
  // Em produção painel, app dos pais e API são a MESMA origem: não há CORS.
  // Em dev, libera os servidores do Vite (o proxy deles também resolve, mas ajuda em testes manuais).
  if (env.NODE_ENV !== 'production') {
    app.use(cors({ origin: env.CORS_ORIGENS.split(',').map((o) => o.trim()), credentials: true }));
  }
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser()); // lê o cookie do refresh token (modo web, ver modulos/auth/cookie.ts)

  app.use(rotasSaude);
  app.use('/v1/auth', rotasAuth);
  app.use('/v1/plataforma', rotasPlataforma);
  // /v1/admin tem dois routers: Diretoria (admin.rotas) e Cantina (cantina.rotas).
  app.use('/v1/admin', rotasAdmin);
  app.use('/v1/admin', rotasCantina);
  app.use('/v1/estoque', rotasEstoque);
  app.use('/v1/mercadopago', rotasMercadoPago);
  app.use('/v1/caixa', rotasCaixa);
  app.use('/v1/me', rotasResponsavel);
  app.use('/v1', rotasPublicas); // /v1/termos/atual e /v1/push/chave-publica
  app.use('/v1/webhooks', rotasWebhooks);

  // Fronts DEPOIS da API e ANTES do 404 JSON.
  servirFronts(app, opcoes.fronts ?? pastasPadrao());

  app.use(rotaNaoEncontrada);
  app.use(tratarErros);
  return app;
}
