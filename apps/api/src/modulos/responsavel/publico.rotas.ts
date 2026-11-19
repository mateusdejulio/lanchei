// Rotas públicas que o app dos pais usa antes do login:
//   GET /v1/termos/atual       → versão e link do termo de uso e privacidade
//   GET /v1/push/chave-publica → chave VAPID pública, para o navegador se inscrever no push
import { Router } from 'express';
import { env } from '../../config/env.js';
import { termoAtual } from '../../config/urls.js';
import { ErroApi } from '../../erros.js';
import { pushConfigurado } from '../../infra/push.js';

export const rotasPublicas = Router();

rotasPublicas.get('/termos/atual', (_req, res) => {
  res.json(termoAtual());
});

// A chave PÚBLICA pode ser pública mesmo: ela só permite ao navegador
// conferir que o push veio de nós. A privada fica só no servidor.
rotasPublicas.get('/push/chave-publica', (_req, res) => {
  if (!pushConfigurado()) throw new ErroApi(503, 'PUSH_NAO_CONFIGURADO', 'As notificações ainda não estão disponíveis.');
  res.json({ chave: env.VAPID_PUBLIC_KEY });
});
