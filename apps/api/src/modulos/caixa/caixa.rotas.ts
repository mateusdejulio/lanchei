// Rotas implementadas aqui: identificar, pedidos (compra), estorno.
// A IMPLEMENTAR (ver docs/etapa4-backend.md): catálogo, busca de aluno,
// foto, pedidos de hoje.
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../infra/db.js';
import { erros } from '../../erros.js';
import { autenticar, exigirPapel, usuarioDaEscola } from '../../middlewares/autenticacao.js';
import { limiteCaixa } from '../../middlewares/limites.js';
import { realizarCompra } from './compra.servico.js';
import { estornarPedido } from './estorno.servico.js';
import { identificarPorQr } from './identificacao.js';

const esquemaIdentificacao = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('CARTEIRINHA'), qrConteudo: z.string().min(1).max(100) }),
  z.object({ tipo: z.literal('PIN'), alunoId: z.number().int().positive(), pin: z.string().regex(/^\d{4}$/) }),
]);

const esquemaPedido = z.object({
  identificacao: esquemaIdentificacao,
  itens: z
    .array(z.object({ produtoId: z.number().int().positive(), quantidade: z.number().int().min(1).max(50) }))
    .min(1)
    .max(30),
});

const esquemaEstorno = z.object({
  motivo: z.string().trim().min(3).max(200),
  devolverEstoque: z.boolean(),
});

export const rotasCaixa = Router();
rotasCaixa.use(autenticar, exigirPapel('ADMIN', 'OPERADOR'), limiteCaixa);

rotasCaixa.post('/identificar', async (req, res) => {
  const { escolaId } = usuarioDaEscola(req);
  const { qrConteudo } = z.object({ qrConteudo: z.string().min(1).max(100) }).parse(req.body);
  const quem = await identificarPorQr(escolaId, qrConteudo);
  const aluno = await db('alunos_lanchei as a')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where({ 'a.id': quem.alunoId })
    .first<{ id: number; nome: string; turma: string | null; status: string }>('a.id', 'a.nome', 't.nome as turma', 'a.status');
  // NUNCA devolve saldo (decisão de produto).
  res.json({
    aluno: { id: aluno.id, nome: aluno.nome, turma: aluno.turma },
    carteirinha: { status: quem.carteirinhaStatus },
    contaAtiva: aluno.status === 'ATIVO',
  });
});

rotasCaixa.post('/pedidos', async (req, res) => {
  const usuario = usuarioDaEscola(req);
  const chave = z.uuid().safeParse(req.get('Idempotency-Key'));
  if (!chave.success) {
    throw erros.regra('IDEMPOTENCY_KEY_OBRIGATORIA', 'Envie o header Idempotency-Key com um UUID.');
  }
  const corpo = esquemaPedido.parse(req.body);

  const r = await realizarCompra({
    escolaId: usuario.escolaId,
    operadorId: usuario.id,
    idempotencyKey: chave.data,
    identificacao: corpo.identificacao,
    itens: corpo.itens,
  });

  if (r.status === 'RECUSADO') {
    res.status(422).json({
      erro: {
        codigo: 'COMPRA_RECUSADA',
        mensagem: r.mensagem,
        detalhes: { motivo: r.motivo, pedidoId: r.pedidoId, ...(r.produtoIds ? { produtoIds: r.produtoIds } : {}) },
      },
    });
    return;
  }
  res.status(r.status === 'CONFIRMADO' ? 201 : 200).json({ pedido: r.pedido });
});

rotasCaixa.post('/pedidos/:id/estorno', async (req, res) => {
  const usuario = usuarioDaEscola(req);
  const pedidoId = z.coerce.number().int().positive().parse(req.params.id);
  const corpo = esquemaEstorno.parse(req.body);
  const r = await estornarPedido({
    escolaId: usuario.escolaId,
    pedidoId,
    // exigirPapel('ADMIN','OPERADOR') acima garante que não é ESCOLA
    usuario: { id: usuario.id, papel: usuario.papel as 'ADMIN' | 'OPERADOR' },
    motivo: corpo.motivo,
    devolverEstoque: corpo.devolverEstoque,
  });
  res.json(r);
});
