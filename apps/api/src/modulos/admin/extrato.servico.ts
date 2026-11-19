// Histórico do aluno para o painel (Cantina e Diretoria), com exportação CSV.
//
// Junta duas fontes, em ordem cronológica (mais recente primeiro):
//   - o LEDGER (transacoes_lanchei): compras, depósitos, estornos, ajustes, reembolso;
//   - as compras RECUSADAS (pedidos_lanchei), que não mexem no saldo e por
//     isso não estão no ledger, mas são justamente o que os pais perguntam
//     ("por que meu filho não conseguiu comprar?").
//
// Toda consulta gera auditoria: HISTORICO_VISUALIZAR (ao abrir; as páginas
// seguintes da rolagem não repetem) e HISTORICO_EXPORTAR (CSV).
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { centavosCsv, gerarCsv } from '../../dominio/csv.js';
import { erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { alunoDaEscola } from './acesso.js';

export const TIPOS_EXTRATO = ['DEPOSITO', 'COMPRA', 'ESTORNO', 'REEMBOLSO', 'AJUSTE', 'RECUSADA'] as const;
export type TipoExtrato = (typeof TIPOS_EXTRATO)[number];

export interface FiltrosExtrato {
  de?: string | undefined; // AAAA-MM-DD, no fuso da escola
  ate?: string | undefined; // AAAA-MM-DD (inclusivo)
  tipo?: TipoExtrato | undefined;
}

interface LinhaUnida {
  origem: 'T' | 'R'; // T = transação do ledger, R = pedido recusado
  id: number;
  tipo: TipoExtrato;
  valor_centavos: number;
  saldo_apos_centavos: number | null;
  descricao: string | null;
  pedido_id: number | null;
  deposito_id: number | null;
  motivo_recusa: string | null;
  criado_em: Date;
}

/** "2026-11-01" .. "2026-11-30" no fuso da escola -> intervalo UTC [inicio, fim). */
function intervalo(f: FiltrosExtrato, timezone: string) {
  const dia = (s: string) => {
    const d = DateTime.fromISO(s, { zone: timezone });
    if (!d.isValid) throw erros.regra('DATA_INVALIDA', `Data inválida: ${s} (use AAAA-MM-DD).`);
    return d.startOf('day');
  };
  return {
    inicio: f.de ? dia(f.de).toUTC().toJSDate() : undefined,
    fim: f.ate ? dia(f.ate).plus({ days: 1 }).toUTC().toJSDate() : undefined,
  };
}

/** Monta a consulta unificada (UNION ALL) como tabela derivada "x". */
function consultaUnida(contaId: number, f: FiltrosExtrato, timezone: string) {
  const { inicio, fim } = intervalo(f, timezone);
  const transacoes = db('transacoes_lanchei')
    .where('conta_id', contaId)
    .select(
      db.raw("'T' AS origem"), 'id', 'tipo', 'valor_centavos', 'saldo_apos_centavos', 'descricao', 'pedido_id', 'deposito_id',
      db.raw('NULL AS motivo_recusa'), 'created_at AS criado_em',
    );
  const recusas = db('pedidos_lanchei')
    .where({ conta_id: contaId, status: 'RECUSADO' })
    .select(
      db.raw("'R' AS origem"), 'id', db.raw("'RECUSADA' AS tipo"), 'total_centavos AS valor_centavos', db.raw('NULL AS saldo_apos_centavos'),
      db.raw('NULL AS descricao'), 'id AS pedido_id', db.raw('NULL AS deposito_id'), 'motivo_recusa', 'created_at AS criado_em',
    );
  const q = db.select('*').from(transacoes.unionAll(recusas).as('x'));
  if (inicio) q.where('x.criado_em', '>=', inicio);
  if (fim) q.where('x.criado_em', '<', fim);
  if (f.tipo) q.where('x.tipo', f.tipo);
  return q;
}

async function contexto(escolaId: number, alunoId: number) {
  const aluno = await alunoDaEscola(db, escolaId, alunoId);
  const c = await db('contas_lanchei as c')
    .join('escolas_lanchei as e', 'e.id', 'c.escola_id')
    .where('c.aluno_id', alunoId)
    .first<{ id: number; timezone: string }>('c.id', 'e.timezone');
  return { aluno, contaId: c.id, timezone: c.timezone };
}

/** Itens (nome + quantidade) dos pedidos da página, para a descrição da compra. */
export async function itensDosPedidos(pedidoIds: number[]) {
  const mapa = new Map<number, { nome: string; quantidade: number }[]>();
  if (pedidoIds.length === 0) return mapa;
  const itens = await db('pedido_itens_lanchei')
    .whereIn('pedido_id', pedidoIds)
    .orderBy('id')
    .select<{ pedido_id: number; nome_produto: string; quantidade: number }[]>('pedido_id', 'nome_produto', 'quantidade');
  for (const i of itens) {
    const lista = mapa.get(i.pedido_id) ?? [];
    lista.push({ nome: i.nome_produto, quantidade: i.quantidade });
    mapa.set(i.pedido_id, lista);
  }
  return mapa;
}

// (data, origem, id): ordem total e estável, mesmo com duas linhas no mesmo milissegundo.
const zCursor = z.tuple([z.string(), z.enum(['T', 'R']), z.number().int()]);

export type FiltrosPagina = FiltrosExtrato & { limite: number; cursor?: string | undefined };

/** Painel (Cantina e Diretoria): a página do extrato + auditoria na abertura. */
export async function extratoDoAluno(escolaId: number, alunoId: number, f: FiltrosPagina, ator: AtorUsuario) {
  const { contaId, timezone } = await contexto(escolaId, alunoId);
  if (!f.cursor) {
    // Só a abertura do histórico é auditada; a rolagem (páginas com cursor) não repete.
    await auditarUsuario(db, ator, {
      escolaId,
      acao: 'HISTORICO_VISUALIZAR',
      entidade: 'alunos',
      entidadeId: alunoId,
      alunoId,
      depois: { de: f.de ?? null, ate: f.ate ?? null, tipo: f.tipo ?? null },
    });
  }
  return paginaDoExtrato(contaId, timezone, f);
}

/**
 * Uma página do extrato (ledger + compras recusadas), sem auditoria.
 * Usada pelo painel (acima) e pelo app dos pais (que vê o extrato do próprio filho).
 */
export async function paginaDoExtrato(contaId: number, timezone: string, f: FiltrosPagina) {
  const q = consultaUnida(contaId, f, timezone);

  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) {
    const [data, origem, id] = cursor;
    const d = new Date(data);
    // Ordem DESC: "depois" do cursor = mais antigo.
    q.andWhere((w) =>
      w
        .where('x.criado_em', '<', d)
        .orWhere((w2) => w2.where('x.criado_em', d).andWhere('x.origem', '<', origem))
        .orWhere((w3) => w3.where('x.criado_em', d).andWhere('x.origem', origem).andWhere('x.id', '<', id)),
    );
  }
  q.orderBy([
    { column: 'x.criado_em', order: 'desc' },
    { column: 'x.origem', order: 'desc' },
    { column: 'x.id', order: 'desc' },
  ]).limit(f.limite + 1);

  const { itens, proximoCursor } = paginar((await q) as LinhaUnida[], f.limite, (u) => [new Date(u.criado_em).toISOString(), u.origem, u.id]);
  const itensPedido = await itensDosPedidos(itens.filter((l) => l.pedido_id !== null).map((l) => l.pedido_id!));
  return { itens: itens.map((l) => linhaParaApi(l, itensPedido)), proximoCursor };
}

function linhaParaApi(l: LinhaUnida, itensPedido: Map<number, { nome: string; quantidade: number }[]>) {
  return {
    id: `${l.origem}${l.id}`, // único entre as duas fontes
    tipo: l.tipo,
    // Recusada não movimenta saldo: o valor é o total que TENTOU comprar.
    valorCentavos: l.valor_centavos,
    saldoAposCentavos: l.saldo_apos_centavos,
    descricao: l.descricao,
    motivoRecusa: l.motivo_recusa,
    pedidoId: l.pedido_id,
    depositoId: l.deposito_id,
    itens: l.pedido_id !== null ? (itensPedido.get(l.pedido_id) ?? []) : [],
    criadoEm: l.criado_em,
  };
}

const NOME_TIPO: Record<TipoExtrato, string> = {
  DEPOSITO: 'Depósito',
  COMPRA: 'Compra',
  ESTORNO: 'Estorno',
  REEMBOLSO: 'Reembolso',
  AJUSTE: 'Ajuste',
  RECUSADA: 'Compra recusada',
};

export const MAX_LINHAS_CSV = 10_000;

/** GET /admin/alunos/:id/extrato.csv: o período inteiro, para mandar aos responsáveis. */
export async function extratoCsv(escolaId: number, alunoId: number, f: FiltrosExtrato, ator: AtorUsuario) {
  const { aluno, contaId, timezone } = await contexto(escolaId, alunoId);
  const linhas = (await consultaUnida(contaId, f, timezone)
    .orderBy([{ column: 'x.criado_em', order: 'asc' }, { column: 'x.origem' }, { column: 'x.id' }])
    .limit(MAX_LINHAS_CSV + 1)) as LinhaUnida[];
  if (linhas.length > MAX_LINHAS_CSV) throw erros.regra('PERIODO_GRANDE_DEMAIS', 'Período grande demais. Escolha um intervalo menor.');

  await auditarUsuario(db, ator, {
    escolaId,
    acao: 'HISTORICO_EXPORTAR',
    entidade: 'alunos',
    entidadeId: alunoId,
    alunoId,
    depois: { de: f.de ?? null, ate: f.ate ?? null, tipo: f.tipo ?? null, linhas: linhas.length },
  });

  const itensPedido = await itensDosPedidos(linhas.filter((l) => l.pedido_id !== null).map((l) => l.pedido_id!));
  const csv = gerarCsv(
    ['data_hora', 'tipo', 'descricao', 'valor_reais', 'saldo_apos_reais', 'motivo_recusa'],
    linhas.map((l) => {
      const itens = l.pedido_id !== null ? (itensPedido.get(l.pedido_id) ?? []) : [];
      // A compra já grava os itens na descrição do ledger; a recusada não tem descrição.
      const descricao = l.descricao ?? itens.map((i) => `${i.quantidade}x ${i.nome}`).join(', ');
      return [
        DateTime.fromJSDate(new Date(l.criado_em), { zone: timezone }).toFormat('dd/MM/yyyy HH:mm'),
        NOME_TIPO[l.tipo],
        descricao,
        centavosCsv(l.valor_centavos),
        l.saldo_apos_centavos === null ? '' : centavosCsv(l.saldo_apos_centavos),
        l.motivo_recusa,
      ];
    }),
  );
  // Nome do arquivo sem o nome do aluno: arquivos baixados vão parar em lugares imprevisíveis.
  return { csv, nomeArquivo: `extrato-${aluno.matricula.replace(/[^\w-]/g, '')}.csv` };
}
