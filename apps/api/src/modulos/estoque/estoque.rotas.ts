// /v1/estoque: ADMIN (Cantina) e OPERADOR. Contrato: docs/etapa3-api.md §2.6.
import { Router } from 'express';
import { z } from 'zod';
import { autenticar, exigirPapel, usuarioDaEscola } from '../../middlewares/autenticacao.js';
import { zBoolQuery, zData, zId } from '../../validacao.js';
import { zLimite } from '../../paginacao.js';
import { lancarMovimento, listarEstoque, listarMovimentos } from './estoque.servico.js';

export const rotasEstoque = Router();
rotasEstoque.use(autenticar, exigirPapel('ADMIN', 'OPERADOR'));

rotasEstoque.get('/', async (req, res) => {
  const { baixo } = z.object({ baixo: zBoolQuery.default(false) }).parse(req.query);
  res.json({ itens: await listarEstoque(usuarioDaEscola(req).escolaId, baixo) });
});

rotasEstoque.post('/movimentos', async (req, res) => {
  const u = usuarioDaEscola(req);
  const corpo = z
    .object({
      produtoId: z.number().int().positive(),
      tipo: z.enum(['ENTRADA', 'PERDA', 'AJUSTE']),
      // 0 só faz sentido no AJUSTE ("contei e não tem nenhum").
      quantidade: z.number().int().min(0).max(100_000),
      motivo: z.string().trim().min(3).max(255).optional(),
    })
    .parse(req.body);
  res.status(201).json({ movimento: await lancarMovimento(u.escolaId, u.id, corpo) });
});

rotasEstoque.get('/movimentos', async (req, res) => {
  const f = z
    .object({ produtoId: zId.optional(), de: zData.optional(), ate: zData.optional(), limite: zLimite, cursor: z.string().max(200).optional() })
    .parse(req.query);
  res.json(await listarMovimentos(usuarioDaEscola(req).escolaId, f));
});
