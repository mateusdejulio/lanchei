// GET /v1/mercadopago/oauth/callback: para onde o Mercado Pago manda o
// NAVEGADOR do admin depois que ele autoriza (ou recusa) a conexão.
//
// A rota é pública (o navegador chega aqui vindo do site do MP, sem o nosso
// token de acesso). A segurança está no "state" assinado: ver
// mercadopago.servico.ts. A resposta é sempre um REDIRECT de volta ao
// painel, com ?mp=conectado ou ?mp=erro&motivo=CODIGO (nunca JSON: quem lê
// é uma pessoa no navegador, e o painel mostra a mensagem certa pelo código).
import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { link, urlPainel } from '../../config/urls.js';
import { ErroApi } from '../../erros.js';
import { logger } from '../../infra/logger.js';
import { concluirConexao } from './mercadopago.servico.js';

const TELA_CONFIGURACOES = '/painel/cantina/configuracoes';

const limite = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  keyGenerator: (req) => `mp-callback:${ipKeyGenerator(req.ip ?? '')}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
});

export const rotasMercadoPago = Router();

rotasMercadoPago.get('/oauth/callback', limite, async (req, res) => {
  const voltar = (params: Record<string, string>) => res.redirect(303, link(urlPainel, TELA_CONFIGURACOES, params));

  const q = z
    .object({ code: z.string().min(1).max(500).optional(), state: z.string().min(1).max(2000).optional(), error: z.string().max(100).optional() })
    .safeParse(req.query);
  if (!q.success) return voltar({ mp: 'erro', motivo: 'RESPOSTA_INVALIDA' });
  // O admin clicou em "cancelar" na tela do Mercado Pago.
  if (q.data.error || !q.data.code || !q.data.state) return voltar({ mp: 'erro', motivo: q.data.error ? 'AUTORIZACAO_NEGADA' : 'RESPOSTA_INVALIDA' });

  try {
    await concluirConexao({ code: q.data.code, state: q.data.state, ip: req.ip, userAgent: req.get('user-agent') });
    return voltar({ mp: 'conectado' });
  } catch (e) {
    if (e instanceof ErroApi) return voltar({ mp: 'erro', motivo: e.codigo });
    logger.error({ err: e }, 'erro inesperado no callback do Mercado Pago');
    return voltar({ mp: 'erro', motivo: 'ERRO_INTERNO' });
  }
});
