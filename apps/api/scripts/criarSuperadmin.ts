// Cria o SUPERADMIN (você). Rode uma vez após aplicar o schema:
//   npm run db:superadmin -- --nome "Mateus" --email voce@exemplo.com --senha "uma-senha-forte"
import { parseArgs } from 'node:util';
import { db } from '../src/infra/db.js';
import { hashSenha } from '../src/infra/cripto.js';

const { values } = parseArgs({
  options: { nome: { type: 'string' }, email: { type: 'string' }, senha: { type: 'string' } },
});
if (!values.nome || !values.email || !values.senha || values.senha.length < 12) {
  console.error('Uso: --nome "..." --email ... --senha "..." (senha com 12+ caracteres)');
  process.exit(1);
}

await db('usuarios_lanchei').insert({
  escola_id: null,
  papel: 'SUPERADMIN',
  nome: values.nome,
  email: values.email.toLowerCase(),
  senha_hash: await hashSenha(values.senha),
});
console.log('Superadmin criado.');
await db.destroy();
