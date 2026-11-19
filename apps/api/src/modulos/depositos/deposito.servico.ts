// Depósito via Pix pelo app dos pais (POST /me/filhos/:alunoId/depositos).
//
// O saldo NÃO muda aqui: só criamos a cobrança Pix na conta Mercado Pago DA
// CANTINA. O crédito entra quando o MP confirma o pagamento (webhook ou job
// de pendentes → pagamento.servico.ts → ledger), uma vez só.
//
// Passo a passo (etapa4 §4.7):
//   1. mesma Idempotency-Key deste responsável → devolve o mesmo depósito;
//   2. confere mínimo/máximo da escola e se o MP está conectado;
//   3. INSERT PENDENTE (precisamos do id para o external_reference);
//   4. cria o Pix no MP (FORA da transação: é uma chamada HTTP, que pode
//      levar segundos; não seguramos lock de banco esperando a internet);
//   5. salva o mp_payment_id e o "copia e cola". Se o MP falhou → CANCELADO + 502.
//
// O MP também recebe a nossa Idempotency-Key (X-Idempotency-Key): se a mesma
// cobrança for pedida duas vezes, ele devolve o MESMO pagamento.
import { env } from '../../config/env.js';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { descriptografar } from '../../infra/cripto.js';
import { clienteMercadoPago, type ClienteMercadoPago } from '../../infra/mercadopago.js';
import { logger } from '../../infra/logger.js';
import { ErroApi, erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { z } from 'zod';
import { exigirContaAberta, garantirVinculo } from '../responsavel/vinculo.js';

export const MINUTOS_VALIDADE_PIX = 30;

let cliente: ClienteMercadoPago = clienteMercadoPago;
/** Só para testes: troca o cliente do MP por um falso (undefined volta ao real). */
export function usarClienteMercadoPago(c: ClienteMercadoPago | undefined) {
  cliente = c ?? clienteMercadoPago;
}
export const clienteMpAtual = () => cliente;

interface LinhaDeposito {
  id: number;
  conta_id: number;
  responsavel_id: number;
  valor_centavos: number;
  status: string;
  pix_copia_cola: string | null;
  expira_em: Date | null;
  aprovado_em: Date | null;
  created_at: Date;
  mp_payment_id: string | null;
}

function paraApi(d: LinhaDeposito, extra: { alunoId: number; recebedor?: string } , agora = new Date()) {
  const aberto = d.status === 'PENDENTE' && d.expira_em !== null && d.expira_em > agora;
  return {
    id: d.id,
    alunoId: extra.alunoId,
    status: d.status, // PENDENTE | APROVADO | CANCELADO | REJEITADO | DEVOLVIDO
    valorCentavos: d.valor_centavos,
    // O "copia e cola" só serve enquanto o Pix está aberto.
    pixCopiaCola: aberto ? d.pix_copia_cola : null,
    expiraEm: d.expira_em,
    aprovadoEm: d.aprovado_em,
    criadoEm: d.created_at,
    ...(extra.recebedor ? { recebedor: extra.recebedor } : {}),
  };
}

export async function criarDeposito(responsavelId: number, alunoId: number, valorCentavos: number, idempotencyKey: string, agora = new Date()) {
  const f = await garantirVinculo(db, responsavelId, alunoId);
  const escola = await db('escolas_lanchei')
    .where({ id: f.escolaId })
    .first<{ nome: string; deposito_min_centavos: number; deposito_max_centavos: number }>('nome', 'deposito_min_centavos', 'deposito_max_centavos');
  const recebedor = `Cantina ${escola.nome}`;

  // 1) Idempotência: retentativa de rede devolve o mesmo depósito (inclusive o "copia e cola").
  const existente = await db('depositos_lanchei').where({ idempotency_key: idempotencyKey }).first<LinhaDeposito | undefined>();
  if (existente) return { criado: false, deposito: replay(existente, responsavelId, f.contaId, alunoId, recebedor) };

  // 2) Regras.
  exigirContaAberta(f);
  if (valorCentavos < escola.deposito_min_centavos || valorCentavos > escola.deposito_max_centavos) {
    throw erros.regra('VALOR_FORA_DO_LIMITE', 'Valor fora do limite de depósito da escola.', {
      minCentavos: escola.deposito_min_centavos,
      maxCentavos: escola.deposito_max_centavos,
    });
  }
  const mp = await db('escola_mercadopago_lanchei').where({ escola_id: f.escolaId }).first<{ access_token_enc: Buffer; token_expira_em: Date } | undefined>('access_token_enc', 'token_expira_em');
  if (!mp || mp.token_expira_em <= agora) {
    throw erros.conflito('MP_NAO_CONECTADO', 'A cantina ainda não está recebendo Pix pelo Lanchei. Fale com a cantina.');
  }
  const responsavel = await db('responsaveis_lanchei').where({ id: responsavelId }).first<{ email: string }>('email');

  // 3) Registro PENDENTE.
  const expiraEm = new Date(agora.getTime() + MINUTOS_VALIDADE_PIX * 60_000);
  let depositoId: number;
  try {
    [depositoId] = (await db('depositos_lanchei').insert({
      escola_id: f.escolaId,
      conta_id: f.contaId,
      responsavel_id: responsavelId,
      valor_centavos: valorCentavos,
      idempotency_key: idempotencyKey,
      status: 'PENDENTE',
      expira_em: expiraEm,
    })) as [number];
  } catch (e) {
    // Dois envios SIMULTÂNEOS com a mesma chave: o UNIQUE barra o segundo.
    if (!ehChaveDuplicada(e)) throw e;
    const outro = (await db('depositos_lanchei').where({ idempotency_key: idempotencyKey }).first<LinhaDeposito>())!;
    return { criado: false, deposito: replay(outro, responsavelId, f.contaId, alunoId, recebedor) };
  }

  // 4) Pix no Mercado Pago, com o token DA CANTINA (o dinheiro cai na conta dela).
  try {
    const pix = await cliente.criarPix({
      accessToken: descriptografar(mp.access_token_enc),
      idempotencyKey,
      valorCentavos,
      // Sem nome do aluno: a descrição aparece no app do banco de quem paga.
      descricao: `Créditos na cantina (Lanchei) - ${escola.nome}`.slice(0, 120),
      emailPagador: responsavel.email,
      externalReference: String(depositoId),
      expiraEm,
      ...(env.URL_PUBLICA_API ? { notificationUrl: new URL('/v1/webhooks/mercadopago', env.URL_PUBLICA_API).toString() } : {}),
    });
    // 5) Guarda o que o app precisa para mostrar o QR.
    await db('depositos_lanchei').where({ id: depositoId }).update({ mp_payment_id: pix.mpPaymentId, pix_copia_cola: pix.pixCopiaCola });
  } catch (e) {
    logger.error({ depositoId, motivo: (e as Error).message }, 'falha ao criar Pix no Mercado Pago');
    await db('depositos_lanchei').where({ id: depositoId, status: 'PENDENTE' }).update({ status: 'CANCELADO' });
    throw new ErroApi(502, 'GATEWAY_INDISPONIVEL', 'Não foi possível gerar o Pix agora. Tente de novo em instantes.');
  }

  const d = (await db('depositos_lanchei').where({ id: depositoId }).first<LinhaDeposito>())!;
  return { criado: true, deposito: paraApi(d, { alunoId, recebedor }, agora) };
}

/** Mesma chave de novo: só vale para o MESMO responsável e o MESMO aluno. */
function replay(d: LinhaDeposito, responsavelId: number, contaId: number, alunoId: number, recebedor: string) {
  if (d.responsavel_id !== responsavelId || d.conta_id !== contaId) {
    throw erros.conflito('IDEMPOTENCY_KEY_REUTILIZADA', 'Esta Idempotency-Key já foi usada em outro depósito.');
  }
  // O primeiro envio ainda está esperando o Mercado Pago responder.
  if (d.status === 'PENDENTE' && !d.pix_copia_cola) {
    throw erros.conflito('DEPOSITO_EM_PROCESSAMENTO', 'O Pix ainda está sendo gerado. Tente de novo em alguns segundos.');
  }
  return paraApi(d, { alunoId, recebedor });
}

/** GET /me/depositos/:id: o app consulta a cada 3 s enquanto mostra o QR. Só o PRÓPRIO responsável. */
export async function statusDoDeposito(responsavelId: number, depositoId: number) {
  const d = await db('depositos_lanchei as d')
    .join('contas_lanchei as c', 'c.id', 'd.conta_id')
    .where({ 'd.id': depositoId, 'd.responsavel_id': responsavelId })
    .first<(LinhaDeposito & { aluno_id: number }) | undefined>('d.*', 'c.aluno_id');
  if (!d) throw erros.naoEncontrado('Depósito não encontrado.');
  return paraApi(d, { alunoId: d.aluno_id });
}

const zCursor = z.number().int().positive();

/** Histórico de depósitos do filho (de todos os responsáveis dele). */
export async function depositosDoFilho(responsavelId: number, alunoId: number, f: { limite: number; cursor?: string | undefined }) {
  const filho = await garantirVinculo(db, responsavelId, alunoId);
  const q = db('depositos_lanchei as d')
    .join('responsaveis_lanchei as r', 'r.id', 'd.responsavel_id')
    .where('d.conta_id', filho.contaId)
    .orderBy('d.id', 'desc')
    .limit(f.limite + 1)
    .select('d.*', 'r.nome as responsavel_nome');
  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) q.andWhere('d.id', '<', cursor);
  const { itens, proximoCursor } = paginar((await q) as (LinhaDeposito & { responsavel_nome: string })[], f.limite, (u) => u.id);
  return {
    itens: itens.map((d) => ({
      ...paraApi(d, { alunoId }),
      feitoPorMim: d.responsavel_id === responsavelId,
      feitoPor: d.responsavel_nome.split(/\s+/)[0],
    })),
    proximoCursor,
  };
}
