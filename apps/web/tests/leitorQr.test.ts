// Filtro do leitor de QR: só "LCH1." e anti-repetição de 3 s.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { criarFiltroQr } from '../src/caixa/leitorQr';

/** Versão do zxing-wasm que um "require" enxerga (o pacote não exporta o package.json). */
function versaoZxing(req: NodeJS.Require): string {
  let pasta = dirname(req.resolve('zxing-wasm/reader'));
  while (!existsSync(join(pasta, 'package.json')) || JSON.parse(readFileSync(join(pasta, 'package.json'), 'utf8')).name !== 'zxing-wasm') {
    pasta = dirname(pasta);
  }
  return JSON.parse(readFileSync(join(pasta, 'package.json'), 'utf8')).version;
}

describe('leitor em WebAssembly (iPad/Safari)', () => {
  it('o .wasm servido é da MESMA versão do ZXing que o barcode-detector carrega', () => {
    // O app serve zxing-wasm/reader/zxing_reader.wasm (import "?url") e o
    // barcode-detector carrega o JavaScript do ZXing que ELE usa. Versões
    // diferentes = toda leitura falha (aconteceu: barcode-detector 3.2.4
    // trazia o ZXing 3.1.7, e o app servia o .wasm 3.1.6).
    const doApp = createRequire(import.meta.url);
    const doDetector = createRequire(doApp.resolve('barcode-detector/ponyfill'));
    expect(versaoZxing(doApp)).toBe(versaoZxing(doDetector));
  });
});

describe('filtro do leitor de QR', () => {
  it('ignora em silêncio QR que não é do Lanchei', () => {
    const f = criarFiltroQr();
    expect(f('https://site-qualquer.com', 0)).toBeNull();
    expect(f('7891234567890', 0)).toBeNull();
    expect(f('lch1.minusculo', 0)).toBeNull();
    expect(f('  LCH1.abc  ', 0)).toBe('LCH1.abc');
  });

  it('a mesma carteirinha em menos de 3 s é ignorada; depois, vale de novo', () => {
    const f = criarFiltroQr(3000);
    expect(f('LCH1.ana', 0)).toBe('LCH1.ana');
    expect(f('LCH1.ana', 500)).toBeNull();
    expect(f('LCH1.ana', 2900)).toBeNull(); // ainda na frente da câmera: a janela se estende
    expect(f('LCH1.ana', 6000)).toBe('LCH1.ana');
  });

  it('outra carteirinha logo em seguida é lida na hora', () => {
    const f = criarFiltroQr();
    expect(f('LCH1.ana', 0)).toBe('LCH1.ana');
    expect(f('LCH1.bruno', 100)).toBe('LCH1.bruno');
    expect(f('LCH1.ana', 200)).toBe('LCH1.ana');
  });
});
