// Notificações = caixa de entrada do app + fila de push (outbox).
// Aqui só INSERIMOS dentro da transação do negócio; um job envia o push
// depois do COMMIT. Assim nunca sai push de uma compra que deu rollback.
import type { Trx } from '../infra/db.js';

export type TipoNotificacao =
  | 'COMPRA'
  | 'COMPRA_SEM_CARTEIRINHA'
  | 'COMPRA_RECUSADA'
  | 'SALDO_BAIXO'
  | 'DEPOSITO_CONFIRMADO'
  | 'CARTEIRINHA'
  | 'REGRAS_ALTERADAS'
  | 'ESTORNO';

export interface NovaNotificacao {
  alunoId: number;
  tipo: TipoNotificacao;
  titulo: string;
  corpo: string;
  dados?: Record<string, unknown>;
  /** Não notifica este responsável (ex.: quem fez a alteração). */
  excetoResponsavelId?: number;
  criadoEm?: Date;
}

/** Notifica todos os responsáveis com vínculo ATIVO. Devolve quantos. */
export async function notificarResponsaveis(trx: Trx, n: NovaNotificacao): Promise<number> {
  const ids = await trx('aluno_responsaveis_lanchei')
    .where({ aluno_id: n.alunoId })
    .whereNull('desvinculado_em')
    .pluck<number[]>('responsavel_id');
  const destinatarios = ids.filter((id) => id !== n.excetoResponsavelId);
  if (destinatarios.length === 0) return 0;

  await trx('notificacoes_lanchei').insert(
    destinatarios.map((responsavelId) => ({
      responsavel_id: responsavelId,
      aluno_id: n.alunoId,
      tipo: n.tipo,
      titulo: n.titulo,
      corpo: n.corpo,
      dados: n.dados ? JSON.stringify(n.dados) : null,
      ...(n.criadoEm ? { created_at: n.criadoEm } : {}),
    })),
  );
  return destinatarios.length;
}

const formatador = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** 1250 -> "R$ 12,50" */
export function reais(centavos: number): string {
  return formatador.format(centavos / 100).replace(/ /g, ' ');
}

/** "João Pedro da Silva" -> "João" (notificação curta e menos exposição). */
export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}
