// FLUXO DE COMPRA (POST /v1/caixa/pedidos)
//
// Tudo numa única transação MySQL. Ordem dos locks (sempre a mesma em todo
// o sistema, para não haver deadlock):
//   1. conta do aluno       (SELECT ... FOR UPDATE)
//   2. produtos com estoque (FOR UPDATE, em ordem crescente de id)
//
// Garantias:
//   • Clique duplo / retry de rede: mesma Idempotency-Key => mesma resposta,
//     sem debitar de novo. A checagem acontece DEPOIS do lock da conta, então
//     duas requisições simultâneas com a mesma chave ficam em fila e a segunda
//     sempre encontra o pedido da primeira.
//   • Saldo nunca negativo, mesmo com dois caixas cobrando o mesmo aluno ao
//     mesmo tempo (o lock da conta serializa).
//   • Preços SEMPRE do banco, nunca do front.
//   • Recusas são gravadas (pedido RECUSADO) e notificam os responsáveis.
//   • Falta de estoque NÃO grava nada e NÃO notifica (culpa não é do aluno).
import { db, ehChaveDuplicada, type Trx } from '../../infra/db.js';
import { erros } from '../../erros.js';
import { lancarTransacao } from '../../dominio/ledger.js';
import { movimentarEstoque, travarProdutosComEstoque } from '../../dominio/estoque.js';
import { avaliarCompra, MENSAGENS_RECUSA, type MotivoRecusa } from '../../dominio/regrasCompra.js';
import { diaIsoNaEscola, intervaloDoPeriodo } from '../../dominio/periodos.js';
import { notificarResponsaveis, primeiroNome, reais } from '../../dominio/notificacoes.js';
import { identificarPorQr, verificarPinAluno, type AlunoIdentificado } from './identificacao.js';

export type Identificacao =
  | { tipo: 'CARTEIRINHA'; qrConteudo: string }
  | { tipo: 'PIN'; alunoId: number; pin: string };

export interface ItemPedido {
  produtoId: number;
  quantidade: number;
}

export interface EntradaCompra {
  escolaId: number;
  operadorId: number;
  idempotencyKey: string;
  identificacao: Identificacao;
  itens: ItemPedido[];
  /** Injetável para testes. */
  agora?: Date;
}

export interface ItemResumo {
  produtoId: number;
  nome: string;
  quantidade: number;
  precoUnitarioCentavos: number;
  subtotalCentavos: number;
}

export type ResultadoCompra =
  | {
      status: 'CONFIRMADO' | 'ESTORNADO';
      pedido: { id: number; status: 'CONFIRMADO' | 'ESTORNADO'; totalCentavos: number; itens: ItemResumo[] };
    }
  | { status: 'RECUSADO'; pedidoId: number; motivo: MotivoRecusa; mensagem: string; produtoIds?: number[] };

const MINUTOS_ENTRE_AVISOS_DE_RECUSA = 30;

/** Junta linhas repetidas do mesmo produto: [{7,1},{7,2}] -> [{7,3}] */
export function agruparItens(itens: ItemPedido[]): ItemPedido[] {
  const mapa = new Map<number, number>();
  for (const i of itens) mapa.set(i.produtoId, (mapa.get(i.produtoId) ?? 0) + i.quantidade);
  return [...mapa].map(([produtoId, quantidade]) => ({ produtoId, quantidade }));
}

export async function realizarCompra(entrada: EntradaCompra): Promise<ResultadoCompra> {
  const agora = entrada.agora ?? new Date();
  const itens = agruparItens(entrada.itens);
  if (itens.length === 0) throw erros.regra('PEDIDO_VAZIO', 'O pedido não tem itens.');

  // Identificação acontece ANTES da transação: o PIN errado precisa gravar a
  // tentativa mesmo quando a compra não segue.
  let quem: AlunoIdentificado;
  if (entrada.identificacao.tipo === 'CARTEIRINHA') {
    quem = await identificarPorQr(entrada.escolaId, entrada.identificacao.qrConteudo);
  } else {
    await verificarPinAluno(entrada.escolaId, entrada.identificacao.alunoId, entrada.identificacao.pin, agora);
    quem = { alunoId: entrada.identificacao.alunoId, carteirinhaId: null, carteirinhaStatus: null };
  }

  try {
    return await db.transaction((trx) => executarCompra(trx, entrada, quem, itens, agora));
  } catch (erro) {
    // Mesma chave usada ao mesmo tempo para OUTRO aluno (o lock da conta não
    // serializa contas diferentes): a UNIQUE do banco pega.
    if (ehChaveDuplicada(erro)) {
      throw erros.conflito('IDEMPOTENCY_KEY_REUTILIZADA', 'Esta Idempotency-Key já foi usada em outro pedido.');
    }
    throw erro;
  }
}

async function executarCompra(
  trx: Trx,
  entrada: EntradaCompra,
  quem: AlunoIdentificado,
  itens: ItemPedido[],
  agora: Date,
): Promise<ResultadoCompra> {
  const { escolaId } = entrada;

  // 1) LOCK da conta do aluno.
  const conta = await trx('contas_lanchei')
    .where({ aluno_id: quem.alunoId, escola_id: escolaId })
    .forUpdate()
    .first<{ id: number; saldo_centavos: number } | undefined>('id', 'saldo_centavos');
  if (!conta) throw erros.naoEncontrado('Aluno não encontrado.');

  // 2) Idempotência (depois do lock!).
  const existente = await trx('pedidos_lanchei')
    .where({ escola_id: escolaId, idempotency_key: entrada.idempotencyKey })
    .first();
  if (existente) {
    if (existente.aluno_id !== quem.alunoId) {
      throw erros.conflito('IDEMPOTENCY_KEY_REUTILIZADA', 'Esta Idempotency-Key já foi usada em outro pedido.');
    }
    return resultadoDePedidoExistente(trx, existente);
  }

  // 3) Dados para as regras.
  const escola = await trx('escolas_lanchei').where({ id: escolaId }).first<{ timezone: string }>('timezone');
  const aluno = await trx('alunos_lanchei')
    .where({ id: quem.alunoId })
    .first<{ nome: string; status: 'ATIVO' | 'INATIVO' | 'ENCERRADO' }>('nome', 'status');
  const regras = await trx('regras_aluno_lanchei').where({ aluno_id: quem.alunoId }).first<{
    limite_diario_centavos: number | null;
    limite_semanal_centavos: number | null;
    limite_mensal_centavos: number | null;
    dias_permitidos: number;
    alerta_saldo_baixo_centavos: number | null;
  }>();
  if (!escola || !aluno || !regras) throw erros.naoEncontrado('Aluno não encontrado.');

  const produtoIds = itens.map((i) => i.produtoId);
  const produtos = await trx('produtos_lanchei')
    .where({ escola_id: escolaId, ativo: true })
    .whereIn('id', produtoIds)
    .select<{ id: number; nome: string; categoria_id: number; preco_centavos: number; controla_estoque: boolean }[]>(
      'id',
      'nome',
      'categoria_id',
      'preco_centavos',
      'controla_estoque',
    );
  const produtoPorId = new Map(produtos.map((p) => [p.id, p]));
  const indisponiveis = produtoIds.filter((id) => !produtoPorId.has(id));
  if (indisponiveis.length > 0) {
    throw erros.regra('PRODUTO_INDISPONIVEL', 'Produto inexistente ou inativo.', { produtoIds: indisponiveis });
  }

  // 4) LOCK + checagem de estoque (antes das regras: sem estoque, nada é gravado).
  const estoque = await travarProdutosComEstoque(
    trx,
    escolaId,
    produtos.filter((p) => p.controla_estoque).map((p) => p.id),
  );
  const faltas = itens
    .filter((i) => estoque.has(i.produtoId) && i.quantidade > estoque.get(i.produtoId)!)
    .map((i) => ({ produtoId: i.produtoId, disponivel: estoque.get(i.produtoId)! }));
  if (faltas.length > 0) {
    throw erros.conflito('ESTOQUE_INSUFICIENTE', 'Estoque insuficiente para um ou mais itens.', { itens: faltas });
  }

  // 5) Itens com snapshot e total calculado com o preço do BANCO.
  const linhas = itens.map((i) => {
    const p = produtoPorId.get(i.produtoId)!;
    return { ...i, nome: p.nome, categoriaId: p.categoria_id, preco: p.preco_centavos, subtotal: p.preco_centavos * i.quantidade };
  });
  const total = linhas.reduce((s, l) => s + l.subtotal, 0);

  // 6) Bloqueios e consumo do período.
  const [catBloq, prodBloq] = await Promise.all([
    trx('bloqueios_categoria_lanchei').where({ aluno_id: quem.alunoId }).pluck<number[]>('categoria_id'),
    trx('bloqueios_produto_lanchei').where({ aluno_id: quem.alunoId }).pluck<number[]>('produto_id'),
  ]);
  const consumo = await consumoNosPeriodos(trx, quem.alunoId, agora, escola.timezone);

  // 7) Regras (função pura).
  const avaliacao = avaliarCompra({
    alunoAtivo: aluno.status === 'ATIVO',
    carteirinhaStatus: quem.carteirinhaStatus,
    diaIso: diaIsoNaEscola(agora, escola.timezone),
    regras: {
      diasPermitidos: regras.dias_permitidos,
      limiteDiarioCentavos: regras.limite_diario_centavos,
      limiteSemanalCentavos: regras.limite_semanal_centavos,
      limiteMensalCentavos: regras.limite_mensal_centavos,
    },
    itens: linhas.map((l) => ({ produtoId: l.produtoId, categoriaId: l.categoriaId })),
    bloqueios: { categoriaIds: new Set(catBloq), produtoIds: new Set(prodBloq) },
    consumo,
    totalCentavos: total,
    saldoCentavos: conta.saldo_centavos,
  });

  // 8) Grava o pedido (aprovado ou recusado) e os itens.
  const [pedidoId] = await trx('pedidos_lanchei').insert({
    escola_id: escolaId,
    aluno_id: quem.alunoId,
    conta_id: conta.id,
    operador_id: entrada.operadorId,
    modo_identificacao: entrada.identificacao.tipo,
    carteirinha_id: quem.carteirinhaId,
    idempotency_key: entrada.idempotencyKey,
    status: avaliacao.aprovado ? 'CONFIRMADO' : 'RECUSADO',
    motivo_recusa: avaliacao.aprovado ? null : avaliacao.motivo,
    total_centavos: total,
    created_at: agora,
  });
  await trx('pedido_itens_lanchei').insert(
    linhas.map((l) => ({
      pedido_id: pedidoId,
      produto_id: l.produtoId,
      categoria_id: l.categoriaId,
      nome_produto: l.nome,
      preco_unitario_centavos: l.preco,
      quantidade: l.quantidade,
    })),
  );

  const nome = primeiroNome(aluno.nome);

  // 9a) Recusado: só registra e avisa os responsáveis.
  if (!avaliacao.aprovado) {
    await avisarRecusa(trx, quem.alunoId, nome, pedidoId!, avaliacao.motivo, total, agora);
    return {
      status: 'RECUSADO',
      pedidoId: pedidoId!,
      motivo: avaliacao.motivo,
      mensagem: MENSAGENS_RECUSA[avaliacao.motivo],
      ...(avaliacao.produtoIds ? { produtoIds: avaliacao.produtoIds } : {}),
    };
  }

  // 9b) Aprovado: débito no ledger + baixa de estoque + notificações.
  const lanc = await lancarTransacao(trx, {
    escolaId,
    contaId: conta.id,
    tipo: 'COMPRA',
    valorCentavos: -total,
    pedidoId: pedidoId!,
    descricao: linhas.map((l) => `${l.quantidade}x ${l.nome}`).join(', ').slice(0, 255),
    criadoEm: agora,
  });

  for (const l of [...linhas].sort((a, b) => a.produtoId - b.produtoId)) {
    if (estoque.has(l.produtoId)) {
      await movimentarEstoque(trx, {
        escolaId,
        produtoId: l.produtoId,
        tipo: 'VENDA',
        quantidade: -l.quantidade,
        pedidoId: pedidoId!,
        criadoEm: agora,
      });
    }
  }

  const semCarteirinha = entrada.identificacao.tipo === 'PIN';
  await notificarResponsaveis(trx, {
    alunoId: quem.alunoId,
    tipo: semCarteirinha ? 'COMPRA_SEM_CARTEIRINHA' : 'COMPRA',
    titulo: semCarteirinha ? 'Compra sem carteirinha' : 'Compra na cantina',
    corpo: semCarteirinha
      ? `${nome} comprou ${reais(total)} usando o PIN (sem carteirinha).`
      : `${nome} comprou ${reais(total)} na cantina.`,
    dados: { pedidoId, totalCentavos: total },
    criadoEm: agora,
  });

  // Saldo baixo: só quando CRUZA o valor de alerta (evita aviso a cada compra).
  const alerta = regras.alerta_saldo_baixo_centavos;
  if (alerta !== null && lanc.saldoAntesCentavos >= alerta && lanc.saldoAposCentavos < alerta) {
    await notificarResponsaveis(trx, {
      alunoId: quem.alunoId,
      tipo: 'SALDO_BAIXO',
      titulo: 'Saldo baixo',
      corpo: `O saldo de ${nome} está em ${reais(lanc.saldoAposCentavos)}.`,
      dados: { saldoCentavos: lanc.saldoAposCentavos },
      criadoEm: agora,
    });
  }

  return {
    status: 'CONFIRMADO',
    pedido: {
      id: pedidoId!,
      status: 'CONFIRMADO',
      totalCentavos: total,
      itens: linhas.map((l) => ({
        produtoId: l.produtoId,
        nome: l.nome,
        quantidade: l.quantidade,
        precoUnitarioCentavos: l.preco,
        subtotalCentavos: l.subtotal,
      })),
    },
  };
}

/** Soma dos pedidos CONFIRMADOS no dia, semana e mês (fuso da escola). */
export async function consumoNosPeriodos(trx: Trx, alunoId: number, agora: Date, timezone: string) {
  const dia = intervaloDoPeriodo(agora, timezone, 'DIA');
  const semana = intervaloDoPeriodo(agora, timezone, 'SEMANA');
  const mes = intervaloDoPeriodo(agora, timezone, 'MES');
  const inicio = semana.inicio < mes.inicio ? semana.inicio : mes.inicio;
  const fim = semana.fim > mes.fim ? semana.fim : mes.fim;

  const soma = (i: { inicio: Date; fim: Date }) =>
    trx.raw('COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN total_centavos ELSE 0 END), 0)', [i.inicio, i.fim]);

  const linha = await trx('pedidos_lanchei')
    .where({ aluno_id: alunoId, status: 'CONFIRMADO' })
    .where('created_at', '>=', inicio)
    .where('created_at', '<', fim)
    .select({ dia: soma(dia), semana: soma(semana), mes: soma(mes) })
    .first<{ dia: number; semana: number; mes: number }>();

  return { dia: Number(linha?.dia ?? 0), semana: Number(linha?.semana ?? 0), mes: Number(linha?.mes ?? 0) };
}

async function avisarRecusa(
  trx: Trx,
  alunoId: number,
  nome: string,
  pedidoId: number,
  motivo: MotivoRecusa,
  total: number,
  agora: Date,
) {
  // No máximo 1 aviso por motivo a cada 30 min (evita spam se o aluno insistir).
  const desde = new Date(agora.getTime() - MINUTOS_ENTRE_AVISOS_DE_RECUSA * 60_000);
  const recente = await trx('notificacoes_lanchei')
    .where({ aluno_id: alunoId, tipo: 'COMPRA_RECUSADA' })
    .where('created_at', '>=', desde)
    .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(dados, '$.motivo')) = ?", [motivo])
    .first('id');
  if (recente) return;

  await notificarResponsaveis(trx, {
    alunoId,
    tipo: 'COMPRA_RECUSADA',
    titulo: 'Compra recusada',
    corpo: `Uma compra de ${reais(total)} de ${nome} foi recusada: ${MENSAGENS_RECUSA[motivo].toLowerCase()}`,
    dados: { pedidoId, motivo },
    criadoEm: agora,
  });
}

async function resultadoDePedidoExistente(
  trx: Trx,
  p: { id: number; status: 'CONFIRMADO' | 'RECUSADO' | 'ESTORNADO'; motivo_recusa: MotivoRecusa | null; total_centavos: number },
): Promise<ResultadoCompra> {
  if (p.status === 'RECUSADO') {
    const motivo = p.motivo_recusa!;
    return { status: 'RECUSADO', pedidoId: p.id, motivo, mensagem: MENSAGENS_RECUSA[motivo] };
  }
  const itens = await trx('pedido_itens_lanchei')
    .where({ pedido_id: p.id })
    .orderBy('id')
    .select<
      { produto_id: number; nome_produto: string; quantidade: number; preco_unitario_centavos: number; subtotal_centavos: number }[]
    >('produto_id', 'nome_produto', 'quantidade', 'preco_unitario_centavos', 'subtotal_centavos');
  return {
    status: p.status,
    pedido: {
      id: p.id,
      status: p.status,
      totalCentavos: p.total_centavos,
      itens: itens.map((i) => ({
        produtoId: i.produto_id,
        nome: i.nome_produto,
        quantidade: i.quantidade,
        precoUnitarioCentavos: i.preco_unitario_centavos,
        subtotalCentavos: i.subtotal_centavos,
      })),
    },
  };
}
