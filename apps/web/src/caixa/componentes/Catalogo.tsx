// Catálogo (lado esquerdo do caixa): abas de categoria + grade de produtos
// (4 colunas, botões de 112 px). Tocar no produto = +1 no pedido.
//
// Selo do produto, do mais importante para o menos (mockup, tela 1):
//   "N no pedido" (laranja) > "Esgotado" > "Restam N" (âmbar, no mínimo) > "N un." (cinza)
// Destaque vermelho: falta de estoque (409) ou item bloqueado pelos pais.
import { useState } from 'react';
import { formatarCentavos, type CatalogoCaixa, type ProdutoCaixa } from '@lanchei/shared';
import type { Destaque, ItemNoPedido } from '../maquinaVenda';

interface Props {
  catalogo: CatalogoCaixa | undefined;
  itens: ItemNoPedido[];
  destaques: Destaque[];
  podeAdicionar: boolean;
  aoAdicionar: (produtoId: number) => void;
}

type Selo = { texto: string; classe: string } | null;

export function seloDoProduto(p: ProdutoCaixa, noPedido: number, destaque: Destaque | undefined): Selo {
  if (destaque?.motivo === 'BLOQUEADO') return { texto: 'Bloqueado', classe: 'bg-recusado text-white' };
  if (destaque?.motivo === 'ESTOQUE') return { texto: destaque.disponivel === 0 ? 'Esgotou' : `Só restam ${destaque.disponivel}`, classe: 'bg-recusado text-white' };
  if (noPedido > 0) return { texto: `${noPedido} no pedido`, classe: 'bg-marca text-white' };
  if (p.estoqueDisponivel === null) return null;
  if (p.estoqueDisponivel <= 0) return { texto: 'Esgotado', classe: 'bg-neutro-2 text-texto-4' };
  if (p.estoqueMinimo !== null && p.estoqueDisponivel <= p.estoqueMinimo) return { texto: `Restam ${p.estoqueDisponivel}`, classe: 'bg-aviso text-aviso-texto' };
  return { texto: `${p.estoqueDisponivel} un.`, classe: 'bg-neutro text-texto-2' };
}

export function Catalogo({ catalogo, itens, destaques, podeAdicionar, aoAdicionar }: Props) {
  const [categoria, setCategoria] = useState<number | 'TODOS'>('TODOS');
  const categorias = catalogo?.categorias ?? [];
  const produtos = categorias.filter((c) => categoria === 'TODOS' || c.id === categoria).flatMap((c) => c.produtos);
  const qtd = new Map(itens.map((i) => [i.produtoId, i.quantidade]));

  const aba = (ativa: boolean) =>
    `h-12 shrink-0 rounded-full px-5 text-base font-bold ${ativa ? 'bg-texto text-white' : 'border border-borda-2 bg-superficie text-texto'}`;

  return (
    <section aria-label="Produtos" className="flex min-w-0 grow flex-col gap-4 px-6 py-5">
      <nav aria-label="Categorias" className="flex gap-2 overflow-x-auto pb-1">
        <button type="button" className={aba(categoria === 'TODOS')} aria-pressed={categoria === 'TODOS'} onClick={() => setCategoria('TODOS')}>
          Todos
        </button>
        {categorias.map((c) => (
          <button key={c.id} type="button" className={aba(categoria === c.id)} aria-pressed={categoria === c.id} onClick={() => setCategoria(c.id)}>
            {c.nome}
          </button>
        ))}
      </nav>

      {!catalogo ? (
        <p className="text-texto-3">Carregando produtos…</p>
      ) : produtos.length === 0 ? (
        <p className="text-texto-3">Nenhum produto ativo. O administrador cadastra os produtos no painel.</p>
      ) : (
        <div className="-mx-1 grid grid-cols-3 content-start gap-3 overflow-y-auto px-1 pb-4 min-[1180px]:grid-cols-4">
          {produtos.map((p) => {
            const noPedido = qtd.get(p.id) ?? 0;
            const destaque = destaques.find((d) => d.produtoId === p.id);
            const esgotado = p.estoqueDisponivel !== null && p.estoqueDisponivel <= noPedido;
            const selo = seloDoProduto(p, noPedido, destaque);
            const estilo = destaque
              ? 'border-2 border-recusado bg-recusado-suave'
              : noPedido > 0
                ? 'border-2 border-marca bg-marca-suave'
                : p.estoqueDisponivel === 0
                  ? 'border border-dashed border-borda-tracejada bg-neutro text-[#6B756F]'
                  : 'border border-borda-3 bg-superficie';
            return (
              <button
                key={p.id}
                type="button"
                disabled={!podeAdicionar || esgotado}
                onClick={() => aoAdicionar(p.id)}
                aria-label={`${p.nome}, ${formatarCentavos(p.precoCentavos)}${selo ? `, ${selo.texto}` : ''}`}
                className={`flex h-28 flex-col justify-between rounded-2xl px-4 py-3.5 text-left active:scale-[0.98] disabled:active:scale-100 ${estilo}`}
              >
                <span className="text-[17px] font-bold leading-tight">{p.nome}</span>
                {/* flex-wrap: em telas mais estreitas, o selo desce em vez de vazar do cartão. */}
                <span className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="whitespace-nowrap text-lg font-extrabold">{formatarCentavos(p.precoCentavos)}</span>
                  {selo && <span className={`whitespace-nowrap rounded-full px-2 py-1 text-[13px] font-bold ${selo.classe}`}>{selo.texto}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
