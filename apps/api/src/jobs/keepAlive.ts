// Keep-alive: a própria API chama a sua URL PÚBLICA a cada 10 min.
// A requisição entra "de fora", então conta como tráfego para o Render
// (que hiberna o plano gratuito sem tráfego), e /health/db faz SELECT 1
// no MySQL (mantém o Aiven ativo).
import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';

const INTERVALO_MS = 10 * 60_000;

export function iniciarKeepAlive(): (() => void) | undefined {
  if (env.NODE_ENV !== 'production' || !env.URL_PUBLICA_API) return undefined;
  const url = new URL('/health/db', env.URL_PUBLICA_API).toString();

  const timer = setInterval(async () => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) logger.warn({ status: resp.status }, 'keep-alive: resposta não-OK');
    } catch (err) {
      logger.warn({ err }, 'keep-alive: falhou');
    }
  }, INTERVALO_MS);

  logger.info({ url }, 'keep-alive ativo (a cada 10 min)');
  return () => clearInterval(timer);
}
