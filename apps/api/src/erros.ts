// Erro padrão da API. O middleware tratarErros transforma em:
// { "erro": { "codigo": "...", "mensagem": "...", "detalhes": ... } }
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

export const erros = {
  naoAutenticado: (msg = 'Faça login para continuar.') => new ErroApi(401, 'NAO_AUTENTICADO', msg),
  tokenExpirado: () => new ErroApi(401, 'TOKEN_EXPIRADO', 'Sua sessão expirou.'),
  semPermissao: (msg = 'Você não tem permissão para esta ação.') => new ErroApi(403, 'SEM_PERMISSAO', msg),
  // 404 também para "existe, mas não é seu": não confirmamos a existência.
  naoEncontrado: (msg = 'Não encontrado.') => new ErroApi(404, 'NAO_ENCONTRADO', msg),
  conflito: (codigo: string, msg: string, detalhes?: unknown) => new ErroApi(409, codigo, msg, detalhes),
  regra: (codigo: string, msg: string, detalhes?: unknown) => new ErroApi(422, codigo, msg, detalhes),
  muitasTentativas: (msg = 'Muitas tentativas. Aguarde e tente novamente.') =>
    new ErroApi(429, 'MUITAS_TENTATIVAS', msg),
};
