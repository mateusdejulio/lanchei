// Telas de senha da equipe, abertas pelos links dos e-mails (etapa4, bloco 4A):
//   /esqueci-senha              → pede o link por e-mail
//   /definir-senha?token=...    → convite: a pessoa cria a primeira senha (72 h)
//   /redefinir-senha?token=...  → "esqueci a senha" (1 h)
// As duas últimas chamam a mesma rota da API (POST /auth/senha/redefinir).
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErroApi } from '@lanchei/shared';
import { api } from '../api';
import { IconeLogo } from '../ui/Icones';

const campo = 'h-14 rounded-[14px] border-2 border-borda-2 px-[18px] text-xl font-semibold text-texto focus:border-texto outline-none';
const botao = 'mt-2 h-16 rounded-2xl bg-texto text-xl font-extrabold text-white disabled:opacity-60';

function Cartao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="flex w-full max-w-[460px] flex-col gap-4 rounded-[28px] border border-borda bg-superficie p-10">
        <div className="mb-2 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-[14px] bg-marca text-white">
            <IconeLogo tamanho={26} />
          </div>
          <h1 className="m-0 text-2xl font-extrabold tracking-[-0.02em]">{titulo}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

export function PaginaEsqueciSenha() {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    try {
      await api.post('/v1/auth/senha/esqueci', { email: email.trim(), perfil: 'EQUIPE' }, { semAutenticacao: true });
      setEnviado(true);
    } catch (x) {
      setErro(x instanceof ErroApi && x.codigo === 'MUITAS_TENTATIVAS' ? 'Muitos pedidos. Aguarde uma hora e tente de novo.' : 'Sem conexão com o servidor.');
    }
  };

  return (
    <Cartao titulo="Esqueci minha senha">
      {enviado ? (
        // Mesma mensagem exista ou não a conta (a API não revela quem tem conta).
        <p className="m-0 text-lg text-texto-2">Se este e-mail tiver acesso ao Lanchei, enviamos um link para criar uma senha nova. Ele vale por 1 hora.</p>
      ) : (
        <form onSubmit={enviar} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[15px] font-bold text-texto-2">
            E-mail
            <input className={campo} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {erro && <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-3 font-semibold text-recusado">{erro}</p>}
          <button type="submit" className={botao}>
            Enviar link
          </button>
        </form>
      )}
      <Link to="/login" className="text-center text-[15px] font-semibold text-texto-2">
        Voltar para o login
      </Link>
    </Cartao>
  );
}

export function PaginaDefinirSenha({ primeiroAcesso }: { primeiroAcesso: boolean }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [estado, setEstado] = useState<'FORM' | 'ENVIANDO' | 'OK'>('FORM');
  const [erro, setErro] = useState<string | null>(null);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (senha.length < 8) return setErro('A senha precisa ter pelo menos 8 caracteres.');
    if (senha !== confirmacao) return setErro('As duas senhas não são iguais.');
    setErro(null);
    setEstado('ENVIANDO');
    try {
      await api.post('/v1/auth/senha/redefinir', { token, novaSenha: senha }, { semAutenticacao: true });
      setEstado('OK');
    } catch (x) {
      setEstado('FORM');
      setErro(
        x instanceof ErroApi && x.codigo === 'TOKEN_INVALIDO'
          ? primeiroAcesso
            ? 'Este convite expirou ou já foi usado. Use "Esqueci minha senha" com o seu e-mail.'
            : 'Este link expirou ou já foi usado. Peça um novo.'
          : 'Sem conexão com o servidor.',
      );
    }
  };

  return (
    <Cartao titulo={primeiroAcesso ? 'Criar minha senha' : 'Nova senha'}>
      {estado === 'OK' ? (
        <>
          <p className="m-0 text-lg text-texto-2">Senha salva. Agora é só entrar.</p>
          <Link to="/login" className={`${botao} flex items-center justify-center no-underline`}>
            Ir para o login
          </Link>
        </>
      ) : !token ? (
        <p className="m-0 text-lg text-texto-2">Link incompleto. Abra de novo o link do e-mail.</p>
      ) : (
        <form onSubmit={enviar} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[15px] font-bold text-texto-2">
            Nova senha (mínimo 8 caracteres)
            <input className={campo} type="password" autoComplete="new-password" required minLength={8} value={senha} onChange={(e) => setSenha(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-[15px] font-bold text-texto-2">
            Repita a senha
            <input className={campo} type="password" autoComplete="new-password" required value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} />
          </label>
          {erro && <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-3 font-semibold text-recusado">{erro}</p>}
          <button type="submit" disabled={estado === 'ENVIANDO'} className={botao}>
            {estado === 'ENVIANDO' ? 'Salvando…' : 'Salvar senha'}
          </button>
        </form>
      )}
    </Cartao>
  );
}
