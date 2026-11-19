import { describe, expect, it } from 'vitest';
import { centavosParaTexto, digitosParaCentavos, formatarCentavos, textoParaCentavos } from '../src/dinheiro';
import { dataISO, formatarContagem, formatarData, formatarDataHoraCurta, formatarHora, hojeISO, inicioDoMesISO, segundosAte } from '../src/datas';

describe('dinheiro (centavos inteiros, nunca float)', () => {
  it('formata em reais', () => {
    expect(formatarCentavos(1250)).toBe('R$ 12,50');
    expect(formatarCentavos(5)).toBe('R$ 0,05');
    expect(formatarCentavos(123456)).toBe('R$ 1.234,56');
    expect(formatarCentavos(-600)).toBe('-R$ 6,00');
    expect(() => formatarCentavos(12.5)).toThrow();
    expect(centavosParaTexto(123456)).toBe('1.234,56');
  });

  it('texto digitado ou colado → centavos', () => {
    const casos: [string, number | null][] = [
      ['12', 1200], ['12,5', 1250], ['12,50', 1250], ['0,01', 1], ['1.234,56', 123456], ['R$ 12,50', 1250],
      ['  R$1.000,00 ', 100000], ['12.50', 1250], ['12.5', 1250], ['1.234', 123400], ['-6,00', -600],
      ['', null], ['abc', null], ['12,505', null], ['1,2,3', null], ['12.34.5', null], ['1.23,45', null],
    ];
    for (const [texto, esperado] of casos) expect(textoParaCentavos(texto), texto).toBe(esperado);
  });

  it('o clássico 0,1 + 0,2 não acontece aqui', () => {
    expect(textoParaCentavos('0,10')! + textoParaCentavos('0,20')!).toBe(30);
    expect(textoParaCentavos('19,99')).toBe(1999); // 19.99 * 100 = 1998.9999999999998 em float
  });

  it('digitação de maquininha: cada dígito empurra para a esquerda', () => {
    expect(digitosParaCentavos('1')).toBe(1);
    expect(digitosParaCentavos('1250')).toBe(1250);
    expect(digitosParaCentavos('R$ 12,50')).toBe(1250); // campo já com máscara
    expect(digitosParaCentavos('R$ 0,00')).toBe(0);
    expect(digitosParaCentavos('9'.repeat(15))).toBe(999_999_999); // limite de dígitos
  });
});

describe('datas no fuso da escola', () => {
  // 05/11/2026 00:30 em UTC = 04/11/2026 21:30 em São Paulo (UTC-3)
  const instante = '2026-11-05T00:30:00.000Z';

  it('formata no fuso da ESCOLA, não no do aparelho', () => {
    expect(formatarData(instante)).toBe('04/11/2026');
    expect(formatarHora(instante)).toBe('21:30');
    expect(formatarDataHoraCurta(instante)).toBe('04/11 às 21:30');
    expect(formatarData(instante, 'UTC')).toBe('05/11/2026');
    expect(dataISO(instante)).toBe('2026-11-04');
  });

  it('hoje e início do mês (para os filtros da API)', () => {
    const agora = new Date('2026-12-01T02:00:00.000Z'); // ainda 30/11 em SP
    expect(hojeISO('America/Sao_Paulo', agora)).toBe('2026-11-30');
    expect(inicioDoMesISO('America/Sao_Paulo', agora)).toBe('2026-11-01');
  });

  it('contagem regressiva do Pix', () => {
    const agora = new Date('2026-11-05T12:00:00.000Z');
    expect(segundosAte('2026-11-05T12:30:00.000Z', agora)).toBe(1800);
    expect(segundosAte('2026-11-05T12:00:00.400Z', agora)).toBe(1); // arredonda para cima
    expect(segundosAte('2026-11-05T11:00:00.000Z', agora)).toBe(0); // nunca negativo
    expect(formatarContagem(754)).toBe('12:34');
    expect(formatarContagem(5)).toBe('0:05');
  });
});
