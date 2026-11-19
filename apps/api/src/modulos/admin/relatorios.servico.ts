// Relatórios da Cantina: vendas, depósitos e saldos em aberto. JSON ou CSV.
//
// Só entram pedidos CONFIRMADOS (recusados nunca foram venda; estornados
// foram desfeitos) e depósitos que o Mercado Pago aprovou.
//
// "Por dia" é o dia NO FUSO DA ESCOLA. O agrupamento é feito aqui no Node,
// com o Luxon, e não no SQL: CONVERT_TZ() depende de tabelas de fuso que os
// MySQL gerenciados nem sempre trazem carregadas, e um deslocamento fixo
// ("-03:00") erraria em fusos com horário de verão.
import { DateTime } from 'luxon';
import { db } from '../../infra/db.js';
import { dataNaEscola, intervaloDeDatas } from '../../dominio/periodos.js';
import { centavosCsv, gerarCsv } from '../../dominio/csv.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import { fusoDaEscola } from './acesso.js';

export const MAX_DIAS_RELATORIO = 366;
export type Agrupamento = 'dia' | 'produto' | 'categoria' | 'operador';

export interface Periodo {
  de: string;
  ate: string;
}

function validarPeriodo(p: Periodo) {
  const dias = DateTime.fromISO(p.ate).diff(DateTime.fromISO(p.de), 'days').days;
  if (dias < 0) throw erros.regra('PERIODO_INVALIDO', 'A data final é anterior à inicial.');
  if (dias > MAX_DIAS_RELATORIO) throw erros.regra('PERIODO_GRANDE_DEMAIS', `Escolha um período de até ${MAX_DIAS_RELATORIO} dias.`);
}

async function limites(escolaId: number, p: Periodo) {
  validarPeriodo(p);
  const timezone = await fusoDaEscola(db, escolaId);
  const { inicio, fim } = intervaloDeDatas(p.de, p.ate, timezone);
  return { timezone, inicio: inicio!, fim: fim! };
}

/** Divisão inteira com arredondamento (ticket médio em centavos, sem float no resultado). */
const media = (total: number, n: number) => (n === 0 ? 0 : Math.round(total / n));

export interface LinhaRelatorio {
  chave: string | number;
  rotulo: string;
  totalCentavos: number;
  /** dia/operador: número de pedidos. produto/categoria: unidades vendidas. */
  quantidade: number;
}

export async function relatorioVendas(escolaId: number, p: Periodo, agrupar: Agrupamento) {
  const { timezone, inicio, fim } = await limites(escolaId, p);
  const base = () =>
    db('pedidos_lanchei as p').where({ 'p.escola_id': escolaId, 'p.status': 'CONFIRMADO' }).where('p.created_at', '>=', inicio).where('p.created_at', '<', fim);

  const t = await base().first(db.raw('COALESCE(SUM(p.total_centavos), 0) AS total'), db.raw('COUNT(*) AS pedidos'));
  const totalCentavos = Number(t.total);
  const pedidos = Number(t.pedidos);

  let linhas: LinhaRelatorio[];
  if (agrupar === 'dia') {
    const vendas = await base().select<{ created_at: Date; total_centavos: number }[]>('p.created_at', 'p.total_centavos');
    const porDia = new Map<string, { total: number; qtd: number }>();
    for (const v of vendas) {
      const dia = dataNaEscola(v.created_at, timezone);
      const acc = porDia.get(dia) ?? { total: 0, qtd: 0 };
      acc.total += v.total_centavos;
      acc.qtd += 1;
      porDia.set(dia, acc);
    }
    linhas = [...porDia]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, v]) => ({ chave: dia, rotulo: DateTime.fromISO(dia).toFormat('dd/MM/yyyy'), totalCentavos: v.total, quantidade: v.qtd }));
  } else if (agrupar === 'operador') {
    const r = (await base()
      .join('usuarios_lanchei as u', 'u.id', 'p.operador_id')
      .groupBy('u.id', 'u.nome')
      .orderBy('total', 'desc')
      .select('u.id', 'u.nome', db.raw('SUM(p.total_centavos) AS total'), db.raw('COUNT(*) AS qtd'))) as { id: number; nome: string; total: number; qtd: number }[];
    linhas = r.map((l) => ({ chave: l.id, rotulo: l.nome, totalCentavos: Number(l.total), quantidade: Number(l.qtd) }));
  } else {
    // produto / categoria: soma os ITENS dos pedidos confirmados.
    const q = base().join('pedido_itens_lanchei as i', 'i.pedido_id', 'p.id');
    if (agrupar === 'produto') {
      // O nome vem do item (snapshot): se o produto foi renomeado, usa o nome mais recente vendido.
      q.groupBy('i.produto_id').select('i.produto_id as id', db.raw('MAX(i.nome_produto) AS nome'));
    } else {
      q.join('categorias_lanchei as c', 'c.id', 'i.categoria_id').groupBy('c.id', 'c.nome').select('c.id', 'c.nome');
    }
    const r = (await q.select(db.raw('SUM(i.subtotal_centavos) AS total'), db.raw('SUM(i.quantidade) AS qtd')).orderBy('total', 'desc')) as {
      id: number; nome: string; total: number; qtd: number;
    }[];
    linhas = r.map((l) => ({ chave: l.id, rotulo: l.nome, totalCentavos: Number(l.total), quantidade: Number(l.qtd) }));
  }

  return { de: p.de, ate: p.ate, agrupar, totais: { totalCentavos, pedidos, ticketMedioCentavos: media(totalCentavos, pedidos) }, linhas };
}

export function vendasCsv(r: Awaited<ReturnType<typeof relatorioVendas>>) {
  const colQtd = r.agrupar === 'dia' || r.agrupar === 'operador' ? 'pedidos' : 'unidades';
  return gerarCsv(
    [r.agrupar, colQtd, 'total_reais'],
    [...r.linhas.map((l) => [l.rotulo, l.quantidade, centavosCsv(l.totalCentavos)]), ['TOTAL', r.agrupar === 'dia' || r.agrupar === 'operador' ? r.totais.pedidos : '', centavosCsv(r.totais.totalCentavos)]],
  );
}

/**
 * Depósitos aprovados no período (pela data da aprovação).
 * Bruto = o que os pais pagaram (e o que foi creditado aos alunos).
 * Taxa = o que o Mercado Pago descontou; a cantina absorve (etapa1).
 */
export async function relatorioDepositos(escolaId: number, p: Periodo) {
  const { timezone, inicio, fim } = await limites(escolaId, p);
  const deps = await db('depositos_lanchei')
    .where({ escola_id: escolaId })
    .whereIn('status', ['APROVADO', 'DEVOLVIDO'])
    .where('aprovado_em', '>=', inicio)
    .where('aprovado_em', '<', fim)
    .select<{ valor_centavos: number; taxa_centavos: number | null; status: string; aprovado_em: Date }[]>('valor_centavos', 'taxa_centavos', 'status', 'aprovado_em');

  const porDia = new Map<string, { bruto: number; taxa: number; qtd: number }>();
  const totais = { brutoCentavos: 0, taxaCentavos: 0, quantidade: 0 };
  const devolvidos = { quantidade: 0, centavos: 0 };
  for (const d of deps) {
    const dia = dataNaEscola(d.aprovado_em, timezone);
    const acc = porDia.get(dia) ?? { bruto: 0, taxa: 0, qtd: 0 };
    acc.bruto += d.valor_centavos;
    acc.taxa += d.taxa_centavos ?? 0;
    acc.qtd += 1;
    porDia.set(dia, acc);
    totais.brutoCentavos += d.valor_centavos;
    totais.taxaCentavos += d.taxa_centavos ?? 0;
    totais.quantidade += 1;
    // Pix devolvido/contestado depois de creditado: aparece à parte para a cantina conferir.
    if (d.status === 'DEVOLVIDO') {
      devolvidos.quantidade += 1;
      devolvidos.centavos += d.valor_centavos;
    }
  }
  return {
    de: p.de,
    ate: p.ate,
    totais: { ...totais, liquidoCentavos: totais.brutoCentavos - totais.taxaCentavos },
    devolvidos,
    linhas: [...porDia]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, v]) => ({ data: dia, brutoCentavos: v.bruto, taxaCentavos: v.taxa, liquidoCentavos: v.bruto - v.taxa, quantidade: v.qtd })),
  };
}

export function depositosCsv(r: Awaited<ReturnType<typeof relatorioDepositos>>) {
  return gerarCsv(
    ['data', 'depositos', 'bruto_reais', 'taxa_reais', 'liquido_reais'],
    [
      ...r.linhas.map((l) => [DateTime.fromISO(l.data).toFormat('dd/MM/yyyy'), l.quantidade, centavosCsv(l.brutoCentavos), centavosCsv(l.taxaCentavos), centavosCsv(l.liquidoCentavos)]),
      ['TOTAL', r.totais.quantidade, centavosCsv(r.totais.brutoCentavos), centavosCsv(r.totais.taxaCentavos), centavosCsv(r.totais.liquidoCentavos)],
    ],
  );
}

/** Saldos em aberto: quanto a cantina "deve" em lanches (dinheiro já recebido e ainda não consumido). */
export async function relatorioSaldos(escolaId: number) {
  const r = await db('contas_lanchei')
    .where({ escola_id: escolaId })
    .first(db.raw('COALESCE(SUM(saldo_centavos), 0) AS total'), db.raw('COALESCE(SUM(saldo_centavos > 0), 0) AS com_saldo'), db.raw('COALESCE(MAX(saldo_centavos), 0) AS maior'));
  return { totalCentavos: Number(r.total), contasComSaldo: Number(r.com_saldo), maiorSaldoCentavos: Number(r.maior) };
}

/** CSV com o saldo de cada aluno. É uma lista de dados pessoais, então a exportação é auditada. */
export async function saldosCsv(escolaId: number, ator: AtorUsuario) {
  const linhas = await db('contas_lanchei as c')
    .join('alunos_lanchei as a', 'a.id', 'c.aluno_id')
    .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
    .where('c.escola_id', escolaId)
    .where('c.saldo_centavos', '>', 0)
    .orderBy('a.nome')
    .select<{ nome: string; matricula: string; turma: string | null; status: string; saldo_centavos: number }[]>(
      'a.nome', 'a.matricula', 't.nome as turma', 'a.status', 'c.saldo_centavos',
    );
  await auditarUsuario(db, ator, { escolaId, acao: 'SALDOS_EXPORTAR', entidade: 'contas', depois: { linhas: linhas.length } });
  const total = linhas.reduce((s, l) => s + l.saldo_centavos, 0);
  return gerarCsv(
    ['aluno', 'matricula', 'turma', 'status', 'saldo_reais'],
    [...linhas.map((l) => [l.nome, l.matricula, l.turma, l.status, centavosCsv(l.saldo_centavos)]), ['TOTAL', '', '', '', centavosCsv(total)]],
  );
}
