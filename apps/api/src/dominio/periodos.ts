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
