// Rotas públicas de autenticação (/v1/auth). Contrato: docs/etapa3-api.md §2.2.
//   - login (equipe e responsável), refresh rotativo, logout;
//   - cadastro e verificação de e-mail do responsável;
//   - esqueci/redefinir senha (equipe e responsável).
import { Router } from 'express';
import { z } from 'zod';
import { loginEquipe, loginResponsavel } from './auth.servico.js';
import { revogarSessao, rotacionarRefresh } from './tokens.js';
import { cadastrarResponsavel, MENSAGEM_CADASTRO, reenviarVerificacao, verificarEmail } from './cadastro.servico.js';
import { esqueciSenha, redefinirSenha } from './senha.servico.js';
import { limiteCadastro, limiteEnvioEmail, limiteLogin, limiteRefresh, limiteTokenEmail } from '../../middlewares/limites.js';
import { zEmail, zNome, zSenhaNova, zTokenEmail } from '../../validacao.js';

const credenciais = z.object({ email: z.email().max(254), senha: z.string().min(1).max(200) });
const refresh = z.object({ refreshToken: z.string().min(20).max(200) });

const cadastro = z.object({
  nome: zNome,
  email: zEmail,
  senha: zSenhaNova,
  // Só dígitos, espaço, +, -, ( e ). O formato exato fica com o app.
  telefone: z.string().trim().regex(/^[\d\s()+-]{8,20}$/, 'Telefone inválido.').optional(),
});
const soEmail = z.object({ email: zEmail });
const soToken = z.object({ token: zTokenEmail });
const esqueci = z.object({ email: zEmail, perfil: z.enum(['EQUIPE', 'RESPONSAVEL']) });
const redefinir = z.object({ token: zTokenEmail, novaSenha: zSenhaNova });

export const rotasAuth = Router();
const cliente = (req: { ip?: string | undefined; get(h: string): string | undefined }) => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

rotasAuth.post('/equipe/login', limiteLogin, async (req, res) => {
  const { email, senha } = credenciais.parse(req.body);
  res.json(await loginEquipe(email, senha, cliente(req)));
});

rotasAuth.post('/responsavel/login', limiteLogin, async (req, res) => {
  const { email, senha } = credenciais.parse(req.body);
  res.json(await loginResponsavel(email, senha, cliente(req)));
});

// Sempre 201 com a mesma mensagem, mesmo se o e-mail já tiver conta (ver cadastro.servico.ts).
rotasAuth.post('/responsavel/cadastro', limiteCadastro, async (req, res) => {
  await cadastrarResponsavel(cadastro.parse(req.body));
  res.status(201).json({ mensagem: MENSAGEM_CADASTRO });
});

rotasAuth.post('/responsavel/verificar-email', limiteTokenEmail, async (req, res) => {
  await verificarEmail(soToken.parse(req.body).token);
  res.json({ mensagem: 'E-mail confirmado. Agora você já pode vincular seu filho.' });
});

// 202 = "recebido". Sempre, exista ou não a conta.
rotasAuth.post('/responsavel/reenviar-verificacao', limiteEnvioEmail, async (req, res) => {
  await reenviarVerificacao(soEmail.parse(req.body).email);
  res.status(202).end();
});

rotasAuth.post('/senha/esqueci', limiteEnvioEmail, async (req, res) => {
  const { email, perfil } = esqueci.parse(req.body);
  await esqueciSenha(email, perfil);
  res.status(202).end();
});

rotasAuth.post('/senha/redefinir', limiteTokenEmail, async (req, res) => {
  const { token, novaSenha } = redefinir.parse(req.body);
  await redefinirSenha(token, novaSenha, cliente(req));
  res.status(204).end();
});

rotasAuth.post('/refresh', limiteRefresh, async (req, res) => {
  const { refreshToken } = refresh.parse(req.body);
  res.json(await rotacionarRefresh(refreshToken, cliente(req)));
});

rotasAuth.post('/logout', async (req, res) => {
  const { refreshToken } = refresh.parse(req.body);
  await revogarSessao(refreshToken);
  res.status(204).end();
});
