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

  // ---- E-mail (SMTP) ----
  // Sem SMTP_HOST: em dev o e-mail aparece no terminal; nos testes fica em memória.
  // Em produção é obrigatório (ver a checagem no fim do esquema).
  SMTP_HOST: opcional(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // "true" = TLS desde o início (porta 465). "false" = STARTTLS (porta 587).
  // (z.coerce.boolean() não serve: ele transforma a string "false" em true.)
  SMTP_SEGURO: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USUARIO: opcional(z.string()),
  SMTP_SENHA: opcional(z.string()),
  // Remetente, ex.: "Lanchei <nao-responda@exemplo.com>"
  EMAIL_REMETENTE: z.string().default('Lanchei <nao-responda@lanchei.local>'),

  // ---- Links dos e-mails ----
  // Em produção, painel e app dos pais saem da própria API (URL_PUBLICA_API e
  // URL_PUBLICA_API/app). Estas duas só existem para o desenvolvimento, em que
  // cada front roda no seu servidor do Vite.
  URL_PAINEL: opcional(z.url()),
  URL_APP_PAIS: opcional(z.url()),
}).superRefine((e, ctx) => {
  // Em produção, sem SMTP os convites e redefinições de senha sumiriam em silêncio.
  if (e.NODE_ENV === 'production' && !e.SMTP_HOST) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'obrigatório em produção' });
  }
  if (e.NODE_ENV === 'production' && !e.URL_PUBLICA_API) {
    ctx.addIssue({ code: 'custom', path: ['URL_PUBLICA_API'], message: 'obrigatório em produção (links dos e-mails)' });
  }
});

export type Env = z.infer<typeof esquema>;

const resultado = esquema.safeParse(process.env);
if (!resultado.success) {
  // Não usa o logger aqui de propósito: ele depende do env.
  console.error('Variáveis de ambiente inválidas:\n' + z.prettifyError(resultado.error));
  process.exit(1);
}

export const env: Env = resultado.data;
