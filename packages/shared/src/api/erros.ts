// Erros que o cliente HTTP lança. A tela decide o que fazer pelo TIPO e
// pelo `codigo` (estável), e mostra a `mensagem` (pensada para o usuário).

/** A API respondeu com erro no formato { erro: { codigo, mensagem, detalhes? } }. */
export class ErroApi extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    mensagem: string,
    public readonly detalhes?: unknown,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}

/**
 * A requisição NÃO teve resposta: sem internet, servidor fora, tempo esgotado.
 * Atenção: no caixa isso NÃO quer dizer que a venda não aconteceu. A 1ª
 * tentativa pode ter chegado ao servidor; por isso o "Tentar de novo" usa a
 * MESMA Idempotency-Key (etapa5 §5).
 */
export class ErroRede extends Error {
  constructor(public readonly motivo: 'SEM_CONEXAO' | 'TEMPO_ESGOTADO' | 'CANCELADA') {
    super(
      motivo === 'TEMPO_ESGOTADO'
        ? 'O servidor demorou para responder.'
        : motivo === 'CANCELADA'
          ? 'Requisição cancelada.'
          : 'Sem conexão com o servidor.',
    );
    this.name = 'ErroRede';
  }
}

/** A sessão acabou (refresh recusado): o app volta para a tela de login. */
export class ErroSessao extends ErroApi {
  constructor() {
    super(401, 'SESSAO_ENCERRADA', 'Sua sessão terminou. Entre de novo.');
    this.name = 'ErroSessao';
  }
}

export const ehErroApi = (e: unknown, codigo?: string): e is ErroApi => e instanceof ErroApi && (codigo === undefined || e.codigo === codigo);
