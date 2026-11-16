// Regras de aprovação de uma compra, como FUNÇÃO PURA: recebe tudo
// que precisa e devolve aprovado/recusado. Sem banco, sem relógio.
// É aqui que mora a "ordem das validações" da Etapa 1.
import { diaPermitido } from './diasPermitidos.js';

export type MotivoRecusa =
  | 'CONTA_INATIVA'
  | 'CARTEIRINHA_BLOQUEADA'
  | 'DIA_NAO_PERMITIDO'
  | 'ITEM_BLOQUEADO'
  | 'LIMITE_DIARIO'
  | 'LIMITE_SEMANAL'
  | 'LIMITE_MENSAL'
  | 'SALDO_INSUFICIENTE';

export const MENSAGENS_RECUSA: Record<MotivoRecusa, string> = {
  CONTA_INATIVA: 'A conta deste aluno não está ativa.',
  CARTEIRINHA_BLOQUEADA: 'Carteirinha bloqueada pelo responsável.',
  DIA_NAO_PERMITIDO: 'O responsável não liberou compras neste dia da semana.',
  ITEM_BLOQUEADO: 'O pedido tem um item bloqueado pelo responsável.',
  LIMITE_DIARIO: 'O limite diário deste aluno foi atingido.',
  LIMITE_SEMANAL: 'O limite semanal deste aluno foi atingido.',
  LIMITE_MENSAL: 'O limite mensal deste aluno foi atingido.',
  SALDO_INSUFICIENTE: 'Saldo insuficiente.',
};

export interface EntradaAvaliacao {
  alunoAtivo: boolean;
  /** null quando a identificação foi por PIN ou venda manual */
  carteirinhaStatus: 'ATIVA' | 'BLOQUEADA' | null;
  diaIso: number;
  regras: {
    diasPermitidos: number;
    limiteDiarioCentavos: number | null;
    limiteSemanalCentavos: number | null;
    limiteMensalCentavos: number | null;
  };
  itens: { produtoId: number; categoriaId: number }[];
  bloqueios: { categoriaIds: ReadonlySet<number>; produtoIds: ReadonlySet<number> };
  /** Já gasto (pedidos CONFIRMADOS) em cada período, sem contar esta compra. */
  consumo: { dia: number; semana: number; mes: number };
  totalCentavos: number;
  saldoCentavos: number;
}

export type ResultadoAvaliacao =
  | { aprovado: true }
  | { aprovado: false; motivo: MotivoRecusa; produtoIds?: number[] };

export function avaliarCompra(e: EntradaAvaliacao): ResultadoAvaliacao {
  const recusa = (motivo: MotivoRecusa, produtoIds?: number[]): ResultadoAvaliacao =>
    produtoIds ? { aprovado: false, motivo, produtoIds } : { aprovado: false, motivo };

  // 1. carteirinha válida e conta ativa
  if (!e.alunoAtivo) return recusa('CONTA_INATIVA');
  if (e.carteirinhaStatus === 'BLOQUEADA') return recusa('CARTEIRINHA_BLOQUEADA');

  // 2. dia permitido
  if (!diaPermitido(e.regras.diasPermitidos, e.diaIso)) return recusa('DIA_NAO_PERMITIDO');

  // 3. nenhum item bloqueado (por produto ou pela categoria do produto)
  const bloqueados = e.itens
    .filter((i) => e.bloqueios.produtoIds.has(i.produtoId) || e.bloqueios.categoriaIds.has(i.categoriaId))
    .map((i) => i.produtoId);
  if (bloqueados.length > 0) return recusa('ITEM_BLOQUEADO', [...new Set(bloqueados)]);

  // 4. limites do período (null = sem limite)
  const passa = (limite: number | null, gasto: number) => limite === null || gasto + e.totalCentavos <= limite;
  if (!passa(e.regras.limiteDiarioCentavos, e.consumo.dia)) return recusa('LIMITE_DIARIO');
  if (!passa(e.regras.limiteSemanalCentavos, e.consumo.semana)) return recusa('LIMITE_SEMANAL');
  if (!passa(e.regras.limiteMensalCentavos, e.consumo.mes)) return recusa('LIMITE_MENSAL');

  // 5. saldo suficiente
  if (e.saldoCentavos < e.totalCentavos) return recusa('SALDO_INSUFICIENTE');

  return { aprovado: true };
}
