// Contexto de sessão: quem está logado, entrar e sair.
//
// Ao abrir o app (ou recarregar a página), tentamos recuperar a sessão pelo
// cookie do refresh (restaurarSessao) e perguntamos à API quem é o usuário
// (GET /auth/equipe/eu). Enquanto isso, "carregando" fica true e as rotas
// esperam, em vez de mandar a pessoa para o login à toa.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RespostaLoginEquipe, UsuarioLogado } from '@lanchei/shared';
import { api, aoEncerrarSessao } from './api';

interface Sessao {
  carregando: boolean;
  usuario: UsuarioLogado | null;
  entrar(email: string, senha: string): Promise<UsuarioLogado>;
  sair(): Promise<void>;
}

const Contexto = createContext<Sessao | null>(null);

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [carregando, setCarregando] = useState(true);
  const [usuario, setUsuario] = useState<UsuarioLogado | null>(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      try {
        if (await api.restaurarSessao()) {
          const r = await api.get<{ usuario: UsuarioLogado }>('/v1/auth/equipe/eu');
          if (ativo) setUsuario(r.usuario);
        }
      } catch {
        // Sem sessão válida (ou sem rede): fica deslogado.
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    // Refresh recusado no meio do uso (ex.: o admin desativou o usuário).
    const parar = aoEncerrarSessao(() => setUsuario(null));
    return () => {
      ativo = false;
      parar();
    };
  }, []);

  const entrar = useCallback(async (email: string, senha: string) => {
    const r = await api.post<RespostaLoginEquipe>('/v1/auth/equipe/login', { email, senha }, { semAutenticacao: true });
    api.definirSessao(r);
    setUsuario(r.usuario);
    return r.usuario;
  }, []);

  const sair = useCallback(async () => {
    await api.sair().catch(() => undefined);
    setUsuario(null);
  }, []);

  const valor = useMemo(() => ({ carregando, usuario, entrar, sair }), [carregando, usuario, entrar, sair]);
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessao(): Sessao {
  const s = useContext(Contexto);
  if (!s) throw new Error('useSessao fora do ProvedorSessao');
  return s;
}

/** "Cida Ramos" → "CR" (avatar do operador no cabeçalho). */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? (partes.at(-1)?.[0] ?? '') : '')).toUpperCase();
}
