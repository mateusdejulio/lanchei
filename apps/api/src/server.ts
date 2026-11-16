import { env } from './config/env.js';
import { criarApp } from './app.js';
import { db } from './infra/db.js';
import { logger } from './infra/logger.js';
import { iniciarKeepAlive } from './jobs/keepAlive.js';
import { aguardarEmailsPendentes } from './infra/email.js';

const app = criarApp();
const servidor = app.listen(env.PORT, () => logger.info({ porta: env.PORT }, 'API Lanchei no ar'));
const pararKeepAlive = iniciarKeepAlive();
// A IMPLEMENTAR: jobs de push, reprocessar webhooks, depósitos pendentes,
// renovar token MP, reconciliação, limpeza (ver docs/etapa4-backend.md).

// Desligamento limpo (o Render manda SIGTERM em cada deploy).
function desligar(sinal: string) {
  logger.info({ sinal }, 'desligando...');
  pararKeepAlive?.();
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
