// Dados e configurações da escola (/admin/escola).
//
// Um mesmo PATCH, com permissão POR CAMPO (matriz da etapa6 §2):
//   ESCOLA (Diretoria) → nome e fuso horário ("Dados da escola")
//   ADMIN (Cantina)    → mínimo e máximo de depósito ("Configurações de pagamento")
import { db } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import type { PapelPainel } from './acesso.js';

export const CAMPOS_POR_PAPEL: Record<PapelPainel, string[]> = {
  ESCOLA: ['nome', 'timezone'],
  ADMIN: ['depositoMinCentavos', 'depositoMaxCentavos'],
};

const COLUNA: Record<string, string> = {
  nome: 'nome',
  timezone: 'timezone',
  depositoMinCentavos: 'deposito_min_centavos',
  depositoMaxCentavos: 'deposito_max_centavos',
};

export async function dadosDaEscola(escolaId: number) {
  const e = await db('escolas_lanchei as e')
    .leftJoin('escola_mercadopago_lanchei as mp', 'mp.escola_id', 'e.id')
    .where('e.id', escolaId)
    .first<{
      id: number; nome: string; slug: string; timezone: string; deposito_min_centavos: number; deposito_max_centavos: number; mp_conectado: number;
    }>('e.id', 'e.nome', 'e.slug', 'e.timezone', 'e.deposito_min_centavos', 'e.deposito_max_centavos', db.raw('mp.escola_id IS NOT NULL AS mp_conectado'));
  return {
    id: e.id,
    nome: e.nome,
    slug: e.slug,
    timezone: e.timezone,
    depositoMinCentavos: e.deposito_min_centavos,
    depositoMaxCentavos: e.deposito_max_centavos,
    mercadoPagoConectado: Boolean(e.mp_conectado),
  };
}

export async function editarDadosDaEscola(escolaId: number, papel: PapelPainel, d: Record<string, unknown>, ator: AtorUsuario) {
  const enviados = Object.keys(d).filter((k) => d[k] !== undefined);
  const proibidos = enviados.filter((k) => !CAMPOS_POR_PAPEL[papel].includes(k));
  if (proibidos.length > 0) {
    throw erros.semPermissao(`Seu perfil não pode alterar: ${proibidos.join(', ')}.`);
  }

  await db.transaction(async (trx) => {
    const atual = await trx('escolas_lanchei')
      .where({ id: escolaId })
      .forUpdate()
      .first<Record<string, unknown>>('nome', 'timezone', 'deposito_min_centavos', 'deposito_max_centavos');

    const mudancas: Record<string, unknown> = {};
    for (const k of enviados) if (atual[COLUNA[k]!] !== d[k]) mudancas[COLUNA[k]!] = d[k];
    if (Object.keys(mudancas).length === 0) return;

    // Mínimo ≤ máximo, olhando o valor que vai ficar (o novo ou o atual).
    const min = (mudancas.deposito_min_centavos ?? atual.deposito_min_centavos) as number;
    const max = (mudancas.deposito_max_centavos ?? atual.deposito_max_centavos) as number;
    if (min > max) throw erros.regra('DEPOSITO_MIN_MAIOR_QUE_MAX', 'O depósito mínimo não pode ser maior que o máximo.');

    await trx('escolas_lanchei').where({ id: escolaId }).update(mudancas);
    const antes = Object.fromEntries(Object.keys(mudancas).map((c) => [c, atual[c]]));
    await auditarUsuario(trx, ator, { escolaId, acao: 'ESCOLA_EDITAR', entidade: 'escolas', entidadeId: escolaId, antes, depois: mudancas });
  });
  return dadosDaEscola(escolaId);
}
