// O banco guarda os dias permitidos como bitmask (bit 0 = segunda).
// A API e o app só enxergam a lista ["SEG", "TER", ...].
export const DIAS = ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'] as const;
export type Dia = (typeof DIAS)[number];

export function diasParaMascara(dias: readonly Dia[]): number {
  return dias.reduce((mascara, dia) => mascara | (1 << DIAS.indexOf(dia)), 0);
}

export function mascaraParaDias(mascara: number): Dia[] {
  return DIAS.filter((_, i) => (mascara >> i) & 1);
}

/** diaIso: 1 = segunda ... 7 = domingo */
export function diaPermitido(mascara: number, diaIso: number): boolean {
  return ((mascara >> (diaIso - 1)) & 1) === 1;
}
