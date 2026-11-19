// Perfil do responsável, troca de senha, aparelhos de push e caixa de entrada.
import { z } from 'zod';
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { hashSenha, sha256, verificarSenha } from '../../infra/cripto.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { emitirSessao, revogarTodasSessoes, type InfoCliente } from '../auth/tokens.js';

// ------------------------------------------------------------ perfil

export async function meuPerfil(responsavelId: number) {
  const r = await db('responsaveis_lanchei')
    .where({ id: responsavelId })
    .first<{ id: number; nome: string; email: string; telefone: string | null; email_verificado_em: Date | null; created_at: Date }>(
      'id', 'nome', 'email', 'telefone', 'email_verificado_em', 'created_at',
    );
  return { id: r.id, nome: r.nome, email: r.email, telefone: r.telefone, emailVerificado: r.email_verificado_em !== null, criadoEm: r.created_at };
}

export async function editarPerfil(responsavelId: number, d: { nome?: string | undefined; telefone?: string | null | undefined }) {
  const mudancas: Record<string, unknown> = {};
  if (d.nome !== undefined) mudancas.nome = d.nome;
  if (d.telefone !== undefined) mudancas.telefone = d.telefone;
  if (Object.keys(mudancas).length > 0) await db('responsaveis_lanchei').where({ id: responsavelId }).update(mudancas);
  return meuPerfil(responsavelId);
}

/**
 * Troca de senha logado. Derruba TODAS as sessões (inclusive a de um
 * invasor que tivesse a senha antiga) e devolve uma sessão nova para este
 * aparelho, para a pessoa não ser deslogada no meio do que estava fazendo.
 */
export async function trocarSenha(responsavelId: number, senhaAtual: string, novaSenha: string, cliente: InfoCliente) {
  const r = await db('responsaveis_lanchei').where({ id: responsavelId }).first<{ senha_hash: string }>('senha_hash');
  if (!(await verificarSenha(r.senha_hash, senhaAtual))) throw erros.regra('SENHA_INCORRETA', 'A senha atual está incorreta.');
  const novoHash = await hashSenha(novaSenha);
  return db.transaction(async (trx) => {
    await trx('responsaveis_lanchei').where({ id: responsavelId }).update({ senha_hash: novoHash });
    await revogarTodasSessoes(trx, { tipo: 'RESPONSAVEL', id: responsavelId });
    await registrarAuditoria(trx, {
      escolaId: null,
      ator: { tipo: 'RESPONSAVEL', id: responsavelId },
      acao: 'SENHA_TROCAR',
      entidade: 'responsaveis',
      entidadeId: responsavelId,
      ip: cliente.ip ?? null,
      userAgent: cliente.userAgent ?? null,
    });
    return emitirSessao(trx, { tipo: 'RESPONSAVEL', id: responsavelId }, cliente);
  });
}

// ------------------------------------------------------------ aparelhos (push)

export type NovoDispositivo =
  | { canal: 'WEB'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; plataforma: Plataforma }
  | { canal: 'EXPO'; expoPushToken: string; plataforma: Plataforma };
type Plataforma = 'ANDROID' | 'IOS' | 'DESKTOP' | 'OUTRA';

/** O endpoint pode passar de 700 caracteres: o índice único é sobre o SHA-256 dele. */
const identificador = (d: { endpoint: string } | { expoPushToken: string }) => sha256('endpoint' in d ? d.endpoint : d.expoPushToken);

/**
 * Registra (ou reativa) o destino de push deste aparelho.
 * "Upsert" pelo identificador: se o MESMO aparelho estava com OUTRO
 * responsável (celular compartilhado, troca de conta), ele passa para quem
 * está logado agora. Assim um pai nunca recebe avisos do filho de outra pessoa.
 */
export async function registrarDispositivo(responsavelId: number, d: NovoDispositivo) {
  const dados =
    d.canal === 'WEB'
      ? { canal: 'WEB', web_endpoint: d.subscription.endpoint, web_p256dh: d.subscription.keys.p256dh, web_auth: d.subscription.keys.auth, expo_push_token: null }
      : { canal: 'EXPO', expo_push_token: d.expoPushToken, web_endpoint: null, web_p256dh: null, web_auth: null };
  const hash = identificador(d.canal === 'WEB' ? { endpoint: d.subscription.endpoint } : { expoPushToken: d.expoPushToken });
  const linha = { responsavel_id: responsavelId, identificador_hash: hash, plataforma: d.plataforma, ativo: true, ultimo_uso_em: new Date(), ...dados };
  try {
    await db('dispositivos_push_lanchei')
      .insert(linha)
      .onConflict('identificador_hash')
      .merge(['responsavel_id', 'plataforma', 'ativo', 'ultimo_uso_em', 'web_p256dh', 'web_auth']);
  } catch (e) {
    if (!ehChaveDuplicada(e)) throw e;
  }
  const r = await db('dispositivos_push_lanchei').where({ identificador_hash: hash }).first<{ id: number; canal: string; ativo: boolean }>('id', 'canal', 'ativo');
  return { id: r.id, canal: r.canal, ativo: r.ativo };
}

/** No logout: este aparelho para de receber push. Só desativa se for DESTE responsável. */
export async function desativarDispositivo(responsavelId: number, d: { endpoint: string } | { expoPushToken: string }) {
  await db('dispositivos_push_lanchei').where({ identificador_hash: identificador(d), responsavel_id: responsavelId }).update({ ativo: false });
}

// ------------------------------------------------------------ notificações

const zCursor = z.number().int().positive();

export async function minhasNotificacoes(responsavelId: number, f: { naoLidas: boolean; limite: number; cursor?: string | undefined }) {
  const q = db('notificacoes_lanchei')
    .where({ responsavel_id: responsavelId })
    .orderBy('id', 'desc')
    .limit(f.limite + 1)
    .select<{ id: number; aluno_id: number | null; tipo: string; titulo: string; corpo: string; dados: unknown; lida_em: Date | null; created_at: Date }[]>(
      'id', 'aluno_id', 'tipo', 'titulo', 'corpo', 'dados', 'lida_em', 'created_at',
    );
  if (f.naoLidas) q.whereNull('lida_em');
  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) q.andWhere('id', '<', cursor);
  const { itens, proximoCursor } = paginar(await q, f.limite, (u) => u.id);
  const contagem = await db('notificacoes_lanchei').where({ responsavel_id: responsavelId }).whereNull('lida_em').count<{ n: number }[]>({ n: '*' });
  const n = contagem[0]?.n ?? 0;
  return {
    itens: itens.map((n) => ({ id: n.id, alunoId: n.aluno_id, tipo: n.tipo, titulo: n.titulo, corpo: n.corpo, dados: n.dados, lida: n.lida_em !== null, criadoEm: n.created_at })),
    proximoCursor,
    naoLidas: Number(n),
  };
}

export async function marcarLida(responsavelId: number, notificacaoId: number) {
  const n = await db('notificacoes_lanchei').where({ id: notificacaoId, responsavel_id: responsavelId }).first<{ lida_em: Date | null } | undefined>('lida_em');
  if (!n) throw erros.naoEncontrado('Notificação não encontrada.');
  if (!n.lida_em) await db('notificacoes_lanchei').where({ id: notificacaoId }).update({ lida_em: new Date() });
}

export async function marcarTodasLidas(responsavelId: number) {
  await db('notificacoes_lanchei').where({ responsavel_id: responsavelId }).whereNull('lida_em').update({ lida_em: new Date() });
}
