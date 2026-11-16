// Envio de e-mail.
//
// Três "transportes", escolhidos pelo ambiente:
//   - produção (ou dev com SMTP_HOST): SMTP real via nodemailer;
//   - testes: caixa de saída em memória (os testes leem o link de lá);
//   - dev sem SMTP: imprime o e-mail no terminal, para você clicar no link.
//
// Os e-mails saem EM SEGUNDO PLANO (enviarEmailEmSegundoPlano):
//   1. a resposta HTTP não espera o servidor SMTP (que pode levar segundos);
//   2. o tempo de resposta fica igual exista ou não o e-mail no banco, então
//      "esqueci a senha" não serve para descobrir quem tem conta;
//   3. falha no SMTP não derruba a requisição (fica no log, sem o endereço).
// Sempre chame DEPOIS do COMMIT: se a transação desfizer, o e-mail não sai.
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface Email {
  para: string;
  assunto: string;
  texto: string;
  html: string;
}

// ---- Transporte SMTP (criado uma vez e reaproveitado, como recomenda a doc) ----
let smtp: Transporter | undefined;
function transporteSmtp(): Transporter {
  smtp ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SEGURO,
    auth: env.SMTP_USUARIO ? { user: env.SMTP_USUARIO, pass: env.SMTP_SENHA ?? '' } : undefined,
  });
  return smtp;
}

// ---- Caixa de saída dos testes ----
const caixaDeSaida: Email[] = [];
/** Só para testes: e-mails "enviados" para este endereço. */
export const emailsPara = (endereco: string) => caixaDeSaida.filter((e) => e.para === endereco.toLowerCase());

/** Envia agora e espera o resultado. Prefira enviarEmailEmSegundoPlano nas rotas. */
export async function enviarEmail(email: Email): Promise<void> {
  const msg = { ...email, para: email.para.toLowerCase() };

  if (env.NODE_ENV === 'test') {
    caixaDeSaida.push(msg);
    return;
  }
  if (!env.SMTP_HOST) {
    // Só em desenvolvimento (em produção o env.ts exige SMTP_HOST).
    // console e não logger: é para você ler o link, e o logger nunca recebe dados pessoais.
    console.log(`\n===== E-MAIL (dev, não enviado) =====\nPara: ${msg.para}\nAssunto: ${msg.assunto}\n\n${msg.texto}\n=====================================\n`);
    return;
  }
  await transporteSmtp().sendMail({
    from: env.EMAIL_REMETENTE,
    to: msg.para,
    subject: msg.assunto,
    text: msg.texto,
    html: msg.html,
  });
}

// Envios em andamento: permite aos testes esperar e ao servidor não perder
// e-mails quando o Render manda SIGTERM no meio de um deploy.
const pendentes = new Set<Promise<void>>();

export function enviarEmailEmSegundoPlano(email: Email, rotulo: string): void {
  const envio = enviarEmail(email)
    .catch((err: unknown) => {
      // Sem destinatário nem conteúdo no log: só o tipo do e-mail e o código do erro.
      const codigo = (err as { code?: string }).code ?? (err as Error).name;
      logger.error({ email: rotulo, codigo }, 'falha ao enviar e-mail');
    })
    .finally(() => pendentes.delete(envio));
  pendentes.add(envio);
}

/** Espera todos os e-mails em andamento terminarem (testes e desligamento). */
export async function aguardarEmailsPendentes(): Promise<void> {
  while (pendentes.size > 0) await Promise.all([...pendentes]);
}
