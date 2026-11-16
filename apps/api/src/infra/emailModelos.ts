// Modelos dos e-mails (PT-BR). Cada função devolve assunto + texto + HTML.
//
// Sempre há uma versão em texto puro: alguns leitores de e-mail não mostram
// HTML, e filtros de spam desconfiam de mensagens só com HTML.
// Tudo que vem do usuário (nomes) passa por escaparHtml: um nome como
// "<script>" não pode virar código dentro do e-mail.
import type { Email } from './email.js';

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Conteudo = Omit<Email, 'para'>;

/** Layout comum: título, parágrafos, botão opcional e rodapé. Cores do Lanchei (etapa5 §8). */
function montar(op: { assunto: string; titulo: string; paragrafos: string[]; botao?: { texto: string; url: string }; rodape?: string }): Conteudo {
  const rodape = op.rodape ?? 'Se você não esperava este e-mail, pode ignorá-lo com segurança.';
  const texto = [
    op.titulo,
    '',
    ...op.paragrafos,
    ...(op.botao ? ['', `${op.botao.texto}: ${op.botao.url}`] : []),
    '',
    '--',
    rodape,
    'Lanchei: pagamento sem dinheiro na cantina da escola.',
  ].join('\n');

  const p = (t: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#3D4741">${escaparHtml(t)}</p>`;
  const botao = op.botao
    ? `<p style="margin:24px 0"><a href="${escaparHtml(op.botao.url)}" style="background:#E8590C;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:12px;display:inline-block">${escaparHtml(op.botao.texto)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#5B6660">Se o botão não funcionar, copie este endereço no navegador:<br>${escaparHtml(op.botao.url)}</p>`
    : '';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F4F5F1;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="font-size:22px;font-weight:800;color:#E8590C;margin-bottom:16px">Lanchei</div>
<div style="background:#ffffff;border:1px solid #E2E5DD;border-radius:16px;padding:24px">
<h1 style="margin:0 0 16px;font-size:20px;color:#17201B">${escaparHtml(op.titulo)}</h1>
${op.paragrafos.map(p).join('\n')}
${botao}
</div>
<p style="font-size:12px;color:#5B6660;margin-top:16px">${escaparHtml(rodape)}</p>
</div></body></html>`;

  return { assunto: op.assunto, texto, html };
}

export const modelos = {
  verificarEmail: (d: { nome: string; link: string }) =>
    montar({
      assunto: 'Confirme seu e-mail no Lanchei',
      titulo: `Olá, ${d.nome}!`,
      paragrafos: ['Falta só confirmar que este e-mail é seu. O link vale por 24 horas.'],
      botao: { texto: 'Confirmar e-mail', url: d.link },
    }),

  // Enviado quando alguém tenta se cadastrar com um e-mail que já tem conta.
  // A API responde igual nos dois casos (não revela quem tem conta); só o
  // dono do e-mail fica sabendo, por aqui.
  contaJaExiste: (d: { nome: string; linkEntrar: string; linkEsqueci: string }) =>
    montar({
      assunto: 'Você já tem conta no Lanchei',
      titulo: `Olá, ${d.nome}!`,
      paragrafos: [
        'Recebemos um pedido de cadastro com este e-mail, mas você já tem uma conta no Lanchei.',
        `Para entrar, use o seu e-mail e a sua senha. Esqueceu a senha? Redefina aqui: ${d.linkEsqueci}`,
      ],
      botao: { texto: 'Entrar no Lanchei', url: d.linkEntrar },
      rodape: 'Se não foi você que tentou se cadastrar, ignore este e-mail. Sua conta continua segura.',
    }),

  redefinirSenha: (d: { nome: string; link: string }) =>
    montar({
      assunto: 'Redefinição de senha do Lanchei',
      titulo: `Olá, ${d.nome}!`,
      paragrafos: [
        'Recebemos um pedido para redefinir a sua senha. O link vale por 1 hora e só pode ser usado uma vez.',
        'Ao trocar a senha, você sai de todos os aparelhos em que estava conectado.',
      ],
      botao: { texto: 'Criar nova senha', url: d.link },
      rodape: 'Se você não pediu a redefinição, ignore este e-mail: sua senha continua a mesma.',
    }),

  conviteEquipe: (d: { nome: string; papel: 'ADMIN' | 'ESCOLA' | 'OPERADOR'; escola: string; link: string }) => {
    const funcao = { ADMIN: 'administração da cantina', ESCOLA: 'diretoria/secretaria', OPERADOR: 'caixa da cantina' }[d.papel];
    return montar({
      assunto: `Seu acesso ao Lanchei (${d.escola})`,
      titulo: `Olá, ${d.nome}!`,
      paragrafos: [
        `Você recebeu acesso ao Lanchei da escola ${d.escola}, na área de ${funcao}.`,
        'Para começar, crie a sua senha. O link vale por 72 horas. Se ele expirar, use "Esqueci minha senha" na tela de login.',
      ],
      botao: { texto: 'Criar minha senha', url: d.link },
    });
  },

  // Usado na etapa 4B (convites dos responsáveis).
  codigoAtivacao: (d: { primeiroNomeAluno: string; escola: string; codigo: string; link: string }) =>
    montar({
      assunto: `Ative o Lanchei para acompanhar ${d.primeiroNomeAluno}`,
      titulo: 'Ative o Lanchei',
      paragrafos: [
        `A escola ${d.escola} usa o Lanchei na cantina. Com ele você coloca créditos por Pix, define limites e bloqueios e acompanha cada compra de ${d.primeiroNomeAluno}.`,
        `Seu código de ativação é ${d.codigo}. Ele vale por 7 dias e funciona só com este e-mail.`,
      ],
      botao: { texto: 'Ativar agora', url: d.link },
      rodape: 'Se você não é responsável por este aluno, ignore este e-mail e avise a secretaria da escola.',
    }),

  // Usado pelo job de reconciliação (etapa 4D). Sem dados pessoais: só quantidades.
  alertaReconciliacao: (d: { contasDivergentes: number; estoqueDivergente: number }) =>
    montar({
      assunto: '[Lanchei] ALERTA: divergência na reconciliação',
      titulo: 'A reconciliação encontrou divergências',
      paragrafos: [
        `Contas com saldo diferente da soma do ledger: ${d.contasDivergentes}.`,
        `Produtos com estoque diferente da soma dos movimentos: ${d.estoqueDivergente}.`,
        'Consulte as views vw_contas_divergentes_lanchei e vw_estoque_divergente_lanchei.',
      ],
      rodape: 'Alerta automático do job de reconciliação.',
    }),
};
