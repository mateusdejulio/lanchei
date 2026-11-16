// Monta cenários de teste. Cada chamada cria uma ESCOLA NOVA, então os
// testes não interferem uns nos outros (isolamento por tenant).
import { randomUUID } from 'node:crypto';
import { db } from '../src/infra/db.js';
import { criptografar, hashSenha, sha256, tokenAleatorio } from '../src/infra/cripto.js';
import { lancarTransacao } from '../src/dominio/ledger.js';
import { montarQr } from '../src/modulos/caixa/identificacao.js';

export const SENHA = 'senha-teste-123';
let hashSenhaCache: Promise<string> | undefined;
const senhaHash = () => (hashSenhaCache ??= hashSenha(SENHA));

const sufixo = () => randomUUID().replace(/-/g, '').slice(0, 10);

export interface OpcoesRegras {
  limite_diario_centavos?: number | null;
  limite_semanal_centavos?: number | null;
  limite_mensal_centavos?: number | null;
  dias_permitidos?: number;
  permite_sem_carteirinha?: boolean;
  alerta_saldo_baixo_centavos?: number | null;
}

export async function criarEscola() {
  const s = sufixo();
  const [escolaId] = await db('escolas_lanchei').insert({ nome: `Escola ${s}`, slug: `e-${s}` });
  const [adminId] = await db('usuarios_lanchei').insert({
    escola_id: escolaId,
    papel: 'ADMIN',
    nome: 'Admin',
    email: `admin-${s}@teste.com`,
    senha_hash: await senhaHash(),
  });
  const [operadorId] = await db('usuarios_lanchei').insert({
    escola_id: escolaId,
    papel: 'OPERADOR',
    nome: 'Tia da Cantina',
    email: `op-${s}@teste.com`,
    senha_hash: await senhaHash(),
  });
  const [diretoriaId] = await db('usuarios_lanchei').insert({
    escola_id: escolaId,
    papel: 'ESCOLA',
    nome: 'Secretaria',
    email: `escola-${s}@teste.com`,
    senha_hash: await senhaHash(),
  });
  const [turmaId] = await db('turmas_lanchei').insert({ escola_id: escolaId, nome: '3A', ano_letivo: 2026 });
  const [catBebidas] = await db('categorias_lanchei').insert({ escola_id: escolaId, nome: 'Bebidas' });
  const [catDoces] = await db('categorias_lanchei').insert({ escola_id: escolaId, nome: 'Doces' });
  const [suco] = await db('produtos_lanchei').insert({ escola_id: escolaId, categoria_id: catBebidas, nome: 'Suco', preco_centavos: 600 });
  const [refri] = await db('produtos_lanchei').insert({
    escola_id: escolaId,
    categoria_id: catBebidas,
    nome: 'Refrigerante',
    preco_centavos: 500,
    controla_estoque: true,
  });
  const [chocolate] = await db('produtos_lanchei').insert({ escola_id: escolaId, categoria_id: catDoces, nome: 'Chocolate', preco_centavos: 400 });

  return {
    escolaId: escolaId!,
    adminId: adminId!,
    operadorId: operadorId!,
    adminEmail: `admin-${s}@teste.com`,
    operadorEmail: `op-${s}@teste.com`,
    diretoriaId: diretoriaId!,
    diretoriaEmail: `escola-${s}@teste.com`,
    turmaId: turmaId!,
    categorias: { bebidas: catBebidas!, doces: catDoces! },
    produtos: { suco: suco!, refri: refri!, chocolate: chocolate! },
  };
}

export type Escola = Awaited<ReturnType<typeof criarEscola>>;

export async function criarAluno(
  escola: Escola,
  op: { saldoCentavos?: number; regras?: OpcoesRegras; responsaveis?: number; pin?: string } = {},
) {
  const s = sufixo();
  const [alunoId] = await db('alunos_lanchei').insert({
    escola_id: escola.escolaId,
    turma_id: escola.turmaId,
    nome: `João ${s} Silva`,
    matricula: `M${s}`,
    pin_hash: op.pin ? await hashSenha(op.pin) : null,
  });
  // Por padrão TODOS os dias liberados, para os testes não dependerem do dia em que rodam.
  await db('regras_aluno_lanchei').insert({ aluno_id: alunoId, dias_permitidos: 127, alerta_saldo_baixo_centavos: null, ...op.regras });
  const [contaId] = await db('contas_lanchei').insert({ escola_id: escola.escolaId, aluno_id: alunoId });

  const token = tokenAleatorio();
  const [carteirinhaId] = await db('carteirinhas_lanchei').insert({
    escola_id: escola.escolaId,
    aluno_id: alunoId,
    token_hash: sha256(token),
    emitida_por_usuario_id: escola.adminId,
  });

  const responsavelIds: number[] = [];
  for (let i = 0; i < (op.responsaveis ?? 2); i++) {
    const email = `resp${i}-${s}@teste.com`;
    const [rid] = await db('responsaveis_lanchei').insert({
      nome: `Responsável ${i}`,
      email,
      senha_hash: await senhaHash(),
      email_verificado_em: new Date(),
    });
    const [conviteId] = await db('convites_responsavel_lanchei').insert({
      escola_id: escola.escolaId,
      aluno_id: alunoId,
      email,
      codigo_hash: sha256(randomUUID()),
      expira_em: new Date(Date.now() + 86_400_000),
      usado_em: new Date(),
      usado_por_responsavel_id: rid,
      criado_por_usuario_id: escola.adminId,
    });
    await db('aluno_responsaveis_lanchei').insert({ aluno_id: alunoId, responsavel_id: rid, convite_id: conviteId });
    responsavelIds.push(rid!);
  }

  if (op.saldoCentavos) await creditar(escola.escolaId, contaId!, responsavelIds[0]!, op.saldoCentavos);

  return { alunoId: alunoId!, contaId: contaId!, carteirinhaId: carteirinhaId!, qr: montarQr(token), responsavelIds };
}

/** Simula um depósito Pix já aprovado. */
export async function creditar(escolaId: number, contaId: number, responsavelId: number, valorCentavos: number) {
  const [depositoId] = await db('depositos_lanchei').insert({
    escola_id: escolaId,
    conta_id: contaId,
    responsavel_id: responsavelId,
    valor_centavos: valorCentavos,
    idempotency_key: randomUUID(),
    status: 'APROVADO',
    aprovado_em: new Date(),
  });
  await db.transaction((trx) =>
    lancarTransacao(trx, { escolaId, contaId, tipo: 'DEPOSITO', valorCentavos, depositoId: depositoId! }),
  );
}

export async function definirEstoque(escola: Escola, produtoId: number, quantidade: number) {
  const { movimentarEstoque } = await import('../src/dominio/estoque.js');
  await db.transaction((trx) =>
    movimentarEstoque(trx, { escolaId: escola.escolaId, produtoId, tipo: 'ENTRADA', quantidade, usuarioId: escola.adminId }),
  );
}

export async function conectarMercadoPago(escolaId: number) {
  const mpUserId = `mp-${sufixo()}`;
  await db('escola_mercadopago_lanchei').insert({
    escola_id: escolaId,
    mp_user_id: mpUserId,
    access_token_enc: criptografar('TOKEN-DA-CANTINA'),
    refresh_token_enc: criptografar('REFRESH-DA-CANTINA'),
    token_expira_em: new Date(Date.now() + 180 * 86_400_000),
  });
  return mpUserId;
}

export const saldo = async (contaId: number) =>
  (await db('contas_lanchei').where({ id: contaId }).first<{ saldo_centavos: number }>('saldo_centavos')).saldo_centavos;

export const estoqueAtual = async (produtoId: number) =>
  (await db('produtos_lanchei').where({ id: produtoId }).first<{ estoque_atual: number }>('estoque_atual')).estoque_atual;

export async function divergencias() {
  const contas = await db('vw_contas_divergentes_lanchei').count<{ n: number }[]>({ n: '*' });
  const estoque = await db('vw_estoque_divergente_lanchei').count<{ n: number }[]>({ n: '*' });
  return { contas: Number(contas[0]!.n), estoque: Number(estoque[0]!.n) };
}

export const novaChave = () => randomUUID();
