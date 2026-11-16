// Importação de alunos pela planilha (modelo do Lanchei).
// A validação é a função pura dominio/importacaoAlunos.ts; aqui ficam o
// acesso ao banco e a gravação em UMA transação (entra tudo ou nada).
import { DateTime } from 'luxon';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { CABECALHO_MODELO, chaveTurma, EXEMPLO_MODELO, lerTextoUtf8, validarPlanilha, type Relatorio } from '../../dominio/importacaoAlunos.js';
import { gerarCsv } from '../../dominio/csv.js';
import { ErroApi, erros } from '../../erros.js';
import { nomeDaEscola } from './acesso.js';
import { inserirAlunos } from './alunos.servico.js';
import { enviarConvites } from './convites.servico.js';

export const modeloCsv = () => gerarCsv([...CABECALHO_MODELO], [EXEMPLO_MODELO]);

/** Ano letivo atual = ano corrente NO FUSO DA ESCOLA (31/12 às 23h em SP já é 2027 em UTC). */
export async function anoLetivoAtual(escolaId: number, agora = new Date()) {
  const { timezone } = await db('escolas_lanchei').where({ id: escolaId }).first<{ timezone: string }>('timezone');
  return DateTime.fromJSDate(agora, { zone: timezone }).year;
}

function relatorioParaApi(r: Relatorio) {
  return { totalLinhas: r.totalLinhas, validos: r.validos, erros: r.erros, turmasNovas: r.turmasNovas };
}

async function validar(escolaId: number, arquivo: Buffer, anoLetivo: number) {
  const texto = lerTextoUtf8(arquivo);
  if (texto === null) {
    throw erros.regra(
      'ARQUIVO_NAO_UTF8',
      'O arquivo não está em UTF-8. No Excel, use "Salvar como" > "CSV UTF-8 (delimitado por vírgulas)".',
    );
  }
  const matriculas = await db('alunos_lanchei').where({ escola_id: escolaId }).pluck<string[]>('matricula');
  const turmas = await db('turmas_lanchei').where({ escola_id: escolaId, ano_letivo: anoLetivo }).select<{ id: number; nome: string; ativo: boolean }[]>('id', 'nome', 'ativo');
  const relatorio = validarPlanilha(texto, {
    matriculasExistentes: new Set(matriculas),
    turmasDoAno: new Map(turmas.map((t) => [chaveTurma(t.nome), { nome: t.nome, ativo: t.ativo }])),
  });
  return { relatorio, turmas };
}

/** ?simular=true: só valida e devolve o relatório. */
export async function simularImportacao(escolaId: number, arquivo: Buffer) {
  const { relatorio } = await validar(escolaId, arquivo, await anoLetivoAtual(escolaId));
  return relatorioParaApi(relatorio);
}

export async function importarAlunos(escolaId: number, arquivo: Buffer, ator: AtorUsuario) {
  const anoLetivo = await anoLetivoAtual(escolaId);
  const { relatorio, turmas } = await validar(escolaId, arquivo, anoLetivo);
  if (relatorio.erros.length > 0) {
    throw new ErroApi(422, 'IMPORTACAO_COM_ERROS', 'A planilha tem erros. Nada foi importado.', relatorioParaApi(relatorio));
  }

  let r: Awaited<ReturnType<typeof inserirAlunos>>;
  try {
    r = await db.transaction(async (trx) => {
      // Cria as turmas novas do ano letivo atual.
      const idTurma = new Map(turmas.map((t) => [chaveTurma(t.nome), t.id]));
      for (const nome of relatorio.turmasNovas) {
        const [id] = await trx('turmas_lanchei').insert({ escola_id: escolaId, nome, ano_letivo: anoLetivo });
        idTurma.set(chaveTurma(nome), id!);
      }
      const r = await inserirAlunos(
        trx,
        escolaId,
        ator.id,
        relatorio.alunos.map((a) => ({ nome: a.nome, matricula: a.matricula, turmaId: idTurma.get(chaveTurma(a.turma))!, emails: a.emails })),
      );
      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'ALUNOS_IMPORTAR',
        entidade: 'alunos',
        depois: { alunos: relatorio.validos, turmasCriadas: relatorio.turmasNovas, convites: r.convites.length },
      });
      return r;
    });
  } catch (e) {
    // Alguém cadastrou a mesma matrícula entre a validação e a gravação.
    if (ehChaveDuplicada(e)) throw erros.conflito('MATRICULA_JA_EXISTE', 'Uma das matrículas acabou de ser cadastrada. Simule de novo.');
    throw e;
  }

  enviarConvites(r.convites, r.nomes, await nomeDaEscola(db, escolaId));
  return { importados: relatorio.validos, turmasCriadas: relatorio.turmasNovas, convitesCriados: r.convites.length };
}
