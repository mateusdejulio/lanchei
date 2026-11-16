// Validação da planilha de alunos (modelo do Lanchei), como FUNÇÃO PURA:
// recebe o texto do arquivo + o que já existe no banco e devolve o relatório.
// Nada é gravado aqui, o que permite testar todos os casos sem banco e usar o
// mesmo código no "simular" e na importação de verdade.
//
// Modelo (UTF-8, separador ";"):
//   nome;matricula;turma;email_responsavel_1;email_responsavel_2
import { parse } from 'csv-parse/sync';
import { z } from 'zod';

export const CABECALHO_MODELO = ['nome', 'matricula', 'turma', 'email_responsavel_1', 'email_responsavel_2'] as const;
export const EXEMPLO_MODELO = ['João Pedro Silva', '2026001', '3º A', 'maria@email.com', 'jose@email.com'];
export const MAX_LINHAS = 2000;

// Aceitamos também os nomes curtos que aparecem na etapa3 (email_resp_1/2).
const APELIDOS: Record<string, string> = { email_resp_1: 'email_responsavel_1', email_resp_2: 'email_responsavel_2' };

export interface ErroLinha {
  linha: number; // linha do ARQUIVO (o cabeçalho é a linha 1), igual ao que a secretaria vê no Excel
  campo: string;
  mensagem: string;
}

export interface AlunoPlanilha {
  linha: number;
  nome: string;
  matricula: string;
  turma: string; // nome como veio (sem espaços nas pontas)
  emails: string[]; // 0 a 2, normalizados e sem repetição
}

export interface Contexto {
  /** Matrículas que já existem na escola (qualquer status). */
  matriculasExistentes: ReadonlySet<string>;
  /** Turmas do ano letivo atual: nome em minúsculas -> ativa? */
  turmasDoAno: ReadonlyMap<string, { nome: string; ativo: boolean }>;
}

export interface Relatorio {
  totalLinhas: number;
  validos: number;
  erros: ErroLinha[];
  /** Turmas que não existem no ano letivo atual e serão criadas. */
  turmasNovas: string[];
  alunos: AlunoPlanilha[]; // só preenchido se não houver erros
}

const zEmailPlanilha = z.email();
const chaveTurma = (nome: string) => nome.trim().toLocaleLowerCase('pt-BR');

/** Decodifica o arquivo. Excel no Windows costuma salvar em Windows-1252: aqui isso vira um erro claro. */
export function lerTextoUtf8(arquivo: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(arquivo);
  } catch {
    return null;
  }
}

export function validarPlanilha(texto: string, ctx: Contexto): Relatorio {
  const erros: ErroLinha[] = [];
  const vazio = (e: ErroLinha[]): Relatorio => ({ totalLinhas: 0, validos: 0, erros: e, turmasNovas: [], alunos: [] });

  let registros: string[][];
  try {
    registros = parse(texto, {
      delimiter: ';',
      bom: true, // ignora o BOM do "CSV UTF-8" do Excel
      skip_empty_lines: true,
      relax_column_count: true, // colunas a mais/a menos viram erro NOSSO, por linha
      trim: true,
    });
  } catch (e) {
    return vazio([{ linha: 0, campo: 'arquivo', mensagem: `Não foi possível ler o CSV: ${(e as Error).message}` }]);
  }

  const [cabecalho, ...dados] = registros;
  if (!cabecalho) return vazio([{ linha: 0, campo: 'arquivo', mensagem: 'O arquivo está vazio.' }]);

  const colunas = cabecalho.map((c) => {
    const nome = c.trim().toLowerCase();
    return APELIDOS[nome] ?? nome;
  });
  const faltando = CABECALHO_MODELO.slice(0, 3).filter((c) => !colunas.includes(c));
  if (faltando.length > 0) {
    return vazio([
      {
        linha: 1,
        campo: 'cabecalho',
        mensagem: `Faltam as colunas: ${faltando.join(', ')}. Use o modelo do Lanchei (separador ";").`,
      },
    ]);
  }
  if (dados.length === 0) return vazio([{ linha: 2, campo: 'arquivo', mensagem: 'Nenhum aluno na planilha.' }]);
  if (dados.length > MAX_LINHAS) {
    return vazio([{ linha: 0, campo: 'arquivo', mensagem: `No máximo ${MAX_LINHAS} alunos por arquivo. Divida a planilha.` }]);
  }

  const idx = (c: string) => colunas.indexOf(c);
  const valor = (reg: string[], c: string) => (idx(c) >= 0 ? (reg[idx(c)] ?? '').trim() : '');

  const alunos: AlunoPlanilha[] = [];
  const matriculasNoArquivo = new Map<string, number>(); // matrícula -> primeira linha em que apareceu
  const turmasNovas = new Map<string, string>(); // chave -> nome como escrito na 1ª vez

  dados.forEach((reg, i) => {
    const linha = i + 2;
    const errosAntes = erros.length;
    const erro = (campo: string, mensagem: string) => erros.push({ linha, campo, mensagem });

    const nome = valor(reg, 'nome');
    const matricula = valor(reg, 'matricula');
    const turma = valor(reg, 'turma');

    if (!nome) erro('nome', 'Nome obrigatório.');
    else if (nome.length > 150) erro('nome', 'Nome com mais de 150 caracteres.');

    if (!matricula) erro('matricula', 'Matrícula obrigatória.');
    else if (matricula.length > 40) erro('matricula', 'Matrícula com mais de 40 caracteres.');
    else if (ctx.matriculasExistentes.has(matricula)) erro('matricula', `A matrícula ${matricula} já está cadastrada.`);
    else if (matriculasNoArquivo.has(matricula)) {
      erro('matricula', `Matrícula repetida no arquivo (também na linha ${matriculasNoArquivo.get(matricula)}).`);
    } else matriculasNoArquivo.set(matricula, linha);

    if (!turma) erro('turma', 'Turma obrigatória.');
    else if (turma.length > 60) erro('turma', 'Nome da turma com mais de 60 caracteres.');
    else {
      const existente = ctx.turmasDoAno.get(chaveTurma(turma));
      if (existente && !existente.ativo) erro('turma', `A turma "${existente.nome}" está desativada.`);
      else if (!existente && !turmasNovas.has(chaveTurma(turma))) turmasNovas.set(chaveTurma(turma), turma);
    }

    const emails: string[] = [];
    for (const campo of ['email_responsavel_1', 'email_responsavel_2']) {
      const bruto = valor(reg, campo).toLowerCase();
      if (!bruto) continue;
      if (!zEmailPlanilha.safeParse(bruto).success || bruto.length > 254) erro(campo, `E-mail inválido: "${bruto}".`);
      else if (!emails.includes(bruto)) emails.push(bruto);
    }

    if (erros.length === errosAntes) alunos.push({ linha, nome, matricula, turma, emails });
  });

  return {
    totalLinhas: dados.length,
    validos: alunos.length,
    erros,
    turmasNovas: [...turmasNovas.values()],
    alunos: erros.length === 0 ? alunos : [],
  };
}

export { chaveTurma };
