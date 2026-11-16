// /v1/plataforma (SUPERADMIN): escolas e primeiro usuário de cada perfil.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { criarEscola, criarSuperadmin, emailUnico, SENHA, tokenDoEmail } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let tokenSuper: string;
let superId: number;

const loginEquipe = async (email: string, senha = SENHA) =>
  (await request(app).post('/v1/auth/equipe/login').send({ email, senha })).body as { accessToken: string; refreshToken: string };

beforeEach(async () => {
  const s = await criarSuperadmin();
  superId = s.id;
  tokenSuper = (await loginEquipe(s.email)).accessToken;
});

const slugNovo = () => `escola-${randomUUID().slice(0, 8)}`;
const como = (token: string) => ({
  get: (rota: string) => request(app).get(rota).set('Authorization', `Bearer ${token}`),
  post: (rota: string, body: object) => request(app).post(rota).set('Authorization', `Bearer ${token}`).send(body),
  patch: (rota: string, body: object) => request(app).patch(rota).set('Authorization', `Bearer ${token}`).send(body),
});

async function novaEscola(body: object = {}) {
  const r = await como(tokenSuper).post('/v1/plataforma/escolas', { nome: 'Colégio Teste', slug: slugNovo(), ...body });
  expect(r.status).toBe(201);
  return r.body.escola as { id: number; slug: string; timezone: string; ativo: boolean; equipe: { admin: number; escola: number } };
}

describe('escolas', () => {
  it('cria escola com fuso padrão e audita', async () => {
    const e = await novaEscola();
    expect(e).toMatchObject({ timezone: 'America/Sao_Paulo', ativo: true, depositoMinCentavos: 2500, depositoMaxCentavos: 50000, equipe: { admin: 0, escola: 0 } });
    const aud = await db('auditoria_lanchei').where({ acao: 'ESCOLA_CRIAR', entidade_id: e.id }).first();
    expect(aud.ator_usuario_id).toBe(superId);
  });

  it('slug repetido → 409 SLUG_JA_EXISTE; slug e fuso inválidos → 400', async () => {
    const e = await novaEscola();
    const dup = await como(tokenSuper).post('/v1/plataforma/escolas', { nome: 'Outra', slug: e.slug });
    expect(dup.status).toBe(409);
    expect(dup.body.erro.codigo).toBe('SLUG_JA_EXISTE');

    expect((await como(tokenSuper).post('/v1/plataforma/escolas', { nome: 'X escola', slug: 'Com Espaço' })).status).toBe(400);
    expect((await como(tokenSuper).post('/v1/plataforma/escolas', { nome: 'X escola', slug: slugNovo(), timezone: 'Marte/Base' })).status).toBe(400);
  });

  it('lista as escolas com a contagem da equipe', async () => {
    const e = await novaEscola();
    const r = await como(tokenSuper).get('/v1/plataforma/escolas');
    expect(r.status).toBe(200);
    expect(r.body.itens.find((x: { id: number }) => x.id === e.id)).toBeTruthy();
  });

  it('desativar a escola derruba a equipe: login, refresh e sessões abertas', async () => {
    const escola = await criarEscola();
    const sessao = await loginEquipe(escola.adminEmail);

    const r = await como(tokenSuper).patch(`/v1/plataforma/escolas/${escola.escolaId}`, { ativo: false });
    expect(r.status).toBe(200);
    expect(r.body.escola.ativo).toBe(false);

    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: sessao.refreshToken })).status).toBe(401);
    expect((await request(app).post('/v1/auth/equipe/login').send({ email: escola.adminEmail, senha: SENHA })).status).toBe(401);

    const aud = await db('auditoria_lanchei').where({ acao: 'ESCOLA_EDITAR', entidade_id: escola.escolaId }).first();
    expect(aud.depois).toEqual({ ativo: false }); // mysql2 já converte a coluna JSON em objeto

    // Reativar devolve o acesso (com login novo).
    await como(tokenSuper).patch(`/v1/plataforma/escolas/${escola.escolaId}`, { ativo: true });
    expect((await request(app).post('/v1/auth/equipe/login').send({ email: escola.adminEmail, senha: SENHA })).status).toBe(200);
  });

  it('escola inexistente → 404; body vazio → 400', async () => {
    expect((await como(tokenSuper).patch('/v1/plataforma/escolas/999999999', { nome: 'Nada aqui' })).status).toBe(404);
    expect((await como(tokenSuper).patch('/v1/plataforma/escolas/1', {})).status).toBe(400);
  });
});

describe('primeiro usuário de cada perfil', () => {
  it('cria ADMIN e ESCOLA; o convite leva a "crie sua senha" e a pessoa entra com a senha que escolheu', async () => {
    const e = await novaEscola();
    for (const papel of ['ADMIN', 'ESCOLA'] as const) {
      const email = emailUnico(papel.toLowerCase());
      const r = await como(tokenSuper).post(`/v1/plataforma/escolas/${e.id}/usuarios`, { nome: 'Fulana', email, papel });
      expect(r.status).toBe(201);
      expect(r.body.usuario).toMatchObject({ email, papel, ativo: true });
      await aguardarEmailsPendentes();

      const convite = emailsPara(email).at(-1)!;
      expect(convite.texto).toContain('/definir-senha?token=');
      expect(convite.texto).toContain('Colégio Teste');

      // Antes de criar a senha, não há como entrar (a senha inicial é aleatória).
      const senhaEscolhida = `senha-da-${papel.toLowerCase()}-123`;
      const redef = await request(app).post('/v1/auth/senha/redefinir').send({ token: tokenDoEmail(convite.texto), novaSenha: senhaEscolhida });
      expect(redef.status).toBe(204);

      const login = await request(app).post('/v1/auth/equipe/login').send({ email, senha: senhaEscolhida });
      expect(login.status).toBe(200);
      expect(login.body.usuario).toMatchObject({ papel, escola: { id: e.id } });
    }
    const lista = await como(tokenSuper).get('/v1/plataforma/escolas');
    expect(lista.body.itens.find((x: { id: number }) => x.id === e.id).equipe).toEqual({ admin: 1, escola: 1 });
  });

  it('o convite vale 72 horas', async () => {
    const e = await novaEscola();
    const email = emailUnico();
    const r = await como(tokenSuper).post(`/v1/plataforma/escolas/${e.id}/usuarios`, { nome: 'Fulano', email, papel: 'ADMIN' });
    const t = await db('tokens_email_lanchei').where({ usuario_id: r.body.usuario.id }).first();
    const horas = (new Date(t.expira_em).getTime() - new Date(t.created_at).getTime()) / 3_600_000;
    expect(horas).toBeCloseTo(72, 0);
  });

  it('e-mail repetido → 409; papel OPERADOR/SUPERADMIN → 400; escola inexistente → 404', async () => {
    const escola = await criarEscola();
    const dup = await como(tokenSuper).post(`/v1/plataforma/escolas/${escola.escolaId}/usuarios`, { nome: 'X', email: escola.adminEmail, papel: 'ADMIN' });
    expect(dup.status).toBe(409);
    expect(dup.body.erro.codigo).toBe('EMAIL_JA_CADASTRADO');

    for (const papel of ['OPERADOR', 'SUPERADMIN']) {
      const r = await como(tokenSuper).post(`/v1/plataforma/escolas/${escola.escolaId}/usuarios`, { nome: 'X', email: emailUnico(), papel });
      expect(r.status).toBe(400);
    }
    expect((await como(tokenSuper).post('/v1/plataforma/escolas/999999999/usuarios', { nome: 'X', email: emailUnico(), papel: 'ADMIN' })).status).toBe(404);
  });
});

describe('permissões', () => {
  it('ADMIN, ESCOLA, OPERADOR e responsável não acessam a plataforma (403); sem token → 401', async () => {
    const escola = await criarEscola();
    for (const email of [escola.adminEmail, escola.diretoriaEmail, escola.operadorEmail]) {
      const { accessToken } = await loginEquipe(email);
      expect((await como(accessToken).get('/v1/plataforma/escolas')).status).toBe(403);
      expect((await como(accessToken).post('/v1/plataforma/escolas', { nome: 'Hack', slug: slugNovo() })).status).toBe(403);
    }
    expect((await request(app).get('/v1/plataforma/escolas')).status).toBe(401);
  });

  it('o superadmin não acessa rotas de escola (caixa)', async () => {
    const r = await como(tokenSuper).post('/v1/caixa/identificar', { qrConteudo: 'LCH1.qualquer-coisa-aqui' });
    expect(r.status).toBe(403);
  });
});
