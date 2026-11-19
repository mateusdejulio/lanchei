// Rotas do app web (caixa + painel). A API serve este app em "/" (produção);
// o app dos pais fica em "/app" (outro projeto).
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { AREA_DO_PAPEL, type Papel } from '@lanchei/shared';
import { useSessao } from './compartilhado/sessao';
import { PaginaLogin } from './compartilhado/paginas/Login';
import { PaginaDefinirSenha, PaginaEsqueciSenha } from './compartilhado/paginas/Senha';
import { PaginaCaixa } from './caixa/paginas/Caixa';
import { PaginaEstoque } from './caixa/paginas/Estoque';
import { PainelEmBreve } from './painel/PainelEmBreve';

/** Só deixa passar quem está logado com um dos papéis; os outros vão para a própria área. */
function Protegida({ papeis, children }: { papeis: Papel[]; children: ReactNode }) {
  const { carregando, usuario } = useSessao();
  if (carregando) {
    return (
      <div className="flex h-full items-center justify-center text-lg font-semibold text-texto-3" role="status">
        Carregando…
      </div>
    );
  }
  if (!usuario) return <Navigate to="/login" replace />;
  if (!papeis.includes(usuario.papel)) return <Navigate to={AREA_DO_PAPEL[usuario.papel]} replace />;
  return <>{children}</>;
}

function Inicio() {
  const { carregando, usuario } = useSessao();
  if (carregando) return null;
  return <Navigate to={usuario ? AREA_DO_PAPEL[usuario.papel] : '/login'} replace />;
}

export const roteador = createBrowserRouter([
  {
    element: <Outlet />,
    children: [
      { path: '/', element: <Inicio /> },
      { path: '/login', element: <PaginaLogin /> },
      // Links dos e-mails (convite da equipe e esqueci a senha).
      { path: '/esqueci-senha', element: <PaginaEsqueciSenha /> },
      { path: '/definir-senha', element: <PaginaDefinirSenha primeiroAcesso /> },
      { path: '/redefinir-senha', element: <PaginaDefinirSenha primeiroAcesso={false} /> },
      {
        path: '/caixa',
        element: (
          <Protegida papeis={['OPERADOR', 'ADMIN']}>
            <PaginaCaixa />
          </Protegida>
        ),
      },
      {
        path: '/caixa/estoque',
        element: (
          <Protegida papeis={['OPERADOR', 'ADMIN']}>
            <PaginaEstoque />
          </Protegida>
        ),
      },
      {
        path: '/painel/*',
        element: (
          <Protegida papeis={['ADMIN', 'ESCOLA', 'SUPERADMIN']}>
            <PainelEmBreve />
          </Protegida>
        ),
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
