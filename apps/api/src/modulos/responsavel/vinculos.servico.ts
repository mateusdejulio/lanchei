// POST /me/vinculos: o responsável usa o código de ativação que a escola
// mandou por e-mail e passa a acompanhar o aluno.
//
// Regras (etapa3 §2.7 e etapa4 §4.7):
//   - o e-mail do responsável precisa estar VERIFICADO e ser IGUAL ao do
//     convite. Isso impede que alguém que interceptou o código (um print
//     encaminhado, por exemplo) se vincule com outra conta;
//   - código certo com outro e-mail conta como tentativa NO CONVITE; com 5,
//     o convite é invalidado e a escola precisa reenviar;
//   - aceitar o termo (versão vigente) é obrigatório: grava o consentimento
//     LGPD (data, versão, IP, navegador), num registro imutável;
//   - 5 erros por hora por responsável → 429 (limite na rota).
//
// Armadilha: o contador de tentativas precisa ser GRAVADO mesmo quando a
// resposta é erro. Se o "throw" acontecesse dentro da transação, o ROLLBACK
// desfaria o contador, e um atacante poderia tentar para sempre. Por isso a
// transação devolve um resultado e o erro é lançado só depois do COMMIT
// (o mesmo truque do refresh token em auth/tokens.ts).
import { db } from '../../infra/db.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { hashCodigo, normalizarCodigo, TAMANHO_CODIGO } from '../../dominio/codigoAtivacao.js';
import { termoAtual } from '../../config/urls.js';
import { erros } from '../../erros.js';
import { listarFilhos } from './filhos.servico.js';
import type { Origem } from './controle.servico.js';

export const MAX_TENTATIVAS_CONVITE = 5;

const codigoInvalido = () =>
  // A MESMA mensagem para todos os casos (não existe, vencido, usado, outro e-mail):
  // não damos pistas a quem está tentando adivinhar.
  erros.regra('CODIGO_INVALIDO', 'Código inválido ou vencido. Confira o e-mail da escola ou peça um novo código.');

export async function vincularPorCodigo(o: Origem, codigoDigitado: string, versaoTermo: string, agora = new Date()) {
  const responsavel = await db('responsaveis_lanchei')
    .where({ id: o.responsavelId })
    .first<{ email: string; email_verificado_em: Date | null }>('email', 'email_verificado_em');
  if (!responsavel.email_verificado_em) {
    throw erros.regra('EMAIL_NAO_VERIFICADO', 'Confirme o seu e-mail antes de vincular um aluno (veja a mensagem que enviamos).');
  }
  if (versaoTermo !== termoAtual().versao) {
    throw erros.regra('TERMO_DESATUALIZADO', 'O termo de uso foi atualizado. Leia a versão atual e aceite de novo.', { versaoAtual: termoAtual().versao });
  }
  const codigo = normalizarCodigo(codigoDigitado);
  if (codigo.length !== TAMANHO_CODIGO) throw codigoInvalido();

  const r = await db.transaction(async (trx) => {
    // Trava o convite: duas tentativas simultâneas com o mesmo código fazem fila.
    const c = await trx('convites_responsavel_lanchei')
      .where({ codigo_hash: hashCodigo(codigo) })
      .forUpdate()
      .first<
        | { id: number; escola_id: number; aluno_id: number; email: string; expira_em: Date; usado_em: Date | null; revogado_em: Date | null; tentativas_falhas: number }
        | undefined
      >('id', 'escola_id', 'aluno_id', 'email', 'expira_em', 'usado_em', 'revogado_em', 'tentativas_falhas');
    if (!c || c.usado_em || c.revogado_em || c.expira_em <= agora) return { erro: 'INVALIDO' as const };

    if (c.email !== responsavel.email) {
      // Código certo, conta errada: conta tentativa no próprio convite.
      const falhas = c.tentativas_falhas + 1;
      await trx('convites_responsavel_lanchei')
        .where({ id: c.id })
        .update({ tentativas_falhas: falhas, ...(falhas >= MAX_TENTATIVAS_CONVITE ? { revogado_em: agora } : {}) });
      await registrarAuditoria(trx, {
        escolaId: c.escola_id,
        ator: { tipo: 'RESPONSAVEL', id: o.responsavelId },
        acao: 'CONVITE_EMAIL_DIFERENTE',
        entidade: 'convites_responsavel',
        entidadeId: c.id,
        alunoId: c.aluno_id,
        depois: { tentativas: falhas, invalidado: falhas >= MAX_TENTATIVAS_CONVITE },
        ip: o.ip ?? null,
        userAgent: o.userAgent ?? null,
      });
      return { erro: 'INVALIDO' as const }; // erro lançado DEPOIS do commit (ver o topo)
    }

    const aluno = await trx('alunos_lanchei').where({ id: c.aluno_id }).first<{ status: string }>('status');
    if (aluno.status === 'ENCERRADO') return { erro: 'INVALIDO' as const };

    const vinculo = await trx('aluno_responsaveis_lanchei')
      .where({ aluno_id: c.aluno_id, responsavel_id: o.responsavelId })
      .forUpdate()
      .first<{ desvinculado_em: Date | null } | undefined>('desvinculado_em');
    if (vinculo && vinculo.desvinculado_em === null) return { erro: 'JA_VINCULADO' as const };

    await trx('convites_responsavel_lanchei').where({ id: c.id }).update({ usado_em: agora, usado_por_responsavel_id: o.responsavelId });
    if (vinculo) {
      // Já foi vinculado antes e saiu (ou foi desvinculado): reativa com o convite novo.
      await trx('aluno_responsaveis_lanchei')
        .where({ aluno_id: c.aluno_id, responsavel_id: o.responsavelId })
        .update({ desvinculado_em: null, vinculado_em: agora, convite_id: c.id });
    } else {
      await trx('aluno_responsaveis_lanchei').insert({ aluno_id: c.aluno_id, responsavel_id: o.responsavelId, convite_id: c.id, vinculado_em: agora });
    }
    // Consentimento LGPD (art. 14: dados de menores, consentimento do responsável).
    await trx('consentimentos_lanchei').insert({
      responsavel_id: o.responsavelId,
      aluno_id: c.aluno_id,
      evento: 'ACEITE',
      versao_termo: versaoTermo,
      ip: o.ip ?? null,
      user_agent: o.userAgent?.slice(0, 255) ?? null,
    });
    await registrarAuditoria(trx, {
      escolaId: c.escola_id,
      ator: { tipo: 'RESPONSAVEL', id: o.responsavelId },
      acao: 'VINCULO_CRIAR',
      entidade: 'aluno_responsaveis',
      entidadeId: o.responsavelId,
      alunoId: c.aluno_id,
      depois: { conviteId: c.id, versaoTermo },
      ip: o.ip ?? null,
      userAgent: o.userAgent ?? null,
    });
    return { alunoId: c.aluno_id };
  });

  if ('erro' in r) {
    if (r.erro === 'JA_VINCULADO') throw erros.conflito('JA_VINCULADO', 'Você já acompanha este aluno.');
    throw codigoInvalido();
  }
  const filho = (await listarFilhos(o.responsavelId)).find((f) => f.id === r.alunoId)!;
  return { filho };
}
