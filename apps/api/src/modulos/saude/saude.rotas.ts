import { Router } from 'express';
import { db } from '../../infra/db.js';

export const rotasSaude = Router();

rotasSaude.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Alvo do keep-alive: toca no banco para o Aiven não desligar por inatividade.
rotasSaude.get('/health/db', async (_req, res) => {
  const inicio = performance.now();
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', db: 'ok', latenciaMs: Math.round(performance.now() - inicio) });
  } catch {
    res.status(503).json({ status: 'erro', db: 'indisponivel' });
  }
});
