// Endereços usados nos links dos e-mails.
//
// Produção: tudo sai da mesma URL (a API serve o painel em "/" e o app dos
// pais em "/app"). Desenvolvimento: cada front roda no seu servidor do Vite
// (painel em :5173 e app dos pais em :5174/app), por isso os padrões abaixo.
import { env } from './env.js';

const semBarraFinal = (url: string) => url.replace(/\/+$/, '');

export const urlPainel = semBarraFinal(env.URL_PAINEL ?? env.URL_PUBLICA_API ?? 'http://localhost:5173');

export const urlAppPais = semBarraFinal(
  env.URL_APP_PAIS ?? (env.URL_PUBLICA_API ? `${semBarraFinal(env.URL_PUBLICA_API)}/app` : 'http://localhost:5174/app'),
);

/** Monta "base/caminho?chave=valor" com os valores codificados. */
export function link(base: string, caminho: string, params: Record<string, string> = {}): string {
  const consulta = new URLSearchParams(params).toString();
  return `${base}${caminho}${consulta ? `?${consulta}` : ''}`;
}
