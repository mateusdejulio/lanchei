// Matriz de permissões (docs/etapa6-painel.md §2), rota a rota.
//
// Para cada rota: os papéis PERMITIDOS não recebem 401/403 (podem receber
// 400/404/422, porque mandamos corpos genéricos: o que importa aqui é passar
// pela porta), e os PROIBIDOS recebem exatamente 403 SEM_PERMISSAO.
// Responsável (app dos pais) e SUPERADMIN também ficam de fora do /admin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { criarAluno, criarEscola, criarSuperadmin, logarEquipe, SENHA } from './fixtures.js';

afterAll(() => db.destroy());
const app = criarApp();

type Papel = 'ADMIN' | 'ESCOLA' | 'OPERADOR' | 'SUPERADMIN' | 'RESPONSAVEL';
const TODOS: Papel[] = ['ADMIN', 'ESCOLA', 'OPERADOR', 'SUPERADMIN', 'RESPONSAVEL'];

interface Rota {
  metodo: 'get' | 'post' | 'patch' | 'put';
  caminho: string; // :aluno, :turma, :convite, :usuario, :resp são trocados pelos ids reais
  pode: Papel[];
  descricao: string;
}

// A matriz da etapa6 §2, traduzida em rotas.
const MATRIZ: Rota[] = [
  // Dados da escola: os dois perfis (cada um com os seus campos; ver admin-alunos.test.ts)
  { metodo: 'get', caminho: '/v1/admin/escola', pode: ['ADMIN', 'ESCOLA'], descricao: 'ver dados da escola' },
  { metodo: 'patch', caminho: '/v1/admin/escola', pode: ['ADMIN', 'ESCOLA'], descricao: 'editar dados da escola' },
  // Equipe: cada perfil a sua (ver admin-vinculos.test.ts)
  { metodo: 'get', caminho: '/v1/admin/usuarios', pode: ['ADMIN', 'ESCOLA'], descricao: 'listar equipe' },
  { metodo: 'post', caminho: '/v1/admin/usuarios', pode: ['ADMIN', 'ESCOLA'], descricao: 'convidar equipe' },
  { metodo: 'patch', caminho: '/v1/admin/usuarios/:usuario', pode: ['ADMIN', 'ESCOLA'], descricao: 'editar equipe' },
  // Turmas: Diretoria (a Cantina só lista, para filtrar alunos)
  { metodo: 'get', caminho: '/v1/admin/turmas', pode: ['ADMIN', 'ESCOLA'], descricao: 'listar turmas' },
  { metodo: 'post', caminho: '/v1/admin/turmas', pode: ['ESCOLA'], descricao: 'criar turma' },
  { metodo: 'patch', caminho: '/v1/admin/turmas/:turma', pode: ['ESCOLA'], descricao: 'editar turma' },
  { metodo: 'patch', caminho: '/v1/admin/turmas/mover-alunos', pode: ['ESCOLA'], descricao: 'virada de ano' },
  // Alunos: cadastro = Diretoria; consulta = as duas
  { metodo: 'get', caminho: '/v1/admin/pendencias', pode: ['ESCOLA'], descricao: 'pendências' },
  { metodo: 'get', caminho: '/v1/admin/alunos', pode: ['ADMIN', 'ESCOLA'], descricao: 'consultar alunos' },
  { metodo: 'get', caminho: '/v1/admin/alunos/:aluno', pode: ['ADMIN', 'ESCOLA'], descricao: 'ficha do aluno' },
  { metodo: 'post', caminho: '/v1/admin/alunos', pode: ['ESCOLA'], descricao: 'cadastrar aluno' },
  { metodo: 'patch', caminho: '/v1/admin/alunos/:aluno', pode: ['ESCOLA'], descricao: 'editar/inativar aluno' },
  { metodo: 'get', caminho: '/v1/admin/alunos/importar/modelo', pode: ['ESCOLA'], descricao: 'modelo CSV' },
  { metodo: 'post', caminho: '/v1/admin/alunos/importar', pode: ['ESCOLA'], descricao: 'importar CSV' },
  { metodo: 'put', caminho: '/v1/admin/alunos/:aluno/foto', pode: ['ESCOLA'], descricao: 'enviar foto' },
  { metodo: 'get', caminho: '/v1/admin/alunos/:aluno/foto', pode: ['ADMIN', 'ESCOLA'], descricao: 'ver foto' },
  { metodo: 'post', caminho: '/v1/admin/alunos/:aluno/solicitar-encerramento', pode: ['ESCOLA'], descricao: 'solicitar encerramento' },
  // Histórico: as duas
  { metodo: 'get', caminho: '/v1/admin/alunos/:aluno/extrato', pode: ['ADMIN', 'ESCOLA'], descricao: 'histórico' },
  { metodo: 'get', caminho: '/v1/admin/alunos/:aluno/extrato.csv', pode: ['ADMIN', 'ESCOLA'], descricao: 'exportar histórico' },
  // Convites e vínculos: Diretoria
  { metodo: 'post', caminho: '/v1/admin/alunos/:aluno/convites', pode: ['ESCOLA'], descricao: 'convidar responsável' },
  { metodo: 'post', caminho: '/v1/admin/convites/:convite/reenviar', pode: ['ESCOLA'], descricao: 'reenviar convite' },
  { metodo: 'post', caminho: '/v1/admin/convites/:convite/revogar', pode: ['ESCOLA'], descricao: 'revogar convite' },
  { metodo: 'post', caminho: '/v1/admin/alunos/:aluno/responsaveis/:resp/desvincular', pode: ['ESCOLA'], descricao: 'desvincular' },
  // Carteirinhas: Diretoria
  { metodo: 'post', caminho: '/v1/admin/alunos/:aluno/carteirinhas', pode: ['ESCOLA'], descricao: 'emitir carteirinha' },
  { metodo: 'post', caminho: '/v1/admin/turmas/:turma/carteirinhas', pode: ['ESCOLA'], descricao: 'emitir em lote' },
  { metodo: 'post', caminho: '/v1/admin/alunos/:aluno/carteirinha/desbloquear', pode: ['ESCOLA'], descricao: 'desbloquear carteirinha' },
  // Caixa (já existia): ADMIN e OPERADOR, nunca ESCOLA
  { metodo: 'post', caminho: '/v1/caixa/identificar', pode: ['ADMIN', 'OPERADOR'], descricao: 'caixa: identificar' },
  // Plataforma: só SUPERADMIN
  { metodo: 'get', caminho: '/v1/plataforma/escolas', pode: ['SUPERADMIN'], descricao: 'plataforma' },
];

const tokens = {} as Record<Papel, string>;
let ids: Record<string, number>;

beforeAll(async () => {
  const escola = await criarEscola();
  const aluno = await criarAluno(escola, { responsaveis: 1 });
  const convite = await db('convites_responsavel_lanchei').where({ aluno_id: aluno.alunoId }).first();
  ids = { aluno: aluno.alunoId, turma: escola.turmaId, convite: convite.id, usuario: escola.operadorId, resp: aluno.responsavelIds[0]! };

  tokens.ADMIN = (await logarEquipe(app, escola.adminEmail)).token;
  tokens.ESCOLA = (await logarEquipe(app, escola.diretoriaEmail)).token;
  tokens.OPERADOR = (await logarEquipe(app, escola.operadorEmail)).token;
  tokens.SUPERADMIN = (await logarEquipe(app, (await criarSuperadmin()).email)).token;
  const resp = await db('responsaveis_lanchei').where({ id: aluno.responsavelIds[0] }).first();
  tokens.RESPONSAVEL = (await request(app).post('/v1/auth/responsavel/login').send({ email: resp.email, senha: SENHA })).body.accessToken;
});

const montar = (caminho: string) => caminho.replace(/:(\w+)/g, (_, nome: string) => String(ids[nome]));

describe.each(MATRIZ)('$metodo $caminho ($descricao)', (rota) => {
  it.each(TODOS)('%s', async (papel) => {
    const r = await request(app)[rota.metodo](montar(rota.caminho)).set('Authorization', `Bearer ${tokens[papel]}`).send({});
    if (rota.pode.includes(papel)) {
      expect(r.status, `${papel} deveria passar`).not.toBe(401);
      expect(r.status, `${papel} deveria passar`).not.toBe(403);
    } else {
      expect(r.status, `${papel} deveria ser barrado`).toBe(403);
      expect(r.body.erro.codigo).toBe('SEM_PERMISSAO');
    }
  });
});

it('sem token → 401 em todo o /admin', async () => {
  for (const rota of MATRIZ.filter((r) => r.caminho.startsWith('/v1/admin'))) {
    expect((await request(app)[rota.metodo](montar(rota.caminho)).send({})).status).toBe(401);
  }
});
