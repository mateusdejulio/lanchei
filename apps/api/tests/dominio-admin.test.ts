// Funções puras da área administrativa (sem banco): código de ativação,
// CSV e validação da planilha de alunos.
import { describe, expect, it } from 'vitest';
import { ALFABETO_CODIGO, formatarCodigo, gerarCodigoAtivacao, hashCodigo, normalizarCodigo } from '../src/dominio/codigoAtivacao.js';
import { BOM, centavosCsv, gerarCsv } from '../src/dominio/csv.js';
import { lerTextoUtf8, validarPlanilha, type Contexto } from '../src/dominio/importacaoAlunos.js';

describe('código de ativação', () => {
  it('8 caracteres, só do alfabeto sem ambíguos (sem 0/O, 1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      const c = gerarCodigoAtivacao();
      expect(c).toHaveLength(8);
      expect([...c].every((ch) => ALFABETO_CODIGO.includes(ch))).toBe(true);
    }
    expect(ALFABETO_CODIGO).not.toMatch(/[01OIL]/);
  });

  it('aceita minúsculas, hífen e espaços (mesmo hash)', () => {
    expect(normalizarCodigo(' abcd-2345 ')).toBe('ABCD2345');
    expect(hashCodigo('abcd-2345').equals(hashCodigo('ABCD2345'))).toBe(true);
    expect(formatarCodigo('ABCD2345')).toBe('ABCD-2345');
  });
});

describe('CSV', () => {
  it('BOM, separador ";" e aspas quando precisa', () => {
    const csv = gerarCsv(['a', 'b'], [['x;y', 'diz "oi"']]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toContain('"x;y";"diz ""oi"""');
  });

  it('neutraliza fórmulas (CSV injection), mas deixa números negativos intactos', () => {
    const csv = gerarCsv(['t'], [['=HYPERLINK("x")'], ['+1'], ['@soma'], [centavosCsv(-600)]]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@soma");
    expect(csv).toContain('\r\n-6,00\r\n');
  });

  it('centavos sem float', () => {
    expect(centavosCsv(1250)).toBe('12,50');
    expect(centavosCsv(5)).toBe('0,05');
    expect(centavosCsv(-100001)).toBe('-1000,01');
  });
});

describe('planilha de alunos', () => {
  const ctx = (extra: Partial<Contexto> = {}): Contexto => ({
    matriculasExistentes: new Set(['JA-EXISTE']),
    turmasDoAno: new Map([
      ['3º a', { nome: '3º A', ativo: true }],
      ['antiga', { nome: 'Antiga', ativo: false }],
    ]),
    ...extra,
  });
  const CAB = 'nome;matricula;turma;email_responsavel_1;email_responsavel_2';

  it('planilha válida: turma existente (sem diferenciar maiúsculas), turma nova, e-mails normalizados', () => {
    const r = validarPlanilha(
      `${CAB}\nJoão Silva;M1;3º a;MARIA@Email.com;jose@email.com\nAna;M2;5º B;;\nBia;M3;5º b;x@y.com;x@y.com\n`,
      ctx(),
    );
    expect(r.erros).toEqual([]);
    expect(r.validos).toBe(3);
    expect(r.turmasNovas).toEqual(['5º B']); // "5º b" é a mesma turma nova
    expect(r.alunos[0]!.emails).toEqual(['maria@email.com', 'jose@email.com']);
    expect(r.alunos[2]!.emails).toEqual(['x@y.com']); // repetido vira um só
  });

  it('aceita BOM do Excel e os nomes curtos de coluna da etapa3', () => {
    const r = validarPlanilha(`﻿nome;matricula;turma;email_resp_1;email_resp_2\nJoão;M1;3º A;a@b.com;\n`, ctx());
    expect(r.erros).toEqual([]);
    expect(r.alunos[0]!.emails).toEqual(['a@b.com']);
  });

  it('erros por linha: obrigatórios, e-mail inválido, matrícula no banco e repetida no arquivo, turma desativada', () => {
    const r = validarPlanilha(
      `${CAB}\n;M1;3º A;;\nAna;JA-EXISTE;3º A;;\nBia;M9;3º A;nao-e-email;\nCaio;M9;3º A;;\nDu;M10;Antiga;;\n`,
      ctx(),
    );
    expect(r.validos).toBe(0); // todas as 5 linhas têm algum erro
    expect(r.erros).toEqual(
      expect.arrayContaining([
        { linha: 2, campo: 'nome', mensagem: 'Nome obrigatório.' },
        expect.objectContaining({ linha: 3, campo: 'matricula' }),
        expect.objectContaining({ linha: 4, campo: 'email_responsavel_1' }),
        expect.objectContaining({ linha: 5, campo: 'matricula', mensagem: expect.stringContaining('linha 4') }),
        expect.objectContaining({ linha: 6, campo: 'turma' }),
      ]),
    );
    expect(r.alunos).toEqual([]); // com erro, nada é devolvido para gravar
  });

  it('cabeçalho errado, arquivo vazio e não UTF-8', () => {
    expect(validarPlanilha('aluno,ra,classe\nx,y,z', ctx()).erros[0]!.campo).toBe('cabecalho');
    expect(validarPlanilha(`${CAB}\n`, ctx()).erros[0]!.mensagem).toContain('Nenhum aluno');
    // "João" em Windows-1252: o "ã" vira o byte 0xE3, inválido em UTF-8.
    expect(lerTextoUtf8(Buffer.from([0x4a, 0x6f, 0xe3, 0x6f]))).toBeNull();
    expect(lerTextoUtf8(Buffer.from('João', 'utf8'))).toBe('João');
  });
});
