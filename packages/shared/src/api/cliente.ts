// Cliente HTTP dos fronts (caixa/painel e app dos pais).
//
// Sessão (docs/etapa5-caixa.md §7):
//   - o ACCESS token (15 min) fica só na memória desta página;
//   - o REFRESH token (30 dias) fica num cookie HttpOnly que o JavaScript
//     nem enxerga. Mandamos o header X-Cliente para a API usar o cookie.
//
// REFRESH "SINGLE-FLIGHT" (obrigatório):
// Imagine a tela do painel abrindo e fazendo 5 requisições ao mesmo tempo,
// bem quando o access token venceu. As 5 recebem 401 TOKEN_EXPIRADO. Se cada
// uma pedisse um refresh, a 1ª trocaria o refresh token e as outras 4 usariam
// o refresh ANTIGO, que acabou de ser revogado. A API entende isso como
// roubo de token (detecção de reuso) e derruba TODAS as sessões da pessoa.
// Por isso: um refresh por vez. As requisições que chegam enquanto ele está
// em andamento esperam a MESMA promessa e depois repetem com o token novo.
import { ErroApi, ErroRede, ErroSessao } from './erros';

export type TipoCliente = 'web' | 'pais';
export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OpcoesCliente {
  /** 'web' = caixa/painel; 'pais' = app dos pais (cada um tem o seu cookie). */
  cliente: TipoCliente;
  /** Prefixo das URLs. Vazio = mesma origem (produção e proxy do Vite). */
  baseUrl?: string;
  /** Chamado quando a sessão acaba de vez (refresh recusado): o app manda para o login. */
  aoEncerrarSessao?: () => void;
  /** Tempo máximo de cada requisição (padrão 15 s, como o "Cobrar" do caixa). */
  timeoutMs?: number;
  /** Injetável nos testes. */
  fetch?: typeof fetch;
}

export interface OpcoesRequisicao {
  corpo?: unknown;
  /** Vira ?a=1&b=2 (undefined e null são ignorados). */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Header Idempotency-Key (compra no caixa, depósito Pix, venda manual). */
  idempotencyKey?: string;
  /** 'json' (padrão) ou 'blob' (foto do aluno, CSV). */
  resposta?: 'json' | 'blob';
  /** Para cancelar (ex.: o usuário saiu da tela). */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Rotas públicas (login, cadastro...): não manda token nem tenta refresh. */
  semAutenticacao?: boolean;
}

export interface Tokens {
  accessToken: string;
}

export function criarClienteApi(op: OpcoesCliente) {
  const fazerFetch = op.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (op.baseUrl ?? '').replace(/\/+$/, '');
  let accessToken: string | null = null;
  let refreshEmAndamento: Promise<boolean> | null = null;

  function montarUrl(rota: string, query?: OpcoesRequisicao['query']) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    return `${base}${rota}${s ? `?${s}` : ''}`;
  }

  /** Uma ida ao servidor, sem lógica de refresh. Traduz falhas de rede em ErroRede. */
  async function enviar(metodo: Metodo, rota: string, o: OpcoesRequisicao, token: string | null): Promise<Response> {
    const controle = new AbortController();
    const timeout = setTimeout(() => controle.abort('tempo'), o.timeoutMs ?? op.timeoutMs ?? 15_000);
    const cancelarExterno = () => controle.abort('cancelada');
    o.signal?.addEventListener('abort', cancelarExterno, { once: true });

    const headers: Record<string, string> = { Accept: 'application/json', 'X-Cliente': op.cliente };
    if (o.corpo !== undefined) headers['Content-Type'] = 'application/json';
    if (token && !o.semAutenticacao) headers.Authorization = `Bearer ${token}`;
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;

    try {
      return await fazerFetch(montarUrl(rota, o.query), {
        method: metodo,
        headers,
        body: o.corpo === undefined ? undefined : JSON.stringify(o.corpo),
        credentials: 'same-origin', // o cookie do refresh vai junto (mesma origem)
        signal: controle.signal,
      });
    } catch {
      if (controle.signal.aborted) throw new ErroRede(controle.signal.reason === 'cancelada' ? 'CANCELADA' : 'TEMPO_ESGOTADO');
      throw new ErroRede('SEM_CONEXAO');
    } finally {
      clearTimeout(timeout);
      o.signal?.removeEventListener('abort', cancelarExterno);
    }
  }

  async function lerErro(resp: Response): Promise<ErroApi> {
    try {
      const corpo = (await resp.json()) as { erro?: { codigo?: string; mensagem?: string; detalhes?: unknown } };
      if (corpo.erro?.codigo) return new ErroApi(resp.status, corpo.erro.codigo, corpo.erro.mensagem ?? 'Erro.', corpo.erro.detalhes);
    } catch {
      // corpo não era JSON (ex.: um proxy devolvendo HTML 502)
    }
    return new ErroApi(resp.status, resp.status >= 500 ? 'ERRO_SERVIDOR' : 'ERRO_DESCONHECIDO', 'Algo deu errado. Tente de novo.');
  }

  /** Pede um access token novo usando o cookie. Single-flight: ver o topo do arquivo. */
  function renovar(): Promise<boolean> {
    refreshEmAndamento ??= (async () => {
      try {
        const resp = await enviar('POST', '/v1/auth/refresh', { semAutenticacao: true }, null);
        if (!resp.ok) {
          accessToken = null;
          return false;
        }
        accessToken = ((await resp.json()) as Tokens).accessToken;
        return true;
      } catch {
        // Sem rede: não dá para saber se a sessão ainda vale. Não desloga;
        // a requisição original falha com ErroRede e a tela mostra "sem conexão".
        return false;
      } finally {
        refreshEmAndamento = null;
      }
    })();
    return refreshEmAndamento;
  }

  async function requisitar<T>(metodo: Metodo, rota: string, o: OpcoesRequisicao = {}): Promise<T> {
    // Se um refresh já está rodando, espera ele antes de mandar (evita um 401 garantido).
    if (refreshEmAndamento && !o.semAutenticacao) await refreshEmAndamento;
    const tokenUsado = accessToken;
    let resp = await enviar(metodo, rota, o, tokenUsado);

    if (resp.status === 401 && !o.semAutenticacao) {
      const erro = await lerErro(resp);
      if (erro.codigo !== 'TOKEN_EXPIRADO') {
        if (tokenUsado) encerrar();
        throw tokenUsado ? new ErroSessao() : erro;
      }
      // Outra requisição pode ter renovado enquanto esta estava no ar: só
      // pede refresh se o token ainda é o mesmo que falhou.
      const renovou = accessToken !== tokenUsado ? true : await renovar();
      if (!renovou) {
        if (accessToken === null) encerrar();
        throw new ErroSessao();
      }
      resp = await enviar(metodo, rota, o, accessToken);
    }

    if (!resp.ok) throw await lerErro(resp);
    if (resp.status === 204) return undefined as T;
    if (o.resposta === 'blob') return (await resp.blob()) as T;
    return (await resp.json()) as T;
  }

  function encerrar() {
    accessToken = null;
    op.aoEncerrarSessao?.();
  }

  return {
    requisitar,
    get: <T>(rota: string, o?: Omit<OpcoesRequisicao, 'corpo'>) => requisitar<T>('GET', rota, o),
    post: <T>(rota: string, corpo?: unknown, o?: OpcoesRequisicao) => requisitar<T>('POST', rota, { ...o, corpo }),
    put: <T>(rota: string, corpo?: unknown, o?: OpcoesRequisicao) => requisitar<T>('PUT', rota, { ...o, corpo }),
    patch: <T>(rota: string, corpo?: unknown, o?: OpcoesRequisicao) => requisitar<T>('PATCH', rota, { ...o, corpo }),

    /** Depois do login: guarda o access token (o refresh já ficou no cookie). */
    definirSessao(tokens: Tokens) {
      accessToken = tokens.accessToken;
    },
    /** Ao abrir o app (reload): tenta recuperar a sessão pelo cookie. true = logado. */
    restaurarSessao: () => renovar(),
    /** Sair: revoga o refresh no servidor e limpa o cookie. */
    async sair() {
      try {
        await enviar('POST', '/v1/auth/logout', { semAutenticacao: true }, null);
      } finally {
        accessToken = null;
      }
    },
    temSessao: () => accessToken !== null,
  };
}

export type ClienteApi = ReturnType<typeof criarClienteApi>;
