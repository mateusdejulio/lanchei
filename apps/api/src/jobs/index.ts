// Liga todos os jobs em segundo plano (etapa3 §3, etapa4 §4.8).
// Chamado só pelo server.ts: nos testes, cada job é chamado diretamente.
import { logger } from '../infra/logger.js';
import { criarEnviadorWebPush, pushConfigurado } from '../infra/push.js';
import { clienteMercadoPago } from '../infra/mercadopago.js';
import { clienteOAuthPadrao } from '../modulos/admin/mercadopago.servico.js';
import { agendar } from './agendador.js';
import { enviarPushPendentes } from './push.job.js';
import { renovarTokensMp, reprocessarWebhooks, sincronizarDepositosVencidos } from './mercadopago.jobs.js';
import { limpar, reconciliar } from './manutencao.jobs.js';

const SEG = 1000;
const MIN = 60 * SEG;
const DIA = 24 * 60 * MIN;

export function iniciarJobs(): () => void {
  const paradas: (() => void)[] = [];

  if (pushConfigurado()) {
    const enviador = criarEnviadorWebPush();
    paradas.push(agendar({ nome: 'push', intervaloMs: 15 * SEG, atrasoInicialMs: 10 * SEG, tarefa: () => enviarPushPendentes(enviador) }));
  } else {
    // As notificações continuam na caixa de entrada do app; só não "tocam" no celular.
    logger.warn('push desligado: configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VAPID_SUBJECT');
  }

  paradas.push(
    agendar({ nome: 'webhooks', intervaloMs: MIN, atrasoInicialMs: 30 * SEG, tarefa: () => reprocessarWebhooks(clienteMercadoPago) }),
    agendar({ nome: 'depositos-vencidos', intervaloMs: 5 * MIN, atrasoInicialMs: MIN, tarefa: () => sincronizarDepositosVencidos(clienteMercadoPago) }),
    // Diários: o Render reinicia o serviço a cada deploy, então eles também
    // rodam alguns minutos depois de cada subida. Todos são idempotentes.
    agendar({ nome: 'renovar-token-mp', intervaloMs: DIA, atrasoInicialMs: 2 * MIN, tarefa: () => renovarTokensMp(clienteOAuthPadrao()) }),
    agendar({ nome: 'reconciliacao', intervaloMs: DIA, atrasoInicialMs: 3 * MIN, tarefa: () => reconciliar() }),
    agendar({ nome: 'limpeza', intervaloMs: DIA, atrasoInicialMs: 4 * MIN, tarefa: () => limpar() }),
  );

  logger.info({ jobs: paradas.length }, 'jobs em segundo plano iniciados');
  return () => paradas.forEach((parar) => parar());
}
