// Como o caixa descobre QUEM está comprando: pela carteirinha (QR) ou
// pelo PIN (compra sem carteirinha). O servidor sempre resolve o aluno;
// a tela do caixa nunca escolhe o aluno sozinha.
import { db } from '../../infra/db.js';
import { sha256, verificarSenha } from '../../infra/cripto.js';
import { ErroApi, erros } from '../../erros.js';
import { notificarResponsaveis, primeiroNome } from '../../dominio/notificacoes.js';

export const PREFIXO_QR = 'LCH1.';
export const MAX_FALHAS_PIN = 5;
export const MINUTOS_BLOQUEIO_PIN = 30;

const carteirinhaInvalida = () => new ErroApi(404, 'CARTEIRINHA_INVALIDA', 'Carteirinha não reconhecida.');

/** "LCH1.<token>" -> token. Qualquer outro formato é recusado na hora. */
export function extrairTokenQr(qrConteudo: string): string {
  const conteudo = qrConteudo.trim();
  if (!conteudo.startsWith(PREFIXO_QR)) throw carteirinhaInvalida();
  const token = conteudo.slice(PREFIXO_QR.length);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw carteirinhaInvalida();
  return token;
}

export function montarQr(token: string): string {
  return PREFIXO_QR + token;
}

export interface AlunoIdentificado {
  alunoId: number;
  carteirinhaId: number | null;
  carteirinhaStatus: 'ATIVA' | 'BLOQUEADA' | null;
}

export async function identificarPorQr(escolaId: number, qrConteudo: string): Promise<AlunoIdentificado> {
  const token = extrairTokenQr(qrConteudo);
  const cart = await db('carteirinhas_lanchei')
    .where({ token_hash: sha256(token), escola_id: escolaId })
    .first<{ id: number; aluno_id: number; status: 'ATIVA' | 'BLOQUEADA' | 'REVOGADA' } | undefined>(
      'id',
      'aluno_id',
      'status',
    );
  // Revogada = não existe para o caixa (nenhum dado do aluno é exposto).
  if (!cart || cart.status === 'REVOGADA') throw carteirinhaInvalida();
  return { alunoId: cart.aluno_id, carteirinhaId: cart.id, carteirinhaStatus: cart.status };
}

/**
 * Confere o PIN. Erros contam tentativas; na 5ª, o PIN trava por 30 min
 * e os responsáveis recebem aviso. O contador é gravado mesmo quando a
 * resposta é erro (por isso a transação própria, separada da compra).
 */
export async function verificarPinAluno(escolaId: number, alunoId: number, pin: string, agora: Date): Promise<void> {
  const aluno = await db('alunos_lanchei as a')
    .join('regras_aluno_lanchei as r', 'r.aluno_id', 'a.id')
    .where({ 'a.id': alunoId, 'a.escola_id': escolaId })
    .first<
      | { nome: string; pin_hash: string | null; pin_falhas: number; pin_bloqueado_ate: Date | null; permite_sem_carteirinha: boolean }
      | undefined
    >('a.nome', 'a.pin_hash', 'a.pin_falhas', 'a.pin_bloqueado_ate', 'r.permite_sem_carteirinha');

  if (!aluno) throw erros.naoEncontrado('Aluno não encontrado.');
  if (!aluno.permite_sem_carteirinha || !aluno.pin_hash) {
    throw erros.regra('SEM_CARTEIRINHA_DESATIVADO', 'O responsável não liberou compras sem carteirinha para este aluno.');
  }
  if (aluno.pin_bloqueado_ate && aluno.pin_bloqueado_ate > agora) {
    throw new ErroApi(423, 'PIN_BLOQUEADO', 'PIN bloqueado por excesso de tentativas. Tente mais tarde.', {
      bloqueadoAte: aluno.pin_bloqueado_ate.toISOString(),
    });
  }

  if (await verificarSenha(aluno.pin_hash, pin)) {
    if (aluno.pin_falhas > 0 || aluno.pin_bloqueado_ate) {
      await db('alunos_lanchei').where({ id: alunoId }).update({ pin_falhas: 0, pin_bloqueado_ate: null });
    }
    return;
  }

  // PIN errado: incrementa de forma atômica (dois caixas ao mesmo tempo não "perdem" tentativa).
  const resultado = await db.transaction(async (trx) => {
    const linha = await trx('alunos_lanchei').where({ id: alunoId }).forUpdate().first<{ pin_falhas: number }>('pin_falhas');
    const falhas = (linha?.pin_falhas ?? 0) + 1;
    if (falhas >= MAX_FALHAS_PIN) {
      const ate = new Date(agora.getTime() + MINUTOS_BLOQUEIO_PIN * 60_000);
      await trx('alunos_lanchei').where({ id: alunoId }).update({ pin_falhas: 0, pin_bloqueado_ate: ate });
      await notificarResponsaveis(trx, {
        alunoId,
        tipo: 'CARTEIRINHA',
        titulo: 'PIN bloqueado',
        corpo: `O PIN de ${primeiroNome(aluno.nome)} foi digitado errado ${MAX_FALHAS_PIN} vezes e ficou bloqueado por ${MINUTOS_BLOQUEIO_PIN} minutos.`,
        dados: { evento: 'PIN_BLOQUEADO' },
      });
      return { bloqueado: true as const, ate };
    }
    await trx('alunos_lanchei').where({ id: alunoId }).update({ pin_falhas: falhas });
    return { bloqueado: false as const, restantes: MAX_FALHAS_PIN - falhas };
  });

  if (resultado.bloqueado) {
    throw new ErroApi(423, 'PIN_BLOQUEADO', 'PIN bloqueado por excesso de tentativas. Tente mais tarde.', {
      bloqueadoAte: resultado.ate.toISOString(),
    });
  }
  throw erros.regra('PIN_INCORRETO', 'PIN incorreto.', { tentativasRestantes: resultado.restantes });
}
