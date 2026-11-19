// Envio de Web Push (padrão W3C, chaves VAPID, gratuito). Ver docs/etapa7-app-pais.md §3.
//
// Como funciona: o navegador do responsável se inscreve num serviço de push
// (do Google, da Apple, da Mozilla...) e nos entrega uma "subscription":
// um endpoint + duas chaves. Para mandar uma notificação, a biblioteca
// web-push CRIPTOGRAFA o conteúdo com essas chaves (só aquele navegador lê)
// e assina o pedido com a nossa chave VAPID privada (o serviço sabe que fomos nós).
//
// O resto do sistema só conhece a interface EnviadorPush, então os testes
// usam um enviador falso e nenhum push de verdade sai durante os testes.
import webpush from 'web-push';
import { env } from '../config/env.js';

export interface DestinoWebPush {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** O que aparece na notificação. NUNCA nome completo nem turma: aparece na tela bloqueada. */
export interface ConteudoPush {
  titulo: string;
  corpo: string;
  /** Tela do app que abre ao tocar (o service worker usa). */
  url: string;
  notificacaoId: number;
}

/**
 * OK       = o serviço de push aceitou;
 * EXPIRADO = a inscrição não existe mais (app desinstalado, permissão retirada): desativar;
 * ERRO     = falha temporária ou desconhecida (fica registrada).
 */
export type ResultadoPush = { tipo: 'OK' } | { tipo: 'EXPIRADO' } | { tipo: 'ERRO'; detalhe: string };

export interface EnviadorPush {
  enviar(destino: DestinoWebPush, conteudo: ConteudoPush): Promise<ResultadoPush>;
}

/** Push fica 24 h esperando o celular aparecer (ligar, ter sinal); depois disso, perde o sentido. */
const TTL_SEGUNDOS = 24 * 3600;

export const pushConfigurado = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

export function criarEnviadorWebPush(): EnviadorPush {
  return {
    async enviar(destino, conteudo) {
      try {
        await webpush.sendNotification(
          { endpoint: destino.endpoint, keys: { p256dh: destino.p256dh, auth: destino.auth } },
          JSON.stringify(conteudo),
          {
            TTL: TTL_SEGUNDOS,
            urgency: 'normal',
            timeout: 10_000,
            vapidDetails: { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
          },
        );
        return { tipo: 'OK' };
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404 e 410 (RFC 8030): a inscrição foi cancelada ou expirou. Não adianta tentar de novo.
        if (status === 404 || status === 410) return { tipo: 'EXPIRADO' };
        // Só o código: a mensagem do serviço pode conter o endpoint (identifica o aparelho).
        return { tipo: 'ERRO', detalhe: status ? `HTTP ${status}` : ((e as Error).name ?? 'erro') };
      }
    },
  };
}
