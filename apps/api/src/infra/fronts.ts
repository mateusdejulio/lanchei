// A API também serve os dois fronts (custo zero: um serviço só no Render,
// uma origem só, sem CORS e com o cookie do refresh funcionando):
//   /      → apps/web/dist   (caixa + painel)
//   /app/  → apps/pais/dist  (app dos pais, PWA)
//
// Cache:
//   - /assets/* têm o hash do conteúdo no nome (Vite): podem ficar 1 ano em cache;
//   - index.html, sw.js e manifest NUNCA ficam em cache, senão uma
//     atualização do app demoraria dias para chegar (etapa7 §4).
// SPA: qualquer GET que não seja da API nem um arquivo existente devolve o
// index.html, e o React Router decide a tela (ex.: /painel/cantina).
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PastasFront {
  web?: string | undefined;
  pais?: string | undefined;
}

/** Pastas padrão: apps/web/dist e apps/pais/dist (funciona rodando de src/ ou de dist/). */
export const pastasPadrao = (): PastasFront => ({
  web: fileURLToPath(new URL('../../../web/dist', import.meta.url)),
  pais: fileURLToPath(new URL('../../../pais/dist', import.meta.url)),
});

function cabecalhosDeCache(res: Response, caminho: string) {
  if (/[\\/]assets[\\/]/.test(caminho)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  else res.setHeader('Cache-Control', 'no-cache');
}

/** Pedido de "página" (não de arquivo, nem da API)? Só esses recebem o index.html. */
const ehNavegacao = (req: Request) =>
  (req.method === 'GET' || req.method === 'HEAD') &&
  !req.path.startsWith('/v1/') &&
  !req.path.startsWith('/health') &&
  !/\.[a-z0-9]{1,8}$/i.test(req.path) && // /assets/x.js inexistente → 404, não o index
  req.accepts('html') === 'html';

function montar(app: Express, prefixo: '/' | '/app', pasta: string | undefined) {
  if (!pasta || !existsSync(join(pasta, 'index.html'))) return false;
  const indice = join(pasta, 'index.html');
  // redirect: false → "/app" não vira um redirecionamento para "/app/": o fallback abaixo já responde.
  app.use(prefixo, express.static(pasta, { index: false, redirect: false, setHeaders: cabecalhosDeCache }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const dentro = prefixo === '/app' ? req.path === '/app' || req.path.startsWith('/app/') : !req.path.startsWith('/app');
    if (!dentro || !ehNavegacao(req)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indice);
  });
  return true;
}

/**
 * Registrar DEPOIS das rotas da API e ANTES do 404 JSON.
 * O app dos pais vem primeiro, para que /app/* nunca caia no index do painel.
 */
export function servirFronts(app: Express, pastas: PastasFront) {
  return { pais: montar(app, '/app', pastas.pais), web: montar(app, '/', pastas.web) };
}
