// Início da Cantina (GET /admin/resumo): os números do dia e os alertas que
// pedem ação. "Dia" é sempre o dia no fuso da escola (etapa6 §4.1).
import { db } from '../../infra/db.js';
import { dataNaEscola, intervaloDeDatas } from '../../dominio/periodos.js';
import { listarEstoque } from '../estoque/estoque.servico.js';
import { fusoDaEscola } from './acesso.js';
import { DIAS_AVISO_EXPIRACAO } from './mercadopago.servico.js';

/** Alertas de depósito olham os últimos 30 dias (depois disso, já foi tratado ou esquecido). */
const DIAS_ALERTA_DEPOSITO = 30;

export interface Alerta {
  tipo: 'MP_DESCONECTADO' | 'MP_EXPIRANDO' | 'DEPOSITO_DEVOLVIDO' | 'DEPOSITO_VALOR_DIVERGENTE' | 'RECONCILIACAO' | 'ENCERRADO_COM_SALDO';
  mensagem: string;
  quantidade?: number;
}

export async function resumoDoDia(escolaId: number, data: string | undefined, agora = new Date()) {
  const timezone = await fusoDaEscola(db, escolaId);
  const dia = data ?? dataNaEscola(agora, timezone);
  const { inicio, fim } = intervaloDeDatas(dia, dia, timezone);

  const noDia = () => db('pedidos_lanchei').where({ escola_id: escolaId }).where('created_at', '>=', inicio!).where('created_at', '<', fim!);

  const [vendas, recusas, depositos, estoqueBaixo, alertas] = await Promise.all([
    noDia().where({ status: 'CONFIRMADO' }).first(db.raw('COALESCE(SUM(total_centavos), 0) AS total'), db.raw('COUNT(*) AS pedidos')),
    noDia().where({ status: 'RECUSADO' }).groupBy('motivo_recusa').orderBy('qtd', 'desc').select<{ motivo_recusa: string; qtd: number }[]>('motivo_recusa', db.raw('COUNT(*) AS qtd')),
    db('depositos_lanchei')
      .where({ escola_id: escolaId })
      .whereIn('status', ['APROVADO', 'DEVOLVIDO'])
      .where('aprovado_em', '>=', inicio!)
      .where('aprovado_em', '<', fim!)
      .first(db.raw('COALESCE(SUM(valor_centavos), 0) AS total'), db.raw('COUNT(*) AS qtd')),
    listarEstoque(escolaId, true),
    alertasDaCantina(escolaId, agora),
  ]);

  const totalCentavos = Number(vendas.total);
  const pedidos = Number(vendas.pedidos);
  return {
    data: dia,
    vendas: { totalCentavos, pedidos, ticketMedioCentavos: pedidos === 0 ? 0 : Math.round(totalCentavos / pedidos) },
    depositos: { totalCentavos: Number(depositos.total), quantidade: Number(depositos.qtd) },
    // Muitas recusas por saldo = falta recarga; por limite/bloqueio = pais travando.
    recusasPorMotivo: recusas.map((r) => ({ motivo: r.motivo_recusa, quantidade: Number(r.qtd) })),
    estoqueBaixo,
    alertas,
  };
}

async function alertasDaCantina(escolaId: number, agora: Date): Promise<Alerta[]> {
  const alertas: Alerta[] = [];
  const contar = async (q: PromiseLike<{ n: number | string }[]>) => Number((await q)[0]?.n ?? 0);
  const desde = new Date(agora.getTime() - DIAS_ALERTA_DEPOSITO * 86_400_000);

  const mp = await db('escola_mercadopago_lanchei').where({ escola_id: escolaId }).first<{ token_expira_em: Date } | undefined>('token_expira_em');
  if (!mp) {
    alertas.push({ tipo: 'MP_DESCONECTADO', mensagem: 'Conecte a conta Mercado Pago da cantina para os pais poderem depositar por Pix.' });
  } else if (mp.token_expira_em.getTime() - agora.getTime() < DIAS_AVISO_EXPIRACAO * 86_400_000) {
    alertas.push({ tipo: 'MP_EXPIRANDO', mensagem: 'A autorização do Mercado Pago está perto de expirar. Conecte a conta de novo em Configurações.' });
  }

  const eventos = async (acao: string) =>
    contar(db('auditoria_lanchei').where({ escola_id: escolaId, acao }).where('created_at', '>=', desde).count<{ n: number }[]>({ n: '*' }));
  const devolvidos = await eventos('DEPOSITO_DEVOLVIDO');
  if (devolvidos > 0) {
    alertas.push({
      tipo: 'DEPOSITO_DEVOLVIDO',
      quantidade: devolvidos,
      mensagem: 'Pix devolvido ou contestado depois de creditado. Confira o saldo do aluno e, se for o caso, lance um ajuste.',
    });
  }
  const divergentes = await eventos('DEPOSITO_VALOR_DIVERGENTE');
  if (divergentes > 0) {
    alertas.push({ tipo: 'DEPOSITO_VALOR_DIVERGENTE', quantidade: divergentes, mensagem: 'Pagamento com valor diferente do depósito. Não foi creditado; confira no Mercado Pago.' });
  }

  // As views de reconciliação devem estar SEMPRE vazias. Se aparecer algo, é bug: avisa.
  const contasDiv = await contar(db('vw_contas_divergentes_lanchei').where({ escola_id: escolaId }).count<{ n: number }[]>({ n: '*' }));
  const estoqueDiv = await contar(db('vw_estoque_divergente_lanchei').where({ escola_id: escolaId }).count<{ n: number }[]>({ n: '*' }));
  if (contasDiv + estoqueDiv > 0) {
    alertas.push({ tipo: 'RECONCILIACAO', quantidade: contasDiv + estoqueDiv, mensagem: 'A conferência automática encontrou divergência de saldo ou estoque. Avise o suporte do Lanchei.' });
  }

  const encerradosComSaldo = await contar(
    db('contas_lanchei as c')
      .join('alunos_lanchei as a', 'a.id', 'c.aluno_id')
      .where({ 'c.escola_id': escolaId, 'a.status': 'ENCERRADO' })
      .where('c.saldo_centavos', '>', 0)
      .count<{ n: number }[]>({ n: '*' }),
  );
  if (encerradosComSaldo > 0) {
    alertas.push({
      tipo: 'ENCERRADO_COM_SALDO',
      quantidade: encerradosComSaldo,
      mensagem: 'Aluno encerrado recebeu um crédito depois do encerramento. Devolva o valor à família e lance um ajuste negativo.',
    });
  }
  return alertas;
}
