// Carteirinhas: emissão individual, em lote por turma e desbloqueio.
//
// O QR guarda um token aleatório de 128 bits; o banco guarda SÓ o SHA-256.
// Por isso o qrConteudo existe apenas na resposta da emissão: "reimprimir"
// = emitir uma nova (e a anterior para de funcionar). Uma impressão vazada
// não vira acesso permanente.
import { db, type Trx } from '../../infra/db.js';
import { sha256, tokenAleatorio } from '../../infra/cripto.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { notificarResponsaveis, primeiroNome } from '../../dominio/notificacoes.js';
import { erros } from '../../erros.js';
import { montarQr } from '../caixa/identificacao.js';
import { alunoDaEscola, exigirNaoEncerrado } from './acesso.js';

/** Insere a carteirinha nova e devolve o conteúdo do QR (só existe aqui, em memória). */
async function inserirCarteirinha(trx: Trx, escolaId: number, alunoId: number, usuarioId: number) {
  const token = tokenAleatorio(16); // 128 bits
  const [id] = await trx('carteirinhas_lanchei').insert({
    escola_id: escolaId,
    aluno_id: alunoId,
    token_hash: sha256(token),
    emitida_por_usuario_id: usuarioId,
  });
  return { carteirinhaId: id!, qrConteudo: montarQr(token) };
}

/** POST /admin/alunos/:id/carteirinhas */
export async function emitirCarteirinha(escolaId: number, alunoId: number, motivo: string | undefined, ator: AtorUsuario) {
  return db.transaction(async (trx) => {
    // Trava o aluno: duas emissões ao mesmo tempo fazem fila aqui.
    const aluno = await alunoDaEscola(trx, escolaId, alunoId, true);
    exigirNaoEncerrado(aluno);

    // PRIMEIRO revoga a viva, DEPOIS insere a nova: a UNIQUE (aluno_vivo)
    // não aceita duas carteirinhas vivas nem por um instante.
    const anterior = await trx('carteirinhas_lanchei').where({ aluno_vivo: alunoId }).first<{ id: number; status: string } | undefined>('id', 'status');
    if (anterior) {
      await trx('carteirinhas_lanchei')
        .where({ id: anterior.id })
        .update({ status: 'REVOGADA', revogada_em: new Date(), motivo_revogacao: motivo ?? 'Reemissão' });
    }
    const nova = await inserirCarteirinha(trx, escolaId, alunoId, ator.id);

    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'CARTEIRINHA_EMITIR',
      entidade: 'carteirinhas',
      entidadeId: nova.carteirinhaId,
      alunoId,
      antes: anterior ? { carteirinhaId: anterior.id, status: anterior.status } : undefined,
      depois: { motivo: motivo ?? null },
    });
    if (anterior) {
      await notificarResponsaveis(trx, {
        alunoId,
        tipo: 'CARTEIRINHA',
        titulo: 'Nova carteirinha emitida',
        corpo: `A escola emitiu uma nova carteirinha para ${primeiroNome(aluno.nome)}. A anterior não funciona mais.`,
      });
    }
    return {
      ...nova,
      aluno: { id: aluno.id, nome: aluno.nome, matricula: aluno.matricula, turma: aluno.turma_nome },
    };
  });
}

/**
 * POST /admin/turmas/:id/carteirinhas: emite para os alunos ATIVOS da turma
 * que estão SEM carteirinha viva (quem já tem não é afetado; para trocar,
 * use a emissão individual). Tudo numa transação.
 */
export async function emitirCarteirinhasDaTurma(escolaId: number, turmaId: number, ator: AtorUsuario) {
  return db.transaction(async (trx) => {
    const turma = await trx('turmas_lanchei').where({ id: turmaId, escola_id: escolaId }).first<{ nome: string } | undefined>('nome');
    if (!turma) throw erros.naoEncontrado('Turma não encontrada.');

    // Trava os alunos da turma (em ordem de id) para que uma emissão
    // individual simultânea não crie uma segunda carteirinha viva.
    const alunos = await trx('alunos_lanchei')
      .where({ escola_id: escolaId, turma_id: turmaId, status: 'ATIVO' })
      .orderBy('id')
      .forUpdate()
      .select<{ id: number; nome: string; matricula: string }[]>('id', 'nome', 'matricula');
    const comCarteirinha = new Set(
      await trx('carteirinhas_lanchei').whereIn('aluno_vivo', alunos.map((a) => a.id)).pluck<number[]>('aluno_vivo'),
    );
    const temFoto = new Set(
      await trx('fotos_alunos_lanchei').whereIn('aluno_id', alunos.map((a) => a.id)).pluck<number[]>('aluno_id'),
    );

    const itens = [];
    for (const a of alunos.filter((x) => !comCarteirinha.has(x.id)).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'))) {
      const nova = await inserirCarteirinha(trx, escolaId, a.id, ator.id);
      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'CARTEIRINHA_EMITIR',
        entidade: 'carteirinhas',
        entidadeId: nova.carteirinhaId,
        alunoId: a.id,
        depois: { lote: true, turmaId },
      });
      itens.push({ alunoId: a.id, nome: a.nome, matricula: a.matricula, turma: turma.nome, temFoto: temFoto.has(a.id), ...nova });
    }
    return { itens };
  });
}

/** POST /admin/alunos/:id/carteirinha/desbloquear (ex.: responsável sem acesso ao app). */
export async function desbloquearCarteirinha(escolaId: number, alunoId: number, ator: AtorUsuario) {
  return db.transaction(async (trx) => {
    const aluno = await alunoDaEscola(trx, escolaId, alunoId, true);
    const cart = await trx('carteirinhas_lanchei').where({ aluno_vivo: alunoId }).first<{ id: number; status: string } | undefined>('id', 'status');
    if (!cart) throw erros.naoEncontrado('Este aluno não tem carteirinha. Emita uma nova.');
    if (cart.status === 'ATIVA') return { status: 'ATIVA' }; // repetir não dá erro

    await trx('carteirinhas_lanchei').where({ id: cart.id }).update({ status: 'ATIVA' });
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'CARTEIRINHA_DESBLOQUEAR',
      entidade: 'carteirinhas',
      entidadeId: cart.id,
      alunoId,
      antes: { status: cart.status },
      depois: { status: 'ATIVA' },
    });
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'CARTEIRINHA',
      titulo: 'Carteirinha desbloqueada',
      corpo: `A escola desbloqueou a carteirinha de ${primeiroNome(aluno.nome)}.`,
    });
    return { status: 'ATIVA' };
  });
}
