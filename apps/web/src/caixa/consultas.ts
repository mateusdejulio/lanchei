// Dados do servidor no caixa, via TanStack Query (cache + recarga automática).
// As chaves ficam aqui num lugar só, para invalidar o certo depois de cada ação.
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { CatalogoCaixa, ItemEstoque, PedidoDeHoje } from '@lanchei/shared';
import { api } from '../compartilhado/api';

export const chaves = {
  catalogo: ['caixa', 'catalogo'] as const,
  vendasHoje: ['caixa', 'vendas-hoje'] as const,
  estoque: ['estoque'] as const,
};

/** Catálogo: válido por 60 s; recarregado depois de cada venda, estorno ou movimento de estoque. */
export const useCatalogo = () =>
  useQuery({ queryKey: chaves.catalogo, queryFn: () => api.get<CatalogoCaixa>('/v1/caixa/catalogo'), staleTime: 60_000 });

export const useVendasDeHoje = (ativo: boolean) =>
  useQuery({ queryKey: chaves.vendasHoje, queryFn: () => api.get<{ itens: PedidoDeHoje[] }>('/v1/caixa/pedidos/hoje'), enabled: ativo });

export const useEstoque = () => useQuery({ queryKey: chaves.estoque, queryFn: () => api.get<{ itens: ItemEstoque[] }>('/v1/estoque') });

/** Depois de vender/estornar/movimentar, o estoque mudou: recarrega o que mostra estoque. */
export function atualizarDepoisDeMovimento(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: chaves.catalogo });
  void qc.invalidateQueries({ queryKey: chaves.vendasHoje });
  void qc.invalidateQueries({ queryKey: chaves.estoque });
}
