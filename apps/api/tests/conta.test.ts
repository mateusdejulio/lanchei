// Cadastro do responsável, verificação de e-mail e esqueci/redefinir senha.
// Critérios de aceitação: docs/etapa8-testes-deploy.md §2 (Etapa 4).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { criarEscola, emailUnico, SENHA, tokenDoEmail, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
const SENHA_NOVA = 'nova-senha-segura-456';

/** Faz a requisição e espera os e-mails disparados em segundo plano. */
async function post(rota: string, body: object) {
  const r = await request(app).post(rota).send(body);
  await aguardarEmailsPendentes();
  return r;
}

const ultimoEmail = (email: string) => {
  const lista = emailsPara(email);
  expect(lista.length).toBeGreaterThan(0);
  return lista.at(-1)!;
};

async function cadastrar(email = emailUnico()) {
  const r = await post('/v1/auth/responsavel/cadastro', { nome: 'Maria Souza', email, senha: SENHA });
  expect(r.status).toBe(201);
  return email;
}

const loginResp = (email: string, senha = SENHA) => request(app).post('/v1/auth/responsavel/login').send({ email, senha });

describe('cadastro do responsável', () => {
  it('cria a conta (e-mail não verificado) e manda o link de verificação', async () => {
    const email = await cadastrar();
    const r = await db('responsaveis_lanchei').where({ email }).first();
    expect(r.email_verificado_em).toBeNull();
    expect(r.senha_hash).toMatch(/^\$argon2id\$/);

    const e = ultimoEmail(email);
    expect(e.assunto).toContain('Confirme');
    expect(e.texto).toContain('/verificar-email?token=');

    // Login funciona, mas avisa que o e-mail ainda não foi verificado.
    const l = await loginResp(email);
    expect(l.status).toBe(200);
    expect(l.body.responsavel.emailVerificado).toBe(false);
  });

  it('normaliza o e-mail (espaços e maiúsculas)', async () => {
    const email = emailUnico();
    await post('/v1/auth/responsavel/cadastro', { nome: 'Ana', email: `  ${email.toUpperCase()} `, senha: SENHA });
    expect(await db('responsaveis_lanchei').where({ email }).first()).toBeTruthy();
  });

  it('NÃO revela se o e-mail já tem conta: mesma resposta, e o dono recebe um aviso', async () => {
    const email = await cadastrar();
    await post('/v1/auth/responsavel/verificar-email', { token: tokenDoEmail(ultimoEmail(email).texto) });

    const nova = await post('/v1/auth/responsavel/cadastro', { nome: 'Maria', email: emailUnico(), senha: SENHA });
    const repetida = await post('/v1/auth/responsavel/cadastro', { nome: 'Invasor', email, senha: 'outra-senha-123' });
    expect(repetida.status).toBe(nova.status);
    expect(repetida.body).toEqual(nova.body);

    expect(ultimoEmail(email).assunto).toContain('já tem conta');
    // A senha original continua valendo; a do segundo cadastro, não.
    expect((await loginResp(email)).status).toBe(200);
    expect((await loginResp(email, 'outra-senha-123')).status).toBe(401);
    expect(await db('responsaveis_lanchei').where({ email }).count({ n: '*' })).toEqual([{ n: 1 }]);
  });

  it('cadastro repetido de quem nunca verificou manda um link de verificação NOVO (o antigo para de valer)', async () => {
    const email = await cadastrar();
    const antigo = tokenDoEmail(ultimoEmail(email).texto);
    await post('/v1/auth/responsavel/cadastro', { nome: 'Maria', email, senha: SENHA });
    const novo = tokenDoEmail(ultimoEmail(email).texto);
    expect(novo).not.toBe(antigo);

    expect((await post('/v1/auth/responsavel/verificar-email', { token: antigo })).status).toBe(422);
    expect((await post('/v1/auth/responsavel/verificar-email', { token: novo })).status).toBe(200);
  });

  it('valida a entrada (senha curta, e-mail inválido)', async () => {
    const r = await post('/v1/auth/responsavel/cadastro', { nome: 'X', email: 'nao-e-email', senha: '123' });
    expect(r.status).toBe(400);
    expect(r.body.erro.codigo).toBe('VALIDACAO');
    const campos = r.body.erro.detalhes.campos.map((c: { campo: string }) => c.campo);
    expect(campos).toEqual(expect.arrayContaining(['email', 'senha']));
  });
});

describe('verificação de e-mail', () => {
  it('marca o e-mail como verificado; o link só vale uma vez', async () => {
    const email = await cadastrar();
    const token = tokenDoEmail(ultimoEmail(email).texto);

    const r = await post('/v1/auth/responsavel/verificar-email', { token });
    expect(r.status).toBe(200);
    expect((await loginResp(email)).body.responsavel.emailVerificado).toBe(true);

    const deNovo = await post('/v1/auth/responsavel/verificar-email', { token });
    expect(deNovo.status).toBe(422);
    expect(deNovo.body.erro.codigo).toBe('TOKEN_INVALIDO');
  });

  it('link vencido não vale', async () => {
    const email = await cadastrar();
    const token = tokenDoEmail(ultimoEmail(email).texto);
    const r = await db('responsaveis_lanchei').where({ email }).first('id');
    await db('tokens_email_lanchei').where({ responsavel_id: r.id }).update({ expira_em: new Date(Date.now() - 1000) });
    expect((await post('/v1/auth/responsavel/verificar-email', { token })).status).toBe(422);
  });

  it('token de REDEFINIR_SENHA não serve para verificar e-mail', async () => {
    const email = await cadastrar();
    await post('/v1/auth/senha/esqueci', { email, perfil: 'RESPONSAVEL' });
    const tokenSenha = tokenDoEmail(ultimoEmail(email).texto);
    expect((await post('/v1/auth/responsavel/verificar-email', { token: tokenSenha })).status).toBe(422);
  });

  it('reenviar: sempre 202; só manda e-mail para conta existente e não verificada', async () => {
    const naoExiste = emailUnico();
    expect((await post('/v1/auth/responsavel/reenviar-verificacao', { email: naoExiste })).status).toBe(202);
    expect(emailsPara(naoExiste)).toHaveLength(0);

    const email = await cadastrar();
    const antes = emailsPara(email).length;
    expect((await post('/v1/auth/responsavel/reenviar-verificacao', { email })).status).toBe(202);
    expect(emailsPara(email)).toHaveLength(antes + 1);

    await post('/v1/auth/responsavel/verificar-email', { token: tokenDoEmail(ultimoEmail(email).texto) });
    await post('/v1/auth/responsavel/reenviar-verificacao', { email });
    expect(emailsPara(email)).toHaveLength(antes + 1); // já verificado: nada novo
  });
});

describe('esqueci / redefinir senha', () => {
  let escola: Escola;
  beforeEach(async () => {
    escola = await criarEscola();
  });

  it('e-mail inexistente e existente dão a MESMA resposta (202 sem corpo)', async () => {
    const a = await post('/v1/auth/senha/esqueci', { email: emailUnico(), perfil: 'EQUIPE' });
    const b = await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.text).toBe(b.text);
    expect(ultimoEmail(escola.adminEmail).texto).toContain('/redefinir-senha?token=');
  });

  it('perfil errado não manda e-mail (o admin não é responsável)', async () => {
    const antes = emailsPara(escola.adminEmail).length;
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'RESPONSAVEL' });
    expect(emailsPara(escola.adminEmail)).toHaveLength(antes);
  });

  it('redefinir troca a senha, revoga TODAS as sessões e audita', async () => {
    const login = await request(app).post('/v1/auth/equipe/login').send({ email: escola.adminEmail, senha: SENHA });
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    const token = tokenDoEmail(ultimoEmail(escola.adminEmail).texto);

    const r = await post('/v1/auth/senha/redefinir', { token, novaSenha: SENHA_NOVA });
    expect(r.status).toBe(204);

    // Sessão antiga morreu:
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken })).status).toBe(401);
    // Senha antiga não vale; a nova vale:
    expect((await request(app).post('/v1/auth/equipe/login').send({ email: escola.adminEmail, senha: SENHA })).status).toBe(401);
    expect((await request(app).post('/v1/auth/equipe/login').send({ email: escola.adminEmail, senha: SENHA_NOVA })).status).toBe(200);

    const aud = await db('auditoria_lanchei').where({ acao: 'SENHA_REDEFINIR', ator_usuario_id: escola.adminId }).first();
    expect(aud).toMatchObject({ escola_id: escola.escolaId, entidade: 'usuarios' });

    // Uso único:
    expect((await post('/v1/auth/senha/redefinir', { token, novaSenha: 'mais-uma-senha-789' })).status).toBe(422);
  });

  it('só o link mais recente vale', async () => {
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    const primeiro = tokenDoEmail(ultimoEmail(escola.adminEmail).texto);
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    const segundo = tokenDoEmail(ultimoEmail(escola.adminEmail).texto);

    expect((await post('/v1/auth/senha/redefinir', { token: primeiro, novaSenha: SENHA_NOVA })).status).toBe(422);
    expect((await post('/v1/auth/senha/redefinir', { token: segundo, novaSenha: SENHA_NOVA })).status).toBe(204);
  });

  it('link vencido (mais de 1 hora) não vale', async () => {
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    const token = tokenDoEmail(ultimoEmail(escola.adminEmail).texto);
    await db('tokens_email_lanchei')
      .where({ usuario_id: escola.adminId, tipo: 'REDEFINIR_SENHA' })
      .whereNull('usado_em')
      .update({ expira_em: new Date(Date.now() - 1000) });
    expect((await post('/v1/auth/senha/redefinir', { token, novaSenha: SENHA_NOVA })).status).toBe(422);
  });

  it('usuário desativado não recebe link nem consegue usar um antigo', async () => {
    await post('/v1/auth/senha/esqueci', { email: escola.operadorEmail, perfil: 'EQUIPE' });
    const token = tokenDoEmail(ultimoEmail(escola.operadorEmail).texto);
    await db('usuarios_lanchei').where({ id: escola.operadorId }).update({ ativo: false });

    const antes = emailsPara(escola.operadorEmail).length;
    await post('/v1/auth/senha/esqueci', { email: escola.operadorEmail, perfil: 'EQUIPE' });
    expect(emailsPara(escola.operadorEmail)).toHaveLength(antes);
    expect((await post('/v1/auth/senha/redefinir', { token, novaSenha: SENHA_NOVA })).status).toBe(422);
  });

  it('responsável: redefinir pelo link também confirma o e-mail', async () => {
    const email = await cadastrar();
    await post('/v1/auth/senha/esqueci', { email, perfil: 'RESPONSAVEL' });
    const token = tokenDoEmail(ultimoEmail(email).texto);
    expect(ultimoEmail(email).texto).toContain('/app/redefinir-senha?token=');

    expect((await post('/v1/auth/senha/redefinir', { token, novaSenha: SENHA_NOVA })).status).toBe(204);
    const l = await loginResp(email, SENHA_NOVA);
    expect(l.status).toBe(200);
    expect(l.body.responsavel.emailVerificado).toBe(true);
  });

  it('dois cliques simultâneos no mesmo link: só um troca a senha', async () => {
    await post('/v1/auth/senha/esqueci', { email: escola.adminEmail, perfil: 'EQUIPE' });
    const token = tokenDoEmail(ultimoEmail(escola.adminEmail).texto);
    const respostas = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => request(app).post('/v1/auth/senha/redefinir').send({ token, novaSenha: `senha-paralela-${i}` })),
    );
    expect(respostas.filter((r) => r.status === 204)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 422)).toHaveLength(4);
  });

  it('senha nova curta é recusada', async () => {
    const r = await post('/v1/auth/senha/redefinir', { token: 'x'.repeat(43), novaSenha: '1234567' });
    expect(r.status).toBe(400);
  });
});
