// VENDA MANUAL (contingência): a internet caiu, a cantina vendeu "no
// caderno" e o admin lança depois (POST /v1/admin/vendas-manuais).
//
// É o mesmo fluxo de compra.servico.ts, com a mesma ordem de locks e a mesma
// idempotência, mas valida SÓ saldo e estoque: a venda já aconteceu no mundo
// real, então dia permitido, bloqueios e limites não têm mais o que impedir.
//
//   1. LOCK da conta do aluno
//   2. Idempotency-Key (depois do lock: clique duplo fica em fila)
//   3. LOCK dos produtos com estoque (ordem crescente de id)
//   4. pedido MANUAL + itens + débito no ledger + baixa de estoque
//      + auditoria + aviso aos responsáveis, tudo na mesma transação
//
// Se o saldo não cobre a venda, NADA é gravado (422 SALDO_INSUFICIENTE): o
// saldo nunca fica negativo. A cantina resolve com a família (um depósito)
// e lança de novo.
//
// Datas: o pedido fica com created_at = QUANDO A VENDA ACONTECEU (ocorridoEm),
// e o lançamento no ledger fica com o instante em que o saldo mudou de fato
// (agora). Assim a venda conta no LIMITE e nos RELATÓRIOS do dia em que
// ocorreu. Se usássemos "agora" no pedido, uma venda de segunda lançada na
// terça consumiria o limite diário da terça, e o aluno seria recusado no
// caixa sem ter comprado nada naquele dia.
import { DateTime } from 'luxon';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { erros } from '../../erros.js';
import { lancarTransacao } from '../../dominio/ledger.js';
import { movimentarEstoque, travarProdutosComEstoque } from '../../dominio/estoque.js';
import { notificarResponsaveis, primeiroNome, reais } from '../../dominio/notificacoes.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { agruparItens, resultadoDePedidoExistente, type ItemPedido, type ResultadoCompra } from '../caixa/compra.servico.js';

/** Até quantos dias para trás uma venda manual pode ser lançada. */
export const MAX_DIAS_VENDA_MANUAL = 60;

export interface EntradaVendaManual {
  escolaId: number;
  ator: AtorUsuario; // o ADMIN que está lançando
  idempotencyKey: string;
  alunoId: number;
  itens: ItemPedido[];
  ocorridoEm: Date;
  observacao: string;
  agora?: Date;
}

const chaveReutilizada = () => erros.conflito('IDEMPOTENCY_KEY_REUTILIZADA', 'Esta Idempotency-Key já foi usada em outro pedido.');

export async function registrarVendaManual(e: EntradaVendaManual): Promise<ResultadoCompra> {
  const agora = e.agora ?? new Date();
  const itens = agruparItens(e.itens);
  if (itens.length === 0) throw erros.regra('PEDIDO_VAZIO', 'O pedido não tem itens.');
  if (e.ocorridoEm > agora) throw erros.regra('DATA_NO_FUTURO', 'A venda não pode ter acontecido no futuro.');
  if (e.ocorridoEm.getTime() < agora.getTime() - MAX_DIAS_VENDA_MANUAL * 86_400_000) {
    throw erros.regra('DATA_MUITO_ANTIGA', `Vendas manuais só podem ser lançadas até ${MAX_DIAS_VENDA_MANUAL} dias depois.`);
  }

  try {
    return await db.transaction(async (trx) => {
      const { escolaId } = e;

      // 1) LOCK da conta (primeiro lock, como em todo o sistema).
      const conta = await trx('contas_lanchei')
        .where({ aluno_id: e.alunoId, escola_id: escolaId })
        .forUpdate()
        .first<{ id: number; saldo_centavos: number } | undefined>('id', 'saldo_centavos');
      if (!conta) throw erros.naoEncontrado('Aluno não encontrado.');

      // 2) Idempotência, depois do lock.
      const existente = await trx('pedidos_lanchei').where({ escola_id: escolaId, idempotency_key: e.idempotencyKey }).first();
      if (existente) {
        if (existente.aluno_id !== e.alunoId || existente.modo_identificacao !== 'MANUAL') throw chaveReutilizada();
        return resultadoDePedidoExistente(trx, existente);
      }

      const aluno = await trx('alunos_lanchei as a')
        .join('regras_aluno_lanchei as r', 'r.aluno_id', 'a.id')
        .join('escolas_lanchei as e', 'e.id', 'a.escola_id')
        .where('a.id', e.alunoId)
        .first<{ nome: string; status: string; alerta_saldo_baixo_centavos: number | null; timezone: string }>(
          'a.nome', 'a.status', 'r.alerta_saldo_baixo_centavos', 'e.timezone',
        );
      if (!aluno) throw erros.naoEncontrado('Aluno não encontrado.');
      // INATIVO passa (a venda já aconteceu); ENCERRADO não: a conta foi fechada e reembolsada.
      if (aluno.status === 'ENCERRADO') throw erros.regra('ALUNO_ENCERRADO', 'Este aluno está encerrado; a conta dele foi fechada.');

      const produtoIds = itens.map((i) => i.produtoId);
      const produtos = await trx('produtos_lanchei')
        .where({ escola_id: escolaId, ativo: true })
        .whereIn('id', produtoIds)
        .select<{ id: number; nome: string; categoria_id: number; preco_centavos: number; controla_estoque: boolean }[]>(
          'id', 'nome', 'categoria_id', 'preco_centavos', 'controla_estoque',
        );
      const produtoPorId = new Map(produtos.map((p) => [p.id, p]));
      const indisponiveis = produtoIds.filter((id) => !produtoPorId.has(id));
      if (indisponiveis.length > 0) {
        throw erros.regra('PRODUTO_INDISPONIVEL', 'Produto inexistente ou inativo.', { produtoIds: indisponiveis });
      }

      // 3) LOCK + checagem de estoque.
      const estoque = await travarProdutosComEstoque(trx, escolaId, produtos.filter((p) => p.controla_estoque).map((p) => p.id));
      const faltas = itens
        .filter((i) => estoque.has(i.produtoId) && i.quantidade > estoque.get(i.produtoId)!)
        .map((i) => ({ produtoId: i.produtoId, disponivel: estoque.get(i.produtoId)! }));
      if (faltas.length > 0) {
        throw erros.conflito('ESTOQUE_INSUFICIENTE', 'O estoque do sistema não cobre esta venda. Lance a entrada ou ajuste o estoque antes.', { itens: faltas });
      }

      // Total com o preço ATUAL do banco (o admin não digita preço).
      const linhas = itens.map((i) => {
        const p = produtoPorId.get(i.produtoId)!;
        return { ...i, nome: p.nome, categoriaId: p.categoria_id, preco: p.preco_centavos, subtotal: p.preco_centavos * i.quantidade };
      });
      const total = linhas.reduce((s, l) => s + l.subtotal, 0);

      // Saldo: aqui pode mostrar quanto falta, porque quem lança é o ADMIN (não é a tela do caixa).
      if (total > conta.saldo_centavos) {
        throw erros.regra('SALDO_INSUFICIENTE', 'O saldo do aluno não cobre esta venda. Nada foi lançado.', {
          totalCentavos: total,
          saldoCentavos: conta.saldo_centavos,
          faltamCentavos: total - conta.saldo_centavos,
        });
      }

      // 4) Pedido MANUAL (o banco exige observacao e ocorrido_em neste modo).
      const [pedidoId] = await trx('pedidos_lanchei').insert({
        escola_id: escolaId,
        aluno_id: e.alunoId,
        conta_id: conta.id,
        operador_id: e.ator.id,
        modo_identificacao: 'MANUAL',
        carteirinha_id: null,
        idempotency_key: e.idempotencyKey,
        status: 'CONFIRMADO',
        total_centavos: total,
        observacao: e.observacao,
        ocorrido_em: e.ocorridoEm,
        created_at: e.ocorridoEm, // ver o comentário "Datas" no topo
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

      const lanc = await lancarTransacao(trx, {
        escolaId,
        contaId: conta.id,
        tipo: 'COMPRA',
        valorCentavos: -total,
        pedidoId: pedidoId!,
        descricao: `Venda manual: ${linhas.map((l) => `${l.quantidade}x ${l.nome}`).join(', ')}`.slice(0, 255),
        criadoEm: agora,
      });

      for (const l of [...linhas].sort((a, b) => a.produtoId - b.produtoId)) {
        if (estoque.has(l.produtoId)) {
          await movimentarEstoque(trx, { escolaId, produtoId: l.produtoId, tipo: 'VENDA', quantidade: -l.quantidade, pedidoId: pedidoId!, criadoEm: agora });
        }
      }

      await auditarUsuario(trx, e.ator, {
        escolaId,
        acao: 'VENDA_MANUAL',
        entidade: 'pedidos',
        entidadeId: pedidoId!,
        alunoId: e.alunoId,
        depois: { totalCentavos: total, ocorridoEm: e.ocorridoEm.toISOString(), observacao: e.observacao },
      });

      const nome = primeiroNome(aluno.nome);
      const quando = DateTime.fromJSDate(e.ocorridoEm, { zone: aluno.timezone }).toFormat("dd/MM 'às' HH:mm");
      await notificarResponsaveis(trx, {
        alunoId: e.alunoId,
        tipo: 'COMPRA',
        titulo: 'Compra na cantina',
        corpo: `${nome} comprou ${reais(total)} na cantina em ${quando} (lançada agora pela cantina).`,
        dados: { pedidoId, totalCentavos: total, manual: true },
        criadoEm: agora,
      });
      const alerta = aluno.alerta_saldo_baixo_centavos;
      if (alerta !== null && lanc.saldoAntesCentavos >= alerta && lanc.saldoAposCentavos < alerta) {
        await notificarResponsaveis(trx, {
          alunoId: e.alunoId,
          tipo: 'SALDO_BAIXO',
          titulo: 'Saldo baixo',
          corpo: `O saldo de ${nome} está em ${reais(lanc.saldoAposCentavos)}.`,
          dados: { saldoCentavos: lanc.saldoAposCentavos },
          criadoEm: agora,
        });
      }

      return {
        status: 'CONFIRMADO' as const,
        pedido: {
          id: pedidoId!,
          status: 'CONFIRMADO' as const,
          totalCentavos: total,
          itens: linhas.map((l) => ({ produtoId: l.produtoId, nome: l.nome, quantidade: l.quantidade, precoUnitarioCentavos: l.preco, subtotalCentavos: l.subtotal })),
        },
      };
    });
  } catch (erro) {
    // Mesma chave usada ao mesmo tempo para OUTRO aluno: a UNIQUE do banco pega.
    if (ehChaveDuplicada(erro)) throw chaveReutilizada();
    throw erro;
  }
}
