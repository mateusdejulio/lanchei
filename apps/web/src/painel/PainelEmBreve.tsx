// Lugar reservado para o painel (Etapa 6). Por enquanto, a Cantina (ADMIN)
// já consegue abrir o caixa daqui.
import { Link } from 'react-router';
import { useSessao } from '../compartilhado/sessao';

export function PainelEmBreve() {
  const { usuario, sair } = useSessao();
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="m-0 text-3xl font-extrabold">Olá, {usuario?.nome.split(' ')[0]}</h1>
      <p className="m-0 max-w-[480px] text-lg text-texto-2">O painel {usuario?.papel === 'ADMIN' ? 'da cantina' : 'administrativo'} chega na próxima etapa.</p>
      <div className="flex gap-3">
        {usuario?.papel === 'ADMIN' && (
          <Link to="/caixa" className="flex h-14 items-center rounded-2xl bg-aprovado px-6 text-lg font-extrabold text-white no-underline">
            Abrir caixa
          </Link>
        )}
        <button type="button" onClick={() => void sair()} className="h-14 rounded-2xl border-2 border-texto px-6 text-lg font-extrabold">
          Sair
        </button>
      </div>
    </main>
  );
}
