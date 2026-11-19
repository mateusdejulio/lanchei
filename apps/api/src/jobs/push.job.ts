// Job de push (a cada 15 s): envia as notificações que a transação do
// negócio deixou na "caixa de saída" (outbox) notificacoes_lanchei.
//
// Por que outbox + job, e não enviar direto na compra? Porque o push é uma
// chamada de rede lenta e que pode falhar. A compra grava a notificação na
// MESMA transação (se a compra desfizer, a notificação some junto) e
// responde na hora; o envio acontece aqui, depois do COMMIT.
//
// Garantia escolhida: "no máximo uma vez". O lote é marcado como enviado
// ANTES de chamar o serviço de push; se o processo cair no meio, alguns
// avisos se perdem, mas nenhum pai recebe a mesma compra duas vezes. A
// notificação continua na caixa de entrada do app de qualquer jeito.
import { db } from '../infra/db.js';
import type { ConteudoPush, EnviadorPush } from '../infra/push.js';

export const LOTE_PUSH = 100;
/** Aviso com mais de 24 h sem sair (ex.: push desligado, API fora) não é mais enviado. */
const HORAS_VALIDADE = 24;

/** Para qual tela o toque na notificação leva (o service worker do app usa esta URL). */
export function urlDaNotificacao(alunoId: number | null, dados: Record<string, unknown> | null): string {
  if (alunoId !== null && typeof dados?.pedidoId === 'number') return `/app/filhos/${alunoId}/compras/${dados.pedidoId}`;
  if (alunoId !== null && typeof dados?.depositoId === 'number') return `/app/filhos/${alunoId}/extrato`;
  if (alunoId !== null) return `/app/filhos/${alunoId}`;
  return '/app/notificacoes';
}

export async function enviarPushPendentes(enviador: EnviadorPush, agora = new Date()) {
  await db('notificacoes_lanchei')
    .whereNull('push_enviado_em')
    .where('created_at', '<', new Date(agora.getTime() - HORAS_VALIDADE * 3_600_000))
    .update({ push_enviado_em: agora, push_erro: 'EXPIRADA' });

  const lote = await db('notificacoes_lanchei')
    .whereNull('push_enviado_em')
    .orderBy('id')
    .limit(LOTE_PUSH)
    .select<{ id: number; responsavel_id: number; aluno_id: number | null; titulo: string; corpo: string; dados: Record<string, unknown> | null }[]>(
      'id', 'responsavel_id', 'aluno_id', 'titulo', 'corpo', 'dados',
    );
  const stats = { notificacoes: lote.length, enviadas: 0, semAparelho: 0, falhas: 0, aparelhosDesativados: 0 };
  if (lote.length === 0) return stats;

  // "Reserva" o lote (no máximo uma vez: ver o topo).
  await db('notificacoes_lanchei').whereIn('id', lote.map((n) => n.id)).whereNull('push_enviado_em').update({ push_enviado_em: agora });

  const aparelhos = await db('dispositivos_push_lanchei')
    .whereIn('responsavel_id', [...new Set(lote.map((n) => n.responsavel_id))])
    .where({ canal: 'WEB', ativo: true }) // canal EXPO: fase 2 (app de loja)
    .select<{ id: number; responsavel_id: number; web_endpoint: string; web_p256dh: string; web_auth: string }[]>(
      'id', 'responsavel_id', 'web_endpoint', 'web_p256dh', 'web_auth',
    );
  const porResponsavel = new Map<number, typeof aparelhos>();
  for (const a of aparelhos) porResponsavel.set(a.responsavel_id, [...(porResponsavel.get(a.responsavel_id) ?? []), a]);
  const desativados = new Set<number>();

  for (const n of lote) {
    const destinos = (porResponsavel.get(n.responsavel_id) ?? []).filter((a) => !desativados.has(a.id));
    if (destinos.length === 0) {
      stats.semAparelho++;
      await db('notificacoes_lanchei').where({ id: n.id }).update({ push_erro: 'SEM_APARELHO' });
      continue;
    }
    const conteudo: ConteudoPush = { titulo: n.titulo, corpo: n.corpo, url: urlDaNotificacao(n.aluno_id, n.dados), notificacaoId: n.id };
    // Um responsável pode ter vários aparelhos (celular e tablet): envia para todos.
    const resultados = await Promise.all(
      destinos.map(async (a) => ({ a, r: await enviador.enviar({ endpoint: a.web_endpoint, p256dh: a.web_p256dh, auth: a.web_auth }, conteudo) })),
    );
    for (const { a, r } of resultados) {
      if (r.tipo === 'EXPIRADO' && !desativados.has(a.id)) {
        desativados.add(a.id);
        await db('dispositivos_push_lanchei').where({ id: a.id }).update({ ativo: false });
      }
    }
    if (resultados.some(({ r }) => r.tipo === 'OK')) {
      stats.enviadas++;
    } else {
      stats.falhas++;
      const erro = resultados.map(({ r }) => (r.tipo === 'ERRO' ? r.detalhe : r.tipo)).join(', ');
      await db('notificacoes_lanchei').where({ id: n.id }).update({ push_erro: erro.slice(0, 255) });
    }
  }
  stats.aparelhosDesativados = desativados.size;
  return stats;
}
