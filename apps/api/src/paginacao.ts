// Paginação por cursor (etapa3 §1): ?limite=20&cursor=<opaco>
//
// Por que cursor e não "página 3"? Com OFFSET, se entra um registro novo
// enquanto a pessoa rola a lista, tudo "anda" uma posição e um item aparece
// duas vezes (ou some). O cursor diz "continue DEPOIS deste item", então a
// lista é estável. E o banco usa o índice em vez de contar e pular linhas.
//
// O cursor é a posição do último item, em JSON e base64url. "Opaco" quer
// dizer: o cliente não deve montar nem interpretar; só devolver.
import { z } from 'zod';
import { ErroApi } from './erros.js';

export const zLimite = z.coerce.number().int().min(1).max(100).default(20);

export function codificarCursor(valor: unknown): string {
  return Buffer.from(JSON.stringify(valor)).toString('base64url');
}

export function decodificarCursor<T>(cursor: string | undefined, esquema: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  try {
    return esquema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ErroApi(400, 'VALIDACAO', 'Cursor inválido.', { campos: [{ campo: 'cursor', mensagem: 'Cursor inválido.' }] });
  }
}

/** Busca limite+1 para saber se existe próxima página sem fazer COUNT. */
export function paginar<T>(linhas: T[], limite: number, cursorDe: (ultimo: T) => unknown) {
  const temMais = linhas.length > limite;
  const itens = temMais ? linhas.slice(0, limite) : linhas;
  return { itens, proximoCursor: temMais ? codificarCursor(cursorDe(itens[itens.length - 1]!)) : null };
}
