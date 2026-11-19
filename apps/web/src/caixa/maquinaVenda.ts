// MÁQUINA DE ESTADOS DA VENDA (docs/etapa5-caixa.md §5), como função PURA:
// recebe o estado atual + uma ação e devolve o próximo estado. Sem rede, sem
// relógio, sem tela. Por isso dá para testar cada transição isoladamente.
// A tela (Caixa.tsx) só despacha ações e desenha o estado.
//
//            +itens / -itens (em qualquer estado não-final)
// OCIOSO ──QR lido──▶ IDENTIFICANDO ──200──▶ IDENTIFICADO ──"Cobrar"──▶ COBRANDO
//   ▲                     │404 (aviso 3 s)                                 ├─201──▶ APROVADO ──3 s──▶ OCIOSO
//   │◀────────────────────┘                                                ├─422──▶ RECUSADO
//   │                                                                      ├─409──▶ IDENTIFICADO (itens destacados)
//   │◀──"Cancelar leitura" / 60 s parado em IDENTIFICADO                   └─rede──▶ ERRO_REDE ──"Tentar de novo"──▶ COBRANDO (MESMA chave)
// RECUSADO ──"Editar pedido"──▶ IDENTIFICADO     RECUSADO ──"Cancelar venda"──▶ OCIOSO
//
// IDEMPOTENCY-KEY (o que impede cobrar duas vezes):
//   - criada ao entrar em COBRANDO, se ainda não existir;
//   - REUTILIZADA em ERRO_REDE → COBRANDO (se a 1ª tentativa chegou ao
//     servidor, a 2ª devolve o mesmo resultado sem cobrar de novo);
//   - DESCARTADA quando muda item, quantidade ou aluno, e depois de qualquer
//     resposta final (201, 422, 409).
// O UUID é gerado FORA (no componente) e chega na ação: a função continua pura.
//
// PIN (compra sem carteirinha): o PIN NUNCA entra neste estado. Ele vai
// direto do teclado para a requisição. Um "Tentar de novo" com PIN reabre
// o teclado (com a mesma chave).
import type { DetalhesFaltaEstoque, DetalhesRecusa, ItemPedido, MotivoRecusa, StatusCarteirinha } from '@lanchei/shared';

export type Fase = 'OCIOSO' | 'IDENTIFICANDO' | 'IDENTIFICADO' | 'COBRANDO' | 'APROVADO' | 'RECUSADO' | 'ERRO_REDE';

export type Identificacao = { tipo: 'CARTEIRINHA'; qrConteudo: string } | { tipo: 'PIN'; alunoId: number };

export interface AlunoNaTela {
  id: number;
  nome: string;
  turma: string | null;
  carteirinha: StatusCarteirinha | null;
  identificacao: Identificacao;
}

export interface ItemNoPedido {
  produtoId: number;
  quantidade: number;
}

/** Produto destacado em vermelho: sem estoque suficiente ou bloqueado pelos responsáveis. */
export type Destaque = { produtoId: number; motivo: 'ESTOQUE'; disponivel: number } | { produtoId: number; motivo: 'BLOQUEADO' };

export interface Estado {
  fase: Fase;
  itens: ItemNoPedido[];
  aluno: AlunoNaTela | null;
  chave: string | null;
  /** Mensagem curta na área da câmera (ex.: "Carteirinha não reconhecida"). */
  aviso: string | null;
  destaques: Destaque[];
  aprovado: { pedidoId: number; totalCentavos: number; itens: ItemPedido[] } | null;
  recusa: { motivo: MotivoRecusa; mensagem: string } | null;
  /** Erro do PIN para o teclado mostrar (PIN incorreto, bloqueado...). */
  erroPin: { mensagem: string; tentativasRestantes?: number; bloqueado?: boolean } | null;
  /** Conta as falhas de PIN para a tela "tremer" a cada uma. */
  falhasPin: number;
}

export const estadoInicial: Estado = {
  fase: 'OCIOSO',
  itens: [],
  aluno: null,
  chave: null,
  aviso: null,
  destaques: [],
  aprovado: null,
  recusa: null,
  erroPin: null,
  falhasPin: 0,
};

export type Acao =
  | { tipo: 'ADICIONAR'; produtoId: number }
  | { tipo: 'REMOVER'; produtoId: number }
  | { tipo: 'LIMPAR_ITENS' }
  | { tipo: 'QR_LIDO'; qrConteudo: string }
  | { tipo: 'IDENTIFICOU'; aluno: Omit<AlunoNaTela, 'identificacao'> }
  | { tipo: 'IDENTIFICACAO_FALHOU'; mensagem: string }
  | { tipo: 'LIMPAR_AVISO' }
  | { tipo: 'CANCELAR_LEITURA' }
  | { tipo: 'TEMPO_ESGOTADO' }
  | { tipo: 'COBRAR'; novaChave: string }
  | { tipo: 'COBRAR_COM_PIN'; aluno: Omit<AlunoNaTela, 'identificacao' | 'carteirinha'>; novaChave: string }
  | { tipo: 'APROVOU'; pedido: { id: number; totalCentavos: number; itens: ItemPedido[] } }
  | { tipo: 'RECUSOU'; detalhes: DetalhesRecusa; mensagem: string }
  | { tipo: 'FALTA_ESTOQUE'; detalhes: DetalhesFaltaEstoque }
  | { tipo: 'FALHA_PIN'; mensagem: string; tentativasRestantes?: number; bloqueado?: boolean }
  | { tipo: 'ERRO_REDE' }
  | { tipo: 'ERRO_COBRANCA'; mensagem: string }
  | { tipo: 'TENTAR_DE_NOVO' }
  | { tipo: 'EDITAR_PEDIDO' }
  | { tipo: 'CANCELAR_VENDA' }
  | { tipo: 'PROXIMO' };

/** Fases em que o pedido pode ser montado/alterado. */
const PODE_EDITAR: Fase[] = ['OCIOSO', 'IDENTIFICANDO', 'IDENTIFICADO'];

export const quantidadeTotal = (e: Estado) => e.itens.reduce((s, i) => s + i.quantidade, 0);
/** "Cobrar" só habilita com aluno IDENTIFICADO e pelo menos 1 item. */
export const podeCobrar = (e: Estado) => e.fase === 'IDENTIFICADO' && e.aluno !== null && quantidadeTotal(e) > 0;
/** A leitura da câmera só roda parada (OCIOSO). */
export const leituraAtiva = (e: Estado) => e.fase === 'OCIOSO';

/** Dá para cobrar com PIN agora? (pedido montado e nada em andamento) */
export const podeCobrarComPin = (e: Estado) => ['OCIOSO', 'IDENTIFICADO', 'ERRO_REDE'].includes(e.fase) && quantidadeTotal(e) > 0;

/** A chave da próxima cobrança por carteirinha: a que já existe (retentativa) ou uma nova. */
export const chaveDaCobranca = (e: Estado, novaChave: string) => e.chave ?? novaChave;

/** Com PIN: reaproveita a chave só se for o MESMO aluno (retentativa); outro aluno = outra venda. */
export const chaveDaCobrancaPin = (e: Estado, alunoId: number, novaChave: string) =>
  e.aluno?.identificacao.tipo === 'PIN' && e.aluno.id === alunoId && e.chave ? e.chave : novaChave;

function alterarItens(e: Estado, itens: ItemNoPedido[]): Estado {
  // Mudou o pedido: a chave antiga não vale mais (é OUTRO pedido).
  // Os destaques de produtos que saíram do pedido somem.
  const ids = new Set(itens.map((i) => i.produtoId));
  return { ...e, itens, chave: null, destaques: e.destaques.filter((d) => ids.has(d.produtoId)) };
}

export function reduzir(e: Estado, a: Acao): Estado {
  switch (a.tipo) {
    case 'ADICIONAR': {
      if (!PODE_EDITAR.includes(e.fase)) return e;
      const existe = e.itens.some((i) => i.produtoId === a.produtoId);
      return alterarItens(
        e,
        existe
          ? e.itens.map((i) => (i.produtoId === a.produtoId ? { ...i, quantidade: i.quantidade + 1 } : i))
          : [...e.itens, { produtoId: a.produtoId, quantidade: 1 }],
      );
    }
    case 'REMOVER': {
      if (!PODE_EDITAR.includes(e.fase)) return e;
      return alterarItens(
        e,
        e.itens.map((i) => (i.produtoId === a.produtoId ? { ...i, quantidade: i.quantidade - 1 } : i)).filter((i) => i.quantidade > 0),
      );
    }
    case 'LIMPAR_ITENS':
      return PODE_EDITAR.includes(e.fase) ? alterarItens(e, []) : e;

    case 'QR_LIDO':
      if (e.fase !== 'OCIOSO') return e;
      return {
        ...e,
        fase: 'IDENTIFICANDO',
        aviso: null,
        chave: null,
        aluno: { id: 0, nome: '', turma: null, carteirinha: null, identificacao: { tipo: 'CARTEIRINHA', qrConteudo: a.qrConteudo } },
      };
    case 'IDENTIFICOU':
      if (e.fase !== 'IDENTIFICANDO' || !e.aluno) return e;
      return { ...e, fase: 'IDENTIFICADO', aluno: { ...a.aluno, identificacao: e.aluno.identificacao } };
    case 'IDENTIFICACAO_FALHOU':
      if (e.fase !== 'IDENTIFICANDO') return e;
      return { ...e, fase: 'OCIOSO', aluno: null, aviso: a.mensagem };
    case 'LIMPAR_AVISO':
      return { ...e, aviso: null };

    case 'CANCELAR_LEITURA':
    case 'TEMPO_ESGOTADO':
      // Privacidade: o nome e a foto de uma criança não ficam parados na tela.
      if (e.fase !== 'IDENTIFICADO' && e.fase !== 'IDENTIFICANDO') return e;
      return { ...e, fase: 'OCIOSO', aluno: null, chave: null, destaques: [], erroPin: null };

    case 'COBRAR':
      if (!podeCobrar(e) || e.aluno?.identificacao.tipo !== 'CARTEIRINHA') return e;
      return { ...e, fase: 'COBRANDO', chave: chaveDaCobranca(e, a.novaChave), aviso: null };
    case 'COBRAR_COM_PIN': {
      // Do teclado do PIN: vale parado (OCIOSO), com outro aluno na tela, ou no ERRO_REDE ("Tentar de novo").
      if (!podeCobrarComPin(e)) return e;
      return {
        ...e,
        fase: 'COBRANDO',
        aluno: { ...a.aluno, carteirinha: null, identificacao: { tipo: 'PIN', alunoId: a.aluno.id } },
        // Mesmo aluno e mesmo pedido (retentativa): MESMA chave. Outro aluno: chave nova.
        chave: chaveDaCobrancaPin(e, a.aluno.id, a.novaChave),
        erroPin: null,
        aviso: null,
      };
    }

    case 'APROVOU':
      if (e.fase !== 'COBRANDO') return e;
      return { ...e, fase: 'APROVADO', chave: null, destaques: [], aprovado: { pedidoId: a.pedido.id, totalCentavos: a.pedido.totalCentavos, itens: a.pedido.itens } };
    case 'RECUSOU':
      if (e.fase !== 'COBRANDO') return e;
      return {
        ...e,
        fase: 'RECUSADO',
        chave: null,
        recusa: { motivo: a.detalhes.motivo, mensagem: a.mensagem },
        // Item bloqueado: guarda quais para destacar quando a atendente for editar.
        destaques: (a.detalhes.produtoIds ?? []).map((produtoId) => ({ produtoId, motivo: 'BLOQUEADO' as const })),
      };
    case 'FALTA_ESTOQUE':
      // Sem tela vermelha: volta para o aluno, com os itens em falta destacados.
      if (e.fase !== 'COBRANDO') return e;
      return {
        ...e,
        fase: 'IDENTIFICADO',
        chave: null,
        destaques: a.detalhes.itens.map((i) => ({ produtoId: i.produtoId, motivo: 'ESTOQUE' as const, disponivel: i.disponivel })),
      };
    case 'FALHA_PIN':
      // PIN errado/bloqueado: nenhum pedido foi criado; o aluno continua escolhido no teclado.
      if (e.fase !== 'COBRANDO') return e;
      return { ...e, fase: 'IDENTIFICADO', chave: null, erroPin: { mensagem: a.mensagem, tentativasRestantes: a.tentativasRestantes, bloqueado: a.bloqueado }, falhasPin: e.falhasPin + 1 };
    case 'ERRO_REDE':
      // A chave FICA: o "Tentar de novo" precisa dela.
      return e.fase === 'COBRANDO' ? { ...e, fase: 'ERRO_REDE' } : e;
    case 'ERRO_COBRANCA':
      // Erro que não é recusa nem rede (ex.: produto desativado agora há pouco).
      return e.fase === 'COBRANDO' ? { ...e, fase: 'IDENTIFICADO', chave: null, aviso: a.mensagem } : e;
    case 'TENTAR_DE_NOVO':
      if (e.fase !== 'ERRO_REDE' || e.aluno?.identificacao.tipo !== 'CARTEIRINHA') return e;
      return { ...e, fase: 'COBRANDO' };

    case 'EDITAR_PEDIDO':
      // A próxima cobrança usa chave NOVA (o pedido recusado já foi gravado com a anterior).
      return e.fase === 'RECUSADO' ? { ...e, fase: 'IDENTIFICADO', recusa: null, chave: null } : e;
    case 'CANCELAR_VENDA':
      if (e.fase === 'COBRANDO') return e; // esperando o servidor: não dá para cancelar no meio
      return { ...estadoInicial, falhasPin: e.falhasPin };
    case 'PROXIMO':
      return e.fase === 'APROVADO' ? { ...estadoInicial, falhasPin: e.falhasPin } : e;
  }
}
