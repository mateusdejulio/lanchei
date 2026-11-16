// /v1/admin: painel da Cantina (ADMIN) e da Diretoria (ESCOLA).
//
// Quem pode o quê está na MATRIZ de docs/etapa6-painel.md §2, e cada rota
// declara isso com soCantina / soDiretoria / cantinaOuDiretoria. Os testes
// em tests/permissoes.test.ts conferem a matriz rota a rota.
//
// Ordem importa no Express: rotas fixas (/alunos/importar/modelo,
// /turmas/mover-alunos) vêm ANTES das rotas com parâmetro (/alunos/:id),
// senão "importar" seria lido como um :id.
import { Router } from 'express';
import { z } from 'zod';
import { autenticar } from '../../middlewares/autenticacao.js';
import { uploadCsv, uploadFoto } from '../../middlewares/upload.js';
import { responderFoto } from '../../infra/fotos.js';
import { zEmail, zId, zNome } from '../../validacao.js';
import { zLimite } from '../../paginacao.js';
import { cantinaOuDiretoria, soDiretoria, usuarioDoPainel } from './acesso.js';
import { criarAluno, editarAluno, fichaDoAluno, listarAlunos, PENDENCIAS, resumoPendencias, solicitarEncerramento } from './alunos.servico.js';
import { importarAlunos, modeloCsv, simularImportacao } from './importacao.servico.js';
import { convidarResponsavel, desvincularResponsavel, reenviarConvite, revogarConvite } from './convites.servico.js';
import { desbloquearCarteirinha, emitirCarteirinha, emitirCarteirinhasDaTurma } from './carteirinhas.servico.js';
import { lerFotoAuditada, salvarFoto } from './fotos.servico.js';
import { extratoCsv, extratoDoAluno, TIPOS_EXTRATO } from './extrato.servico.js';
import { criarTurma, editarTurma, listarTurmas, moverAlunos } from './turmas.servico.js';
import { dadosDaEscola, editarDadosDaEscola } from './escola.servico.js';
import { convidarParaEquipe, editarMembro, listarEquipe } from './equipe.servico.js';
import { fusoValido } from '../plataforma/plataforma.servico.js';

export const rotasAdmin = Router();
rotasAdmin.use(autenticar);

// ------------------------------------------------------------ validação
const zMatricula = z.string().trim().min(1).max(40);
const zNomeTurma = z.string().trim().min(1).max(60);
const zAnoLetivo = z.coerce.number().int().min(2000).max(2100);
const zMotivo = z.string().trim().min(3).max(255);
const zData = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD.');
const zBool = z.enum(['true', 'false']).transform((v) => v === 'true');

const filtrosExtrato = z.object({ de: zData.optional(), ate: zData.optional(), tipo: z.enum(TIPOS_EXTRATO).optional() });

// ------------------------------------------------------------ escola
rotasAdmin.get('/escola', cantinaOuDiretoria, async (req, res) => {
  res.json({ escola: await dadosDaEscola(usuarioDoPainel(req).escolaId) });
});

rotasAdmin.patch('/escola', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      nome: z.string().trim().min(2).max(150).optional(),
      timezone: z.string().refine(fusoValido, 'Fuso horário inválido (ex.: America/Sao_Paulo).').optional(),
      // R$ 1,00 a R$ 5.000,00: limites de sanidade (o padrão é R$ 25 a R$ 500).
      depositoMinCentavos: z.number().int().min(100).max(500_000).optional(),
      depositoMaxCentavos: z.number().int().min(100).max(500_000).optional(),
    })
    .strict()
    .parse(req.body);
  res.json({ escola: await editarDadosDaEscola(u.escolaId, u.papel, corpo, u) });
});

// ------------------------------------------------------------ equipe
rotasAdmin.get('/usuarios', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  res.json({ itens: await listarEquipe(u.escolaId, u.papel) });
});

rotasAdmin.post('/usuarios', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z.object({ nome: zNome, email: zEmail, papel: z.enum(['ADMIN', 'ESCOLA', 'OPERADOR']) }).parse(req.body);
  res.status(201).json({ usuario: await convidarParaEquipe(u.escolaId, u.papel, corpo, u) });
});

rotasAdmin.patch('/usuarios/:id', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({ nome: zNome.optional(), papel: z.enum(['ADMIN', 'ESCOLA', 'OPERADOR']).optional(), ativo: z.boolean().optional() })
    .parse(req.body);
  res.json({ usuario: await editarMembro(u.escolaId, u.papel, zId.parse(req.params.id), corpo, u) });
});

// ------------------------------------------------------------ turmas
// Listar: as duas áreas (a Cantina filtra alunos por turma).
rotasAdmin.get('/turmas', cantinaOuDiretoria, async (req, res) => {
  const { anoLetivo } = z.object({ anoLetivo: zAnoLetivo.optional() }).parse(req.query);
  res.json({ itens: await listarTurmas(usuarioDoPainel(req).escolaId, anoLetivo) });
});

rotasAdmin.post('/turmas', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z.object({ nome: zNomeTurma, anoLetivo: zAnoLetivo }).parse(req.body);
  res.status(201).json({ turma: await criarTurma(u.escolaId, corpo, u) });
});

rotasAdmin.patch('/turmas/mover-alunos', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({ deTurmaId: zId, paraTurmaId: zId, alunoIds: z.array(zId).min(1).max(2000).optional() })
    .parse(req.body);
  res.json(await moverAlunos(u.escolaId, corpo, u));
});

rotasAdmin.patch('/turmas/:id', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({ nome: zNomeTurma.optional(), ativo: z.boolean().optional() })
    .refine((v) => v.nome !== undefined || v.ativo !== undefined, 'Informe nome e/ou ativo.')
    .parse(req.body);
  res.json({ turma: await editarTurma(u.escolaId, zId.parse(req.params.id), corpo, u) });
});

rotasAdmin.post('/turmas/:id/carteirinhas', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  res.status(201).json(await emitirCarteirinhasDaTurma(u.escolaId, zId.parse(req.params.id), u));
});

// ------------------------------------------------------------ pendências
rotasAdmin.get('/pendencias', soDiretoria, async (req, res) => {
  res.json(await resumoPendencias(usuarioDoPainel(req).escolaId));
});

// ------------------------------------------------------------ alunos (rotas fixas primeiro)
rotasAdmin.get('/alunos/importar/modelo', soDiretoria, (_req, res) => {
  res
    .set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="modelo-alunos-lanchei.csv"' })
    .send(modeloCsv());
});

rotasAdmin.post('/alunos/importar', soDiretoria, uploadCsv, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { simular } = z.object({ simular: zBool.default(false) }).parse(req.query);
  if (simular) {
    res.json(await simularImportacao(u.escolaId, req.file!.buffer));
    return;
  }
  res.status(201).json(await importarAlunos(u.escolaId, req.file!.buffer, u));
});

rotasAdmin.get('/alunos', cantinaOuDiretoria, async (req, res) => {
  const f = z
    .object({
      busca: z.string().trim().min(1).max(100).optional(),
      turmaId: zId.optional(),
      status: z.enum(['ATIVO', 'INATIVO', 'ENCERRADO']).optional(),
      pendencia: z.enum(PENDENCIAS).optional(),
      limite: zLimite,
      cursor: z.string().max(500).optional(),
    })
    .parse(req.query);
  res.json(await listarAlunos(usuarioDoPainel(req).escolaId, f));
});

rotasAdmin.post('/alunos', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      nome: zNome,
      matricula: zMatricula,
      turmaId: zId,
      // Até 2 responsáveis (etapa6 §5.2). Repetições contam uma vez só: tira primeiro, limita depois.
      emailsResponsaveis: z
        .array(zEmail)
        .max(10)
        .default([])
        .transform((lista) => [...new Set(lista)])
        .pipe(z.array(z.string()).max(2, 'No máximo 2 e-mails de responsáveis.')),
    })
    .parse(req.body);
  res.status(201).json(await criarAluno(u.escolaId, { nome: corpo.nome, matricula: corpo.matricula, turmaId: corpo.turmaId, emails: corpo.emailsResponsaveis }, u));
});

rotasAdmin.get('/alunos/:id', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  res.json(await fichaDoAluno(u.escolaId, zId.parse(req.params.id), u.papel));
});

rotasAdmin.patch('/alunos/:id', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      nome: zNome.optional(),
      matricula: zMatricula.optional(),
      turmaId: zId.optional(),
      // ENCERRADO não: o encerramento tem fluxo próprio (com reembolso), na Cantina.
      status: z.enum(['ATIVO', 'INATIVO']).optional(),
    })
    .parse(req.body);
  res.json(await editarAluno(u.escolaId, zId.parse(req.params.id), corpo, u));
});

rotasAdmin.put('/alunos/:id/foto', soDiretoria, uploadFoto, async (req, res) => {
  const u = usuarioDoPainel(req);
  await salvarFoto(u.escolaId, zId.parse(req.params.id), req.file!.buffer, u);
  res.status(204).end();
});

rotasAdmin.get('/alunos/:id/foto', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const foto = await lerFotoAuditada(u.escolaId, zId.parse(req.params.id), { tipo: 'USUARIO', id: u.id }, u);
  responderFoto(res, foto);
});

rotasAdmin.get('/alunos/:id/extrato', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const f = filtrosExtrato.extend({ limite: zLimite, cursor: z.string().max(500).optional() }).parse(req.query);
  res.json(await extratoDoAluno(u.escolaId, zId.parse(req.params.id), f, u));
});

rotasAdmin.get('/alunos/:id/extrato.csv', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { csv, nomeArquivo } = await extratoCsv(u.escolaId, zId.parse(req.params.id), filtrosExtrato.parse(req.query), u);
  res
    .set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
      'Cache-Control': 'private, no-store',
    })
    .send(csv);
});

rotasAdmin.post('/alunos/:id/solicitar-encerramento', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { motivo } = z.object({ motivo: zMotivo }).parse(req.body);
  res.status(202).json(await solicitarEncerramento(u.escolaId, zId.parse(req.params.id), motivo, u));
});

// ------------------------------------------------------------ convites e vínculos
rotasAdmin.post('/alunos/:id/convites', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { email } = z.object({ email: zEmail }).parse(req.body);
  res.status(201).json({ convite: await convidarResponsavel(u.escolaId, zId.parse(req.params.id), email, u) });
});

rotasAdmin.post('/convites/:id/reenviar', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  res.status(201).json({ convite: await reenviarConvite(u.escolaId, zId.parse(req.params.id), u) });
});

rotasAdmin.post('/convites/:id/revogar', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  await revogarConvite(u.escolaId, zId.parse(req.params.id), u);
  res.status(204).end();
});

rotasAdmin.post('/alunos/:id/responsaveis/:responsavelId/desvincular', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { motivo } = z.object({ motivo: zMotivo }).parse(req.body);
  await desvincularResponsavel(u.escolaId, zId.parse(req.params.id), zId.parse(req.params.responsavelId), motivo, u);
  res.status(204).end();
});

// ------------------------------------------------------------ carteirinhas
rotasAdmin.post('/alunos/:id/carteirinhas', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { motivo } = z.object({ motivo: z.string().trim().min(1).max(255).optional() }).parse(req.body ?? {});
  res.status(201).json(await emitirCarteirinha(u.escolaId, zId.parse(req.params.id), motivo, u));
});

rotasAdmin.post('/alunos/:id/carteirinha/desbloquear', soDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  res.json({ carteirinha: await desbloquearCarteirinha(u.escolaId, zId.parse(req.params.id), u) });
});
