// Integração com a API do Mercado Pago.
//
// ⚠️ Conferir na documentação oficial do MP antes de ir para produção:
//    - payload de criação de pagamento Pix (POST /v1/payments)
//    - formato da assinatura do webhook (x-signature)
//    - fluxo OAuth (troca de code por token e renovação)
// O resto do sistema só depende da interface ClienteMercadoPago, então
// ajustes aqui não afetam ledger nem regras.
import { createHmac } from 'node:crypto';
import { iguaisSeguro } from './cripto.js';

export type StatusPagamentoMp =
  | 'pending'
  | 'approved'
  | 'authorized'
  | 'in_process'
  | 'in_mediation'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back';

/** Pagamento já convertido para o nosso formato (centavos inteiros). */
export interface PagamentoMp {
  id: string;
  status: StatusPagamentoMp;
  externalReference: string | null;
  valorCentavos: number;
  taxaCentavos: number | null;
}

export interface NovoPix {
  accessToken: string;
  idempotencyKey: string;
  valorCentavos: number;
  descricao: string;
  emailPagador: string;
  externalReference: string;
  expiraEm: Date;
  notificationUrl?: string;
}

export interface PixCriado {
  mpPaymentId: string;
  pixCopiaCola: string;
}

export interface ClienteMercadoPago {
  buscarPagamento(accessToken: string, paymentId: string): Promise<PagamentoMp>;
  criarPix(p: NovoPix): Promise<PixCriado>;
}

const BASE = 'https://api.mercadopago.com';

/** R$ em decimal (ex.: 50.5) -> centavos inteiros (5050), sem erro de float. */
export const reaisParaCentavos = (v: number) => Math.round(v * 100);

export const clienteMercadoPago: ClienteMercadoPago = {
  async buscarPagamento(accessToken, paymentId) {
    const resp = await fetch(`${BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new Error(`MP buscarPagamento falhou: HTTP ${resp.status}`);
    const p = (await resp.json()) as {
      id: number | string;
      status: StatusPagamentoMp;
      external_reference: string | null;
      transaction_amount: number;
      fee_details?: { amount: number }[];
    };
    const taxa = p.fee_details?.reduce((s, f) => s + f.amount, 0);
    return {
      id: String(p.id),
      status: p.status,
      externalReference: p.external_reference,
      valorCentavos: reaisParaCentavos(p.transaction_amount),
      taxaCentavos: taxa === undefined ? null : reaisParaCentavos(taxa),
    };
  },

  async criarPix(n) {
    const resp = await fetch(`${BASE}/v1/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${n.accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': n.idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: n.valorCentavos / 100,
        payment_method_id: 'pix',
        description: n.descricao,
        external_reference: n.externalReference,
        date_of_expiration: n.expiraEm.toISOString(),
        notification_url: n.notificationUrl,
        payer: { email: n.emailPagador },
      }),
    });
    if (!resp.ok) throw new Error(`MP criarPix falhou: HTTP ${resp.status}`);
    const p = (await resp.json()) as {
      id: number | string;
      point_of_interaction?: { transaction_data?: { qr_code?: string } };
    };
    const copiaCola = p.point_of_interaction?.transaction_data?.qr_code;
    if (!copiaCola) throw new Error('MP criarPix: resposta sem qr_code');
    return { mpPaymentId: String(p.id), pixCopiaCola: copiaCola };
  },
};

/**
 * Valida o header x-signature do webhook ("ts=...,v1=...").
 * Manifesto assinado (HMAC-SHA256 com o segredo do painel):
 *   "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * Partes ausentes são omitidas; data.id alfanumérico vai em minúsculas.
 */
export function validarAssinaturaMp(p: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  segredo: string;
}): boolean {
  if (!p.xSignature) return false;
  const partes = Object.fromEntries(
    p.xSignature.split(',').map((par) => {
      const [k, ...v] = par.trim().split('=');
      return [k?.trim(), v.join('=').trim()];
    }),
  ) as Record<string, string | undefined>;
  const ts = partes['ts'];
  const v1 = partes['v1'];
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;

  let manifesto = '';
  if (p.dataId) manifesto += `id:${/^[a-z0-9]+$/i.test(p.dataId) ? p.dataId.toLowerCase() : p.dataId};`;
  if (p.xRequestId) manifesto += `request-id:${p.xRequestId};`;
  manifesto += `ts:${ts};`;

  const esperado = createHmac('sha256', p.segredo).update(manifesto).digest();
  return iguaisSeguro(esperado, Buffer.from(v1, 'hex'));
}

// ---------------------------------------------------------------------
// OAuth: a cantina autoriza a plataforma a agir na conta Mercado Pago DELA.
// Conferido na documentação oficial (docs/security/oauth, nov/2026):
//   - autorização: https://auth.mercadopago.com/authorization
//       ?client_id&response_type=code&platform_id=mp&state&redirect_uri
//   - o "code" devolvido vale 10 minutos e só pode ser usado uma vez;
//   - troca e renovação: POST https://api.mercadopago.com/oauth/token (JSON);
//   - o access token vale 180 dias; RENOVAR devolve também um refresh token
//     NOVO, que precisa ser guardado (o antigo deixa de valer).
// ⚠️ PKCE é opcional no MP e depende da configuração da aplicação; não usamos.
//    Se for ligado no painel do MP, é preciso enviar code_challenge/code_verifier.
// ---------------------------------------------------------------------

export interface TokensOAuthMp {
  accessToken: string;
  refreshToken: string;
  /** id do vendedor (a cantina) no MP; é ele que vem nos webhooks. */
  mpUserId: string;
  publicKey: string | null;
  expiraEm: Date;
}

export interface ClienteOAuthMp {
  urlAutorizacao(p: { state: string; redirectUri: string }): string;
  trocarCodigo(p: { code: string; redirectUri: string }): Promise<TokensOAuthMp>;
  renovar(refreshToken: string): Promise<TokensOAuthMp>;
}

export function criarClienteOAuthMp(cred: { clientId: string; clientSecret: string }): ClienteOAuthMp {
  async function pedirTokens(corpo: Record<string, string>, agora = new Date()): Promise<TokensOAuthMp> {
    const resp = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cred.clientId, client_secret: cred.clientSecret, ...corpo }),
      signal: AbortSignal.timeout(15_000),
    });
    // Nunca colocar o corpo da resposta no erro/log: ele pode conter tokens.
    if (!resp.ok) throw new Error(`MP oauth/token falhou: HTTP ${resp.status}`);
    const t = (await resp.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      user_id?: unknown;
      public_key?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof t.access_token !== 'string' ||
      typeof t.refresh_token !== 'string' ||
      (typeof t.user_id !== 'number' && typeof t.user_id !== 'string') ||
      typeof t.expires_in !== 'number'
    ) {
      // Sem refresh_token = a aplicação não tem o escopo offline_access.
      throw new Error('MP oauth/token: resposta incompleta (confira o escopo offline_access da aplicação)');
    }
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      mpUserId: String(t.user_id),
      publicKey: typeof t.public_key === 'string' ? t.public_key : null,
      expiraEm: new Date(agora.getTime() + t.expires_in * 1000),
    };
  }

  return {
    urlAutorizacao({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: cred.clientId,
        response_type: 'code',
        platform_id: 'mp',
        state,
        redirect_uri: redirectUri,
      });
      return `https://auth.mercadopago.com/authorization?${q.toString()}`;
    },
    trocarCodigo: ({ code, redirectUri }) => pedirTokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    renovar: (refreshToken) => pedirTokens({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}
