// Variáveis de ambiente validadas na inicialização.
// Se faltar algo obrigatório, a API nem sobe — melhor do que falhar
// no meio de uma venda.
import { z } from 'zod';

// No .env, "CHAVE=" (vazio) significa "não configurado".
const opcional = <T extends z.ZodType>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s.optional());

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1).default('lanchei'),
  // Certificado CA do Aiven (conteúdo PEM). Vazio = sem SSL (só em dev local).
  DB_SSL_CA: opcional(z.string()),

  // Segredo do JWT: no mínimo 32 caracteres aleatórios.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  // Chave AES-256 (64 caracteres hex) para criptografar os tokens do Mercado Pago.
  CHAVE_CRIPTOGRAFIA: z.string().regex(/^[0-9a-f]{64}$/i, 'CHAVE_CRIPTOGRAFIA deve ter 64 caracteres hex'),

  // URL pública da própria API (ex.: https://lanchei-api.onrender.com).
  // Usada pelo keep-alive e como notification_url do Mercado Pago.
  URL_PUBLICA_API: opcional(z.url()),
  // Segredo de assinatura dos webhooks (painel do Mercado Pago > Webhooks).
  MP_WEBHOOK_SECRET: opcional(z.string()),

  // Origens liberadas no CORS (painel web), separadas por vírgula.
  CORS_ORIGENS: z.string().default('http://localhost:5173'),
});

export type Env = z.infer<typeof esquema>;

const resultado = esquema.safeParse(process.env);
if (!resultado.success) {
  // Não usa o logger aqui de propósito: ele depende do env.
  console.error('Variáveis de ambiente inválidas:\n' + z.prettifyError(resultado.error));
  process.exit(1);
}

export const env: Env = resultado.data;
