// Cadastro do responsável e verificação de e-mail.
//
// Proteção contra ENUMERAÇÃO DE E-MAILS: o cadastro responde sempre a mesma
// coisa ("enviamos um e-mail"), exista ou não conta com aquele endereço. Se
// a resposta fosse "e-mail já cadastrado", qualquer pessoa descobriria quais
// pais usam o Lanchei (e, com isso, em que escola estão os filhos).
// Quem já tem conta recebe um e-mail avisando; só o dono do e-mail fica sabendo.
import { db, ehChaveDuplicada } from '../../infra/db.js';
import { hashSenha } from '../../infra/cripto.js';
import { enviarEmailEmSegundoPlano } from '../../infra/email.js';
import { modelos } from '../../infra/emailModelos.js';
import { link, urlAppPais } from '../../config/urls.js';
import { erros } from '../../erros.js';
import { consumirTokenEmail, criarTokenEmail, VALIDADE } from './tokensEmail.js';

export const MENSAGEM_CADASTRO = 'Enviamos um e-mail para confirmar o seu endereço. Abra o link para continuar.';

interface DadosCadastro {
  nome: string;
  email: string; // já normalizado (zEmail)
  senha: string;
  telefone?: string | undefined;
}

export async function cadastrarResponsavel(d: DadosCadastro): Promise<void> {
  // O hash é calculado SEMPRE, mesmo que o e-mail já exista: o argon2 é a
  // parte lenta, e assim os dois caminhos levam praticamente o mesmo tempo
  // (medir o tempo da resposta não revela se a conta existe).
  const senhaHash = await hashSenha(d.senha);

  const existente = await db('responsaveis_lanchei')
    .where({ email: d.email })
    .first<{ id: number; nome: string; ativo: boolean; email_verificado_em: Date | null } | undefined>(
      'id', 'nome', 'ativo', 'email_verificado_em',
    );

  if (existente) {
    await avisarContaExistente(existente);
    return;
  }

  let token: string;
  try {
    token = await db.transaction(async (trx) => {
      const [id] = await trx('responsaveis_lanchei').insert({
        nome: d.nome,
        email: d.email,
        senha_hash: senhaHash,
        telefone: d.telefone ?? null,
      });
      return criarTokenEmail(trx, { tipo: 'RESPONSAVEL', id: id! }, 'VERIFICAR_EMAIL', VALIDADE.VERIFICAR_EMAIL);
    });
  } catch (e) {
    // Dois cadastros com o mesmo e-mail ao mesmo tempo: o UNIQUE do banco
    // barra o segundo. A outra requisição já está cuidando do e-mail.
    if (ehChaveDuplicada(e)) return;
    throw e;
  }

  enviarEmailEmSegundoPlano(
    { para: d.email, ...modelos.verificarEmail({ nome: d.nome, link: link(urlAppPais, '/verificar-email', { token }) }) },
    'verificar-email',
  );
}

async function avisarContaExistente(r: { id: number; nome: string; ativo: boolean; email_verificado_em: Date | null }) {
  if (!r.ativo) return; // conta desativada: não manda nada
  const email = await emailDoResponsavel(r.id);

  if (r.email_verificado_em === null) {
    // Cadastrou e nunca confirmou: o mais útil é mandar um link de verificação novo.
    await enviarVerificacao(r.id, r.nome, email);
    return;
  }
  enviarEmailEmSegundoPlano(
    {
      para: email,
      ...modelos.contaJaExiste({
        nome: r.nome,
        linkEntrar: link(urlAppPais, '/entrar'),
        linkEsqueci: link(urlAppPais, '/esqueci-senha'),
      }),
    },
    'conta-ja-existe',
  );
}

const emailDoResponsavel = async (id: number) =>
  (await db('responsaveis_lanchei').where({ id }).first<{ email: string }>('email')).email;

async function enviarVerificacao(responsavelId: number, nome: string, email: string) {
  const token = await criarTokenEmail(db, { tipo: 'RESPONSAVEL', id: responsavelId }, 'VERIFICAR_EMAIL', VALIDADE.VERIFICAR_EMAIL);
  enviarEmailEmSegundoPlano(
    { para: email, ...modelos.verificarEmail({ nome, link: link(urlAppPais, '/verificar-email', { token }) }) },
    'verificar-email',
  );
}

/** Reenvia o link de verificação. Não revela nada: a rota responde 202 sempre. */
export async function reenviarVerificacao(email: string): Promise<void> {
  const r = await db('responsaveis_lanchei')
    .where({ email, ativo: true })
    .whereNull('email_verificado_em')
    .first<{ id: number; nome: string } | undefined>('id', 'nome');
  if (r) await enviarVerificacao(r.id, r.nome, email);
}

export async function verificarEmail(token: string): Promise<void> {
  const ok = await db.transaction(async (trx) => {
    const dono = await consumirTokenEmail(trx, token, 'VERIFICAR_EMAIL');
    if (!dono || dono.tipo !== 'RESPONSAVEL') return false;
    await trx('responsaveis_lanchei')
      .where({ id: dono.id })
      .whereNull('email_verificado_em')
      .update({ email_verificado_em: new Date() });
    return true;
  });
  if (!ok) throw tokenInvalido();
}

export const tokenInvalido = () =>
  erros.regra('TOKEN_INVALIDO', 'Este link é inválido, expirou ou já foi usado. Peça um novo.');
