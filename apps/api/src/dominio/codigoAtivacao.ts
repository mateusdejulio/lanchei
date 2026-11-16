// Código de ativação que a escola manda para cada responsável (8 caracteres).
//
// Alfabeto SEM caracteres ambíguos: nada de 0/O, 1/I/L. O código é lido num
// e-mail e às vezes digitado à mão no celular; "B0LA" ou "BOLA"? Aqui não
// existe essa dúvida.
// 31 símbolos ^ 8 posições ≈ 852 bilhões de combinações. Com 5 tentativas
// por hora por responsável (etapa3 §2.7), adivinhar é inviável.
import { randomInt } from 'node:crypto';
import { sha256 } from '../infra/cripto.js';

export const ALFABETO_CODIGO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TAMANHO_CODIGO = 8;
export const VALIDADE_CONVITE_MS = 7 * 86_400_000; // 7 dias

/** Gera um código aleatório. randomInt usa o gerador criptográfico (Math.random NÃO serve). */
export function gerarCodigoAtivacao(): string {
  let codigo = '';
  for (let i = 0; i < TAMANHO_CODIGO; i++) codigo += ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)];
  return codigo;
}

/** "abcd-2345 " -> "ABCD2345". Aceita o código com hífen, espaço e minúsculas. */
export function normalizarCodigo(entrada: string): string {
  return entrada.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "ABCD2345" -> "ABCD-2345" (mais fácil de ler no e-mail). */
export function formatarCodigo(codigo: string): string {
  return `${codigo.slice(0, 4)}-${codigo.slice(4)}`;
}

/** O banco guarda só o hash do código NORMALIZADO (como as senhas, só que sem argon2: ver abaixo). */
export function hashCodigo(codigo: string): Buffer {
  // SHA-256 simples é suficiente aqui: o código vale 7 dias, é aleatório
  // (não é uma senha escolhida por gente) e a busca precisa ser por igualdade
  // no índice UNIQUE, o que argon2 (com sal) não permitiria.
  return sha256(normalizarCodigo(codigo));
}
