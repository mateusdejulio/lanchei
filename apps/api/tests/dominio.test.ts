// Testes das regras PURAS (sem banco).
import { describe, expect, it } from 'vitest';
import { avaliarCompra, type EntradaAvaliacao } from '../src/dominio/regrasCompra.js';
import { diaPermitido, diasParaMascara, mascaraParaDias } from '../src/dominio/diasPermitidos.js';
import { diaIsoNaEscola, intervaloDoPeriodo, mesmoDiaNaEscola } from '../src/dominio/periodos.js';
import { dividirComandos } from '../src/infra/aplicarSchema.js';
import { validarAssinaturaMp, reaisParaCentavos } from '../src/infra/mercadopago.js';
import { createHmac } from 'node:crypto';

const base: EntradaAvaliacao = {
  alunoAtivo: true,
  carteirinhaStatus: 'ATIVA',
  diaIso: 1,
  regras: { diasPermitidos: 31, limiteDiarioCentavos: null, limiteSemanalCentavos: null, limiteMensalCentavos: null },
  itens: [{ produtoId: 10, categoriaId: 1 }],
  bloqueios: { categoriaIds: new Set(), produtoIds: new Set() },
  consumo: { dia: 0, semana: 0, mes: 0 },
  totalCentavos: 500,
  saldoCentavos: 1000,
};

describe('avaliarCompra', () => {
  it('aprova quando tudo está ok', () => {
    expect(avaliarCompra(base)).toEqual({ aprovado: true });
  });

  it('respeita a ORDEM das validações (conta inativa vem antes de saldo)', () => {
    const r = avaliarCompra({ ...base, alunoAtivo: false, saldoCentavos: 0 });
    expect(r).toMatchObject({ aprovado: false, motivo: 'CONTA_INATIVA' });
  });

  it('carteirinha bloqueada', () => {
    expect(avaliarCompra({ ...base, carteirinhaStatus: 'BLOQUEADA' })).toMatchObject({ motivo: 'CARTEIRINHA_BLOQUEADA' });
  });

  it('PIN (carteirinha null) não é tratado como bloqueado', () => {
    expect(avaliarCompra({ ...base, carteirinhaStatus: null })).toEqual({ aprovado: true });
  });

  it('dia não permitido (sábado com máscara seg-sex)', () => {
    expect(avaliarCompra({ ...base, diaIso: 6 })).toMatchObject({ motivo: 'DIA_NAO_PERMITIDO' });
  });

  it('bloqueio por categoria devolve os produtos afetados', () => {
    const r = avaliarCompra({
      ...base,
      itens: [
        { produtoId: 10, categoriaId: 1 },
        { produtoId: 11, categoriaId: 2 },
      ],
      bloqueios: { categoriaIds: new Set([2]), produtoIds: new Set() },
    });
    expect(r).toEqual({ aprovado: false, motivo: 'ITEM_BLOQUEADO', produtoIds: [11] });
  });

  it('bloqueio por produto', () => {
    const r = avaliarCompra({ ...base, bloqueios: { categoriaIds: new Set(), produtoIds: new Set([10]) } });
    expect(r).toEqual({ aprovado: false, motivo: 'ITEM_BLOQUEADO', produtoIds: [10] });
  });

  it('limite diário conta o que já foi gasto + esta compra (igual ao limite passa)', () => {
    const regras = { ...base.regras, limiteDiarioCentavos: 1000 };
    expect(avaliarCompra({ ...base, regras, consumo: { dia: 500, semana: 500, mes: 500 } })).toEqual({ aprovado: true });
    expect(avaliarCompra({ ...base, regras, consumo: { dia: 501, semana: 501, mes: 501 } })).toMatchObject({
      motivo: 'LIMITE_DIARIO',
    });
  });

  it('limites semanal e mensal', () => {
    expect(
      avaliarCompra({ ...base, regras: { ...base.regras, limiteSemanalCentavos: 600 }, consumo: { dia: 0, semana: 200, mes: 200 } }),
    ).toMatchObject({ motivo: 'LIMITE_SEMANAL' });
    expect(
      avaliarCompra({ ...base, regras: { ...base.regras, limiteMensalCentavos: 600 }, consumo: { dia: 0, semana: 0, mes: 200 } }),
    ).toMatchObject({ motivo: 'LIMITE_MENSAL' });
  });

  it('saldo insuficiente é a última checagem', () => {
    expect(avaliarCompra({ ...base, saldoCentavos: 499 })).toMatchObject({ motivo: 'SALDO_INSUFICIENTE' });
    expect(avaliarCompra({ ...base, saldoCentavos: 500 })).toEqual({ aprovado: true });
  });
});

describe('dias permitidos (bitmask)', () => {
  it('converte nos dois sentidos', () => {
    expect(diasParaMascara(['SEG', 'TER', 'QUA', 'QUI', 'SEX'])).toBe(31);
    expect(mascaraParaDias(31)).toEqual(['SEG', 'TER', 'QUA', 'QUI', 'SEX']);
    expect(mascaraParaDias(127)).toHaveLength(7);
    expect(diaPermitido(31, 5)).toBe(true);
    expect(diaPermitido(31, 6)).toBe(false);
    expect(diaPermitido(diasParaMascara(['DOM']), 7)).toBe(true);
  });
});

describe('períodos no fuso da escola (America/Sao_Paulo, UTC-3)', () => {
  const tz = 'America/Sao_Paulo';

  it('domingo 22h em SP já é segunda em UTC, mas para a escola ainda é domingo', () => {
    const agora = new Date('2026-11-09T01:00:00Z'); // domingo 08/11 22:00 em SP
    expect(diaIsoNaEscola(agora, tz)).toBe(7);
    const dia = intervaloDoPeriodo(agora, tz, 'DIA');
    expect(dia.inicio.toISOString()).toBe('2026-11-08T03:00:00.000Z');
    expect(dia.fim.toISOString()).toBe('2026-11-09T03:00:00.000Z');
  });

  it('semana começa na segunda 00:00 local', () => {
    const semana = intervaloDoPeriodo(new Date('2026-11-05T15:00:00Z'), tz, 'SEMANA'); // quinta
    expect(semana.inicio.toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(semana.fim.toISOString()).toBe('2026-11-09T03:00:00.000Z');
  });

  it('mês', () => {
    const mes = intervaloDoPeriodo(new Date('2026-11-30T23:30:00Z'), tz, 'MES'); // 30/11 20:30 SP
    expect(mes.inicio.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    expect(mes.fim.toISOString()).toBe('2026-12-01T03:00:00.000Z');
  });

  it('mesmo dia na escola', () => {
    expect(mesmoDiaNaEscola(new Date('2026-11-05T12:00:00Z'), new Date('2026-11-06T02:59:00Z'), tz)).toBe(true);
    expect(mesmoDiaNaEscola(new Date('2026-11-05T12:00:00Z'), new Date('2026-11-06T03:00:00Z'), tz)).toBe(false);
  });
});

describe('aplicador de schema', () => {
  it('entende DELIMITER e ignora comentários', () => {
    const cmds = dividirComandos(`
-- comentário; com ponto e vírgula
CREATE TABLE a (id INT);
DELIMITER $$
CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x'; END$$
DELIMITER ;
SELECT 1;`);
    expect(cmds).toHaveLength(3);
    expect(cmds[1]).toContain("SET MESSAGE_TEXT = 'x'; END");
  });
});

describe('Mercado Pago', () => {
  it('converte reais para centavos sem erro de float', () => {
    expect(reaisParaCentavos(0.1 + 0.2)).toBe(30);
    expect(reaisParaCentavos(50.5)).toBe(5050);
  });

  it('valida a assinatura do webhook', () => {
    const segredo = 'abc';
    const manifesto = 'id:123456;request-id:req-1;ts:1700000000;';
    const v1 = createHmac('sha256', segredo).update(manifesto).digest('hex');
    const ok = { xSignature: `ts=1700000000,v1=${v1}`, xRequestId: 'req-1', dataId: '123456', segredo };
    expect(validarAssinaturaMp(ok)).toBe(true);
    expect(validarAssinaturaMp({ ...ok, dataId: '999' })).toBe(false);
    expect(validarAssinaturaMp({ ...ok, segredo: 'outro' })).toBe(false);
    expect(validarAssinaturaMp({ ...ok, xSignature: undefined })).toBe(false);
    expect(validarAssinaturaMp({ ...ok, xSignature: 'lixo' })).toBe(false);
  });
});
