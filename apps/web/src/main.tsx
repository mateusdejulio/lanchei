import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Fonte servida pelo próprio app (sem Google Fonts): nenhuma chamada a
// terceiros a partir do tablet, e a CSP da API continua só com 'self'.
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/plus-jakarta-sans/800.css';
import './estilos.css';
import { ProvedorSessao } from './compartilhado/sessao';
import { roteador } from './rotas';

const consultas = new QueryClient({
  defaultOptions: {
    // Uma nova tentativa só (o caixa não pode ficar "pensando" muito).
    queries: { retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <QueryClientProvider client={consultas}>
      <ProvedorSessao>
        <RouterProvider router={roteador} />
      </ProvedorSessao>
    </QueryClientProvider>
  </StrictMode>,
);
