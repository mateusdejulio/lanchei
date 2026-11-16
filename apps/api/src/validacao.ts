// Pedaços de validação (Zod) reaproveitados por várias rotas.
import { z } from 'zod';

/** E-mail sem espaços nas pontas e em minúsculas (o banco guarda assim; o UNIQUE depende disso). */
export const zEmail = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.email('E-mail inválido.').max(254),
);

/**
 * Senha NOVA (cadastro, redefinição). Mínimo de 8 caracteres (etapa3 §1).
 * O máximo existe porque o argon2 processa a senha inteira: sem limite,
 * alguém poderia mandar 10 MB de "senha" para ocupar o servidor.
 */
export const zSenhaNova = z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(200);

/** Nome de pessoa: sem espaços nas pontas, nem vazio. */
export const zNome = z.string().trim().min(1, 'Informe o nome.').max(150);

/** Id numérico vindo da URL (/escolas/:escolaId). */
export const zId = z.coerce.number().int().positive();

/** Token que veio num link de e-mail. */
export const zTokenEmail = z.string().min(20).max(200);
