// Conexão com o MySQL via Knex.
import knexFactory, { type Knex } from 'knex';
import { env } from '../config/env.js';

export type Trx = Knex.Transaction;
export type Db = Knex | Knex.Transaction;

export const db: Knex = knexFactory({
  client: 'mysql2',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    // Datas sempre em UTC entre o Node e o MySQL.
    timezone: 'Z',
    // BIGINT e SUM() voltam como number (nossos valores cabem com folga
    // em Number.MAX_SAFE_INTEGER: ~90 trilhões de reais em centavos).
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    ssl: env.DB_SSL_CA ? { ca: env.DB_SSL_CA, rejectUnauthorized: true } : undefined,
    // BOOLEAN no MySQL é TINYINT(1): converte para true/false.
    typeCast(field: { type: string; length: number; string(): string | null }, next: () => unknown) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  },
  pool: {
    min: 0,
    max: 10,
    // Garante UTC também nas funções do MySQL (NOW(), CURRENT_TIMESTAMP...).
    afterCreate(conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) {
      conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
    },
  },
});

/** Código de erro do MySQL para chave duplicada. */
export function ehChaveDuplicada(erro: unknown): boolean {
  return typeof erro === 'object' && erro !== null && (erro as { code?: string }).code === 'ER_DUP_ENTRY';
}
