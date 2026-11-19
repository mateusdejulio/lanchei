// Login único da equipe (caixa e painel). Depois de entrar, cada papel vai
// para a sua área (etapa6 §3): operador → caixa; cantina → painel da cantina...
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { AREA_DO_PAPEL, ErroApi } from '@lanchei/shared';
import { useSessao } from '../sessao';
import { IconeLogo } from '../ui/Icones';

export function PaginaLogin() {
  const { usuario, entrar } = useSessao();
  const navegar = useNavigate();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  if (usuario) return <Navigate to={AREA_DO_PAPEL[usuario.papel]} replace />;

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const u = await entrar(email.trim(), senha);
      navegar(AREA_DO_PAPEL[u.papel], { replace: true });
    } catch (x) {
      setErro(
        x instanceof ErroApi
          ? x.codigo === 'MUITAS_TENTATIVAS'
            ? 'Muitas tentativas. Aguarde alguns minutos.'
            : 'E-mail ou senha incorretos.'
          : 'Sem conexão com o servidor. Verifique a internet.',
      );
      setSenha('');
    } finally {
      setEnviando(false);
    }
  };

  const campo = 'h-14 rounded-[14px] border-2 border-borda-2 px-[18px] text-xl font-semibold text-texto focus:border-texto outline-none';
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={enviar} className="flex w-full max-w-[460px] flex-col gap-4 rounded-[28px] border border-borda bg-superficie p-10">
        <div className="mb-2 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-[14px] bg-marca text-white">
            <IconeLogo tamanho={26} />
          </div>
          <div>
            <p className="m-0 text-2xl font-extrabold tracking-[-0.02em]">Lanchei</p>
            <p className="m-0 text-[15px] font-medium text-texto-3">Entrar na cantina</p>
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-[15px] font-bold text-texto-2">
          E-mail
          <input className={campo} type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-[15px] font-bold text-texto-2">
          Senha
          <input className={campo} type="password" autoComplete="current-password" required value={senha} onChange={(e) => setSenha(e.target.value)} />
        </label>
        {erro && (
          <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-3 text-base font-semibold text-recusado">
            {erro}
          </p>
        )}
        <button type="submit" disabled={enviando} className="mt-2 h-16 rounded-2xl bg-texto text-xl font-extrabold text-white disabled:opacity-60">
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
        <Link to="/esqueci-senha" className="text-center text-[15px] font-semibold text-texto-2">
          Esqueci minha senha
        </Link>
      </form>
    </main>
  );
}
