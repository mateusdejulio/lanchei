// Uso: npm run db:schema                  (cria o banco se não existir)
//      npm run db:schema -- --recriar         (APAGA e recria: só em dev!)
//      npm run db:schema -- --sem-triggers    (se o provedor recusar triggers;
//                                              aí o grants.sql é OBRIGATÓRIO)
import { fileURLToPath } from 'node:url';
import { aplicarSchema } from '../src/infra/aplicarSchema.js';
import { env } from '../src/config/env.js';

const recriar = process.argv.includes('--recriar');
const semTriggers = process.argv.includes('--sem-triggers');
if (recriar && env.NODE_ENV === 'production') {
  console.error('--recriar é proibido em produção.');
  process.exit(1);
}

const total = await aplicarSchema({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  ssl: env.DB_SSL_CA ? { ca: env.DB_SSL_CA } : undefined,
  banco: env.DB_NAME,
  recriar,
  semTriggers,
  caminhoSchema: fileURLToPath(new URL('../../../database/schema.sql', import.meta.url)),
});
console.log(`Schema aplicado no banco "${env.DB_NAME}": ${total} comandos.`);
if (semTriggers) console.warn('ATENÇÃO: triggers NÃO criados. Aplique database/grants.sql e use o usuário lanchei_api na API.');
