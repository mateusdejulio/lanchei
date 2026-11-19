// Direitos do titular (LGPD), pelo app dos pais.
//
//  - GET /me/dados: exporta TUDO que existe sobre o responsável e os filhos
//    vinculados (direito de acesso, art. 18). Um JSON que a pessoa baixa.
//  - POST /me/solicitacoes-lgpd: pedido de correção/exclusão/outro. Quem
//    decide é a ESCOLA (ela é a controladora dos dados; a plataforma é
//    operadora), então o pedido vai por e-mail para os usuários ESCOLA.
import { db } from '../../infra/db.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { mascaraParaDias } from '../../dominio/diasPermitidos.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { erros } from '../../erros.js';
import { itensDosPedidos } from '../admin/extrato.servico.js';
import type { Origem } from './controle.servico.js';

export async function exportarMeusDados(o: Origem) {
  const r = await db('responsaveis_lanchei')
    .where({ id: o.responsavelId })
    .first('id', 'nome', 'email', 'telefone', 'cpf', 'email_verificado_em', 'created_at');
  const vinculos = await db('aluno_responsaveis_lanchei').where({ responsavel_id: o.responsavelId }).select('aluno_id', 'vinculado_em', 'desvinculado_em');
  const consentimentos = await db('consentimentos_lanchei').where({ responsavel_id: o.responsavelId }).orderBy('id').select('aluno_id', 'evento', 'versao_termo', 'ip', 'created_at');
  // Aparelhos: sem as chaves de criptografia do push (não ajudam a pessoa e são sensíveis).
  const dispositivos = await db('dispositivos_push_lanchei').where({ responsavel_id: o.responsavelId }).select('canal', 'plataforma', 'ativo', 'created_at', 'ultimo_uso_em');
  const depositos = await db('depositos_lanchei').where({ responsavel_id: o.responsavelId }).orderBy('id').select('id', 'conta_id', 'valor_centavos', 'status', 'created_at', 'aprovado_em');
  const notificacoes = await db('notificacoes_lanchei').where({ responsavel_id: o.responsavelId }).orderBy('id').select('aluno_id', 'tipo', 'titulo', 'corpo', 'created_at', 'lida_em');

  // Filhos com vínculo ATIVO: dados, regras, bloqueios, extrato e compras.
  const ativos = vinculos.filter((v) => v.desvinculado_em === null).map((v) => v.aluno_id as number);
  const filhos = [];
  for (const alunoId of ativos) {
    const a = await db('alunos_lanchei as a')
      .join('escolas_lanchei as e', 'e.id', 'a.escola_id')
      .leftJoin('turmas_lanchei as t', 't.id', 'a.turma_id')
      .join('contas_lanchei as c', 'c.aluno_id', 'a.id')
      .where('a.id', alunoId)
      .first('a.id', 'a.nome', 'a.matricula', 'a.status', 'e.nome as escola', 't.nome as turma', 'c.id as conta_id', 'c.saldo_centavos');
    const regras = await db('regras_aluno_lanchei').where({ aluno_id: alunoId }).first();
    const extrato = await db('transacoes_lanchei').where({ conta_id: a.conta_id }).orderBy('id').select('tipo', 'valor_centavos', 'saldo_apos_centavos', 'descricao', 'created_at');
    const pedidos = await db('pedidos_lanchei').where({ aluno_id: alunoId }).orderBy('id').select('id', 'status', 'motivo_recusa', 'modo_identificacao', 'total_centavos', 'created_at');
    const itens = await itensDosPedidos(pedidos.map((p) => p.id as number));
    filhos.push({
      aluno: { id: a.id, nome: a.nome, matricula: a.matricula, status: a.status, escola: a.escola, turma: a.turma, saldoCentavos: a.saldo_centavos },
      regras: { ...regras, dias_permitidos: mascaraParaDias(regras.dias_permitidos) },
      bloqueios: {
        categorias: await db('bloqueios_categoria_lanchei as b').join('categorias_lanchei as c', 'c.id', 'b.categoria_id').where('b.aluno_id', alunoId).pluck('c.nome'),
        produtos: await db('bloqueios_produto_lanchei as b').join('produtos_lanchei as p', 'p.id', 'b.produto_id').where('b.aluno_id', alunoId).pluck('p.nome'),
      },
      extrato,
      compras: pedidos.map((p) => ({ ...p, itens: itens.get(p.id as number) ?? [] })),
    });
  }

  await registrarAuditoria(db, {
    escolaId: null,
    ator: { tipo: 'RESPONSAVEL', id: o.responsavelId },
    acao: 'DADOS_EXPORTAR',
    entidade: 'responsaveis',
    entidadeId: o.responsavelId,
    ip: o.ip ?? null,
    userAgent: o.userAgent ?? null,
  });

  return {
    geradoEm: new Date().toISOString(),
    observacao: 'Dados guardados pelo Lanchei sobre você e os alunos que você acompanha. Valores em centavos de real.',
    responsavel: r,
    vinculos,
    consentimentos,
    dispositivosDePush: dispositivos,
    depositos,
    notificacoes,
    filhos,
  };
}

export type TipoSolicitacao = 'CORRECAO' | 'EXCLUSAO' | 'OUTRO';

export async function solicitarLgpd(o: Origem, tipo: TipoSolicitacao, mensagem: string) {
  const r = await db('responsaveis_lanchei').where({ id: o.responsavelId }).first<{ nome: string; email: string }>('nome', 'email');
  // Escolas dos filhos vinculados (ativos): cada uma recebe o pedido.
  const escolas = await db('aluno_responsaveis_lanchei as ar')
    .join('alunos_lanchei as a', 'a.id', 'ar.aluno_id')
    .join('escolas_lanchei as e', 'e.id', 'a.escola_id')
    .where('ar.responsavel_id', o.responsavelId)
    .whereNull('ar.desvinculado_em')
    .distinct<{ id: number; nome: string }[]>('e.id', 'e.nome');
  if (escolas.length === 0) {
    throw erros.regra('SEM_ESCOLA', 'Você não acompanha nenhum aluno. Para pedidos sobre a sua conta, use o contato dos termos de uso.');
  }

  let avisados = 0;
  for (const e of escolas) {
    await registrarAuditoria(db, {
      escolaId: e.id,
      ator: { tipo: 'RESPONSAVEL', id: o.responsavelId },
      acao: 'SOLICITACAO_LGPD',
      entidade: 'responsaveis',
      entidadeId: o.responsavelId,
      depois: { tipo, mensagem },
      ip: o.ip ?? null,
      userAgent: o.userAgent ?? null,
    });
    const destinos = await db('usuarios_lanchei').where({ escola_id: e.id, papel: 'ESCOLA', ativo: true }).pluck<string[]>('email');
    for (const para of destinos) {
      enviarEmailEmSegundoPlano({ para, ...modelos.solicitacaoLgpd({ escola: e.nome, nome: r.nome, email: r.email, tipo, mensagem }) }, 'solicitacao-lgpd');
      avisados++;
    }
  }
  return { escolas: escolas.length, destinatarios: avisados };
}
