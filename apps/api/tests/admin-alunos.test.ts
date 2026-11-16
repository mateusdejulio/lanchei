// Diretoria: alunos (cadastro, lista, pendências, ficha, edição), foto,
// importação CSV, turmas, convites, carteirinhas e dados da escola.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { db } from '../src/infra/db.js';
import { criarApp } from '../src/app.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import { criarAluno, criarEscola, emailUnico, logarEquipe, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

const app = criarApp();
let escola: Escola;
let diretoria: Awaited<ReturnType<typeof logarEquipe>>;
let cantina: Awaited<ReturnType<typeof logarEquipe>>;

beforeEach(async () => {
  escola = await criarEscola();
  diretoria = await logarEquipe(app, escola.diretoriaEmail);
  cantina = await logarEquipe(app, escola.adminEmail);
});

const matricula = () => `M${Math.random().toString(36).slice(2, 10)}`;

async function novoAluno(extra: object = {}) {
  const r = await diretoria.post('/v1/admin/alunos', { nome: 'Pedro Henrique Souza', matricula: matricula(), turmaId: escola.turmaId, ...extra });
  expect(r.status).toBe(201);
  await aguardarEmailsPendentes();
  return r.body as { aluno: { id: number; matricula: string }; convites: { id: number; email: string; status: string }[] };
}

describe('cadastro de aluno', () => {
  it('cria aluno + regras padrão + conta + um convite por e-mail; o código chega por e-mail', async () => {
    const [e1, e2] = [emailUnico('mae'), emailUnico('pai')];
    const ficha = await novoAluno({ emailsResponsaveis: [e1, e2, e1] }); // repetido conta uma vez

    expect(ficha.convites.map((c) => c.email).sort()).toEqual([e1, e2].sort());
    const regras = await db('regras_aluno_lanchei').where({ aluno_id: ficha.aluno.id }).first();
    expect(regras).toMatchObject({ dias_permitidos: 31, alerta_saldo_baixo_centavos: 1000, permite_sem_carteirinha: false });
    expect(await db('contas_lanchei').where({ aluno_id: ficha.aluno.id }).first()).toMatchObject({ saldo_centavos: 0 });

    const email = emailsPara(e1).at(-1)!;
    expect(email.assunto).toContain('Pedro'); // só o primeiro nome
    expect(email.assunto).not.toContain('Souza');
    expect(email.texto).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(email.texto).toMatch(/\/app\/vincular\?codigo=[A-Z2-9]{8}/);

    // enviado_em só depois que o e-mail saiu
    const conv = await db('convites_responsavel_lanchei').where({ aluno_id: ficha.aluno.id });
    expect(conv.every((c) => c.enviado_em !== null)).toBe(true);
    expect(await db('auditoria_lanchei').where({ acao: 'ALUNO_CRIAR', aluno_id: ficha.aluno.id }).first()).toBeTruthy();
  });

  it('matrícula repetida → 409; turma de OUTRA escola → 404 (não cria nada)', async () => {
    const m = matricula();
    await novoAluno({ matricula: m });
    const dup = await diretoria.post('/v1/admin/alunos', { nome: 'Outro', matricula: m, turmaId: escola.turmaId });
    expect(dup.status).toBe(409);
    expect(dup.body.erro.codigo).toBe('MATRICULA_JA_EXISTE');

    const outra = await criarEscola();
    const r = await diretoria.post('/v1/admin/alunos', { nome: 'X', matricula: matricula(), turmaId: outra.turmaId });
    expect(r.status).toBe(404);
  });
});

describe('lista, pendências e ficha', () => {
  it('pendências e filtro por pendência', async () => {
    const semNada = await novoAluno(); // sem carteirinha, foto, responsável
    const completo = await criarAluno(escola); // fixture: com carteirinha e 2 responsáveis

    const p = await diretoria.get('/v1/admin/pendencias');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ alunosAtivos: 2, semCarteirinha: 1, semFoto: 2, semResponsavel: 1, convitesVencidos: 0 });

    const lista = await diretoria.get('/v1/admin/alunos?pendencia=SEM_CARTEIRINHA');
    expect(lista.body.itens.map((a: { id: number }) => a.id)).toEqual([semNada.aluno.id]);
    const todos = await diretoria.get('/v1/admin/alunos');
    const item = todos.body.itens.find((a: { id: number }) => a.id === completo.alunoId);
    expect(item).toMatchObject({ carteirinha: 'ATIVA', qtdResponsaveis: 2, temFoto: false, saldoCentavos: 0 });
  });

  it('convite vencido aparece na pendência', async () => {
    const a = await novoAluno({ emailsResponsaveis: [emailUnico()] });
    await db('convites_responsavel_lanchei').where({ aluno_id: a.aluno.id }).update({ expira_em: new Date(Date.now() - 1000) });
    const p = await diretoria.get('/v1/admin/pendencias');
    expect(p.body.convitesVencidos).toBe(1);
    const ficha = await diretoria.get(`/v1/admin/alunos/${a.aluno.id}`);
    expect(ficha.body.convites[0].status).toBe('VENCIDO');
  });

  it('busca (nome ou matrícula) e paginação por cursor estável', async () => {
    for (const nome of ['Ana', 'Bruno', 'Carla', 'Daniel', 'Eva']) {
      await diretoria.post('/v1/admin/alunos', { nome: `${nome} Teste`, matricula: matricula(), turmaId: escola.turmaId });
    }
    const p1 = await diretoria.get('/v1/admin/alunos?limite=2');
    const p2 = await diretoria.get(`/v1/admin/alunos?limite=2&cursor=${p1.body.proximoCursor}`);
    const p3 = await diretoria.get(`/v1/admin/alunos?limite=2&cursor=${p2.body.proximoCursor}`);
    const nomes = [...p1.body.itens, ...p2.body.itens, ...p3.body.itens].map((a: { nome: string }) => a.nome);
    expect(nomes).toEqual(['Ana Teste', 'Bruno Teste', 'Carla Teste', 'Daniel Teste', 'Eva Teste']);
    expect(p3.body.proximoCursor).toBeNull();

    expect((await diretoria.get('/v1/admin/alunos?busca=arl')).body.itens).toHaveLength(1);
    // "%" na busca é texto, não curinga
    expect((await diretoria.get('/v1/admin/alunos?busca=%25')).body.itens).toHaveLength(0);
    expect((await diretoria.get('/v1/admin/alunos?cursor=lixo')).status).toBe(400);
  });

  it('ficha: a Diretoria vê responsáveis e regras; a Cantina vê só dados, saldo e carteirinha', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 3000 });
    const d = await diretoria.get(`/v1/admin/alunos/${a.alunoId}`);
    expect(d.body.responsaveis).toHaveLength(2);
    expect(d.body.responsaveis[0].email).toContain('@');
    expect(d.body.regras.diasPermitidos).toEqual(['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM']);

    const c = await cantina.get(`/v1/admin/alunos/${a.alunoId}`);
    expect(c.body.saldoCentavos).toBe(3000);
    expect(c.body.carteirinha.status).toBe('ATIVA');
    expect(c.body.responsaveis).toBeUndefined();
    expect(c.body.regras).toBeUndefined();
  });

  it('aluno de OUTRA escola → 404 (não confirma que existe)', async () => {
    const outra = await criarEscola();
    const a = await criarAluno(outra);
    expect((await diretoria.get(`/v1/admin/alunos/${a.alunoId}`)).status).toBe(404);
    expect((await diretoria.patch(`/v1/admin/alunos/${a.alunoId}`, { status: 'INATIVO' })).status).toBe(404);
    expect((await diretoria.post(`/v1/admin/alunos/${a.alunoId}/carteirinhas`)).status).toBe(404);
  });

  it('editar e inativar (com auditoria antes/depois); encerrado não muda', async () => {
    const a = await novoAluno();
    const r = await diretoria.patch(`/v1/admin/alunos/${a.aluno.id}`, { nome: 'Pedro H. Souza', status: 'INATIVO' });
    expect(r.status).toBe(200);
    expect(r.body.aluno).toMatchObject({ nome: 'Pedro H. Souza', status: 'INATIVO' });
    const aud = await db('auditoria_lanchei').where({ acao: 'ALUNO_EDITAR', aluno_id: a.aluno.id }).first();
    expect(aud.antes.status).toBe('ATIVO');
    expect(aud.depois).toEqual({ nome: 'Pedro H. Souza', status: 'INATIVO' });

    expect((await diretoria.patch(`/v1/admin/alunos/${a.aluno.id}`, { status: 'ENCERRADO' })).status).toBe(400);
    await db('alunos_lanchei').where({ id: a.aluno.id }).update({ status: 'ENCERRADO', encerrado_em: new Date() });
    const enc = await diretoria.patch(`/v1/admin/alunos/${a.aluno.id}`, { nome: 'X' });
    expect(enc.body.erro.codigo).toBe('ALUNO_ENCERRADO');
  });

  it('solicitar encerramento avisa os ADMIN da cantina por e-mail e audita', async () => {
    const a = await novoAluno();
    const r = await diretoria.post(`/v1/admin/alunos/${a.aluno.id}/solicitar-encerramento`, { motivo: 'Transferido de escola' });
    expect(r.status).toBe(202);
    await aguardarEmailsPendentes();
    expect(emailsPara(escola.adminEmail).at(-1)!.texto).toContain('Transferido de escola');
    expect(emailsPara(escola.operadorEmail)).toHaveLength(0);
  });
});

describe('foto do aluno', () => {
  it('processa (400x400 JPEG, sem EXIF/GPS), serve sem cache e audita cada visualização', async () => {
    const a = await novoAluno();
    // Foto "de celular": 1200x900 com orientação e GPS no EXIF.
    const original = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#88aa44' } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '22/1 54/1 0/1' } } })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeTruthy();

    const up = await diretoria.upload('put', `/v1/admin/alunos/${a.aluno.id}/foto`, 'foto', original, 'foto.jpg', 'image/jpeg');
    expect(up.status).toBe(204);

    const r = await cantina.get(`/v1/admin/alunos/${a.aluno.id}/foto`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('private, no-store');
    const meta = await sharp(r.body as Buffer).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([400, 400, 'jpeg']);
    expect(meta.exif).toBeUndefined();

    const aud = await db('auditoria_lanchei').where({ acao: 'FOTO_VISUALIZAR', aluno_id: a.aluno.id });
    expect(aud).toHaveLength(1);
    expect(aud[0].ator_usuario_id).toBe(escola.adminId);
  });

  it('arquivo que não é imagem → 422; tipo errado → 422; sem arquivo → 422', async () => {
    const a = await novoAluno();
    const lixo = await diretoria.upload('put', `/v1/admin/alunos/${a.aluno.id}/foto`, 'foto', Buffer.from('não sou imagem'), 'x.jpg', 'image/jpeg');
    expect(lixo.body.erro.codigo).toBe('IMAGEM_INVALIDA');
    const pdf = await diretoria.upload('put', `/v1/admin/alunos/${a.aluno.id}/foto`, 'foto', Buffer.from('%PDF'), 'x.pdf', 'application/pdf');
    expect(pdf.body.erro.codigo).toBe('TIPO_DE_ARQUIVO');
    expect((await diretoria.put(`/v1/admin/alunos/${a.aluno.id}/foto`)).body.erro.codigo).toBe('ARQUIVO_OBRIGATORIO');
    expect((await diretoria.get(`/v1/admin/alunos/${a.aluno.id}/foto`)).status).toBe(404);
  });
});

describe('importação CSV', () => {
  const csv = (linhas: string[]) =>
    Buffer.from(['﻿nome;matricula;turma;email_responsavel_1;email_responsavel_2', ...linhas].join('\r\n'), 'utf8');
  const enviar = (arquivo: Buffer, simular: boolean) =>
    diretoria.upload('post', `/v1/admin/alunos/importar${simular ? '?simular=true' : ''}`, 'arquivo', arquivo, 'alunos.csv', 'text/csv');

  it('modelo para baixar', async () => {
    const r = await diretoria.get('/v1/admin/alunos/importar/modelo');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('modelo-alunos-lanchei.csv');
    expect(r.text).toContain('nome;matricula;turma;email_responsavel_1;email_responsavel_2');
  });

  it('simular não grava; importar cria turma nova, alunos e convites', async () => {
    const [m1, m2] = [matricula(), matricula()];
    const e1 = emailUnico();
    const arquivo = csv([`Lia Prado;${m1};3A;${e1};`, `Rui Paz;${m2};9º Z;;`]);

    const sim = await enviar(arquivo, true);
    expect(sim.status).toBe(200);
    expect(sim.body).toMatchObject({ totalLinhas: 2, validos: 2, erros: [], turmasNovas: ['9º Z'] });
    expect(await db('alunos_lanchei').where({ escola_id: escola.escolaId }).whereIn('matricula', [m1, m2])).toHaveLength(0);

    const imp = await enviar(arquivo, false);
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ importados: 2, turmasCriadas: ['9º Z'], convitesCriados: 1 });
    await aguardarEmailsPendentes();
    expect(emailsPara(e1)).toHaveLength(1);

    const alunos = await db('alunos_lanchei as a').join('turmas_lanchei as t', 't.id', 'a.turma_id').whereIn('a.matricula', [m1, m2]).select('a.id', 't.nome');
    expect(alunos.map((a) => a.nome).sort()).toEqual(['3A', '9º Z']); // "3A" já existia (fixture)
    expect(await db('contas_lanchei').whereIn('aluno_id', alunos.map((a) => a.id))).toHaveLength(2);
    expect(await db('auditoria_lanchei').where({ acao: 'ALUNOS_IMPORTAR', escola_id: escola.escolaId }).first()).toBeTruthy();
  });

  it('com qualquer erro, NADA é importado (422 + relatório por linha)', async () => {
    const existente = await novoAluno();
    const m = matricula();
    const r = await enviar(csv([`Ok;${m};3A;;`, `Repetido;${existente.aluno.matricula};3A;;`]), false);
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('IMPORTACAO_COM_ERROS');
    expect(r.body.erro.detalhes.erros).toEqual([expect.objectContaining({ linha: 3, campo: 'matricula' })]);
    expect(await db('alunos_lanchei').where({ matricula: m })).toHaveLength(0);
  });

  it('arquivo salvo em Windows-1252 → erro explicando como salvar em UTF-8', async () => {
    const latin1 = Buffer.from('nome;matricula;turma\nJo\xe3o;M1;3A\n', 'latin1');
    const r = await enviar(latin1, true);
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('ARQUIVO_NAO_UTF8');
  });
});

describe('turmas', () => {
  it('criar, duplicar (409), mover alunos e só desativar vazia', async () => {
    const t = await diretoria.post('/v1/admin/turmas', { nome: '4º B', anoLetivo: 2027 });
    expect(t.status).toBe(201);
    expect((await diretoria.post('/v1/admin/turmas', { nome: '4º B', anoLetivo: 2027 })).status).toBe(409);

    await novoAluno();
    await novoAluno();
    expect((await diretoria.patch(`/v1/admin/turmas/${escola.turmaId}`, { ativo: false })).body.erro.codigo).toBe('TURMA_COM_ALUNOS');

    const mov = await diretoria.patch('/v1/admin/turmas/mover-alunos', { deTurmaId: escola.turmaId, paraTurmaId: t.body.turma.id });
    expect(mov.body).toEqual({ movidos: 2 });
    expect((await diretoria.patch(`/v1/admin/turmas/${escola.turmaId}`, { ativo: false })).status).toBe(200);

    const lista = await cantina.get('/v1/admin/turmas?anoLetivo=2027');
    expect(lista.body.itens).toEqual([expect.objectContaining({ nome: '4º B', qtdAlunos: 2 })]);
  });

  it('mover com aluno de outra turma/escola recusa tudo', async () => {
    const t = await diretoria.post('/v1/admin/turmas', { nome: 'Destino', anoLetivo: 2027 });
    const a = await novoAluno();
    const outra = await criarAluno(await criarEscola());
    const r = await diretoria.patch('/v1/admin/turmas/mover-alunos', { deTurmaId: escola.turmaId, paraTurmaId: t.body.turma.id, alunoIds: [a.aluno.id, outra.alunoId] });
    expect(r.status).toBe(404);
    expect((await db('alunos_lanchei').where({ id: a.aluno.id }).first()).turma_id).toBe(escola.turmaId);
  });
});

describe('dados da escola (permissão por campo)', () => {
  it('Diretoria muda nome/fuso; Cantina muda depósito; cruzado → 403', async () => {
    expect((await diretoria.patch('/v1/admin/escola', { nome: 'Colégio Novo Nome' })).status).toBe(200);
    expect((await cantina.patch('/v1/admin/escola', { depositoMinCentavos: 3000 })).body.escola.depositoMinCentavos).toBe(3000);
    expect((await diretoria.patch('/v1/admin/escola', { depositoMaxCentavos: 90000 })).status).toBe(403);
    expect((await cantina.patch('/v1/admin/escola', { timezone: 'America/Manaus' })).status).toBe(403);
    expect((await cantina.patch('/v1/admin/escola', { depositoMinCentavos: 60000 })).body.erro.codigo).toBe('DEPOSITO_MIN_MAIOR_QUE_MAX');
    expect((await diretoria.patch('/v1/admin/escola', { timezone: 'Lugar/Nenhum' })).status).toBe(400);
  });
});
