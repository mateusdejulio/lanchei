// Foto do aluno no banco (fotos_alunos_lanchei). Toda VISUALIZAÇÃO gera
// auditoria FOTO_VISUALIZAR (admin, caixa e responsável): é dado de menor.
import { db } from '../../infra/db.js';
import { processarFoto } from '../../infra/fotos.js';
import { auditarUsuario, registrarAuditoria, type Ator, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';
import { alunoDaEscola, exigirNaoEncerrado } from './acesso.js';

export async function salvarFoto(escolaId: number, alunoId: number, arquivo: Buffer, ator: AtorUsuario) {
  // Processa ANTES da transação (sharp leva alguns milissegundos e não precisa de lock).
  const foto = await processarFoto(arquivo);
  await db.transaction(async (trx) => {
    const aluno = await alunoDaEscola(trx, escolaId, alunoId, true);
    exigirNaoEncerrado(aluno);
    await trx('fotos_alunos_lanchei')
      .insert({
        aluno_id: alunoId,
        escola_id: escolaId,
        conteudo: foto.conteudo,
        mime_type: 'image/jpeg',
        tamanho_bytes: foto.conteudo.length,
        sha256: foto.sha256,
      })
      // "upsert": se já existe foto, troca (sem DELETE, que a API não tem).
      .onConflict('aluno_id')
      .merge(['conteudo', 'mime_type', 'tamanho_bytes', 'sha256']);
    await auditarUsuario(trx, ator, {
      escolaId,
      acao: 'FOTO_ALTERAR',
      entidade: 'fotos_alunos',
      entidadeId: alunoId,
      alunoId,
      depois: { tamanhoBytes: foto.conteudo.length },
    });
  });
}

/**
 * Busca a foto de um aluno DA ESCOLA e audita o acesso.
 * Reaproveitada pelo caixa e pelo app dos pais (com o ator certo).
 */
export async function lerFotoAuditada(
  escolaId: number,
  alunoId: number,
  ator: Ator,
  origem: { ip?: string | undefined; userAgent?: string | undefined } = {},
) {
  const foto = await db('fotos_alunos_lanchei')
    .where({ aluno_id: alunoId, escola_id: escolaId })
    .first<{ conteudo: Buffer; mime_type: string; sha256: Buffer } | undefined>('conteudo', 'mime_type', 'sha256');
  if (!foto) throw erros.naoEncontrado('Este aluno não tem foto.');
  await registrarAuditoria(db, {
    escolaId,
    ator,
    acao: 'FOTO_VISUALIZAR',
    entidade: 'fotos_alunos',
    entidadeId: alunoId,
    alunoId,
    ip: origem.ip ?? null,
    userAgent: origem.userAgent ?? null,
  });
  return foto;
}
