// Textos de cada motivo de recusa, para a ATENDENTE (caixa, etapa5 §6.3) e
// para os PAIS (app, etapa7 §6.4). Num lugar só, para os dois apps falarem
// a mesma língua.
import type { MotivoRecusa } from './api/tipos';

export interface TextoRecusa {
  /** Título grande na tela vermelha do caixa. */
  titulo: string;
  /** O que a atendente faz/diz. */
  orientacaoCaixa: string;
  /** Como aparece no extrato dos pais (em cinza). */
  textoPais: string;
}

export const TEXTOS_RECUSA: Record<MotivoRecusa, TextoRecusa> = {
  CONTA_INATIVA: {
    titulo: 'Conta inativa',
    orientacaoCaixa: 'Nada foi cobrado. Peça para o aluno procurar a secretaria.',
    textoPais: 'Conta inativa. Nada foi cobrado.',
  },
  CARTEIRINHA_BLOQUEADA: {
    titulo: 'Carteirinha bloqueada',
    orientacaoCaixa: 'O responsável bloqueou esta carteirinha. Nada foi cobrado.',
    textoPais: 'Carteirinha bloqueada. Nada foi cobrado.',
  },
  DIA_NAO_PERMITIDO: {
    titulo: 'Compra não liberada hoje',
    orientacaoCaixa: 'Os responsáveis não liberaram compras neste dia da semana.',
    textoPais: 'Dia não liberado para compras. Nada foi cobrado.',
  },
  ITEM_BLOQUEADO: {
    titulo: 'Item bloqueado',
    orientacaoCaixa: 'Itens destacados não são permitidos para este aluno. Remova-os e cobre de novo.',
    textoPais: 'Item bloqueado por você. Nada foi cobrado.',
  },
  LIMITE_DIARIO: {
    titulo: 'Limite diário atingido',
    orientacaoCaixa: 'Nada foi cobrado. Diga ao aluno que o limite de hoje definido pelos responsáveis já foi usado.',
    textoPais: 'Limite diário atingido. Nada foi cobrado.',
  },
  LIMITE_SEMANAL: {
    titulo: 'Limite semanal atingido',
    orientacaoCaixa: 'Nada foi cobrado. Diga ao aluno que o limite desta semana definido pelos responsáveis já foi usado.',
    textoPais: 'Limite semanal atingido. Nada foi cobrado.',
  },
  LIMITE_MENSAL: {
    titulo: 'Limite mensal atingido',
    orientacaoCaixa: 'Nada foi cobrado. Diga ao aluno que o limite deste mês definido pelos responsáveis já foi usado.',
    textoPais: 'Limite mensal atingido. Nada foi cobrado.',
  },
  SALDO_INSUFICIENTE: {
    titulo: 'Saldo insuficiente',
    orientacaoCaixa: 'Nada foi cobrado. Peça para o aluno avisar os responsáveis para recarregar.',
    textoPais: 'Saldo insuficiente. Nada foi cobrado.',
  },
};

/** Frase do rodapé da tela de recusa do caixa (os pais são avisados pelo app). */
export const AVISO_PAIS_NOTIFICADOS = 'Os responsáveis foram avisados no app.';
