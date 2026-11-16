import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ErroApi } from '../erros.js';
import { logger } from '../infra/logger.js';

export function rotaNaoEncontrada(_req: Request, res: Response) {
  res.status(404).json({ erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Rota não encontrada.' } });
}

// Express 5 encaminha erros de funções async para cá automaticamente.
export function tratarErros(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ErroApi) {
    res.status(err.status).json({
      erro: { codigo: err.codigo, mensagem: err.message, ...(err.detalhes !== undefined ? { detalhes: err.detalhes } : {}) },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      erro: {
        codigo: 'VALIDACAO',
        mensagem: 'Dados inválidos.',
        detalhes: { campos: err.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })) },
      },
    });
    return;
  }
  // JSON malformado no body
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ erro: { codigo: 'VALIDACAO', mensagem: 'JSON inválido.' } });
    return;
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ erro: { codigo: 'MUITO_GRANDE', mensagem: 'Requisição grande demais.' } });
    return;
  }

  // Erro inesperado: loga (sem body!) e responde genérico.
  logger.error({ err, metodo: req.method, rota: req.route?.path ?? req.path }, 'erro não tratado');
  res.status(500).json({ erro: { codigo: 'ERRO_INTERNO', mensagem: 'Erro interno. Tente novamente.' } });
}
