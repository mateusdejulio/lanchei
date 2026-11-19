// Datas no front. A API manda tudo em UTC (ISO 8601, "2026-11-05T19:30:00.000Z").
// Para mostrar, convertemos para o fuso DA ESCOLA (não o do aparelho): uma
// compra das 12:30 em São Paulo aparece 12:30 mesmo que o pai esteja viajando.
//
// Usamos só o Intl do próprio navegador (nenhuma biblioteca): menos código
// para os pais baixarem.

export const FUSO_PADRAO = 'America/Sao_Paulo';

type Entrada = string | Date;
const comoData = (d: Entrada) => (d instanceof Date ? d : new Date(d));

const cacheFormatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string, opcoes: Intl.DateTimeFormatOptions) {
  const chave = `${fuso}|${JSON.stringify(opcoes)}`;
  let f = cacheFormatadores.get(chave);
  if (!f) {
    f = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, ...opcoes });
    cacheFormatadores.set(chave, f);
  }
  return f;
}

/** "05/11/2026" */
export const formatarData = (d: Entrada, fuso = FUSO_PADRAO) =>
  formatador(fuso, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(comoData(d));

/** "12:30" */
export const formatarHora = (d: Entrada, fuso = FUSO_PADRAO) =>
  formatador(fuso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(comoData(d));

/** "05/11 às 12:30" (avisos e listas) */
export const formatarDataHoraCurta = (d: Entrada, fuso = FUSO_PADRAO) =>
  `${formatador(fuso, { day: '2-digit', month: '2-digit' }).format(comoData(d))} às ${formatarHora(d, fuso)}`;

/** "quinta-feira, 5 de novembro" (cabeçalho do extrato agrupado por dia) */
export const formatarDiaPorExtenso = (d: Entrada, fuso = FUSO_PADRAO) =>
  formatador(fuso, { weekday: 'long', day: 'numeric', month: 'long' }).format(comoData(d));

/** Instante → "AAAA-MM-DD" no fuso da escola (o formato que a API aceita em ?de=&ate=). */
export function dataISO(d: Entrada, fuso = FUSO_PADRAO): string {
  const partes = formatador(fuso, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(comoData(d));
  const v = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** Hoje no fuso da escola, "AAAA-MM-DD". */
export const hojeISO = (fuso = FUSO_PADRAO, agora = new Date()) => dataISO(agora, fuso);

/** Primeiro dia do mês de hoje (padrão do filtro "período" no painel). */
export const inicioDoMesISO = (fuso = FUSO_PADRAO, agora = new Date()) => `${hojeISO(fuso, agora).slice(0, 8)}01`;

/**
 * Segundos que faltam até um instante (contagem regressiva do Pix).
 * Nunca negativo; o arredondamento para cima evita mostrar "0:00" um segundo antes da hora.
 */
export function segundosAte(fim: Entrada, agora = new Date()): number {
  return Math.max(0, Math.ceil((comoData(fim).getTime() - agora.getTime()) / 1000));
}

/** 754 → "12:34" (minutos:segundos) */
export function formatarContagem(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
