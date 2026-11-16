// Testes pela API HTTP: autenticação, permissões e o contrato do caixa.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { criarAluno, criarEscola, novaChave, saldo, SENHA, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;
beforeEach(async () => {
  escola = await criarEscola();
});

const loginEquipe = async (email: string) => {
  const r = await request(app).post('/v1/auth/equipe/login').send({ email, senha: SENHA });
  expect(r.status).toBe(200);
  return r.body as { accessToken: string; refreshToken: string; usuario: { papel: string } };
};

describe('saúde', () => {
  it('/health e /health/db', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const r = await request(app).get('/health/db');
    expect(r.body).toMatchObject({ status: 'ok', db: 'ok' });
  });
});

describe('autenticação', () => {
  it('login da equipe devolve tokens e dados do usuário', async () => {
    const r = await loginEquipe(escola.operadorEmail);
    expect(r.usuario).toMatchObject({ papel: 'OPERADOR', escola: { id: escola.escolaId } });
    expect(r.accessToken).toBeTruthy();
  });

  it('senha errada e e-mail inexistente dão a MESMA resposta', async () => {
    const a = await request(app).post('/v1/auth/equipe/login').send({ email: escola.operadorEmail, senha: 'errada' });
    const b = await request(app).post('/v1/auth/equipe/login').send({ email: 'nao-existe@teste.com', senha: 'errada' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('usuário desativado não loga', async () => {
    await db('usuarios_lanchei').where({ id: escola.operadorId }).update({ ativo: false });
    const r = await request(app).post('/v1/auth/equipe/login').send({ email: escola.operadorEmail, senha: SENHA });
    expect(r.status).toBe(401);
  });

  it('refresh rotaciona: o token antigo deixa de valer', async () => {
    const { refreshToken } = await loginEquipe(escola.adminEmail);
    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(refreshToken);
  });

  it('REUSO de refresh revogado derruba TODAS as sessões', async () => {
    const s1 = await loginEquipe(escola.adminEmail);
    const s2 = await loginEquipe(escola.adminEmail); // outra sessão (outro aparelho)
    const novo = await request(app).post('/v1/auth/refresh').send({ refreshToken: s1.refreshToken });
    expect(novo.status).toBe(200);

    // Atacante usa o token antigo (já trocado pelo dono):
    const ataque = await request(app).post('/v1/auth/refresh').send({ refreshToken: s1.refreshToken });
    expect(ataque.status).toBe(401);

    // Agora nem o token novo do dono nem a outra sessão funcionam:
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: novo.body.refreshToken })).status).toBe(401);
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: s2.refreshToken })).status).toBe(401);
  });

  it('logout revoga o refresh', async () => {
    const { refreshToken } = await loginEquipe(escola.adminEmail);
    expect((await request(app).post('/v1/auth/logout').send({ refreshToken })).status).toBe(204);
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
  });

  it('login do responsável', async () => {
    const a = await criarAluno(escola);
    const resp = await db('responsaveis_lanchei').where({ id: a.responsavelIds[0] }).first();
    const r = await request(app).post('/v1/auth/responsavel/login').send({ email: resp.email, senha: SENHA });
    expect(r.status).toBe(200);
    expect(r.body.responsavel).toMatchObject({ id: a.responsavelIds[0], emailVerificado: true });
  });
});

describe('permissões do caixa', () => {
  it('sem token => 401; token de responsável => 403', async () => {
    expect((await request(app).post('/v1/caixa/identificar').send({ qrConteudo: 'x' })).status).toBe(401);

    const a = await criarAluno(escola);
    const resp = await db('responsaveis_lanchei').where({ id: a.responsavelIds[0] }).first();
    const login = await request(app).post('/v1/auth/responsavel/login').send({ email: resp.email, senha: SENHA });
    const r = await request(app)
      .post('/v1/caixa/identificar')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ qrConteudo: a.qr });
    expect(r.status).toBe(403);
  });

  it('perfil ESCOLA (diretoria) não usa o caixa => 403', async () => {
    const a = await criarAluno(escola);
    const { accessToken, usuario } = await loginEquipe(escola.diretoriaEmail);
    expect(usuario.papel).toBe('ESCOLA');
    const r = await request(app).post('/v1/caixa/identificar').set('Authorization', `Bearer ${accessToken}`).send({ qrConteudo: a.qr });
    expect(r.status).toBe(403);
  });

  it('token adulterado => 401', async () => {
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const r = await request(app)
      .post('/v1/caixa/identificar')
      .set('Authorization', `Bearer ${accessToken.slice(0, -2)}xx`)
      .send({ qrConteudo: 'x' });
    expect(r.status).toBe(401);
  });
});

describe('caixa via HTTP', () => {
  it('identificar devolve aluno SEM saldo', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const r = await request(app).post('/v1/caixa/identificar').set('Authorization', `Bearer ${accessToken}`).send({ qrConteudo: a.qr });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ aluno: { id: a.alunoId, turma: '3A' }, carteirinha: { status: 'ATIVA' }, contaAtiva: true });
    expect(JSON.stringify(r.body)).not.toMatch(/saldo/i);
  });

  it('pedido sem Idempotency-Key => 422', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const r = await request(app)
      .post('/v1/caixa/pedidos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('IDEMPOTENCY_KEY_OBRIGATORIA');
  });

  it('body inválido => 400 VALIDACAO com os campos', async () => {
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const r = await request(app)
      .post('/v1/caixa/pedidos')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', novaChave())
      .send({ identificacao: { tipo: 'PIN', alunoId: 1, pin: '12' }, itens: [] });
    expect(r.status).toBe(400);
    expect(r.body.erro.codigo).toBe('VALIDACAO');
    expect(r.body.erro.detalhes.campos.map((c: { campo: string }) => c.campo)).toEqual(
      expect.arrayContaining(['identificacao.pin', 'itens']),
    );
  });

  it('201 na aprovação, 422 COMPRA_RECUSADA na recusa, e replay idempotente', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const pedir = (chave: string) =>
      request(app)
        .post('/v1/caixa/pedidos')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', chave)
        .send({ identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }] });

    const chave = novaChave();
    const r1 = await pedir(chave);
    expect(r1.status).toBe(201);
    expect(r1.body.pedido).toMatchObject({ status: 'CONFIRMADO', totalCentavos: 600 });

    const r1b = await pedir(chave); // clique duplo
    expect(r1b.status).toBe(201);
    expect(r1b.body).toEqual(r1.body);
    expect(await saldo(a.contaId)).toBe(400);

    const r2 = await pedir(novaChave()); // 400 < 600
    expect(r2.status).toBe(422);
    expect(r2.body.erro).toMatchObject({
      codigo: 'COMPRA_RECUSADA',
      mensagem: 'Saldo insuficiente.',
      detalhes: { motivo: 'SALDO_INSUFICIENTE' },
    });
  });

  it('operador estorna pelo HTTP', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const { accessToken } = await loginEquipe(escola.operadorEmail);
    const compra = await request(app)
      .post('/v1/caixa/pedidos')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', novaChave())
      .send({ identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }] });
    const r = await request(app)
      .post(`/v1/caixa/pedidos/${compra.body.pedido.id}/estorno`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ motivo: 'cliquei errado', devolverEstoque: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pedidoId: compra.body.pedido.id, status: 'ESTORNADO' });
    expect(await saldo(a.contaId)).toBe(1000);
  });

  it('rota inexistente => 404 no formato padrão', async () => {
    const r = await request(app).get('/v1/nao-existe');
    expect(r.status).toBe(404);
    expect(r.body.erro.codigo).toBe('NAO_ENCONTRADO');
  });
});
