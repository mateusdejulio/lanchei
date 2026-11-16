// Aplica database/schema.sql usando o próprio Node (sem precisar do
// cliente `mysql` instalado). Entende o comando DELIMITER usado nos
// triggers, que o driver mysql2 não entende sozinho.
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

/** Divide o script em comandos, respeitando DELIMITER. */
export function dividirComandos(sql: string): string[] {
  const comandos: string[] = [];
  let delimitador = ';';
  let atual: string[] = [];

  for (const linhaBruta of sql.split(/\r?\n/)) {
    const linha = linhaBruta.trimEnd();
    const semEspaco = linha.trim();
    if (semEspaco === '' || semEspaco.startsWith('--')) continue; // comentário de linha inteira

    const mudanca = /^DELIMITER\s+(\S+)$/i.exec(semEspaco);
    if (mudanca) {
      delimitador = mudanca[1]!;
      continue;
    }

    if (semEspaco.endsWith(delimitador)) {
      atual.push(linha.slice(0, linha.length - delimitador.length));
      const comando = atual.join('\n').trim();
      if (comando) comandos.push(comando);
      atual = [];
    } else {
      atual.push(linha);
    }
  }
  if (atual.join('').trim()) throw new Error('schema.sql terminou com um comando sem delimitador');
  return comandos;
}

export interface OpcoesSchema {
  host: string;
  port: number;
  user: string;
  password: string;
  ssl?: { ca: string } | undefined;
  /** Nome do banco a criar (troca o "lanchei" do arquivo). */
  banco: string;
  /** Apaga o banco antes. CUIDADO: só para testes/dev. */
  recriar?: boolean;
  /**
   * Pula os CREATE TRIGGER. Use só se o provedor recusar triggers (alguns
   * MySQL gerenciados exigem privilégio SUPER com binlog ligado). Nesse caso
   * a imutabilidade do ledger fica garantida pelas permissões do grants.sql.
   */
  semTriggers?: boolean;
  caminhoSchema: string;
}

export async function aplicarSchema(op: OpcoesSchema): Promise<number> {
  if (!/^[a-z0-9_]+$/i.test(op.banco)) throw new Error('Nome de banco inválido');
  const sql = (await readFile(op.caminhoSchema, 'utf8'))
    .replace(/CREATE DATABASE IF NOT EXISTS lanchei\b/, `CREATE DATABASE IF NOT EXISTS ${op.banco}`)
    .replace(/^USE lanchei;/m, `USE ${op.banco};`);

  const conexao = await mysql.createConnection({
    host: op.host,
    port: op.port,
    user: op.user,
    password: op.password,
    ssl: op.ssl,
  });
  try {
    if (op.recriar) await conexao.query(`DROP DATABASE IF EXISTS ${op.banco}`);
    const comandos = dividirComandos(sql).filter((c) => !(op.semTriggers && /^CREATE\s+TRIGGER\b/i.test(c)));
    for (const comando of comandos) await conexao.query(comando);
    return comandos.length;
  } finally {
    await conexao.end();
  }
}
