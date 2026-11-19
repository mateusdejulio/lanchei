// npm run dev (na raiz): sobe ao mesmo tempo todos os workspaces que têm
// script "dev" (a API e, quando existirem, o painel e o app dos pais),
// com o nome de cada um na frente das linhas do terminal.
// Ctrl+C derruba todos. Sem dependência extra (só Node).
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// A ordem importa só para a leitura do terminal: API primeiro.
const candidatos = [
  { pasta: 'apps/api', rotulo: 'api ', cor: 36 },
  { pasta: 'apps/web', rotulo: 'web ', cor: 35 },
  { pasta: 'apps/pais', rotulo: 'pais', cor: 33 },
];

const ativos = candidatos.filter(({ pasta }) => {
  const pkg = join(raiz, pasta, 'package.json');
  return existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).scripts?.dev;
});

const filhos = ativos.map(({ pasta, rotulo, cor }) => {
  // shell: true para achar o "npm" também no Windows (npm.cmd). O comando vai
  // como string única: as pastas são fixas aqui, nada vem do usuário.
  const filho = spawn(`npm run dev -w ${pasta}`, { cwd: raiz, shell: true, env: process.env });
  const prefixo = `\x1b[${cor}m[${rotulo}]\x1b[0m `;
  const repassar = (saida) => (dados) => {
    for (const linha of String(dados).split(/\r?\n/)) if (linha.trim()) saida.write(prefixo + linha + '\n');
  };
  filho.stdout.on('data', repassar(process.stdout));
  filho.stderr.on('data', repassar(process.stderr));
  filho.on('exit', (codigo) => process.stdout.write(`${prefixo}terminou (código ${codigo})\n`));
  return filho;
});

console.log(`Subindo: ${ativos.map((a) => a.pasta).join(', ')}. Ctrl+C para parar todos.`);
const parar = () => {
  for (const f of filhos) f.kill();
  process.exit(0);
};
process.on('SIGINT', parar);
process.on('SIGTERM', parar);
