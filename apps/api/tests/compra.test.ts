// Fluxo de compra contra MySQL real: regras, idempotência, estoque,
// PIN, estorno e — o mais importante — CONCORRÊNCIA.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/infra/db.js';
import { realizarCompra, type EntradaCompra } from '../src/modulos/caixa/compra.servico.js';
import { estornarPedido } from '../src/modulos/caixa/estorno.servico.js';
import { ErroApi } from '../src/erros.js';
import {
  criarAluno,
  criarEscola,
  definirEstoque,
  divergencias,
  estoqueAtual,
  novaChave,
  saldo,
  type Escola,
} from './fixtures.js';

afterAll(() => db.destroy());

let escola: Escola;
beforeEach(async () => {
  escola = await criarEscola();
});

const comprar = (qr: string, itens: EntradaCompra['itens'], extra: Partial<EntradaCompra> = {}) =>
  realizarCompra({
    escolaId: escola.escolaId,
    operadorId: escola.operadorId,
    idempotencyKey: novaChave(),
    identificacao: { tipo: 'CARTEIRINHA', qrConteudo: qr },
    itens,
    ...extra,
  });

async function esperarErro(p: Promise<unknown>, codigo: string): Promise<ErroApi> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ErroApi);
  expect((e as ErroApi).codigo).toBe(codigo);
  return e as ErroApi;
}

describe('compra aprovada', () => {
  it('debita, grava ledger com saldo_apos, itens com snapshot e notifica TODOS os responsáveis', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const r = await comprar(a.qr, [
      { produtoId: escola.produtos.suco, quantidade: 2 },
      { produtoId: escola.produtos.chocolate, quantidade: 1 },
    ]);

    expect(r.status).toBe('CONFIRMADO');
    if (r.status !== 'CONFIRMADO') return;
    expect(r.pedido.totalCentavos).toBe(2 * 600 + 400);
    expect(await saldo(a.contaId)).toBe(5000 - 1600);

    const tx = await db('transacoes_lanchei').where({ pedido_id: r.pedido.id }).first();
    expect(tx).toMatchObject({ tipo: 'COMPRA', valor_centavos: -1600, saldo_apos_centavos: 3400 });

    const itens = await db('pedido_itens_lanchei').where({ pedido_id: r.pedido.id }).orderBy('produto_id');
    expect(itens.map((i) => [i.nome_produto, i.subtotal_centavos])).toEqual([
      ['Suco', 1200],
      ['Chocolate', 400],
    ]);

    const notifs = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'COMPRA' });
    expect(notifs).toHaveLength(2); // pai e mãe
    expect(notifs[0].corpo).toContain('R$ 16,00');
  });

  it('agrupa itens repetidos do mesmo produto', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const r = await comprar(a.qr, [
      { produtoId: escola.produtos.suco, quantidade: 1 },
      { produtoId: escola.produtos.suco, quantidade: 2 },
    ]);
    if (r.status !== 'CONFIRMADO') throw new Error('esperava CONFIRMADO');
    expect(r.pedido.itens).toEqual([expect.objectContaining({ produtoId: escola.produtos.suco, quantidade: 3 })]);
  });

  it('usa o preço do BANCO (mudança de preço não afeta pedido antigo)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const r1 = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    await db('produtos_lanchei').where({ id: escola.produtos.suco }).update({ preco_centavos: 900 });
    const r2 = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    if (r1.status !== 'CONFIRMADO' || r2.status !== 'CONFIRMADO') throw new Error();
    expect(r1.pedido.totalCentavos).toBe(600);
    expect(r2.pedido.totalCentavos).toBe(900);
    const i1 = await db('pedido_itens_lanchei').where({ pedido_id: r1.pedido.id }).first();
    expect(i1.preco_unitario_centavos).toBe(600);
  });

  it('avisa saldo baixo só quando CRUZA o limite de alerta', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1500, regras: { alerta_saldo_baixo_centavos: 1000 } });
    await comprar(a.qr, [{ produtoId: escola.produtos.chocolate, quantidade: 1 }]); // 1500 -> 1100
    await comprar(a.qr, [{ produtoId: escola.produtos.chocolate, quantidade: 1 }]); // 1100 -> 700  (cruzou)
    await comprar(a.qr, [{ produtoId: escola.produtos.chocolate, quantidade: 1 }]); // 700 -> 300   (já abaixo)
    const avisos = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'SALDO_BAIXO' });
    expect(avisos).toHaveLength(2); // 1 evento x 2 responsáveis
  });
});

describe('compra recusada (grava pedido RECUSADO e avisa)', () => {
  it('saldo insuficiente não debita nada', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 300 });
    const r = await comprar(a.qr, [{ produtoId: escola.produtos.chocolate, quantidade: 1 }]);
    expect(r).toMatchObject({ status: 'RECUSADO', motivo: 'SALDO_INSUFICIENTE' });
    expect(await saldo(a.contaId)).toBe(300);
    const p = await db('pedidos_lanchei').where({ aluno_id: a.alunoId }).first();
    expect(p).toMatchObject({ status: 'RECUSADO', motivo_recusa: 'SALDO_INSUFICIENTE' });
    expect(await db('transacoes_lanchei').where({ pedido_id: p.id })).toHaveLength(0);
  });

  it('item de categoria bloqueada', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await db('bloqueios_categoria_lanchei').insert({
      escola_id: escola.escolaId,
      aluno_id: a.alunoId,
      categoria_id: escola.categorias.doces,
      criado_por_responsavel_id: a.responsavelIds[0],
    });
    const r = await comprar(a.qr, [
      { produtoId: escola.produtos.suco, quantidade: 1 },
      { produtoId: escola.produtos.chocolate, quantidade: 1 },
    ]);
    expect(r).toMatchObject({ status: 'RECUSADO', motivo: 'ITEM_BLOQUEADO', produtoIds: [escola.produtos.chocolate] });
  });

  it('dia não permitido usa o dia NO FUSO DA ESCOLA', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, regras: { dias_permitidos: 31 } }); // seg-sex
    // 2026-11-07 é sábado em SP (02:00 UTC de sábado = 23:00 de sexta em SP!)
    const sextaEmSP = new Date('2026-11-07T02:00:00Z');
    const sabadoEmSP = new Date('2026-11-07T15:00:00Z');
    expect((await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }], { agora: sextaEmSP })).status).toBe('CONFIRMADO');
    expect(await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }], { agora: sabadoEmSP })).toMatchObject({
      motivo: 'DIA_NAO_PERMITIDO',
    });
  });

  it('limite diário soma as compras CONFIRMADAS do dia; estorno devolve o limite', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 10_000, regras: { limite_diario_centavos: 1000 } });
    const r1 = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]); // 600
    expect(r1.status).toBe('CONFIRMADO');
    const r2 = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]); // 1200 > 1000
    expect(r2).toMatchObject({ status: 'RECUSADO', motivo: 'LIMITE_DIARIO' });

    if (r1.status !== 'CONFIRMADO') throw new Error();
    await estornarPedido({
      escolaId: escola.escolaId,
      pedidoId: r1.pedido.id,
      usuario: { id: escola.operadorId, papel: 'OPERADOR' },
      motivo: 'errei o item',
      devolverEstoque: false,
    });
    const r3 = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    expect(r3.status).toBe('CONFIRMADO');
  });

  it('carteirinha bloqueada pelo responsável', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await db('carteirinhas_lanchei').where({ id: a.carteirinhaId }).update({ status: 'BLOQUEADA' });
    const r = await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    expect(r).toMatchObject({ status: 'RECUSADO', motivo: 'CARTEIRINHA_BLOQUEADA' });
  });

  it('aluno inativo', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await db('alunos_lanchei').where({ id: a.alunoId }).update({ status: 'INATIVO' });
    expect(await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }])).toMatchObject({ motivo: 'CONTA_INATIVA' });
  });

  it('limita aviso de recusa a 1 por motivo a cada 30 min', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 100 });
    for (let i = 0; i < 3; i++) await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]);
    const avisos = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'COMPRA_RECUSADA' });
    expect(avisos).toHaveLength(2); // 1 evento x 2 responsáveis
  });
});

describe('carteirinha', () => {
  it('QR fora do formato, desconhecido ou revogado => CARTEIRINHA_INVALIDA', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const item = [{ produtoId: escola.produtos.suco, quantidade: 1 }];
    await esperarErro(comprar('https://qualquer-site.com', item), 'CARTEIRINHA_INVALIDA');
    await esperarErro(comprar('LCH1.tokenquenaoexiste123', item), 'CARTEIRINHA_INVALIDA');
    await db('carteirinhas_lanchei').where({ id: a.carteirinhaId }).update({ status: 'REVOGADA', revogada_em: new Date() });
    await esperarErro(comprar(a.qr, item), 'CARTEIRINHA_INVALIDA');
  });

  it('QR de OUTRA escola não funciona aqui (isolamento entre tenants)', async () => {
    const outra = await criarEscola();
    const alunoDeOutra = await criarAluno(outra, { saldoCentavos: 5000 });
    await esperarErro(comprar(alunoDeOutra.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }]), 'CARTEIRINHA_INVALIDA');
  });

  it('produto de outra escola é recusado', async () => {
    const outra = await criarEscola();
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await esperarErro(comprar(a.qr, [{ produtoId: outra.produtos.suco, quantidade: 1 }]), 'PRODUTO_INDISPONIVEL');
  });
});

describe('idempotência', () => {
  it('mesma chave = mesma resposta, débito UMA vez', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const chave = novaChave();
    const itens = [{ produtoId: escola.produtos.suco, quantidade: 1 }];
    const r1 = await comprar(a.qr, itens, { idempotencyKey: chave });
    const r2 = await comprar(a.qr, itens, { idempotencyKey: chave });
    expect(r2).toEqual(r1);
    expect(await saldo(a.contaId)).toBe(4400);
    expect(await db('pedidos_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(1);
  });

  it('recusa repetida devolve a mesma recusa (sem gravar outro pedido)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 100 });
    const chave = novaChave();
    const itens = [{ produtoId: escola.produtos.suco, quantidade: 1 }];
    const r1 = await comprar(a.qr, itens, { idempotencyKey: chave });
    const r2 = await comprar(a.qr, itens, { idempotencyKey: chave });
    expect(r2).toMatchObject({ status: 'RECUSADO', motivo: 'SALDO_INSUFICIENTE', pedidoId: (r1 as { pedidoId: number }).pedidoId });
  });

  it('mesma chave para OUTRO aluno => 409', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const b = await criarAluno(escola, { saldoCentavos: 5000 });
    const chave = novaChave();
    await comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }], { idempotencyKey: chave });
    await esperarErro(
      comprar(b.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }], { idempotencyKey: chave }),
      'IDEMPOTENCY_KEY_REUTILIZADA',
    );
  });

  it('CLIQUE DUPLO simultâneo: 8 requisições iguais em paralelo => 1 pedido, 1 débito', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const chave = novaChave();
    const itens = [{ produtoId: escola.produtos.suco, quantidade: 1 }];
    const resultados = await Promise.all(Array.from({ length: 8 }, () => comprar(a.qr, itens, { idempotencyKey: chave })));
    const ids = new Set(resultados.map((r) => (r.status === 'CONFIRMADO' ? r.pedido.id : -1)));
    expect(ids.size).toBe(1);
    expect(await saldo(a.contaId)).toBe(4400);
  });
});

describe('concorrência de saldo', () => {
  it('20 compras simultâneas de R$ 10 com saldo de R$ 50 => exatamente 5 aprovadas, saldo 0, nunca negativo', async () => {
    await db('produtos_lanchei').where({ id: escola.produtos.suco }).update({ preco_centavos: 1000 });
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const resultados = await Promise.all(
      Array.from({ length: 20 }, () => comprar(a.qr, [{ produtoId: escola.produtos.suco, quantidade: 1 }])),
    );
    expect(resultados.filter((r) => r.status === 'CONFIRMADO')).toHaveLength(5);
    expect(resultados.filter((r) => r.status === 'RECUSADO' && r.motivo === 'SALDO_INSUFICIENTE')).toHaveLength(15);
    expect(await saldo(a.contaId)).toBe(0);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });
});

describe('estoque', () => {
  it('baixa o estoque na venda', async () => {
    await definirEstoque(escola, escola.produtos.refri, 10);
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await comprar(a.qr, [{ produtoId: escola.produtos.refri, quantidade: 3 }]);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(7);
  });

  it('sem estoque => 409, NADA gravado e NENHUM aviso aos pais', async () => {
    await definirEstoque(escola, escola.produtos.refri, 1);
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const e = await esperarErro(comprar(a.qr, [{ produtoId: escola.produtos.refri, quantidade: 2 }]), 'ESTOQUE_INSUFICIENTE');
    expect(e.status).toBe(409);
    expect(e.detalhes).toEqual({ itens: [{ produtoId: escola.produtos.refri, disponivel: 1 }] });
    expect(await db('pedidos_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(0);
    expect(await db('notificacoes_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(0);
    expect(await saldo(a.contaId)).toBe(5000);
  });

  it('10 alunos diferentes disputando 3 refrigerantes ao mesmo tempo => 3 vendas, estoque 0', async () => {
    await definirEstoque(escola, escola.produtos.refri, 3);
    const alunos = await Promise.all(Array.from({ length: 10 }, () => criarAluno(escola, { saldoCentavos: 5000, responsaveis: 1 })));
    const resultados = await Promise.allSettled(
      alunos.map((a) =>
        comprar(a.qr, [
          { produtoId: escola.produtos.suco, quantidade: 1 },
          { produtoId: escola.produtos.refri, quantidade: 1 },
        ]),
      ),
    );
    const ok = resultados.filter((r) => r.status === 'fulfilled' && r.value.status === 'CONFIRMADO');
    const semEstoque = resultados.filter(
      (r) => r.status === 'rejected' && (r.reason as ErroApi).codigo === 'ESTOQUE_INSUFICIENTE',
    );
    expect(ok).toHaveLength(3);
    expect(semEstoque).toHaveLength(7);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(0);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });
});

describe('compra sem carteirinha (PIN)', () => {
  const pin = (alunoId: number, valor: string, extra: Partial<EntradaCompra> = {}) =>
    realizarCompra({
      escolaId: escola.escolaId,
      operadorId: escola.operadorId,
      idempotencyKey: novaChave(),
      identificacao: { tipo: 'PIN', alunoId, pin: valor },
      itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }],
      ...extra,
    });

  it('PIN certo compra e avisa como COMPRA_SEM_CARTEIRINHA', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, pin: '4821', regras: { permite_sem_carteirinha: true } });
    expect((await pin(a.alunoId, '4821')).status).toBe('CONFIRMADO');
    const p = await db('pedidos_lanchei').where({ aluno_id: a.alunoId }).first();
    expect(p).toMatchObject({ modo_identificacao: 'PIN', carteirinha_id: null });
    expect(await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'COMPRA_SEM_CARTEIRINHA' })).toHaveLength(2);
  });

  it('responsável não liberou => SEM_CARTEIRINHA_DESATIVADO', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, pin: '4821' });
    await esperarErro(pin(a.alunoId, '4821'), 'SEM_CARTEIRINHA_DESATIVADO');
  });

  it('5 erros bloqueiam o PIN por 30 min e avisam os pais; nem o PIN certo passa', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, pin: '4821', regras: { permite_sem_carteirinha: true } });
    for (let i = 1; i <= 4; i++) {
      const e = await esperarErro(pin(a.alunoId, '0000'), 'PIN_INCORRETO');
      expect(e.detalhes).toEqual({ tentativasRestantes: 5 - i });
    }
    expect((await esperarErro(pin(a.alunoId, '0000'), 'PIN_BLOQUEADO')).status).toBe(423);
    await esperarErro(pin(a.alunoId, '4821'), 'PIN_BLOQUEADO');
    expect(await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'CARTEIRINHA' })).toHaveLength(2);
    // 31 minutos depois, volta a funcionar
    expect((await pin(a.alunoId, '4821', { agora: new Date(Date.now() + 31 * 60_000) })).status).toBe('CONFIRMADO');
  });
});

describe('estorno', () => {
  async function compraFeita(qtdRefri = 0) {
    if (qtdRefri) await definirEstoque(escola, escola.produtos.refri, 10);
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const itens = [{ produtoId: escola.produtos.suco, quantidade: 1 }];
    if (qtdRefri) itens.push({ produtoId: escola.produtos.refri, quantidade: qtdRefri });
    const r = await comprar(a.qr, itens);
    if (r.status !== 'CONFIRMADO') throw new Error('compra deveria ser aprovada');
    return { a, pedidoId: r.pedido.id, total: r.pedido.totalCentavos };
  }

  it('devolve o saldo e (opcionalmente) o estoque; não expõe saldo na resposta', async () => {
    const { a, pedidoId } = await compraFeita(2);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(8);
    const r = await estornarPedido({
      escolaId: escola.escolaId,
      pedidoId,
      usuario: { id: escola.operadorId, papel: 'OPERADOR' },
      motivo: 'item errado',
      devolverEstoque: true,
    });
    expect(r).toEqual({ pedidoId, status: 'ESTORNADO' });
    expect(await saldo(a.contaId)).toBe(5000);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(10);
    expect(await db('auditoria_lanchei').where({ acao: 'PEDIDO_ESTORNAR', entidade_id: pedidoId })).toHaveLength(1);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('estorno duplo => JA_ESTORNADO (409)', async () => {
    const { pedidoId } = await compraFeita();
    const e = { escolaId: escola.escolaId, pedidoId, usuario: { id: escola.adminId, papel: 'ADMIN' as const }, motivo: 'teste', devolverEstoque: false };
    await estornarPedido(e);
    await esperarErro(estornarPedido(e), 'JA_ESTORNADO');
  });

  it('operador NÃO estorna pedido de outro dia; admin sim', async () => {
    const { pedidoId } = await compraFeita();
    const amanha = new Date(Date.now() + 26 * 3_600_000);
    const base = { escolaId: escola.escolaId, pedidoId, motivo: 'teste', devolverEstoque: false, agora: amanha };
    await esperarErro(estornarPedido({ ...base, usuario: { id: escola.operadorId, papel: 'OPERADOR' } }), 'SEM_PERMISSAO');
    expect((await estornarPedido({ ...base, usuario: { id: escola.adminId, papel: 'ADMIN' } })).status).toBe('ESTORNADO');
  });

  it('pedido de outra escola => NAO_ENCONTRADO', async () => {
    const { pedidoId } = await compraFeita();
    const outra = await criarEscola();
    await esperarErro(
      estornarPedido({ escolaId: outra.escolaId, pedidoId, usuario: { id: outra.adminId, papel: 'ADMIN' }, motivo: 'x', devolverEstoque: false }),
      'NAO_ENCONTRADO',
    );
  });

  it('estornos simultâneos do mesmo pedido => só 1 passa', async () => {
    const { a, pedidoId } = await compraFeita();
    const tentativas = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        estornarPedido({ escolaId: escola.escolaId, pedidoId, usuario: { id: escola.adminId, papel: 'ADMIN' }, motivo: 'x', devolverEstoque: false }),
      ),
    );
    expect(tentativas.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    expect(await saldo(a.contaId)).toBe(5000);
  });
});
