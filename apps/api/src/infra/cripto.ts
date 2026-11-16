// Utilitários de criptografia.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../config/env.js';

/** Token aleatório seguro em base64url (padrão: 128 bits). */
export function tokenAleatorio(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 (32 bytes). Usado para guardar tokens no banco sem guardar o token. */
export function sha256(valor: string | Buffer): Buffer {
  return createHash('sha256').update(valor).digest();
}

/** Comparação em tempo constante (evita ataque de tempo). */
export function iguaisSeguro(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Senhas e PIN (argon2id) ----
export const hashSenha = (senha: string) => argon2.hash(senha, { type: argon2.argon2id });
export const verificarSenha = (hash: string, senha: string) => argon2.verify(hash, senha).catch(() => false);

// Hash "falso" para gastar o mesmo tempo quando o usuário não existe
// (não dá para descobrir quais e-mails têm conta medindo o tempo do login).
let hashFicticio: Promise<string> | undefined;
export async function verificarSenhaFicticia(senha: string): Promise<false> {
  hashFicticio ??= hashSenha('senha-ficticia-para-tempo-constante');
  await verificarSenha(await hashFicticio, senha);
  return false;
}

// ---- AES-256-GCM (tokens do Mercado Pago) ----
// Formato gravado: [12 bytes IV][16 bytes authTag][dados cifrados]
const CHAVE = Buffer.from(env.CHAVE_CRIPTOGRAFIA, 'hex');

export function criptografar(texto: string): Buffer {
  const iv = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', CHAVE, iv);
  const dados = Buffer.concat([cifra.update(texto, 'utf8'), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), dados]);
}

export function descriptografar(pacote: Buffer): string {
  const iv = pacote.subarray(0, 12);
  const tag = pacote.subarray(12, 28);
  const dados = pacote.subarray(28);
  const decifra = createDecipheriv('aes-256-gcm', CHAVE, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8');
}
