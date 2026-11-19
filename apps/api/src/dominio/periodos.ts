// "Hoje", "esta semana" e "este mês" no fuso da ESCOLA, devolvidos em UTC
// para comparar com o banco. Semana começa na segunda (padrão ISO).
import { DateTime } from 'luxon';

export interface Intervalo {
  inicio: Date; // inclusivo
  fim: Date; // exclusivo
}

const unidades = { DIA: 'day', SEMANA: 'week', MES: 'month' } as const;
export type Periodo = keyof typeof unidades;

export function intervaloDoPeriodo(agora: Date, timezone: string, periodo: Periodo): Intervalo {
  const local = DateTime.fromJSDate(agora, { zone: timezone });
  if (!local.isValid) throw new Error(`Fuso horário inválido: ${timezone}`);
  const inicio = local.startOf(unidades[periodo]); // luxon: semana ISO (segunda)
  const fim = inicio.plus({ [unidades[periodo]]: 1 });
  return { inicio: inicio.toUTC().toJSDate(), fim: fim.toUTC().toJSDate() };
}

/** Dia da semana ISO no fuso da escola: 1 = segunda ... 7 = domingo. */
export function diaIsoNaEscola(agora: Date, timezone: string): number {
  return DateTime.fromJSDate(agora, { zone: timezone }).weekday;
}

/** true se as duas datas caem no mesmo dia, no fuso da escola. */
export function mesmoDiaNaEscola(a: Date, b: Date, timezone: string): boolean {
  const da = DateTime.fromJSDate(a, { zone: timezone });
  const dbb = DateTime.fromJSDate(b, { zone: timezone });
  return da.hasSame(dbb, 'day');
}

/** Data "AAAA-MM-DD" válida no calendário? (2026-02-30 não é.) */
export function dataValida(data: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(data) && DateTime.fromISO(data, { zone: 'utc' }).isValid;
}

/**
 * Período informado em datas do calendário da ESCOLA ("2026-11-01" a
 * "2026-11-30", as duas inclusive) -> intervalo em UTC [inicio, fim) para
 * comparar com o banco. Qualquer ponta pode faltar (undefined = sem limite).
 */
export function intervaloDeDatas(de: string | undefined, ate: string | undefined, timezone: string) {
  const dia = (s: string) => DateTime.fromISO(s, { zone: timezone }).startOf('day');
  return {
    inicio: de ? dia(de).toUTC().toJSDate() : undefined,
    fim: ate ? dia(ate).plus({ days: 1 }).toUTC().toJSDate() : undefined,
  };
}

/** Data (AAAA-MM-DD) de um instante, no calendário da escola. */
export function dataNaEscola(instante: Date, timezone: string): string {
  return DateTime.fromJSDate(instante, { zone: timezone }).toFormat('yyyy-MM-dd');
}
