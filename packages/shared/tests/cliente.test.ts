// Cliente HTTP com um servidor FALSO (fetch simulado): refresh single-flight,
// sessão encerrada, erros de rede e formato de erro da API.
import { describe, expect, it, vi } from 'vitest';
import { criarClienteApi } from '../src/api/cliente';
import { ErroApi, ErroRede, ErroSessao } from '../src/api/erros';

const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
const erro = (status: number, codigo: string) => json(status, { erro: { codigo, mensagem: `msg ${codigo}` } });

/**
 * Servidor falso com a mesma regra da API: access token "t<N>" vale até ser
 * trocado; refresh rotaciona e, se o refresh velho for usado de novo, é REUSO.
 */
function servidorFalso(op: { refreshFalha?: boolean; atrasoRefreshMs?: number } = {}) {
  let versao = 1;
  let refreshes = 0;
  let reuso = false;
  const chamadas: { url: string; init: RequestInit }[] = [];
  const fetchFalso = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    chamadas.push({ url: u, init });
    const headers = init.headers as Record<string, string>;
    if (u.endsWith('/v1/auth/refresh')) {
      refreshes++;
      if (op.atrasoRefreshMs) await new Promise((r) => setTimeout(r, op.atrasoRefreshMs));
      if (op.refreshFalha) return erro(401, 'NAO_AUTENTICADO');
      versao++;
      return json(200, { accessToken: `t${versao}` });
    }
    if (u.endsWith('/v1/auth/logout')) return new Response(null, { status: 204 });
    if (headers.Authorization !== `Bearer t${versao}`) return erro(401, 'TOKEN_EXPIRADO');
    if (u.includes('/vazio')) return new Response(null, { status: 204 });
    return json(200, { ok: true, url: u });
  });
  return { fetchFalso, chamadas, refreshes: () => refreshes, expirar: () => versao++, reuso: () => reuso };
}

describe('refresh single-flight', () => {
  it('5 requisições com o token vencido → UM refresh, e todas terminam com sucesso', async () => {
    const s = servidorFalso({ atrasoRefreshMs: 30 });
    const api = criarClienteApi({ cliente: 'web', fetch: s.fetchFalso });
    api.definirSessao({ accessToken: 't1' });
    s.expirar(); // o token t1 venceu no servidor

    const respostas = await Promise.all([1, 2, 3, 4, 5].map((i) => api.get<{ ok: boolean }>(`/v1/coisa/${i}`)));
    expect(respostas.every((r) => r.ok)).toBe(true);
    expect(s.refreshes()).toBe(1);
  });

  it('requisição que começa DURANTE o refresh espera por ele (não leva 401 à toa)', async () => {
    const s = servidorFalso({ atrasoRefreshMs: 50 });
    const api = criarClienteApi({ cliente: 'web', fetch: s.fetchFalso });
    api.definirSessao({ accessToken: 't1' });
    s.expirar();
    const primeira = api.get('/v1/a');
    await new Promise((r) => setTimeout(r, 10)); // o refresh está no ar
    const segunda = api.get('/v1/b');
    await Promise.all([primeira, segunda]);
    expect(s.refreshes()).toBe(1);
  });

  it('refresh recusado → ErroSessao e aoEncerrarSessao é chamado (o app vai para o login)', async () => {
    const s = servidorFalso({ refreshFalha: true });
    const sair = vi.fn();
    const api = criarClienteApi({ cliente: 'pais', fetch: s.fetchFalso, aoEncerrarSessao: sair });
    api.definirSessao({ accessToken: 't1' });
    s.expirar();
    const r = await Promise.allSettled([api.get('/v1/a'), api.get('/v1/b'), api.get('/v1/c')]);
    expect(r.every((x) => x.status === 'rejected' && x.reason instanceof ErroSessao)).toBe(true);
    expect(s.refreshes()).toBe(1);
    expect(sair).toHaveBeenCalled();
    expect(api.temSessao()).toBe(false);
  });
});

describe('requisições', () => {
  it('manda X-Cliente, credenciais da mesma origem, Idempotency-Key e query; 204 vira undefined', async () => {
    const s = servidorFalso();
    const api = criarClienteApi({ cliente: 'web', fetch: s.fetchFalso });
    api.definirSessao({ accessToken: 't1' });
    await api.post('/v1/caixa/pedidos', { itens: [] }, { idempotencyKey: 'chave-1', query: { a: 1, b: undefined, c: 'x y' } });
    const { url, init } = s.chamadas.at(-1)!;
    expect(url).toBe('/v1/caixa/pedidos?a=1&c=x+y');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ 'X-Cliente': 'web', 'Idempotency-Key': 'chave-1', 'Content-Type': 'application/json', Authorization: 'Bearer t1' });
    expect(await api.get('/v1/vazio')).toBeUndefined();
  });

  it('erro da API vira ErroApi com codigo/mensagem/detalhes; corpo que não é JSON vira ERRO_SERVIDOR', async () => {
    const f = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('html') ? new Response('<html>Bad Gateway</html>', { status: 502 }) : json(422, { erro: { codigo: 'COMPRA_RECUSADA', mensagem: 'Saldo insuficiente.', detalhes: { motivo: 'SALDO_INSUFICIENTE' } } }),
    );
    const api = criarClienteApi({ cliente: 'web', fetch: f });
    const e = await api.post('/v1/caixa/pedidos').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErroApi);
    expect(e).toMatchObject({ status: 422, codigo: 'COMPRA_RECUSADA', message: 'Saldo insuficiente.', detalhes: { motivo: 'SALDO_INSUFICIENTE' } });
    expect(await api.get('/v1/html').catch((x: unknown) => x)).toMatchObject({ status: 502, codigo: 'ERRO_SERVIDOR' });
  });

  it('sem rede → ErroRede SEM_CONEXAO; servidor lento → TEMPO_ESGOTADO; cancelada → CANCELADA', async () => {
    const semRede = criarClienteApi({ cliente: 'web', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    expect(await semRede.get('/v1/x').catch((x: unknown) => x)).toMatchObject({ motivo: 'SEM_CONEXAO' });

    const lento = criarClienteApi({
      cliente: 'web',
      timeoutMs: 20,
      fetch: (_u, init) => new Promise((_ok, falha) => init?.signal?.addEventListener('abort', () => falha(new DOMException('abortado', 'AbortError')))),
    });
    const t = await lento.get('/v1/x').catch((x: unknown) => x);
    expect(t).toBeInstanceOf(ErroRede);
    expect(t).toMatchObject({ motivo: 'TEMPO_ESGOTADO' });

    const controle = new AbortController();
    const p = lento.get('/v1/x', { signal: controle.signal, timeoutMs: 5000 }).catch((x: unknown) => x);
    controle.abort();
    expect(await p).toMatchObject({ motivo: 'CANCELADA' });
  });

  it('rota pública (login) não manda token nem tenta refresh: 401 é só "senha errada"', async () => {
    const s = servidorFalso();
    const api = criarClienteApi({ cliente: 'web', fetch: s.fetchFalso });
    const e = await api.post('/v1/auth/equipe/login', { email: 'x', senha: 'y' }, { semAutenticacao: true }).catch((x: unknown) => x);
    expect(e).toMatchObject({ codigo: 'TOKEN_EXPIRADO' }); // o servidor falso responde 401; o cliente só repassa
    expect(s.refreshes()).toBe(0);
    expect((s.chamadas[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('restaurarSessao (reload) usa o cookie; sair chama o logout e esquece o token', async () => {
    const s = servidorFalso();
    const api = criarClienteApi({ cliente: 'pais', fetch: s.fetchFalso });
    expect(await api.restaurarSessao()).toBe(true);
    expect(api.temSessao()).toBe(true);
    await api.sair();
    expect(api.temSessao()).toBe(false);
    expect(s.chamadas.at(-1)!.url).toBe('/v1/auth/logout');
  });
});
