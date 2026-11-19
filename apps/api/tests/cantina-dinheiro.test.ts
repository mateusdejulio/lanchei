// Cantina, parte que mexe em DINHEIRO: venda manual, ajuste de saldo,
// encerramento com reembolso e estorno pelo admin. Inclui concorrência.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { creditar, criarAluno, criarEscola, definirEstoque, divergencias, estoqueAtual, logarEquipe, novaChave, saldo, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;
let cantina: Awaited<ReturnType<typeof logarEquipe>>;
let operador: Awaited<ReturnType<typeof logarEquipe>>;

beforeEach(async () => {
  escola = await criarEscola();
  cantina = await logarEquipe(app, escola.adminEmail);
  operador = await logarEquipe(app, escola.operadorEmail);
});

const HORA = 3_600_000;
const haHoras = (h: number) => new Date(Date.now() - h * HORA);
const ledger = (contaId: number) => db('transacoes_lanchei').where({ conta_id: contaId }).orderBy('id');
const comprar = (qr: string, produtoId: number, quantidade = 1, agora?: Date) =>
  realizarCompra({
    escolaId: escola.escolaId,
    operadorId: escola.operadorId,
    idempotencyKey: novaChave(),
    identificacao: { tipo: 'CARTEIRINHA', qrConteudo: qr },
    itens: [{ produtoId, quantidade }],
    ...(agora ? { agora } : {}),
  });

describe('venda manual (contingência)', () => {
  const vender = (alunoId: number, extra: object = {}, chave = novaChave()) =>
    cantina
      .post('/v1/admin/vendas-manuais', {
        alunoId,
        itens: [{ produtoId: escola.produtos.suco, quantidade: 2 }],
        ocorridoEm: haHoras(3).toISOString(),
        observacao: 'Internet caiu no recreio',
        ...extra,
      })
      .set('Idempotency-Key', chave);

  it('debita o saldo, baixa o estoque, grava pedido MANUAL com a data em que ocorreu, audita e avisa os pais', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await definirEstoque(escola, escola.produtos.refri, 10);
    const ocorridoEm = haHoras(5);
    const r = await vender(a.alunoId, { itens: [{ produtoId: escola.produtos.refri, quantidade: 3 }], ocorridoEm: ocorridoEm.toISOString() });
    expect(r.status).toBe(201);
    expect(r.body.pedido).toMatchObject({ status: 'CONFIRMADO', totalCentavos: 1500 });

    expect(await saldo(a.contaId)).toBe(3500);
    expect(await estoqueAtual(escola.produtos.refri)).toBe(7);
    const p = await db('pedidos_lanchei').where({ id: r.body.pedido.id }).first();
    expect(p).toMatchObject({ modo_identificacao: 'MANUAL', carteirinha_id: null, operador_id: escola.adminId, observacao: 'Internet caiu no recreio' });
    expect(new Date(p.created_at).getTime()).toBe(ocorridoEm.getTime());
    expect(new Date(p.ocorrido_em).getTime()).toBe(ocorridoEm.getTime());

    // O ledger registra o instante em que o saldo mudou de fato (agora), não a data da venda.
    const tx = (await ledger(a.contaId)).at(-1);
    expect(tx).toMatchObject({ tipo: 'COMPRA', valor_centavos: -1500, saldo_apos_centavos: 3500 });
    expect(Date.now() - new Date(tx.created_at).getTime()).toBeLessThan(60_000);

    expect(await db('auditoria_lanchei').where({ acao: 'VENDA_MANUAL', entidade_id: p.id }).first()).toBeTruthy();
    const avisos = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'COMPRA' });
    expect(avisos).toHaveLength(2);
    expect(avisos[0].corpo).toContain('lançada agora pela cantina');
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('valida SÓ saldo e estoque: passa mesmo com dia bloqueado, item bloqueado e limite estourado', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, regras: { dias_permitidos: 0, limite_diario_centavos: 100 } });
    await db('bloqueios_produto_lanchei').insert({ escola_id: escola.escolaId, aluno_id: a.alunoId, produto_id: escola.produtos.suco, criado_por_responsavel_id: a.responsavelIds[0] });
    expect((await vender(a.alunoId)).status).toBe(201);
    expect(await saldo(a.contaId)).toBe(3800);
  });

  it('saldo insuficiente → 422 e NADA é gravado (saldo nunca fica negativo)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const r = await vender(a.alunoId); // 2 sucos = 1200
    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({ codigo: 'SALDO_INSUFICIENTE', detalhes: { totalCentavos: 1200, saldoCentavos: 1000, faltamCentavos: 200 } });
    expect(await saldo(a.contaId)).toBe(1000);
    expect(await db('pedidos_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(0);
  });

  it('estoque insuficiente → 409 e nada gravado', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    await definirEstoque(escola, escola.produtos.refri, 1);
    const r = await vender(a.alunoId, { itens: [{ produtoId: escola.produtos.refri, quantidade: 2 }] });
    expect(r.status).toBe(409);
    expect(r.body.erro.detalhes.itens).toEqual([{ produtoId: escola.produtos.refri, disponivel: 1 }]);
    expect(await saldo(a.contaId)).toBe(5000);
  });

  it('mesma Idempotency-Key de novo: mesma resposta, UM débito', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const chave = novaChave();
    const r1 = await vender(a.alunoId, {}, chave);
    const r2 = await vender(a.alunoId, {}, chave);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(await saldo(a.contaId)).toBe(3800);
  });

  it('8 envios SIMULTÂNEOS com a mesma chave: 1 pedido, 1 débito', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const chave = novaChave();
    const respostas = await Promise.all(Array.from({ length: 8 }, () => vender(a.alunoId, {}, chave)));
    expect(respostas.every((r) => r.status === 201)).toBe(true);
    expect(new Set(respostas.map((r) => r.body.pedido.id)).size).toBe(1);
    expect(await saldo(a.contaId)).toBe(3800);
    expect(await db('pedidos_lanchei').where({ aluno_id: a.alunoId })).toHaveLength(1);
  });

  it('chave já usada por OUTRO aluno → 409', async () => {
    const [a, b] = [await criarAluno(escola, { saldoCentavos: 5000 }), await criarAluno(escola, { saldoCentavos: 5000 })];
    const chave = novaChave();
    await vender(a.alunoId, {}, chave);
    const r = await vender(b.alunoId, {}, chave);
    expect(r.body.erro.codigo).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
    expect(await saldo(b.contaId)).toBe(5000);
  });

  it('conta no LIMITE do dia em que ocorreu, não no dia do lançamento', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, regras: { limite_diario_centavos: 1000 } });
    // Venda de ONTEM (R$ 6,00) lançada hoje...
    expect((await vender(a.alunoId, { itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }], ocorridoEm: haHoras(24).toISOString() })).status).toBe(201);
    // ...não consome o limite de HOJE: a compra de R$ 6,00 no caixa passa.
    expect((await comprar(a.qr, escola.produtos.suco)).status).toBe('CONFIRMADO');
    // E a segunda de hoje estoura (600 + 600 > 1000).
    expect((await comprar(a.qr, escola.produtos.suco)).status).toBe('RECUSADO');
  });

  it('recusa: data no futuro, data muito antiga, aluno encerrado, sem Idempotency-Key, aluno de outra escola', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    expect((await vender(a.alunoId, { ocorridoEm: new Date(Date.now() + HORA).toISOString() })).body.erro.codigo).toBe('DATA_NO_FUTURO');
    expect((await vender(a.alunoId, { ocorridoEm: haHoras(24 * 61).toISOString() })).body.erro.codigo).toBe('DATA_MUITO_ANTIGA');
    expect((await vender(a.alunoId, { observacao: '' })).status).toBe(400);
    const semChave = await cantina.post('/v1/admin/vendas-manuais', { alunoId: a.alunoId, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }], ocorridoEm: haHoras(1).toISOString(), observacao: 'teste' });
    expect(semChave.body.erro.codigo).toBe('IDEMPOTENCY_KEY_OBRIGATORIA');

    const alheio = await criarAluno(await criarEscola(), { saldoCentavos: 5000 });
    expect((await vender(alheio.alunoId)).status).toBe(404);

    await db('alunos_lanchei').where({ id: a.alunoId }).update({ status: 'ENCERRADO', encerrado_em: new Date() });
    expect((await vender(a.alunoId)).body.erro.codigo).toBe('ALUNO_ENCERRADO');
    expect(await saldo(a.contaId)).toBe(5000);
  });
});

describe('ajuste de saldo', () => {
  const ajustar = (alunoId: number, valorCentavos: number, descricao = 'Pix contestado pelo banco') =>
    cantina.post(`/v1/admin/alunos/${alunoId}/ajustes`, { valorCentavos, descricao });

  it('crédito e débito pelo ledger, com auditoria (saldo antes e depois)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 2000 });
    const r = await ajustar(a.alunoId, -500);
    expect(r.status).toBe(201);
    expect(r.body.saldoCentavos).toBe(1500);
    expect((await ajustar(a.alunoId, 300, 'Cortesia da cantina')).body.saldoCentavos).toBe(1800);

    const tx = await ledger(a.contaId);
    expect(tx.slice(-2).map((t) => [t.tipo, t.valor_centavos, t.usuario_id])).toEqual([
      ['AJUSTE', -500, escola.adminId],
      ['AJUSTE', 300, escola.adminId],
    ]);
    const aud = await db('auditoria_lanchei').where({ acao: 'AJUSTE_SALDO', aluno_id: a.alunoId }).orderBy('id').first();
    expect(aud.antes).toEqual({ saldoCentavos: 2000 });
    expect(aud.depois).toMatchObject({ saldoCentavos: 1500, valorCentavos: -500 });
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('nunca deixa o saldo negativo; valor zero e descrição curta são recusados', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const r = await ajustar(a.alunoId, -1001);
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('SALDO_INSUFICIENTE');
    expect(await saldo(a.contaId)).toBe(1000);
    expect((await ajustar(a.alunoId, 0)).status).toBe(400);
    expect((await ajustar(a.alunoId, 100, 'x')).status).toBe(400);
    expect((await ajustar(a.alunoId, 10.5)).status).toBe(400); // centavos são inteiros
  });

  it('clique duplo: 6 ajustes IDÊNTICOS simultâneos → 1 lançado, 5 recusados com 409', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const respostas = await Promise.all(Array.from({ length: 6 }, () => ajustar(a.alunoId, 500, 'Devolução de troco errado')));
    expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respostas.filter((r) => r.body.erro?.codigo === 'AJUSTE_DUPLICADO')).toHaveLength(5);
    expect(await saldo(a.contaId)).toBe(1500);
    // Outro ajuste (descrição diferente) passa normalmente.
    expect((await ajustar(a.alunoId, 500, 'Segunda devolução, outro dia')).status).toBe(201);
  });

  it('aluno de outra escola → 404', async () => {
    const alheio = await criarAluno(await criarEscola(), { saldoCentavos: 1000 });
    expect((await ajustar(alheio.alunoId, 100)).status).toBe(404);
    expect(await saldo(alheio.contaId)).toBe(1000);
  });
});

describe('encerramento com reembolso', () => {
  const encerrar = (alunoId: number, corpo: object = { motivo: 'Transferido de escola', reembolso: { forma: 'PIX', comprovanteRef: 'E123' } }) =>
    cantina.post(`/v1/admin/alunos/${alunoId}/encerramento`, corpo);

  it('com saldo, exige o reembolso (422 SALDO_PENDENTE) e nada muda', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 3700 });
    const r = await encerrar(a.alunoId, { motivo: 'Formatura' });
    expect(r.status).toBe(422);
    expect(r.body.erro).toMatchObject({ codigo: 'SALDO_PENDENTE', detalhes: { saldoCentavos: 3700 } });
    expect((await db('alunos_lanchei').where({ id: a.alunoId }).first()).status).toBe('ATIVO');
    expect(await saldo(a.contaId)).toBe(3700);
  });

  it('zera o saldo com REEMBOLSO no ledger, encerra, revoga carteirinha e convites, audita e avisa por e-mail', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 3700 });
    const [conviteId] = await db('convites_responsavel_lanchei').insert({
      escola_id: escola.escolaId, aluno_id: a.alunoId, email: 'pendente@teste.com', codigo_hash: Buffer.alloc(32, a.alunoId % 251),
      expira_em: new Date(Date.now() + HORA), criado_por_usuario_id: escola.diretoriaId,
    });

    const r = await encerrar(a.alunoId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ENCERRADO', reembolso: { valorCentavos: 3700, forma: 'PIX' } });

    expect(await saldo(a.contaId)).toBe(0);
    const tx = (await ledger(a.contaId)).at(-1);
    expect(tx).toMatchObject({ tipo: 'REEMBOLSO', valor_centavos: -3700, saldo_apos_centavos: 0, usuario_id: escola.adminId, reembolso_id: r.body.reembolso.id });
    expect(await db('reembolsos_lanchei').where({ id: r.body.reembolso.id }).first()).toMatchObject({
      valor_centavos: 3700, forma: 'PIX', comprovante_ref: 'E123', motivo: 'Transferido de escola', usuario_id: escola.adminId,
    });

    const aluno = await db('alunos_lanchei').where({ id: a.alunoId }).first();
    expect(aluno.status).toBe('ENCERRADO');
    expect(aluno.encerrado_em).not.toBeNull();
    expect((await operador.post('/v1/caixa/identificar', { qrConteudo: a.qr })).status).toBe(404); // carteirinha revogada
    expect((await db('convites_responsavel_lanchei').where({ id: conviteId }).first()).revogado_em).not.toBeNull();

    const aud = await db('auditoria_lanchei').where({ acao: 'ALUNO_ENCERRAR', aluno_id: a.alunoId }).first();
    expect(aud.antes).toEqual({ status: 'ATIVO', saldoCentavos: 3700 });
    expect(aud.depois.reembolso).toMatchObject({ valorCentavos: 3700, forma: 'PIX', comprovanteRef: 'E123' });

    await aguardarEmailsPendentes();
    const resp = await db('responsaveis_lanchei').where({ id: a.responsavelIds[0] }).first();
    const email = emailsPara(resp.email).at(-1)!;
    expect(email.assunto).toContain('encerrada');
    expect(email.texto).toMatch(/R\$\s?37,00/);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });

    // Segunda vez: 409, e o ledger não ganha outro reembolso.
    expect((await encerrar(a.alunoId)).body.erro.codigo).toBe('JA_ENCERRADO');
    expect((await ledger(a.contaId)).filter((t) => t.tipo === 'REEMBOLSO')).toHaveLength(1);
  });

  it('sem saldo, encerra sem reembolso (e não cria lançamento)', async () => {
    const a = await criarAluno(escola);
    const r = await encerrar(a.alunoId, { motivo: 'Formatura' });
    expect(r.body).toEqual({ status: 'ENCERRADO', reembolso: null });
    expect(await ledger(a.contaId)).toHaveLength(0);
  });

  it('Pix em aberto bloqueia o encerramento (409); vencido não bloqueia', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const [depId] = await db('depositos_lanchei').insert({
      escola_id: escola.escolaId, conta_id: a.contaId, responsavel_id: a.responsavelIds[0], valor_centavos: 5000,
      idempotency_key: novaChave(), status: 'PENDENTE', expira_em: new Date(Date.now() + 20 * 60_000),
    });
    expect((await encerrar(a.alunoId)).body.erro.codigo).toBe('DEPOSITO_PENDENTE');
    await db('depositos_lanchei').where({ id: depId }).update({ expira_em: new Date(Date.now() - 1000) });
    expect((await encerrar(a.alunoId)).status).toBe(200);
  });

  it('5 encerramentos SIMULTÂNEOS: 1 passa, 1 reembolso, saldo 0', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 2500 });
    const respostas = await Promise.all(Array.from({ length: 5 }, () => encerrar(a.alunoId)));
    expect(respostas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(respostas.filter((r) => r.body.erro?.codigo === 'JA_ENCERRADO')).toHaveLength(4);
    expect(await saldo(a.contaId)).toBe(0);
    expect(await db('reembolsos_lanchei').where({ conta_id: a.contaId })).toHaveLength(1);
  });

  it('encerramento disputando com 10 compras: o que foi vendido + o reembolso = saldo inicial, e a conta fecha zerada', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const [enc, ...compras] = await Promise.all([
      encerrar(a.alunoId),
      ...Array.from({ length: 10 }, () => comprar(a.qr, escola.produtos.suco).catch((e: unknown) => e)),
    ]);
    expect(enc.status).toBe(200);
    const vendido = compras.filter((c) => (c as { status?: string }).status === 'CONFIRMADO').length * 600;
    expect(vendido + enc.body.reembolso.valorCentavos).toBe(5000);
    expect(await saldo(a.contaId)).toBe(0);
    expect(await divergencias()).toEqual({ contas: 0, estoque: 0 });
  });

  it('conta encerrada: ajuste de crédito é recusado; débito é aceito (crédito que chegou atrasado)', async () => {
    const a = await criarAluno(escola);
    await encerrar(a.alunoId, { motivo: 'Saiu' });
    const credito = await cantina.post(`/v1/admin/alunos/${a.alunoId}/ajustes`, { valorCentavos: 500, descricao: 'Tentativa de crédito' });
    expect(credito.body.erro.codigo).toBe('ALUNO_ENCERRADO');

    // Um Pix pago no último segundo é creditado mesmo com a conta encerrada (o dinheiro entrou).
    await creditar(escola.escolaId, a.contaId, a.responsavelIds[0]!, 2500);
    const resumo = await cantina.get('/v1/admin/resumo');
    expect(resumo.body.alertas).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'ENCERRADO_COM_SALDO', quantidade: 1 })]));
    // A cantina devolve à família e zera com um ajuste negativo.
    const debito = await cantina.post(`/v1/admin/alunos/${a.alunoId}/ajustes`, { valorCentavos: -2500, descricao: 'Devolvido por Pix após o encerramento' });
    expect(debito.status).toBe(201);
    expect(await saldo(a.contaId)).toBe(0);
  });
});

describe('estorno pelo admin', () => {
  it('admin estorna pedido de OUTRO dia; o operador não', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 2000 });
    const antigo = await comprar(a.qr, escola.produtos.suco, 1, haHoras(72));
    if (antigo.status !== 'CONFIRMADO') throw new Error('compra deveria passar');

    const op = await operador.post(`/v1/caixa/pedidos/${antigo.pedido.id}/estorno`, { motivo: 'Cobrado errado', devolverEstoque: false });
    expect(op.status).toBe(403);

    const r = await cantina.post(`/v1/admin/pedidos/${antigo.pedido.id}/estorno`, { motivo: 'Cobrado errado', devolverEstoque: false });
    expect(r.status).toBe(200);
    expect(await saldo(a.contaId)).toBe(2000);
    expect((await cantina.post(`/v1/admin/pedidos/${antigo.pedido.id}/estorno`, { motivo: 'De novo', devolverEstoque: false })).body.erro.codigo).toBe('JA_ESTORNADO');
  });

  it('pedido de outra escola → 404', async () => {
    const outra = await criarEscola();
    const b = await criarAluno(outra, { saldoCentavos: 2000 });
    const p = await realizarCompra({
      escolaId: outra.escolaId, operadorId: outra.operadorId, idempotencyKey: novaChave(),
      identificacao: { tipo: 'CARTEIRINHA', qrConteudo: b.qr }, itens: [{ produtoId: outra.produtos.suco, quantidade: 1 }],
    });
    if (p.status !== 'CONFIRMADO') throw new Error('compra deveria passar');
    expect((await cantina.post(`/v1/admin/pedidos/${p.pedido.id}/estorno`, { motivo: 'Invasão', devolverEstoque: false })).status).toBe(404);
    expect((await cantina.get(`/v1/admin/pedidos/${p.pedido.id}`)).status).toBe(404);
    expect(await saldo(b.contaId)).toBe(1400);
  });
});
