// Consulta da trilha de auditoria (GET /admin/auditoria).
//
// Cada perfil vê a parte que é dele (matriz da etapa6 §2):
//   ADMIN (Cantina):    vendas, estoque, saldo, pagamentos
//   ESCOLA (Diretoria): alunos, carteirinhas, vínculos, regras dos responsáveis
// Algumas ações são comuns aos dois (histórico consultado, foto vista, equipe).
import { z } from 'zod';
import { db } from '../../infra/db.js';
import { intervaloDeDatas } from '../../dominio/periodos.js';
import { decodificarCursor, paginar } from '../../paginacao.js';
import { fusoDaEscola, type PapelPainel } from './acesso.js';

/** Ações que só a Cantina vê. */
export const ACOES_CANTINA = [
  'PEDIDO_ESTORNAR', 'VENDA_MANUAL', 'AJUSTE_SALDO', 'SALDOS_EXPORTAR',
  'PRODUTO_CRIAR', 'PRODUTO_EDITAR', 'CATEGORIA_CRIAR', 'CATEGORIA_EDITAR',
  'MP_CONECTAR', 'DEPOSITO_DEVOLVIDO', 'DEPOSITO_VALOR_DIVERGENTE',
];
/** Ações que os dois perfis veem. */
export const ACOES_COMUNS = [
  'HISTORICO_VISUALIZAR', 'HISTORICO_EXPORTAR', 'FOTO_VISUALIZAR',
  'ALUNO_ENCERRAR', 'ENCERRAMENTO_SOLICITAR', 'ESCOLA_EDITAR', 'USUARIO_CRIAR', 'USUARIO_EDITAR', 'SENHA_REDEFINIR',
];
// Todo o resto (alunos, turmas, carteirinhas, convites, vínculos, regras,
// bloqueios, PIN...) é da Diretoria. Assim, uma ação nova que alguém esqueça
// de classificar cai no perfil que cuida dos dados dos alunos, nunca na Cantina.

export interface FiltrosAuditoria {
  alunoId?: number | undefined;
  acao?: string | undefined;
  de?: string | undefined;
  ate?: string | undefined;
  limite: number;
  cursor?: string | undefined;
}

const zCursor = z.number().int().positive();

export async function listarAuditoria(escolaId: number, papel: PapelPainel, f: FiltrosAuditoria) {
  const { inicio, fim } = intervaloDeDatas(f.de, f.ate, await fusoDaEscola(db, escolaId));
  const q = db('auditoria_lanchei as au')
    .leftJoin('usuarios_lanchei as u', 'u.id', 'au.ator_usuario_id')
    .leftJoin('responsaveis_lanchei as r', 'r.id', 'au.ator_responsavel_id')
    .where('au.escola_id', escolaId)
    .select(
      'au.id', 'au.acao', 'au.entidade', 'au.entidade_id', 'au.aluno_id', 'au.ator_tipo', 'au.antes', 'au.depois', 'au.created_at',
      'u.id as usuario_id', 'u.nome as usuario_nome', 'r.id as responsavel_id', 'r.nome as responsavel_nome',
    )
    .orderBy('au.id', 'desc')
    .limit(f.limite + 1);

  if (papel === 'ADMIN') q.whereIn('au.acao', [...ACOES_CANTINA, ...ACOES_COMUNS]);
  else q.whereNotIn('au.acao', ACOES_CANTINA);

  if (f.alunoId) q.andWhere('au.aluno_id', f.alunoId);
  if (f.acao) q.andWhere('au.acao', f.acao);
  if (inicio) q.andWhere('au.created_at', '>=', inicio);
  if (fim) q.andWhere('au.created_at', '<', fim);
  const cursor = decodificarCursor(f.cursor, zCursor);
  if (cursor) q.andWhere('au.id', '<', cursor);

  type Linha = {
    id: number; acao: string; entidade: string; entidade_id: number | null; aluno_id: number | null; ator_tipo: 'USUARIO' | 'RESPONSAVEL' | 'SISTEMA';
    antes: unknown; depois: unknown; created_at: Date; usuario_id: number | null; usuario_nome: string | null; responsavel_id: number | null; responsavel_nome: string | null;
  };
  const { itens, proximoCursor } = paginar((await q) as Linha[], f.limite, (u) => u.id);
  return {
    itens: itens.map((l) => ({
      id: l.id,
      acao: l.acao,
      entidade: l.entidade,
      entidadeId: l.entidade_id,
      alunoId: l.aluno_id,
      ator:
        l.ator_tipo === 'USUARIO'
          ? { tipo: 'USUARIO' as const, id: l.usuario_id, nome: l.usuario_nome }
          : l.ator_tipo === 'RESPONSAVEL'
            ? // A Cantina não vê quem são os responsáveis (menor privilégio); a Diretoria vê.
              { tipo: 'RESPONSAVEL' as const, id: papel === 'ESCOLA' ? l.responsavel_id : null, nome: papel === 'ESCOLA' ? l.responsavel_nome : null }
            : { tipo: 'SISTEMA' as const, id: null, nome: null },
      antes: l.antes,
      depois: l.depois,
      criadoEm: l.created_at,
      // IP e user-agent ficam no banco para investigação, mas não são expostos no painel.
    })),
    proximoCursor,
  };
}
