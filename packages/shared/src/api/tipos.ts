// Tipos das respostas da API usadas pelos fronts (contrato: docs/etapa3-api.md).
// Dinheiro sempre em CENTAVOS (campos terminados em "Centavos"); datas em
// ISO 8601 UTC (string). Mantidos à mão: se uma rota mudar no backend,
// mude aqui no mesmo commit.

// ------------------------------------------------------------ comuns
export type Papel = 'SUPERADMIN' | 'ADMIN' | 'ESCOLA' | 'OPERADOR';
export type Dia = 'SEG' | 'TER' | 'QUA' | 'QUI' | 'SEX' | 'SAB' | 'DOM';
export const DIAS: readonly Dia[] = ['SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB', 'DOM'];

export interface Pagina<T> {
  itens: T[];
  proximoCursor: string | null;
}

export type MotivoRecusa =
  | 'CONTA_INATIVA'
  | 'CARTEIRINHA_BLOQUEADA'
  | 'DIA_NAO_PERMITIDO'
  | 'ITEM_BLOQUEADO'
  | 'LIMITE_DIARIO'
  | 'LIMITE_SEMANAL'
  | 'LIMITE_MENSAL'
  | 'SALDO_INSUFICIENTE';

export type StatusCarteirinha = 'ATIVA' | 'BLOQUEADA';
export type StatusPedido = 'CONFIRMADO' | 'RECUSADO' | 'ESTORNADO';
export type ModoIdentificacao = 'CARTEIRINHA' | 'PIN' | 'MANUAL';

// ------------------------------------------------------------ autenticação
export interface UsuarioLogado {
  id: number;
  nome: string;
  papel: Papel;
  escola: { id: number; nome: string } | null;
}
/** POST /auth/equipe/login (modo cookie: sem refreshToken). */
export interface RespostaLoginEquipe {
  accessToken: string;
  usuario: UsuarioLogado;
}
export interface RespostaLoginResponsavel {
  accessToken: string;
  responsavel: { id: number; nome: string; emailVerificado: boolean };
}

/** Para onde cada papel vai depois do login (etapa6 §3). */
export const AREA_DO_PAPEL: Record<Papel, string> = {
  OPERADOR: '/caixa',
  ADMIN: '/painel/cantina',
  ESCOLA: '/painel/escola',
  SUPERADMIN: '/painel/plataforma',
};

// ------------------------------------------------------------ caixa
export interface ProdutoCaixa {
  id: number;
  nome: string;
  precoCentavos: number;
  /** null = não controla estoque (nunca esgota). */
  estoqueDisponivel: number | null;
  estoqueMinimo: number | null;
}
export interface CatalogoCaixa {
  categorias: { id: number; nome: string; produtos: ProdutoCaixa[] }[];
}
/** POST /caixa/identificar. NUNCA traz saldo. */
export interface AlunoIdentificado {
  aluno: { id: number; nome: string; turma: string | null };
  carteirinha: { status: StatusCarteirinha | null };
  contaAtiva: boolean;
}
export interface AlunoBuscaCaixa {
  id: number;
  nome: string;
  turma: string | null;
  aceitaPin: boolean;
}
export interface ItemPedido {
  produtoId: number;
  nome: string;
  quantidade: number;
  precoUnitarioCentavos: number;
  subtotalCentavos: number;
}
/** POST /caixa/pedidos (201). A recusa vem como ErroApi COMPRA_RECUSADA (422). */
export interface PedidoAprovado {
  pedido: { id: number; status: 'CONFIRMADO' | 'ESTORNADO'; totalCentavos: number; itens: ItemPedido[] };
}
/** detalhes do erro 422 COMPRA_RECUSADA */
export interface DetalhesRecusa {
  motivo: MotivoRecusa;
  pedidoId: number;
  produtoIds?: number[];
}
/** detalhes do erro 409 ESTOQUE_INSUFICIENTE */
export interface DetalhesFaltaEstoque {
  itens: { produtoId: number; disponivel: number }[];
}
export interface PedidoDeHoje {
  id: number;
  criadoEm: string;
  aluno: { id: number; primeiroNome: string; turma: string | null };
  totalCentavos: number;
  status: StatusPedido;
  motivoRecusa: MotivoRecusa | null;
  modoIdentificacao: ModoIdentificacao;
}
export interface ItemEstoque {
  id: number;
  nome: string;
  estoqueAtual: number;
  estoqueMinimo: number | null;
  abaixoDoMinimo: boolean;
}

// ------------------------------------------------------------ extrato (painel e app)
export type TipoExtrato = 'DEPOSITO' | 'COMPRA' | 'ESTORNO' | 'REEMBOLSO' | 'AJUSTE' | 'RECUSADA';
export interface LinhaExtrato {
  id: string;
  tipo: TipoExtrato;
  valorCentavos: number;
  /** null nas compras recusadas (não mexem no saldo). */
  saldoAposCentavos: number | null;
  descricao: string | null;
  motivoRecusa: MotivoRecusa | null;
  pedidoId: number | null;
  depositoId: number | null;
  itens: { nome: string; quantidade: number }[];
  criadoEm: string;
}

// ------------------------------------------------------------ app dos pais
export interface Filho {
  id: number;
  nome: string;
  status: 'ATIVO' | 'INATIVO' | 'ENCERRADO';
  escola: { id: number; nome: string };
  turma: string | null;
  saldoCentavos: number;
  carteirinha: { status: StatusCarteirinha | null };
  temFoto: boolean;
}
export interface Regras {
  limiteDiarioCentavos: number | null;
  limiteSemanalCentavos: number | null;
  limiteMensalCentavos: number | null;
  diasPermitidos: Dia[];
  alertaSaldoBaixoCentavos: number | null;
  permiteSemCarteirinha: boolean;
}
export interface RegrasDetalhadas extends Regras {
  temPin: boolean;
  pinBloqueadoAte: string | null;
  ultimaAlteracao: { por: string; em: string; oQue: 'REGRAS' | 'BLOQUEIOS' } | null;
}
export interface DetalheFilho extends Filho {
  regras: RegrasDetalhadas;
  bloqueios: { categoriaIds: number[]; produtoIds: number[] };
  outrosResponsaveis: { nome: string }[];
}
export type StatusDeposito = 'PENDENTE' | 'APROVADO' | 'CANCELADO' | 'REJEITADO' | 'DEVOLVIDO';
export interface Deposito {
  id: number;
  alunoId: number;
  status: StatusDeposito;
  valorCentavos: number;
  /** Só enquanto o Pix está aberto. */
  pixCopiaCola: string | null;
  expiraEm: string | null;
  aprovadoEm: string | null;
  criadoEm: string;
  recebedor?: string;
}
export type TipoNotificacao =
  | 'COMPRA'
  | 'COMPRA_SEM_CARTEIRINHA'
  | 'COMPRA_RECUSADA'
  | 'SALDO_BAIXO'
  | 'DEPOSITO_CONFIRMADO'
  | 'CARTEIRINHA'
  | 'REGRAS_ALTERADAS'
  | 'ESTORNO';
export interface Notificacao {
  id: number;
  alunoId: number | null;
  tipo: TipoNotificacao;
  titulo: string;
  corpo: string;
  dados: Record<string, unknown> | null;
  lida: boolean;
  criadoEm: string;
}
