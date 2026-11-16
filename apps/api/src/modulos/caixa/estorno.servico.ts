// Estorno total de um pedido. Operador: só pedidos do dia (fuso da escola).
// Admin: qualquer data. Devolver ao estoque é opcional (lanche comido não volta).
import { db } from '../../infra/db.js';
import { erros } from '../../erros.js';
import { lancarTransacao, travarConta } from '../../dominio/ledger.js';
import { movimentarEstoque } from '../../dominio/estoque.js';
import { mesmoDiaNaEscola } from '../../dominio/periodos.js';
import { notificarResponsaveis, primeiroNome, reais } from '../../dominio/notificacoes.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';

export interface EntradaEstorno {
  escolaId: number;
  pedidoId: number;
  usuario: { id: number; papel: 'ADMIN' | 'OPERADOR' };
  motivo: string;
  devolverEstoque: boolean;
  agora?: Date;
}

export async function estornarPedido(e: EntradaEstorno) {
  const agora = e.agora ?? new Date();

  return db.transaction(async (trx) => {
    // Descobre a conta sem lock, trava a CONTA primeiro (mesma ordem da compra)
    // e só então trava o pedido.
    const ref = await trx('pedidos_lanchei')
      .where({ id: e.pedidoId, escola_id: e.escolaId })
      .first<{ conta_id: number } | undefined>('conta_id');
    if (!ref) throw erros.naoEncontrado('Pedido não encontrado.');
    await travarConta(trx, e.escolaId, ref.conta_id);

    const pedido = await trx('pedidos_lanchei')
      .where({ id: e.pedidoId })
      .forUpdate()
      .first<{ id: number; aluno_id: number; conta_id: number; status: string; total_centavos: number; created_at: Date }>();
    if (!pedido) throw erros.naoEncontrado('Pedido não encontrado.');
    if (pedido.status === 'RECUSADO') throw erros.regra('PEDIDO_RECUSADO', 'Pedido recusado não tem o que estornar.');
    if (pedido.status === 'ESTORNADO') throw erros.conflito('JA_ESTORNADO', 'Este pedido já foi estornado.');

    if (e.usuario.papel === 'OPERADOR') {
      const escola = await trx('escolas_lanchei').where({ id: e.escolaId }).first<{ timezone: string }>('timezone');
      if (!mesmoDiaNaEscola(pedido.created_at, agora, escola!.timezone)) {
        throw erros.semPermissao('O caixa só estorna pedidos do dia. Peça ao administrador.');
      }
    }

    await trx('pedidos_lanchei').where({ id: pedido.id }).update({
      status: 'ESTORNADO',
      estornado_em: agora,
      estornado_por_usuario_id: e.usuario.id,
      motivo_estorno: e.motivo,
    });

    await lancarTransacao(trx, {
      escolaId: e.escolaId,
      contaId: pedido.conta_id,
      tipo: 'ESTORNO',
      valorCentavos: pedido.total_centavos,
      pedidoId: pedido.id,
      usuarioId: e.usuario.id,
      descricao: `Estorno: ${e.motivo}`.slice(0, 255),
      criadoEm: agora,
    });

    if (e.devolverEstoque) {
      // Só produtos que (ainda) controlam estoque; ordem por id evita deadlock.
      const itens = await trx('pedido_itens_lanchei as i')
        .join('produtos_lanchei as p', 'p.id', 'i.produto_id')
        .where({ 'i.pedido_id': pedido.id, 'p.controla_estoque': true })
        .groupBy('i.produto_id')
        .orderBy('i.produto_id')
        .select<{ produto_id: number; qtd: number }[]>('i.produto_id', trx.raw('SUM(i.quantidade) AS qtd'));
      for (const item of itens) {
        await movimentarEstoque(trx, {
          escolaId: e.escolaId,
          produtoId: item.produto_id,
          tipo: 'ESTORNO',
          quantidade: Number(item.qtd),
          pedidoId: pedido.id,
          usuarioId: e.usuario.id,
          criadoEm: agora,
        });
      }
    }

    await registrarAuditoria(trx, {
      escolaId: e.escolaId,
      ator: { tipo: 'USUARIO', id: e.usuario.id },
      acao: 'PEDIDO_ESTORNAR',
      entidade: 'pedidos',
      entidadeId: pedido.id,
      alunoId: pedido.aluno_id,
      depois: { motivo: e.motivo, devolverEstoque: e.devolverEstoque, totalCentavos: pedido.total_centavos },
    });

    const aluno = await trx('alunos_lanchei').where({ id: pedido.aluno_id }).first<{ nome: string }>('nome');
    await notificarResponsaveis(trx, {
      alunoId: pedido.aluno_id,
      tipo: 'ESTORNO',
      titulo: 'Compra estornada',
      corpo: `Uma compra de ${reais(pedido.total_centavos)} de ${primeiroNome(aluno!.nome)} foi estornada.`,
      dados: { pedidoId: pedido.id },
      criadoEm: agora,
    });

    // Sem saldo na resposta: o caixa nunca vê saldo do aluno.
    return { pedidoId: pedido.id, status: 'ESTORNADO' as const };
  });
}
