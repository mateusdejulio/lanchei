// Diretoria: convites, desvínculo, carteirinhas e equipe. Histórico do aluno (as duas áreas).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { criarAluno, criarEscola, emailUnico, logarEquipe, novaChave, SENHA, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;
let diretoria: Awaited<ReturnType<typeof logarEquipe>>;
let cantina: Awaited<ReturnType<typeof logarEquipe>>;
let operador: Awaited<ReturnType<typeof logarEquipe>>;

beforeEach(async () => {
  escola = await criarEscola();
  diretoria = await logarEquipe(app, escola.diretoriaEmail);
  cantina = await logarEquipe(app, escola.adminEmail);
  operador = await logarEquipe(app, escola.operadorEmail);
});

const notificacoes = (alunoId: number, tipo: string) => db('notificacoes_lanchei').where({ aluno_id: alunoId, tipo });

describe('convites', () => {
  it('convidar de novo o mesmo e-mail revoga o código anterior; reenviar e revogar', async () => {
    const a = await criarAluno(escola, { responsaveis: 0 });
    const email = emailUnico();
    const c1 = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/convites`, { email });
    expect(c1.status).toBe(201);
    const c2 = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/convites`, { email });
    const ant = await db('convites_responsavel_lanchei').where({ id: c1.body.convite.id }).first();
    expect(ant.revogado_em).not.toBeNull();

    const re = await diretoria.post(`/v1/admin/convites/${c2.body.convite.id}/reenviar`);
    expect(re.status).toBe(201);
    expect(re.body.convite.id).not.toBe(c2.body.convite.id);
    await aguardarEmailsPendentes();
    expect(emailsPara(email)).toHaveLength(3);

    expect((await diretoria.post(`/v1/admin/convites/${re.body.convite.id}/revogar`)).status).toBe(204);
    expect((await diretoria.post(`/v1/admin/convites/${re.body.convite.id}/revogar`)).status).toBe(204); // repetir não dá erro
    const ficha = await diretoria.get(`/v1/admin/alunos/${a.alunoId}`);
    expect(ficha.body.convites).toEqual([]); // revogados não aparecem
  });

  it('e-mail já vinculado → 409; convite usado não reenvia; convite de outra escola → 404', async () => {
    const a = await criarAluno(escola);
    const emailVinculado = (await db('responsaveis_lanchei').where({ id: a.responsavelIds[0] }).first()).email;
    const r = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/convites`, { email: emailVinculado });
    expect(r.body.erro.codigo).toBe('RESPONSAVEL_JA_VINCULADO');

    const usado = await db('convites_responsavel_lanchei').where({ aluno_id: a.alunoId }).first();
    expect((await diretoria.post(`/v1/admin/convites/${usado.id}/reenviar`)).body.erro.codigo).toBe('CONVITE_JA_USADO');

    const outra = await criarEscola();
    const b = await criarAluno(outra);
    const alheio = await db('convites_responsavel_lanchei').where({ aluno_id: b.alunoId }).first();
    expect((await diretoria.post(`/v1/admin/convites/${alheio.id}/revogar`)).status).toBe(404);
  });

  it('desvincular: o vínculo acaba, o responsável é avisado por e-mail, auditoria com motivo', async () => {
    const a = await criarAluno(escola);
    const [rid] = a.responsavelIds;
    const r = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/responsaveis/${rid}/desvincular`, { motivo: 'Guarda judicial alterada' });
    expect(r.status).toBe(204);
    await aguardarEmailsPendentes();

    const v = await db('aluno_responsaveis_lanchei').where({ aluno_id: a.alunoId, responsavel_id: rid }).first();
    expect(v.desvinculado_em).not.toBeNull();
    const email = (await db('responsaveis_lanchei').where({ id: rid }).first()).email;
    expect(emailsPara(email).at(-1)!.assunto).toContain('vínculo');
    const aud = await db('auditoria_lanchei').where({ acao: 'VINCULO_DESVINCULAR', aluno_id: a.alunoId }).first();
    expect(aud.depois).toEqual({ motivo: 'Guarda judicial alterada' });

    // De novo: não há mais vínculo ativo
    expect((await diretoria.post(`/v1/admin/alunos/${a.alunoId}/responsaveis/${rid}/desvincular`, { motivo: 'de novo' })).status).toBe(404);
  });
});

describe('carteirinhas', () => {
  it('emitir revoga a anterior NA MESMA transação: o QR velho para no caixa, o novo funciona', async () => {
    const a = await criarAluno(escola);
    const r = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/carteirinhas`, { motivo: 'Perdeu' });
    expect(r.status).toBe(201);
    expect(r.body.qrConteudo).toMatch(/^LCH1\.[A-Za-z0-9_-]{22}$/);
    expect(r.body.aluno.id).toBe(a.alunoId);

    expect((await operador.post('/v1/caixa/identificar', { qrConteudo: a.qr })).status).toBe(404);
    expect((await operador.post('/v1/caixa/identificar', { qrConteudo: r.body.qrConteudo })).status).toBe(200);

    const todas = await db('carteirinhas_lanchei').where({ aluno_id: a.alunoId }).orderBy('id');
    expect(todas.map((c) => c.status)).toEqual(['REVOGADA', 'ATIVA']);
    expect(todas[0].motivo_revogacao).toBe('Perdeu');
    // O banco nunca guarda o QR em texto, só o hash.
    expect(todas[1].token_hash).toHaveLength(32);
    expect((await notificacoes(a.alunoId, 'CARTEIRINHA')).length).toBe(2); // 2 responsáveis
  });

  it('5 emissões simultâneas do mesmo aluno: sempre UMA carteirinha viva', async () => {
    const a = await criarAluno(escola);
    const respostas = await Promise.all([1, 2, 3, 4, 5].map(() => diretoria.post(`/v1/admin/alunos/${a.alunoId}/carteirinhas`)));
    expect(respostas.every((r) => r.status === 201)).toBe(true);
    const vivas = await db('carteirinhas_lanchei').where({ aluno_vivo: a.alunoId });
    expect(vivas).toHaveLength(1);
  });

  it('lote por turma: só para quem está sem carteirinha viva', async () => {
    const comCarteirinha = await criarAluno(escola);
    const semCarteirinha = await criarAluno(escola);
    await db('carteirinhas_lanchei').where({ id: semCarteirinha.carteirinhaId }).update({ status: 'REVOGADA', revogada_em: new Date() });
    const inativo = await criarAluno(escola);
    await db('carteirinhas_lanchei').where({ id: inativo.carteirinhaId }).update({ status: 'REVOGADA', revogada_em: new Date() });
    await db('alunos_lanchei').where({ id: inativo.alunoId }).update({ status: 'INATIVO' });

    const r = await diretoria.post(`/v1/admin/turmas/${escola.turmaId}/carteirinhas`);
    expect(r.status).toBe(201);
    expect(r.body.itens.map((i: { alunoId: number }) => i.alunoId)).toEqual([semCarteirinha.alunoId]);
    expect(r.body.itens[0].qrConteudo).toMatch(/^LCH1\./);
    // quem já tinha continua com a mesma
    expect((await operador.post('/v1/caixa/identificar', { qrConteudo: comCarteirinha.qr })).status).toBe(200);
  });

  it('desbloquear carteirinha bloqueada pelo responsável avisa os pais', async () => {
    const a = await criarAluno(escola);
    await db('carteirinhas_lanchei').where({ id: a.carteirinhaId }).update({ status: 'BLOQUEADA' });
    const r = await diretoria.post(`/v1/admin/alunos/${a.alunoId}/carteirinha/desbloquear`);
    expect(r.body.carteirinha.status).toBe('ATIVA');
    expect((await notificacoes(a.alunoId, 'CARTEIRINHA')).length).toBe(2);
    expect(await db('auditoria_lanchei').where({ acao: 'CARTEIRINHA_DESBLOQUEAR', aluno_id: a.alunoId }).first()).toBeTruthy();
  });
});

describe('histórico do aluno', () => {
  async function cenario() {
    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    const comprar = (produtoId: number, quantidade: number) =>
      realizarCompra({
        escolaId: escola.escolaId,
        operadorId: escola.operadorId,
        idempotencyKey: novaChave(),
        identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qr },
        itens: [{ produtoId, quantidade }],
      });
    expect((await comprar(escola.produtos.suco, 1)).status).toBe('CONFIRMADO'); // -600, sobra 400
    expect((await comprar(escola.produtos.suco, 1)).status).toBe('RECUSADO'); // saldo insuficiente
    return a;
  }

  it('junta ledger e compras recusadas, mais novo primeiro, com itens; Cantina e Diretoria veem', async () => {
    const a = await cenario();
    for (const quem of [cantina, diretoria]) {
      const r = await quem.get(`/v1/admin/alunos/${a.alunoId}/extrato`);
      expect(r.status).toBe(200);
      expect(r.body.itens.map((l: { tipo: string }) => l.tipo)).toEqual(['RECUSADA', 'COMPRA', 'DEPOSITO']);
      const [recusa, compra] = r.body.itens;
      expect(recusa).toMatchObject({ motivoRecusa: 'SALDO_INSUFICIENTE', saldoAposCentavos: null, itens: [{ nome: 'Suco', quantidade: 1 }] });
      expect(compra).toMatchObject({ valorCentavos: -600, saldoAposCentavos: 400 });
    }
  });

  it('paginação por cursor e auditoria só na abertura (não a cada página)', async () => {
    const a = await cenario();
    const p1 = await cantina.get(`/v1/admin/alunos/${a.alunoId}/extrato?limite=2`);
    const p2 = await cantina.get(`/v1/admin/alunos/${a.alunoId}/extrato?limite=2&cursor=${p1.body.proximoCursor}`);
    expect([...p1.body.itens, ...p2.body.itens].map((l: { tipo: string }) => l.tipo)).toEqual(['RECUSADA', 'COMPRA', 'DEPOSITO']);
    expect(p2.body.proximoCursor).toBeNull();
    const aud = await db('auditoria_lanchei').where({ acao: 'HISTORICO_VISUALIZAR', aluno_id: a.alunoId });
    expect(aud).toHaveLength(1);
    expect(aud[0].ator_usuario_id).toBe(escola.adminId);
  });

  it('filtros por tipo e período (no fuso da escola)', async () => {
    const a = await cenario();
    const compras = await cantina.get(`/v1/admin/alunos/${a.alunoId}/extrato?tipo=COMPRA`);
    expect(compras.body.itens).toHaveLength(1);
    const passado = await cantina.get(`/v1/admin/alunos/${a.alunoId}/extrato?de=2020-01-01&ate=2020-12-31`);
    expect(passado.body.itens).toHaveLength(0);
    expect((await cantina.get(`/v1/admin/alunos/${a.alunoId}/extrato?de=2020-13-45`)).status).toBe(422);
  });

  it('CSV para os responsáveis: BOM, ";", valores em reais, auditoria HISTORICO_EXPORTAR', async () => {
    const a = await cenario();
    const r = await diretoria.get(`/v1/admin/alunos/${a.alunoId}/extrato.csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/extrato-M\w+\.csv/);
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    // trimEnd e não trim: o trim() do JavaScript também remove o BOM do começo.
    const linhas = r.text.trimEnd().split('\r\n');
    expect(linhas[0]).toBe('﻿data_hora;tipo;descricao;valor_reais;saldo_apos_reais;motivo_recusa');
    expect(linhas[2]).toMatch(/;Compra;1x Suco;-6,00;4,00;$/);
    expect(linhas[3]).toMatch(/;Compra recusada;1x Suco;6,00;;SALDO_INSUFICIENTE$/);
    expect(await db('auditoria_lanchei').where({ acao: 'HISTORICO_EXPORTAR', aluno_id: a.alunoId }).first()).toBeTruthy();
  });

  it('aluno de outra escola → 404', async () => {
    const outro = await criarAluno(await criarEscola());
    expect((await cantina.get(`/v1/admin/alunos/${outro.alunoId}/extrato`)).status).toBe(404);
    expect((await cantina.get(`/v1/admin/alunos/${outro.alunoId}/extrato.csv`)).status).toBe(404);
  });
});

describe('equipe', () => {
  it('Cantina cria OPERADOR (convite por e-mail); não cria ESCOLA. Diretoria cria ESCOLA; não cria OPERADOR', async () => {
    const op = emailUnico('op');
    const r = await cantina.post('/v1/admin/usuarios', { nome: 'Tia Nova', email: op, papel: 'OPERADOR' });
    expect(r.status).toBe(201);
    await aguardarEmailsPendentes();
    expect(emailsPara(op).at(-1)!.texto).toContain('/definir-senha?token=');

    expect((await cantina.post('/v1/admin/usuarios', { nome: 'X', email: emailUnico(), papel: 'ESCOLA' })).status).toBe(403);
    expect((await diretoria.post('/v1/admin/usuarios', { nome: 'X', email: emailUnico(), papel: 'ESCOLA' })).status).toBe(201);
    expect((await diretoria.post('/v1/admin/usuarios', { nome: 'X', email: emailUnico(), papel: 'OPERADOR' })).status).toBe(403);
  });

  it('cada perfil só enxerga e edita a própria equipe', async () => {
    const listaC = await cantina.get('/v1/admin/usuarios');
    expect(listaC.body.itens.map((u: { papel: string }) => u.papel).sort()).toEqual(['ADMIN', 'OPERADOR']);
    const listaD = await diretoria.get('/v1/admin/usuarios');
    expect(listaD.body.itens.map((u: { papel: string }) => u.papel)).toEqual(['ESCOLA']);
    // A Cantina não "enxerga" o usuário da Diretoria: 404
    expect((await cantina.patch(`/v1/admin/usuarios/${escola.diretoriaId}`, { ativo: false })).status).toBe(404);
  });

  it('desativar derruba as sessões; ninguém desativa a si mesmo nem muda o próprio papel', async () => {
    const sessaoOp = await request(app).post('/v1/auth/equipe/login').send({ email: escola.operadorEmail, senha: SENHA });
    const r = await cantina.patch(`/v1/admin/usuarios/${escola.operadorId}`, { ativo: false });
    expect(r.body.usuario.ativo).toBe(false);
    expect((await request(app).post('/v1/auth/refresh').send({ refreshToken: sessaoOp.body.refreshToken })).status).toBe(401);

    expect((await cantina.patch(`/v1/admin/usuarios/${escola.adminId}`, { ativo: false })).body.erro.codigo).toBe('NAO_PODE_DESATIVAR_A_SI_MESMO');
    expect((await cantina.patch(`/v1/admin/usuarios/${escola.adminId}`, { papel: 'OPERADOR' })).body.erro.codigo).toBe('NAO_PODE_MUDAR_PROPRIO_PAPEL');
  });
});
