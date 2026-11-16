import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';

// Carrega .env.test ANTES de qualquer import do código (env.ts valida na importação).
if (existsSync('.env.test')) process.loadEnvFile('.env.test');
if (!process.env.DB_NAME?.endsWith('_test')) {
  throw new Error('Por segurança, DB_NAME do .env.test precisa terminar em "_test" (os testes apagam o banco).');
}

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    // Um banco só para testes; cada teste cria a PRÓPRIA escola (isolamento por tenant).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
