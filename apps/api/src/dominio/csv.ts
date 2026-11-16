// Geração de CSV para abrir no Excel em português.
//
// - Separador ";" (no Excel pt-BR a vírgula é o separador decimal).
// - UTF-8 COM BOM: sem o BOM, o Excel abre "João" como "JoÃ£o".
// - Proteção contra "CSV injection": um texto que começa com =, +, - ou @
//   vira FÓRMULA no Excel. Um nome de produto como "=HYPERLINK(...)" poderia
//   executar algo na máquina de quem abriu o relatório. Por isso textos que
//   começam assim recebem um apóstrofo na frente (o Excel mostra o texto puro).
export const BOM = '﻿';

export type Celula = string | number | null | undefined;

function escaparCelula(v: Celula): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let texto = v;
  // Número puro ("-6,00") não é fórmula: passa direto, senão o Excel o trataria como texto.
  const ehNumero = /^-?\d+(,\d+)?$/.test(texto);
  if (!ehNumero && /^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  // Aspas, ";" ou quebra de linha: envolve em aspas e duplica as aspas internas.
  if (/[";\r\n]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

export function gerarCsv(cabecalho: string[], linhas: Celula[][]): string {
  const todas = [cabecalho, ...linhas].map((l) => l.map(escaparCelula).join(';'));
  return BOM + todas.join('\r\n') + '\r\n';
}

/** 1250 -> "12,50"; -600 -> "-6,00" (número que o Excel pt-BR entende). Inteiros, sem float. */
export function centavosCsv(centavos: number): string {
  const sinal = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  return `${sinal}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
