// O que os pais CONTROLAM: regras (limites, dias, alerta), bloqueios de
// produtos/categorias, PIN da compra sem carteirinha, bloqueio da
// carteirinha e o próprio desvínculo.
//
// Padrão de toda alteração aqui:
//   1. garantirVinculo (sem vínculo = 404);
//   2. trava a linha de regras do aluno (FOR UPDATE): pai e mãe mexendo ao
//      mesmo tempo fazem fila, em vez de um apagar a mudança do outro;
//   3. grava + auditoria com ANTES e DEPOIS;
//   4. avisa os OUTROS responsáveis (quem mudou não precisa de aviso).
// A compra não trava esta linha (só lê), então não há como formar deadlock.
import { db, type Trx } from '../../infra/db.js';
import { hashSenha, verificarSenha } from '../../infra/cripto.js';
import { registrarAuditoria } from '../../dominio/auditoria.js';
import { DIAS, diasParaMascara, mascaraParaDias, type Dia } from '../../dominio/diasPermitidos.js';
import { notificarResponsaveis, primeiroNome } from '../../dominio/notificacoes.js';
import { pinObvio } from '../../dominio/pin.js';
import { termoAtual } from '../../config/urls.js';
import { erros } from '../../erros.js';
import { exigirContaAberta, garantirVinculo, type FilhoVinculado } from './vinculo.js';
import { regrasDoFilho } from './filhos.servico.js';

export interface Origem {
  responsavelId: number;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const auditar = (trx: Trx, o: Origem, f: FilhoVinculado, acao: string, entidade: string, antes?: unknown, depois?: unknown) =>
  registrarAuditoria(trx, {
    escolaId: f.escolaId,
    ator: { tipo: 'RESPONSAVEL', id: o.responsavelId },
    acao,
    entidade,
    entidadeId: f.alunoId,
    alunoId: f.alunoId,
    antes,
    depois,
    ip: o.ip ?? null,
    userAgent: o.userAgent ?? null,
  });

const nomeDoResponsavel = async (trx: Trx, id: number) =>
  primeiroNome((await trx('responsaveis_lanchei').where({ id }).first<{ nome: string }>('nome')).nome);

/** Abre a transação, confere o vínculo e trava a linha de regras do aluno. */
async function comAlunoTravado<T>(o: Origem, alunoId: number, fn: (trx: Trx, f: FilhoVinculado) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    const f = await garantirVinculo(trx, o.responsavelId, alunoId);
    exigirContaAberta(f);
    await trx('regras_aluno_lanchei').where({ aluno_id: alunoId }).forUpdate().first('aluno_id');
    return fn(trx, f);
  });
}

// ------------------------------------------------------------ regras

export interface NovasRegras {
  limiteDiarioCentavos: number | null;
  limiteSemanalCentavos: number | null;
  limiteMensalCentavos: number | null;
  diasPermitidos: Dia[];
  alertaSaldoBaixoCentavos: number | null;
  permiteSemCarteirinha: boolean;
}

const NOMES_CAMPOS: Record<keyof NovasRegras, string> = {
  limiteDiarioCentavos: 'o limite diário',
  limiteSemanalCentavos: 'o limite semanal',
  limiteMensalCentavos: 'o limite mensal',
  diasPermitidos: 'os dias de compra',
  alertaSaldoBaixoCentavos: 'o alerta de saldo baixo',
  permiteSemCarteirinha: 'a compra sem carteirinha',
};

export async function atualizarRegras(o: Origem, alunoId: number, n: NovasRegras) {
  await comAlunoTravado(o, alunoId, async (trx, f) => {
    const atual = await trx('regras_aluno_lanchei as r')
      .join('alunos_lanchei as a', 'a.id', 'r.aluno_id')
      .where('r.aluno_id', alunoId)
      .first<{
        limite_diario_centavos: number | null; limite_semanal_centavos: number | null; limite_mensal_centavos: number | null; dias_permitidos: number;
        alerta_saldo_baixo_centavos: number | null; permite_sem_carteirinha: boolean; pin_hash: string | null;
      }>('r.*', 'a.pin_hash');

    // A compra sem carteirinha depende do PIN: sem PIN, não há como ligar.
    if (n.permiteSemCarteirinha && !atual.pin_hash) {
      throw erros.regra('PIN_NECESSARIO', 'Defina um PIN antes de liberar a compra sem carteirinha.');
    }

    const antes: NovasRegras = {
      limiteDiarioCentavos: atual.limite_diario_centavos,
      limiteSemanalCentavos: atual.limite_semanal_centavos,
      limiteMensalCentavos: atual.limite_mensal_centavos,
      diasPermitidos: mascaraParaDias(atual.dias_permitidos),
      alertaSaldoBaixoCentavos: atual.alerta_saldo_baixo_centavos,
      permiteSemCarteirinha: atual.permite_sem_carteirinha,
    };
    // Compara em formato "canônico" (dias na ordem SEG..DOM, sem repetição).
    const depois: NovasRegras = { ...n, diasPermitidos: mascaraParaDias(diasParaMascara(n.diasPermitidos)) };
    const mudou = (Object.keys(NOMES_CAMPOS) as (keyof NovasRegras)[]).filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(depois[k]));
    if (mudou.length === 0) return;

    await trx('regras_aluno_lanchei').where({ aluno_id: alunoId }).update({
      limite_diario_centavos: n.limiteDiarioCentavos,
      limite_semanal_centavos: n.limiteSemanalCentavos,
      limite_mensal_centavos: n.limiteMensalCentavos,
      dias_permitidos: diasParaMascara(n.diasPermitidos),
      alerta_saldo_baixo_centavos: n.alertaSaldoBaixoCentavos,
      permite_sem_carteirinha: n.permiteSemCarteirinha,
    });
    await auditar(trx, o, f, 'REGRAS_ATUALIZAR', 'regras_aluno', pick(antes, mudou), pick(depois, mudou));

    const quem = await nomeDoResponsavel(trx, o.responsavelId);
    const oQue = mudou.length === 1 ? NOMES_CAMPOS[mudou[0]!] : 'as regras';
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'REGRAS_ALTERADAS',
      titulo: 'Regras alteradas',
      corpo: `${quem} alterou ${oQue} de ${primeiroNome(f.nome)}.`,
      excetoResponsavelId: o.responsavelId,
    });
  });
  return regrasDoFilho(alunoId);
}

function pick<T extends object>(obj: T, chaves: (keyof T)[]) {
  return Object.fromEntries(chaves.map((k) => [k, obj[k]]));
}

// ------------------------------------------------------------ bloqueios

/** Substitui o conjunto inteiro (mais simples para o app: manda o estado final). */
export async function substituirBloqueios(o: Origem, alunoId: number, d: { categoriaIds: number[]; produtoIds: number[] }) {
  const categoriaIds = [...new Set(d.categoriaIds)].sort((a, b) => a - b);
  const produtoIds = [...new Set(d.produtoIds)].sort((a, b) => a - b);

  await comAlunoTravado(o, alunoId, async (trx, f) => {
    // Todos os ids precisam ser DA ESCOLA do aluno. (O banco também barraria,
    // pela FK composta, mas aqui o erro sai claro e nada é gravado.)
    const catsValidas = categoriaIds.length ? await trx('categorias_lanchei').where({ escola_id: f.escolaId }).whereIn('id', categoriaIds).pluck<number[]>('id') : [];
    const prodsValidos = produtoIds.length ? await trx('produtos_lanchei').where({ escola_id: f.escolaId }).whereIn('id', produtoIds).pluck<number[]>('id') : [];
    if (catsValidas.length !== categoriaIds.length || prodsValidos.length !== produtoIds.length) {
      throw erros.naoEncontrado('Categoria ou produto não encontrado.');
    }

    const antes = {
      categoriaIds: (await trx('bloqueios_categoria_lanchei').where({ aluno_id: alunoId }).orderBy('categoria_id').pluck<number[]>('categoria_id')).map(Number),
      produtoIds: (await trx('bloqueios_produto_lanchei').where({ aluno_id: alunoId }).orderBy('produto_id').pluck<number[]>('produto_id')).map(Number),
    };
    const depois = { categoriaIds, produtoIds };
    if (JSON.stringify(antes) === JSON.stringify(depois)) return;

    // Única exceção ao "nada se apaga" (etapa2 §15): bloqueio é configuração.
    // O histórico do que estava bloqueado fica na auditoria (antes/depois).
    await trx('bloqueios_categoria_lanchei').where({ aluno_id: alunoId }).delete();
    await trx('bloqueios_produto_lanchei').where({ aluno_id: alunoId }).delete();
    const base = { escola_id: f.escolaId, aluno_id: alunoId, criado_por_responsavel_id: o.responsavelId };
    if (categoriaIds.length) await trx('bloqueios_categoria_lanchei').insert(categoriaIds.map((categoria_id) => ({ ...base, categoria_id })));
    if (produtoIds.length) await trx('bloqueios_produto_lanchei').insert(produtoIds.map((produto_id) => ({ ...base, produto_id })));

    await auditar(trx, o, f, 'BLOQUEIOS_ATUALIZAR', 'bloqueios', antes, depois);
    const quem = await nomeDoResponsavel(trx, o.responsavelId);
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'REGRAS_ALTERADAS',
      titulo: 'Bloqueios alterados',
      corpo: `${quem} alterou os produtos bloqueados de ${primeiroNome(f.nome)}.`,
      excetoResponsavelId: o.responsavelId,
    });
  });
  return { categoriaIds, produtoIds };
}

// ------------------------------------------------------------ PIN

/** Confere a senha do RESPONSÁVEL (confirmação de ação sensível). */
async function exigirSenha(trx: Trx, responsavelId: number, senha: string) {
  const r = await trx('responsaveis_lanchei').where({ id: responsavelId }).first<{ senha_hash: string }>('senha_hash');
  if (!(await verificarSenha(r.senha_hash, senha))) {
    // 422 e não 401: o app não deve entender isto como "sessão expirou".
    throw erros.regra('SENHA_INCORRETA', 'Senha incorreta.');
  }
}

export async function definirPin(o: Origem, alunoId: number, pin: string, senha: string) {
  if (pinObvio(pin)) throw erros.regra('PIN_FRACO', 'Esse PIN é fácil de adivinhar. Evite números repetidos ou em sequência.');
  // argon2 ANTES de abrir a transação (é lento de propósito e não precisa de lock).
  const pinHash = await hashSenha(pin);
  await comAlunoTravado(o, alunoId, async (trx, f) => {
    await exigirSenha(trx, o.responsavelId, senha);
    const tinha = await trx('alunos_lanchei').where({ id: alunoId }).first<{ pin_hash: string | null }>('pin_hash');
    // Zera tentativas e o bloqueio: PIN novo começa do zero.
    await trx('alunos_lanchei').where({ id: alunoId }).update({ pin_hash: pinHash, pin_falhas: 0, pin_bloqueado_ate: null });
    // O PIN nunca vai para a auditoria (nem o hash): só o fato de ter mudado.
    await auditar(trx, o, f, 'PIN_DEFINIR', 'alunos', { tinhaPin: tinha.pin_hash !== null }, { temPin: true });
    const quem = await nomeDoResponsavel(trx, o.responsavelId);
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'CARTEIRINHA',
      titulo: 'PIN alterado',
      corpo: `${quem} definiu um novo PIN para ${primeiroNome(f.nome)}.`,
      excetoResponsavelId: o.responsavelId,
    });
  });
}

/** Remove o PIN e, junto, desliga a compra sem carteirinha. */
export async function removerPin(o: Origem, alunoId: number, senha: string) {
  await comAlunoTravado(o, alunoId, async (trx, f) => {
    await exigirSenha(trx, o.responsavelId, senha);
    await trx('alunos_lanchei').where({ id: alunoId }).update({ pin_hash: null, pin_falhas: 0, pin_bloqueado_ate: null });
    await trx('regras_aluno_lanchei').where({ aluno_id: alunoId }).update({ permite_sem_carteirinha: false });
    await auditar(trx, o, f, 'PIN_REMOVER', 'alunos', undefined, { temPin: false, permiteSemCarteirinha: false });
    const quem = await nomeDoResponsavel(trx, o.responsavelId);
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'CARTEIRINHA',
      titulo: 'PIN removido',
      corpo: `${quem} removeu o PIN de ${primeiroNome(f.nome)}. A compra sem carteirinha foi desligada.`,
      excetoResponsavelId: o.responsavelId,
    });
  });
}

// ------------------------------------------------------------ carteirinha

export async function alterarBloqueioCarteirinha(o: Origem, alunoId: number, bloquear: boolean, motivo?: 'PERDIDA' | 'OUTRO') {
  return comAlunoTravado(o, alunoId, async (trx, f) => {
    const cart = await trx('carteirinhas_lanchei').where({ aluno_vivo: alunoId }).forUpdate().first<{ id: number; status: string } | undefined>('id', 'status');
    if (!cart) throw erros.naoEncontrado('Este aluno ainda não tem carteirinha.');
    const novo = bloquear ? 'BLOQUEADA' : 'ATIVA';
    if (cart.status === novo) return { status: novo }; // repetir não dá erro

    // Efeito imediato: a próxima leitura no caixa já vê o novo status.
    await trx('carteirinhas_lanchei').where({ id: cart.id }).update({ status: novo });
    await auditar(trx, o, f, bloquear ? 'CARTEIRINHA_BLOQUEAR' : 'CARTEIRINHA_DESBLOQUEAR', 'carteirinhas', { status: cart.status }, { status: novo, motivo: motivo ?? null });
    const quem = await nomeDoResponsavel(trx, o.responsavelId);
    await notificarResponsaveis(trx, {
      alunoId,
      tipo: 'CARTEIRINHA',
      titulo: bloquear ? 'Carteirinha bloqueada' : 'Carteirinha desbloqueada',
      corpo: `${quem} ${bloquear ? 'bloqueou' : 'desbloqueou'} a carteirinha de ${primeiroNome(f.nome)}.`,
      excetoResponsavelId: o.responsavelId,
    });
    return { status: novo };
  });
}

// ------------------------------------------------------------ desvínculo

/**
 * O responsável sai do vínculo. Para a LGPD, isto é REVOGAR o consentimento:
 * grava um registro REVOGACAO (a tabela de consentimentos é imutável).
 * Vale também para aluno encerrado (é o jeito de "sair" de vez).
 */
export async function desvincular(o: Origem, alunoId: number) {
  await db.transaction(async (trx) => {
    const f = await garantirVinculo(trx, o.responsavelId, alunoId);
    await trx('aluno_responsaveis_lanchei').where({ aluno_id: alunoId, responsavel_id: o.responsavelId }).update({ desvinculado_em: new Date() });
    await trx('consentimentos_lanchei').insert({
      responsavel_id: o.responsavelId,
      aluno_id: alunoId,
      evento: 'REVOGACAO',
      versao_termo: termoAtual().versao,
      ip: o.ip ?? null,
      user_agent: o.userAgent?.slice(0, 255) ?? null,
    });
    await auditar(trx, o, f, 'VINCULO_REVOGAR', 'aluno_responsaveis');
  });
}

export { DIAS };
