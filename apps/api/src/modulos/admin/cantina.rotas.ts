// /v1/admin, parte da CANTINA (ADMIN): Mercado Pago, catálogo, pedidos,
// estorno, venda manual, ajuste, encerramento, relatórios, resumo e auditoria.
// A parte da Diretoria está em admin.rotas.ts. A matriz de quem pode o quê
// (docs/etapa6-painel.md §2) é conferida rota a rota em tests/permissoes.test.ts.
import { Router, type Response } from 'express';
import { z } from 'zod';
import { autenticar } from '../../middlewares/autenticacao.js';
import { erros } from '../../erros.js';
import { zBoolQuery, zChaveIdempotencia, zData, zId } from '../../validacao.js';
import { zLimite } from '../../paginacao.js';
import { estornarPedido } from '../caixa/estorno.servico.js';
import { cantinaOuDiretoria, soCantina, usuarioDoPainel } from './acesso.js';
import { criarCategoria, criarProduto, editarCategoria, editarProduto, listarCategorias, listarProdutos } from './catalogo.servico.js';
import { detalheDoPedido, listarPedidos } from './pedidos.servico.js';
import { registrarVendaManual } from './vendaManual.servico.js';
import { ajustarSaldo, encerrarAluno } from './conta.servico.js';
import { depositosCsv, relatorioDepositos, relatorioSaldos, relatorioVendas, saldosCsv, vendasCsv } from './relatorios.servico.js';
import { resumoDoDia } from './resumo.servico.js';
import { listarAuditoria } from './auditoria.servico.js';
import { statusMercadoPago, urlDeConexao } from './mercadopago.servico.js';

export const rotasCantina = Router();
rotasCantina.use(autenticar);

const zNomeCurto = (max: number) => z.string().trim().min(1).max(max);
// R$ 0,01 a R$ 1.000,00 por produto: limite de sanidade contra erro de digitação.
const zPreco = z.number().int().min(1).max(100_000);
const zFormato = z.enum(['json', 'csv']).default('json');
const zPeriodo = z.object({ de: zData, ate: zData });

function enviarCsv(res: Response, nomeArquivo: string, csv: string) {
  res
    .set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nomeArquivo}"`, 'Cache-Control': 'private, no-store' })
    .send(csv);
}

// ------------------------------------------------------------ Mercado Pago
rotasCantina.get('/mercadopago/status', soCantina, async (req, res) => {
  res.json(await statusMercadoPago(usuarioDoPainel(req).escolaId));
});

rotasCantina.post('/mercadopago/conectar', soCantina, (req, res) => {
  const u = usuarioDoPainel(req);
  res.json(urlDeConexao(u.escolaId, u.id));
});

// ------------------------------------------------------------ catálogo
rotasCantina.get('/categorias', soCantina, async (req, res) => {
  res.json({ itens: await listarCategorias(usuarioDoPainel(req).escolaId) });
});

rotasCantina.post('/categorias', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { nome } = z.object({ nome: zNomeCurto(80) }).parse(req.body);
  res.status(201).json({ categoria: await criarCategoria(u.escolaId, nome, u) });
});

rotasCantina.patch('/categorias/:id', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({ nome: zNomeCurto(80).optional(), ativo: z.boolean().optional() })
    .refine((v) => v.nome !== undefined || v.ativo !== undefined, 'Informe nome e/ou ativo.')
    .parse(req.body);
  res.json({ categoria: await editarCategoria(u.escolaId, zId.parse(req.params.id), corpo, u) });
});

rotasCantina.get('/produtos', soCantina, async (req, res) => {
  const f = z.object({ categoriaId: zId.optional(), ativo: zBoolQuery.optional() }).parse(req.query);
  res.json({ itens: await listarProdutos(usuarioDoPainel(req).escolaId, f) });
});

rotasCantina.post('/produtos', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      nome: zNomeCurto(120),
      categoriaId: z.number().int().positive(),
      precoCentavos: zPreco,
      controlaEstoque: z.boolean().default(false),
      estoqueMinimo: z.number().int().min(0).max(100_000).nullable().optional(),
    })
    .parse(req.body);
  res.status(201).json({ produto: await criarProduto(u.escolaId, corpo, u) });
});

rotasCantina.patch('/produtos/:id', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      nome: zNomeCurto(120).optional(),
      categoriaId: z.number().int().positive().optional(),
      precoCentavos: zPreco.optional(),
      ativo: z.boolean().optional(),
      controlaEstoque: z.boolean().optional(),
      estoqueMinimo: z.number().int().min(0).max(100_000).nullable().optional(),
    })
    .parse(req.body);
  res.json({ produto: await editarProduto(u.escolaId, zId.parse(req.params.id), corpo, u) });
});

// ------------------------------------------------------------ pedidos
rotasCantina.get('/pedidos', soCantina, async (req, res) => {
  const f = z
    .object({
      de: zData.optional(),
      ate: zData.optional(),
      status: z.enum(['CONFIRMADO', 'RECUSADO', 'ESTORNADO']).optional(),
      alunoId: zId.optional(),
      operadorId: zId.optional(),
      limite: zLimite,
      cursor: z.string().max(200).optional(),
    })
    .parse(req.query);
  res.json(await listarPedidos(usuarioDoPainel(req).escolaId, f));
});

rotasCantina.get('/pedidos/:id', soCantina, async (req, res) => {
  res.json({ pedido: await detalheDoPedido(usuarioDoPainel(req).escolaId, zId.parse(req.params.id)) });
});

// O admin estorna pedido de QUALQUER data (o operador, só os do dia).
rotasCantina.post('/pedidos/:id/estorno', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z.object({ motivo: z.string().trim().min(3).max(200), devolverEstoque: z.boolean() }).parse(req.body);
  res.json(
    await estornarPedido({
      escolaId: u.escolaId,
      pedidoId: zId.parse(req.params.id),
      usuario: { id: u.id, papel: 'ADMIN' },
      motivo: corpo.motivo,
      devolverEstoque: corpo.devolverEstoque,
    }),
  );
});

rotasCantina.post('/vendas-manuais', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const chave = zChaveIdempotencia.safeParse(req.get('Idempotency-Key'));
  if (!chave.success) throw erros.regra('IDEMPOTENCY_KEY_OBRIGATORIA', 'Envie o header Idempotency-Key com um UUID.');
  const corpo = z
    .object({
      alunoId: z.number().int().positive(),
      itens: z.array(z.object({ produtoId: z.number().int().positive(), quantidade: z.number().int().min(1).max(50) })).min(1).max(30),
      // ISO 8601 com fuso ("2026-11-05T12:30:00-03:00" ou em UTC com "Z").
      ocorridoEm: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
      observacao: z.string().trim().min(3).max(255),
    })
    .parse(req.body);

  const r = await registrarVendaManual({ escolaId: u.escolaId, ator: u, idempotencyKey: chave.data, ...corpo });
  // registrarVendaManual nunca grava RECUSADO; o ramo existe só para o TypeScript.
  if (r.status === 'RECUSADO') throw erros.regra('COMPRA_RECUSADA', r.mensagem);
  res.status(201).json({ pedido: r.pedido });
});

// ------------------------------------------------------------ saldo do aluno
rotasCantina.post('/alunos/:id/ajustes', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      // ± até R$ 5.000,00, nunca zero.
      valorCentavos: z.number().int().min(-500_000).max(500_000).refine((v) => v !== 0, 'O valor não pode ser zero.'),
      descricao: z.string().trim().min(5, 'Explique o motivo do ajuste.').max(255),
    })
    .parse(req.body);
  res.status(201).json(await ajustarSaldo(u.escolaId, zId.parse(req.params.id), corpo, u));
});

rotasCantina.post('/alunos/:id/encerramento', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const corpo = z
    .object({
      motivo: z.string().trim().min(3).max(255),
      reembolso: z
        .object({ forma: z.enum(['PIX', 'TRANSFERENCIA', 'DINHEIRO']), comprovanteRef: z.string().trim().min(1).max(255).optional() })
        .optional(),
    })
    .parse(req.body);
  res.json(await encerrarAluno(u.escolaId, zId.parse(req.params.id), corpo, u));
});

// ------------------------------------------------------------ relatórios
rotasCantina.get('/resumo', soCantina, async (req, res) => {
  const { data } = z.object({ data: zData.optional() }).parse(req.query);
  res.json(await resumoDoDia(usuarioDoPainel(req).escolaId, data));
});

rotasCantina.get('/relatorios/vendas', soCantina, async (req, res) => {
  const f = zPeriodo.extend({ agrupar: z.enum(['dia', 'produto', 'categoria', 'operador']).default('dia'), formato: zFormato }).parse(req.query);
  const r = await relatorioVendas(usuarioDoPainel(req).escolaId, f, f.agrupar);
  if (f.formato === 'csv') enviarCsv(res, `vendas-por-${f.agrupar}-${f.de}-a-${f.ate}.csv`, vendasCsv(r));
  else res.json(r);
});

rotasCantina.get('/relatorios/depositos', soCantina, async (req, res) => {
  const f = zPeriodo.extend({ formato: zFormato }).parse(req.query);
  const r = await relatorioDepositos(usuarioDoPainel(req).escolaId, f);
  if (f.formato === 'csv') enviarCsv(res, `depositos-${f.de}-a-${f.ate}.csv`, depositosCsv(r));
  else res.json(r);
});

rotasCantina.get('/relatorios/saldos', soCantina, async (req, res) => {
  const u = usuarioDoPainel(req);
  const { formato } = z.object({ formato: zFormato }).parse(req.query);
  if (formato === 'csv') enviarCsv(res, 'saldos-em-aberto.csv', await saldosCsv(u.escolaId, u));
  else res.json(await relatorioSaldos(u.escolaId));
});

// ------------------------------------------------------------ auditoria (cada perfil vê a sua parte)
rotasCantina.get('/auditoria', cantinaOuDiretoria, async (req, res) => {
  const u = usuarioDoPainel(req);
  const f = z
    .object({
      alunoId: zId.optional(),
      acao: z.string().regex(/^[A-Z_]{3,64}$/).optional(),
      de: zData.optional(),
      ate: zData.optional(),
      limite: zLimite,
      cursor: z.string().max(200).optional(),
    })
    .parse(req.query);
  res.json(await listarAuditoria(u.escolaId, u.papel, f));
});
