// Recria o banco de testes a partir do database/schema.sql uma vez por execução.
import { fileURLToPath } from 'node:url';
import { aplicarSchema } from '../src/infra/aplicarSchema.js';

export default async function setup() {
  // PULAR_SETUP_SCHEMA=1: o banco já foi criado por um admin (ex.: testar a API
  // com o usuário de privilégios mínimos do database/grants.sql).
  if (process.env.PULAR_SETUP_SCHEMA === '1') return;
  await aplicarSchema({
    host: process.env.DB_HOST!,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD ?? '',
    banco: process.env.DB_NAME!,
    recriar: true,
    caminhoSchema: fileURLToPath(new URL('../../../database/schema.sql', import.meta.url)),
  });
}
