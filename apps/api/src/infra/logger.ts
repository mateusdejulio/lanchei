// Logger estruturado. REGRA: nunca logar dados pessoais (nome de aluno,
// e-mail, token, PIN, corpo de requisição). Só ids e códigos.
import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.senha', '*.pin', '*.token', '*.refreshToken'],
    censor: '[oculto]',
  },
});
