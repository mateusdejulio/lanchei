import { env } from './config/env.js';
import { criarApp } from './app.js';
import { db } from './infra/db.js';
import { logger } from './infra/logger.js';
import { iniciarKeepAlive } from './jobs/keepAlive.js';
import { aguardarEmailsPendentes } from './infra/email.js';
import { iniciarJobs } from './jobs/index.js';

const app = criarApp();
const servidor = app.listen(env.PORT, () => logger.info({ porta: env.PORT }, 'API Lanchei no ar'));
const pararKeepAlive = iniciarKeepAlive();
// Push, webhooks, depósitos vencidos, token do MP, reconciliação e limpeza (jobs/index.ts).
const pararJobs = iniciarJobs();

// Desligamento limpo (o Render manda SIGTERM em cada deploy).
function desligar(sinal: string) {
  logger.info({ sinal }, 'desligando...');
  pararKeepAlive?.();
  pararJobs();
  servidor.close(async () => {
    // Termina os e-mails em andamento (convites, redefinições) antes de sair.
    await aguardarEmailsPendentes();
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
