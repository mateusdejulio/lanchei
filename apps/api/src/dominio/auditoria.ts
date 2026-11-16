// Trilha de auditoria (tabela imutável).
import type { Db } from '../infra/db.js';

export type Ator =
  | { tipo: 'USUARIO'; id: number }
  | { tipo: 'RESPONSAVEL'; id: number }
  | { tipo: 'SISTEMA' };

export interface RegistroAuditoria {
  escolaId: number | null;
  ator: Ator;
  acao: string; // ex.: "PEDIDO_ESTORNAR", "REGRAS_ATUALIZAR", "FOTO_VISUALIZAR"
  entidade: string; // ex.: "pedidos"
  entidadeId?: number | null;
  alunoId?: number | null;
  antes?: unknown;
  depois?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function registrarAuditoria(db: Db, r: RegistroAuditoria): Promise<void> {
  await db('auditoria_lanchei').insert({
    escola_id: r.escolaId,
    ator_tipo: r.ator.tipo,
    ator_usuario_id: r.ator.tipo === 'USUARIO' ? r.ator.id : null,
    ator_responsavel_id: r.ator.tipo === 'RESPONSAVEL' ? r.ator.id : null,
    acao: r.acao,
    entidade: r.entidade,
    entidade_id: r.entidadeId ?? null,
    aluno_id: r.alunoId ?? null,
    antes: r.antes === undefined ? null : JSON.stringify(r.antes),
    depois: r.depois === undefined ? null : JSON.stringify(r.depois),
    ip: r.ip ?? null,
    user_agent: r.userAgent?.slice(0, 255) ?? null,
  });
}
