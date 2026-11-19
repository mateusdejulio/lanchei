// /v1/me: app dos responsáveis (RESPONSAVEL). Contrato: docs/etapa3-api.md §2.7.
// Toda rota /me/filhos/:alunoId/* passa por garantirVinculo (vinculo.ts):
// sem vínculo ativo com o aluno = 404.
import { Router, type Request } from 'express';
import { z } from 'zod';
import { autenticar, exigirResponsavel } from '../../middlewares/autenticacao.js';
import { limiteSenhaResponsavel, limiteVinculo } from '../../middlewares/limites.js';
import { erros } from '../../erros.js';
import { responderFoto } from '../../infra/fotos.js';
import { DIAS } from '../../dominio/diasPermitidos.js';
import { zChaveIdempotencia, zData, zId, zNome, zSenhaNova, zBoolQuery } from '../../validacao.js';
import { zLimite } from '../../paginacao.js';
import { TIPOS_EXTRATO } from '../admin/extrato.servico.js';
import { lerFotoAuditada } from '../admin/fotos.servico.js';
import { responderComTokens } from '../auth/cookie.js';
import { criarDeposito, depositosDoFilho, statusDoDeposito } from '../depositos/deposito.servico.js';
import { garantirVinculo } from './vinculo.js';
import { catalogoDoFilho, detalheDoFilho, extratoDoFilho, listarFilhos, pedidoDoFilho, regrasDoFilho } from './filhos.servico.js';
import { alterarBloqueioCarteirinha, atualizarRegras, definirPin, desvincular, removerPin, substituirBloqueios, type Origem } from './controle.servico.js';
import { vincularPorCodigo } from './vinculos.servico.js';
import { desativarDispositivo, editarPerfil, marcarLida, marcarTodasLidas, meuPerfil, minhasNotificacoes, registrarDispositivo, trocarSenha } from './perfil.servico.js';
import { exportarMeusDados, solicitarLgpd } from './lgpd.servico.js';
import { db } from '../../infra/db.js';

export const rotasResponsavel = Router();
rotasResponsavel.use(autenticar, exigirResponsavel);

const origem = (req: Request): Origem => ({ responsavelId: req.auth!.id, ip: req.ip, userAgent: req.get('user-agent') });
const alunoDaUrl = (req: Request) => zId.parse(req.params.alunoId);

// Centavos: inteiro, até R$ 10.000 (sanidade). null = sem limite / desligado.
const zLimiteCentavos = z.number().int().min(1).max(1_000_000).nullable();
const zPlataforma = z.enum(['ANDROID', 'IOS', 'DESKTOP', 'OUTRA']).default('OUTRA');

// ------------------------------------------------------------ perfil
rotasResponsavel.get('/', async (req, res) => {
  res.json({ responsavel: await meuPerfil(req.auth!.id) });
});

rotasResponsavel.patch('/', async (req, res) => {
  const d = z
    .object({ nome: zNome.optional(), telefone: z.string().trim().regex(/^[\d\s()+-]{8,20}$/, 'Telefone inválido.').nullable().optional() })
    .parse(req.body);
  res.json({ responsavel: await editarPerfil(req.auth!.id, d) });
});

// Troca de senha: derruba as outras sessões e devolve uma nova para este aparelho.
rotasResponsavel.post('/senha', limiteSenhaResponsavel, async (req, res) => {
  const { senhaAtual, novaSenha } = z.object({ senhaAtual: z.string().min(1).max(200), novaSenha: zSenhaNova }).parse(req.body);
  responderComTokens(req, res, await trocarSenha(req.auth!.id, senhaAtual, novaSenha, { ip: req.ip, userAgent: req.get('user-agent') }));
});

// ------------------------------------------------------------ aparelhos (push)
const zDispositivo = z.discriminatedUnion('canal', [
  z.object({
    canal: z.literal('WEB'),
    subscription: z.object({
      endpoint: z.url().max(2000).refine((u) => u.startsWith('https://'), 'O endpoint precisa ser HTTPS.'),
      keys: z.object({ p256dh: z.string().min(10).max(255), auth: z.string().min(10).max(255) }),
    }),
    plataforma: zPlataforma,
  }),
  // Fase 2 (app de loja): já aceito e guardado, mas o job ainda não envia.
  z.object({ canal: z.literal('EXPO'), expoPushToken: z.string().min(10).max(255), plataforma: zPlataforma }),
]);

rotasResponsavel.post('/dispositivos', async (req, res) => {
  res.status(201).json({ dispositivo: await registrarDispositivo(req.auth!.id, zDispositivo.parse(req.body)) });
});

rotasResponsavel.post('/dispositivos/desativar', async (req, res) => {
  const d = z.union([z.object({ endpoint: z.string().min(10).max(2000) }), z.object({ expoPushToken: z.string().min(10).max(255) })]).parse(req.body);
  await desativarDispositivo(req.auth!.id, d);
  res.status(204).end();
});

// ------------------------------------------------------------ vínculo
rotasResponsavel.post('/vinculos', limiteVinculo, async (req, res) => {
  const { codigo, aceiteTermo } = z
    .object({ codigo: z.string().trim().min(1).max(20), aceiteTermo: z.object({ versao: z.string().min(1).max(20) }) })
    .parse(req.body);
  res.status(201).json(await vincularPorCodigo(origem(req), codigo, aceiteTermo.versao));
});

// ------------------------------------------------------------ filhos (leitura)
rotasResponsavel.get('/filhos', async (req, res) => {
  res.json({ itens: await listarFilhos(req.auth!.id) });
});

rotasResponsavel.get('/filhos/:alunoId', async (req, res) => {
  res.json({ filho: await detalheDoFilho(req.auth!.id, alunoDaUrl(req)) });
});

rotasResponsavel.get('/filhos/:alunoId/foto', async (req, res) => {
  const f = await garantirVinculo(db, req.auth!.id, alunoDaUrl(req));
  const foto = await lerFotoAuditada(f.escolaId, f.alunoId, { tipo: 'RESPONSAVEL', id: req.auth!.id }, { ip: req.ip, userAgent: req.get('user-agent') });
  responderFoto(res, foto);
});

rotasResponsavel.get('/filhos/:alunoId/extrato', async (req, res) => {
  const f = z
    .object({ de: zData.optional(), ate: zData.optional(), tipo: z.enum(TIPOS_EXTRATO).optional(), limite: zLimite, cursor: z.string().max(500).optional() })
    .parse(req.query);
  res.json(await extratoDoFilho(req.auth!.id, alunoDaUrl(req), f));
});

rotasResponsavel.get('/filhos/:alunoId/pedidos/:pedidoId', async (req, res) => {
  res.json({ pedido: await pedidoDoFilho(req.auth!.id, alunoDaUrl(req), zId.parse(req.params.pedidoId)) });
});

rotasResponsavel.get('/filhos/:alunoId/catalogo', async (req, res) => {
  res.json(await catalogoDoFilho(req.auth!.id, alunoDaUrl(req)));
});

// ------------------------------------------------------------ regras e bloqueios
rotasResponsavel.get('/filhos/:alunoId/regras', async (req, res) => {
  const alunoId = alunoDaUrl(req);
  await garantirVinculo(db, req.auth!.id, alunoId);
  res.json({ regras: await regrasDoFilho(alunoId) });
});

rotasResponsavel.put('/filhos/:alunoId/regras', async (req, res) => {
  const n = z
    .object({
      limiteDiarioCentavos: zLimiteCentavos,
      limiteSemanalCentavos: zLimiteCentavos,
      limiteMensalCentavos: zLimiteCentavos,
      diasPermitidos: z.array(z.enum(DIAS)).max(7),
      alertaSaldoBaixoCentavos: zLimiteCentavos,
      permiteSemCarteirinha: z.boolean(),
    })
    .parse(req.body);
  res.json({ regras: await atualizarRegras(origem(req), alunoDaUrl(req), n) });
});

rotasResponsavel.put('/filhos/:alunoId/bloqueios', async (req, res) => {
  const d = z
    .object({ categoriaIds: z.array(z.number().int().positive()).max(200), produtoIds: z.array(z.number().int().positive()).max(1000) })
    .parse(req.body);
  res.json({ bloqueios: await substituirBloqueios(origem(req), alunoDaUrl(req), d) });
});

// ------------------------------------------------------------ PIN e carteirinha
rotasResponsavel.put('/filhos/:alunoId/pin', limiteSenhaResponsavel, async (req, res) => {
  const { pin, senhaResponsavel } = z
    .object({ pin: z.string().regex(/^\d{4}$/, 'O PIN tem 4 números.'), senhaResponsavel: z.string().min(1).max(200) })
    .parse(req.body);
  await definirPin(origem(req), alunoDaUrl(req), pin, senhaResponsavel);
  res.status(204).end();
});

rotasResponsavel.post('/filhos/:alunoId/pin/remover', limiteSenhaResponsavel, async (req, res) => {
  const { senhaResponsavel } = z.object({ senhaResponsavel: z.string().min(1).max(200) }).parse(req.body);
  await removerPin(origem(req), alunoDaUrl(req), senhaResponsavel);
  res.status(204).end();
});

rotasResponsavel.post('/filhos/:alunoId/carteirinha/bloquear', async (req, res) => {
  const { motivo } = z.object({ motivo: z.enum(['PERDIDA', 'OUTRO']).optional() }).parse(req.body ?? {});
  res.json({ carteirinha: await alterarBloqueioCarteirinha(origem(req), alunoDaUrl(req), true, motivo) });
});

rotasResponsavel.post('/filhos/:alunoId/carteirinha/desbloquear', async (req, res) => {
  res.json({ carteirinha: await alterarBloqueioCarteirinha(origem(req), alunoDaUrl(req), false) });
});

rotasResponsavel.post('/filhos/:alunoId/desvincular', async (req, res) => {
  // Confirmação explícita: o app pede para a pessoa confirmar antes.
  z.object({ confirmacao: z.literal(true) }).parse(req.body);
  await desvincular(origem(req), alunoDaUrl(req));
  res.status(204).end();
});

// ------------------------------------------------------------ depósitos (Pix)
rotasResponsavel.post('/filhos/:alunoId/depositos', async (req, res) => {
  const chave = zChaveIdempotencia.safeParse(req.get('Idempotency-Key'));
  if (!chave.success) throw erros.regra('IDEMPOTENCY_KEY_OBRIGATORIA', 'Envie o header Idempotency-Key com um UUID.');
  const { valorCentavos } = z.object({ valorCentavos: z.number().int().positive().max(10_000_000) }).parse(req.body);
  const r = await criarDeposito(req.auth!.id, alunoDaUrl(req), valorCentavos, chave.data);
  // 201 na criação; 200 quando é a repetição de um pedido já atendido.
  res.status(r.criado ? 201 : 200).json({ deposito: r.deposito });
});

rotasResponsavel.get('/filhos/:alunoId/depositos', async (req, res) => {
  const f = z.object({ limite: zLimite, cursor: z.string().max(200).optional() }).parse(req.query);
  res.json(await depositosDoFilho(req.auth!.id, alunoDaUrl(req), f));
});

rotasResponsavel.get('/depositos/:id', async (req, res) => {
  res.json({ deposito: await statusDoDeposito(req.auth!.id, zId.parse(req.params.id)) });
});

// ------------------------------------------------------------ notificações
rotasResponsavel.get('/notificacoes', async (req, res) => {
  const f = z.object({ naoLidas: zBoolQuery.default(false), limite: zLimite, cursor: z.string().max(200).optional() }).parse(req.query);
  res.json(await minhasNotificacoes(req.auth!.id, f));
});

rotasResponsavel.post('/notificacoes/lidas', async (req, res) => {
  await marcarTodasLidas(req.auth!.id);
  res.status(204).end();
});

rotasResponsavel.post('/notificacoes/:id/lida', async (req, res) => {
  await marcarLida(req.auth!.id, zId.parse(req.params.id));
  res.status(204).end();
});

// ------------------------------------------------------------ LGPD
rotasResponsavel.get('/dados', async (req, res) => {
  res
    .set({ 'Content-Disposition': 'attachment; filename="meus-dados-lanchei.json"', 'Cache-Control': 'private, no-store' })
    .json(await exportarMeusDados(origem(req)));
});

rotasResponsavel.post('/solicitacoes-lgpd', async (req, res) => {
  const { tipo, mensagem } = z
    .object({ tipo: z.enum(['CORRECAO', 'EXCLUSAO', 'OUTRO']), mensagem: z.string().trim().min(10, 'Descreva o pedido.').max(2000) })
    .parse(req.body);
  res.status(202).json(await solicitarLgpd(origem(req), tipo, mensagem));
});
