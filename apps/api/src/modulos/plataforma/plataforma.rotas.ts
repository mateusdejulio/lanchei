// /v1/plataforma: somente SUPERADMIN. Contrato: docs/etapa3-api.md §2.3.
import { Router } from 'express';
import { z } from 'zod';
import { autenticar, exigirPapel } from '../../middlewares/autenticacao.js';
import { zEmail, zId, zNome } from '../../validacao.js';
import { criarEscola, criarUsuarioDaEscola, editarEscola, fusoValido, listarEscolas } from './plataforma.servico.js';

const novaEscola = z.object({
  nome: z.string().trim().min(2).max(150),
  // Identificador curto da escola: minúsculas, números e hífen (ex.: "cotil", "colegio-sao-jose").
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use letras minúsculas, números e hífen (ex.: colegio-sao-jose).'),
  timezone: z.string().refine(fusoValido, 'Fuso horário inválido (ex.: America/Sao_Paulo).').default('America/Sao_Paulo'),
});

const edicaoEscola = z
  .object({ nome: z.string().trim().min(2).max(150).optional(), ativo: z.boolean().optional() })
  .refine((v) => v.nome !== undefined || v.ativo !== undefined, 'Informe nome e/ou ativo.');

const novoUsuario = z.object({
  nome: zNome,
  email: zEmail,
  // OPERADOR não: quem cadastra os operadores é a própria cantina (ADMIN).
  papel: z.enum(['ADMIN', 'ESCOLA']),
});

export const rotasPlataforma = Router();
rotasPlataforma.use(autenticar, exigirPapel('SUPERADMIN'));

const ator = (req: { auth?: { id: number }; ip?: string | undefined; get(h: string): string | undefined }) => ({
  id: req.auth!.id,
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

rotasPlataforma.get('/escolas', async (_req, res) => {
  res.json({ itens: await listarEscolas() });
});

rotasPlataforma.post('/escolas', async (req, res) => {
  res.status(201).json({ escola: await criarEscola(novaEscola.parse(req.body), ator(req)) });
});

rotasPlataforma.patch('/escolas/:escolaId', async (req, res) => {
  const escolaId = zId.parse(req.params.escolaId);
  res.json({ escola: await editarEscola(escolaId, edicaoEscola.parse(req.body), ator(req)) });
});

rotasPlataforma.post('/escolas/:escolaId/usuarios', async (req, res) => {
  const escolaId = zId.parse(req.params.escolaId);
  res.status(201).json({ usuario: await criarUsuarioDaEscola(escolaId, novoUsuario.parse(req.body), ator(req)) });
});
