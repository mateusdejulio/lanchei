// Plataforma (SUPERADMIN): escolas e o primeiro usuário de cada perfil.
//
// Menor privilégio: o superadmin NÃO vê alunos, saldos nem extratos. Ele cria
// a escola e convida o primeiro ADMIN (cantina) e o primeiro ESCOLA
// (diretoria); a partir daí cada perfil cadastra a própria equipe.
import { IANAZone } from 'luxon';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import type { InfoCliente } from '../auth/tokens.js';

export const fusoValido = (tz: string) => IANAZone.isValidZone(tz);

interface LinhaEscola {
  id: number;
  nome: string;
  slug: string;
  timezone: string;
  deposito_min_centavos: number;
  deposito_max_centavos: number;
  ativo: boolean;
  created_at: Date;
  qtd_admin: number;
  qtd_escola: number;
}

// snake_case (banco) → camelCase (API), explícito.
const paraApi = (e: LinhaEscola) => ({
  id: e.id,
  nome: e.nome,
  slug: e.slug,
  timezone: e.timezone,
  depositoMinCentavos: e.deposito_min_centavos,
  depositoMaxCentavos: e.deposito_max_centavos,
  ativo: e.ativo,
  criadoEm: e.created_at,
  // Quantos usuários ATIVOS de cada perfil: mostra no painel se falta convidar alguém.
  equipe: { admin: Number(e.qtd_admin), escola: Number(e.qtd_escola) },
});

function consultaEscolas() {
  const contar = (papel: string) =>
    db('usuarios_lanchei as u').count('*').whereRaw('u.escola_id = e.id').andWhere({ 'u.papel': papel, 'u.ativo': true });
  return db('escolas_lanchei as e').select(
    'e.id', 'e.nome', 'e.slug', 'e.timezone', 'e.deposito_min_centavos', 'e.deposito_max_centavos', 'e.ativo', 'e.created_at',
    contar('ADMIN').as('qtd_admin'),
    contar('ESCOLA').as('qtd_escola'),
  );
}

async function buscarEscola(id: number) {
  const e = await consultaEscolas().where('e.id', id).first<LinhaEscola | undefined>();
  if (!e) throw erros.naoEncontrado('Escola não encontrada.');
  return paraApi(e);
}

export async function listarEscolas() {
  const linhas = await consultaEscolas().orderBy('e.nome');
  return (linhas as LinhaEscola[]).map(paraApi);
}

type Ator = { id: number } & InfoCliente;

export async function criarEscola(d: { nome: string; slug: string; timezone: string }, ator: Ator) {
  let escolaId: number;
  try {
    escolaId = await db.transaction(async (trx) => {
      const [id] = await trx('escolas_lanchei').insert({ nome: d.nome, slug: d.slug, timezone: d.timezone });
      await registrarAuditoria(trx, {
        escolaId: id!,
        ator: { tipo: 'USUARIO', id: ator.id },
        acao: 'ESCOLA_CRIAR',
        entidade: 'escolas',
        entidadeId: id!,
        depois: d,
        ip: ator.ip ?? null,
        userAgent: ator.userAgent ?? null,
      });
      return id!;
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw erros.conflito('SLUG_JA_EXISTE', 'Já existe uma escola com esse identificador (slug).');
    throw e;
  }
  return buscarEscola(escolaId);
}

export async function editarEscola(escolaId: number, d: { nome?: string | undefined; ativo?: boolean | undefined }, ator: Ator) {
  await db.transaction(async (trx) => {
    const antes = await trx('escolas_lanchei').where({ id: escolaId }).forUpdate().first<{ nome: string; ativo: boolean } | undefined>('nome', 'ativo');
    if (!antes) throw erros.naoEncontrado('Escola não encontrada.');

    const mudancas: Record<string, unknown> = {};
    if (d.nome !== undefined) mudancas.nome = d.nome;
    if (d.ativo !== undefined) mudancas.ativo = d.ativo;
    if (Object.keys(mudancas).length === 0) return;

    await trx('escolas_lanchei').where({ id: escolaId }).update(mudancas);

    // Desativou: derruba as sessões da equipe da escola. O login e o refresh
    // já recusam escola inativa; isto corta também quem está logado agora
    // (o access token que já existe ainda vale por até 15 min).
    if (antes.ativo && d.ativo === false) {
      await trx('sessoes_lanchei')
        .whereIn('usuario_id', trx('usuarios_lanchei').select('id').where({ escola_id: escolaId }))
        .whereNull('revogada_em')
        .update({ revogada_em: new Date() });
    }

    await registrarAuditoria(trx, {
      escolaId,
      ator: { tipo: 'USUARIO', id: ator.id },
      acao: 'ESCOLA_EDITAR',
      entidade: 'escolas',
      entidadeId: escolaId,
      antes,
      depois: mudancas,
      ip: ator.ip ?? null,
      userAgent: ator.userAgent ?? null,
    });
  });
  return buscarEscola(escolaId);
}

// O primeiro ADMIN/ESCOLA usa a mesma função da equipe (convite "crie sua senha" de 72 h).
export { criarUsuarioDaEscola } from '../admin/equipe.servico.js';
