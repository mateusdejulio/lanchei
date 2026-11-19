// Ações da CANTINA sobre o saldo do aluno: ajuste manual e encerramento com
// reembolso. As duas mexem em dinheiro, então:
//   - o saldo só muda por lancarTransacao() (ledger imutável);
//   - a CONTA é sempre o primeiro lock; a linha do aluno vem depois
//     (ordem do sistema: conta → aluno → pedido/depósito → produtos);
//   - tudo acontece numa transação, com auditoria.
import { db } from '../../infra/db.js';
import { lancarTransacao, travarConta } from '../../dominio/ledger.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { primeiroNome, reais } from '../../dominio/notificacoes.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { erros } from '../../erros.js';
import { nomeDaEscola } from './acesso.js';

/** Conta do aluno DESTA escola (sem lock). 404 se o aluno é de outra escola. */
async function contaDoAluno(escolaId: number, alunoId: number) {
  const c = await db('contas_lanchei').where({ aluno_id: alunoId, escola_id: escolaId }).first<{ id: number } | undefined>('id');
  if (!c) throw erros.naoEncontrado('Aluno não encontrado.');
  return c.id;
}

/** Janela em que um ajuste IDÊNTICO é tratado como clique duplo. */
const SEGUNDOS_AJUSTE_DUPLICADO = 60;

/**
 * POST /admin/alunos/:id/ajustes: crédito (+) ou débito (-) manual, com descrição.
 * Usos: Pix contestado depois de creditado, erro operacional, cortesia.
 * O saldo nunca fica negativo (lancarTransacao recusa com 422 SALDO_INSUFICIENTE).
 */
export async function ajustarSaldo(escolaId: number, alunoId: number, d: { valorCentavos: number; descricao: string }, ator: AtorUsuario, agora = new Date()) {
  const contaId = await contaDoAluno(escolaId, alunoId);
  return db.transaction(async (trx) => {
    await travarConta(trx, escolaId, contaId);
    const aluno = await trx('alunos_lanchei').where({ id: alunoId }).first<{ status: string }>('status');
    // Conta encerrada: só aceita DÉBITO, para zerar um crédito que chegou
    // atrasado (ex.: Pix pago no último segundo) depois de devolvê-lo à família.
    if (aluno.status === 'ENCERRADO' && d.valorCentavos > 0) {
      throw erros.regra('ALUNO_ENCERRADO', 'Este aluno está encerrado; não é possível adicionar saldo.');
    }

    // Proteção contra clique duplo. O ledger não tem Idempotency-Key para
    // ajustes, então a regra é: mesmo usuário, mesma conta, mesmo valor e
    // mesma descrição em menos de 1 minuto = repetição acidental.
    // Como a conta está travada, duas requisições simultâneas fazem fila e a
    // segunda sempre enxerga o lançamento da primeira.
    const repetido = await trx('transacoes_lanchei')
      .where({ conta_id: contaId, tipo: 'AJUSTE', valor_centavos: d.valorCentavos, usuario_id: ator.id, descricao: d.descricao })
      .where('created_at', '>', new Date(agora.getTime() - SEGUNDOS_AJUSTE_DUPLICADO * 1000))
      .first('id');
    if (repetido) {
      throw erros.conflito('AJUSTE_DUPLICADO', 'Um ajuste idêntico acabou de ser lançado. Se for outro ajuste, mude a descrição ou aguarde 1 minuto.');
    }

    const lanc = await lancarTransacao(trx, {
      escolaId,
      contaId,
      tipo: 'AJUSTE',
      valorCentavos: d.valorCentavos,
      usuarioId: ator.id,
      descricao: d.descricao,
      criadoEm: agora,
    });
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'AJUSTE_SALDO',
      entidade: 'transacoes',
      entidadeId: lanc.transacaoId,
      alunoId,
      antes: { saldoCentavos: lanc.saldoAntesCentavos },
      depois: { saldoCentavos: lanc.saldoAposCentavos, valorCentavos: d.valorCentavos, descricao: d.descricao },
    });
    return { transacaoId: lanc.transacaoId, saldoCentavos: lanc.saldoAposCentavos };
  });
}

export interface DadosEncerramento {
  motivo: string;
  reembolso?: { forma: 'PIX' | 'TRANSFERENCIA' | 'DINHEIRO'; comprovanteRef?: string | undefined } | undefined;
}

/**
 * POST /admin/alunos/:id/encerramento: o aluno saiu da escola (ou se formou).
 *
 * Não existe saque no Lanchei; o ÚNICO jeito de o saldo voltar para a família
 * é este: a cantina devolve o dinheiro por fora (Pix, transferência ou
 * dinheiro) e registra aqui. Numa transação só:
 *   saldo > 0 → registro em reembolsos + lançamento REEMBOLSO (saldo vai a 0)
 *   aluno ENCERRADO, carteirinha revogada, convites pendentes revogados, auditoria.
 */
export async function encerrarAluno(escolaId: number, alunoId: number, d: DadosEncerramento, ator: AtorUsuario, agora = new Date()) {
  const contaId = await contaDoAluno(escolaId, alunoId);

  const r = await db.transaction(async (trx) => {
    // Conta travada: nenhuma compra, estorno ou crédito de Pix entra no meio.
    const conta = await travarConta(trx, escolaId, contaId);
    const aluno = await trx('alunos_lanchei').where({ id: alunoId }).forUpdate().first<{ nome: string; status: string }>('nome', 'status');
    if (aluno.status === 'ENCERRADO') throw erros.conflito('JA_ENCERRADO', 'Este aluno já está encerrado.');

    // Pix em aberto: se a família pagar depois do encerramento, o crédito
    // cairia numa conta já fechada. Melhor esperar o Pix vencer (30 min).
    const pixAberto = await trx('depositos_lanchei')
      .where({ conta_id: contaId, status: 'PENDENTE' })
      .andWhere((q) => q.whereNull('expira_em').orWhere('expira_em', '>', agora))
      .orderBy('expira_em', 'desc')
      .first<{ expira_em: Date | null } | undefined>('expira_em');
    if (pixAberto) {
      throw erros.conflito('DEPOSITO_PENDENTE', 'Há um Pix em aberto para este aluno. Aguarde ele ser pago ou vencer e tente de novo.', {
        expiraEm: pixAberto.expira_em,
      });
    }

    const saldo = conta.saldo_centavos;
    let reembolso: { id: number; valorCentavos: number; forma: string } | null = null;
    if (saldo > 0) {
      if (!d.reembolso) {
        throw erros.regra('SALDO_PENDENTE', `O aluno tem ${reais(saldo)} de saldo. Informe como o valor foi devolvido à família.`, { saldoCentavos: saldo });
      }
      const [reembolsoId] = await trx('reembolsos_lanchei').insert({
        escola_id: escolaId,
        conta_id: contaId,
        valor_centavos: saldo,
        forma: d.reembolso.forma,
        comprovante_ref: d.reembolso.comprovanteRef ?? null,
        motivo: d.motivo,
        usuario_id: ator.id,
      });
      await lancarTransacao(trx, {
        escolaId,
        contaId,
        tipo: 'REEMBOLSO',
        valorCentavos: -saldo, // o saldo INTEIRO: a conta fecha zerada
        reembolsoId: reembolsoId!,
        usuarioId: ator.id,
        descricao: `Reembolso no encerramento (${d.reembolso.forma})`,
        criadoEm: agora,
      });
      reembolso = { id: reembolsoId!, valorCentavos: saldo, forma: d.reembolso.forma };
    }

    await trx('alunos_lanchei').where({ id: alunoId }).update({ status: 'ENCERRADO', encerrado_em: agora });
    await trx('carteirinhas_lanchei')
      .where({ aluno_vivo: alunoId })
      .update({ status: 'REVOGADA', revogada_em: agora, motivo_revogacao: 'Encerramento do aluno' });
    await trx('convites_responsavel_lanchei').where({ aluno_id: alunoId }).whereNull('usado_em').whereNull('revogado_em').update({ revogado_em: agora });

    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'ALUNO_ENCERRAR',
      entidade: 'alunos',
      entidadeId: alunoId,
      alunoId,
      antes: { status: aluno.status, saldoCentavos: saldo },
      depois: { motivo: d.motivo, reembolso: reembolso ? { ...reembolso, comprovanteRef: d.reembolso?.comprovanteRef ?? null } : null },
    });

    // Os vínculos continuam: os responsáveis ainda podem ver o extrato no app.
    const responsaveis = await trx('aluno_responsaveis_lanchei as ar')
      .join('responsaveis_lanchei as r', 'r.id', 'ar.responsavel_id')
      .where('ar.aluno_id', alunoId)
      .whereNull('ar.desvinculado_em')
      .select<{ nome: string; email: string }[]>('r.nome', 'r.email');
    return { reembolso, nomeAluno: aluno.nome, responsaveis };
  });

  // Depois do COMMIT: avisa os responsáveis por e-mail (não existe tipo de push para isso).
  const escola = await nomeDaEscola(db, escolaId);
  for (const resp of r.responsaveis) {
    enviarEmailEmSegundoPlano(
      {
        para: resp.email,
        ...modelos.contaEncerrada({
          nomeResponsavel: resp.nome,
          primeiroNomeAluno: primeiroNome(r.nomeAluno),
          escola,
          reembolso: r.reembolso ? { valor: reais(r.reembolso.valorCentavos), forma: r.reembolso.forma } : null,
        }),
      },
      'conta-encerrada',
    );
  }
  return { status: 'ENCERRADO' as const, reembolso: r.reembolso };
}
