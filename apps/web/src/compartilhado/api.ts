// Uma instância do cliente HTTP para o app inteiro (caixa + painel).
// O refresh token fica no cookie HttpOnly "lanchei_rt" (X-Cliente: web).
import { criarClienteApi } from '@lanchei/shared';

/** Quem quiser saber que a sessão acabou (o contexto de sessão) se inscreve aqui. */
const ouvintes = new Set<() => void>();
export const aoEncerrarSessao = (fn: () => void) => {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
};

export const api = criarClienteApi({
  cliente: 'web',
  aoEncerrarSessao: () => ouvintes.forEach((fn) => fn()),
});
