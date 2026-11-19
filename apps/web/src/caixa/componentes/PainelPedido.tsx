// Painel da direita (440 px): câmera OU aluno identificado, a lista do
// pedido com −/+, o total e o botão principal de 68 px (mockup, telas 1 e 2).
import { formatarCentavos, type ProdutoCaixa } from '@lanchei/shared';
import { IconeAlerta, IconeCadeado, IconeCheck } from '../../compartilhado/ui/Icones';
import type { Estado } from '../maquinaVenda';
import { Camera } from './Camera';
import { FotoAluno } from './FotoAluno';

interface Props {
  estado: Estado;
  produtos: Map<number, ProdutoCaixa>;
  totalCentavos: number;
  online: boolean;
  leituraAtiva: boolean;
  aoLerQr: (qr: string) => void;
  aoAdicionar: (id: number) => void;
  aoRemover: (id: number) => void;
  aoLimpar: () => void;
  aoCancelarLeitura: () => void;
  aoCobrar: () => void;
  aoTentarDeNovo: () => void;
  aoCancelarVenda: () => void;
}

export function PainelPedido(p: Props) {
  const { estado } = p;
  const identificado = estado.aluno && (estado.fase === 'IDENTIFICADO' || estado.fase === 'COBRANDO' || estado.fase === 'ERRO_REDE');
  const editavel = estado.fase === 'OCIOSO' || estado.fase === 'IDENTIFICANDO' || estado.fase === 'IDENTIFICADO';

  return (
    <aside aria-label="Pedido" className="flex w-[440px] shrink-0 flex-col border-l border-borda bg-superficie">
      {identificado && estado.aluno ? (
        <>
          <CartaoAluno aluno={estado.aluno} />
          <button
            type="button"
            onClick={p.aoCancelarLeitura}
            disabled={!editavel}
            className="mx-5 mt-2 h-11 rounded-xl text-[15px] font-bold text-recusado disabled:opacity-40"
          >
            Não é este aluno — cancelar leitura
          </button>
        </>
      ) : estado.fase === 'IDENTIFICANDO' ? (
        <div className="mx-5 mt-5 flex h-[200px] items-center justify-center rounded-[18px] bg-fundo text-lg font-bold text-texto-2" role="status">
          Lendo carteirinha…
        </div>
      ) : (
        <>
          <Camera ativo={p.leituraAtiva} aviso={estado.aviso} aoLer={p.aoLerQr} />
          <p className="mx-5 mb-0 mt-3 text-center text-base font-bold">Mostre a carteirinha atrás do tablet</p>
          <p className="mx-5 mb-0 mt-1 text-center text-sm text-texto-3">A leitura é automática. Pode montar o pedido antes ou depois.</p>
        </>
      )}

      {/* Aviso de cobrança (ex.: produto desativado agora há pouco) quando o aluno está na tela. */}
      {identificado && estado.aviso && (
        <p role="alert" className="mx-5 mb-0 mt-2 rounded-xl bg-aviso px-4 py-2 text-sm font-semibold text-aviso-texto">
          {estado.aviso}
        </p>
      )}

      <div className={`mx-5 flex items-baseline justify-between border-t border-borda pt-3.5 ${identificado ? 'mt-1' : 'mt-4'}`}>
        <h2 className="m-0 text-lg font-extrabold">Pedido</h2>
        <button type="button" onClick={p.aoLimpar} disabled={!editavel || estado.itens.length === 0} className="h-9 px-2.5 text-sm font-bold text-recusado disabled:opacity-40">
          Limpar
        </button>
      </div>

      <ul className="m-0 mt-2 flex grow list-none flex-col gap-2 overflow-auto px-5">
        {estado.itens.length === 0 && <li className="py-2 text-[15px] text-texto-3">Toque nos produtos para montar o pedido.</li>}
        {estado.itens.map((i) => {
          const prod = p.produtos.get(i.produtoId);
          const destaque = estado.destaques.find((d) => d.produtoId === i.produtoId);
          const maxEstoque = prod?.estoqueDisponivel ?? null;
          return (
            <li key={i.produtoId} className="flex flex-col py-2">
              <div className="flex items-center gap-2.5">
                <span className={`grow text-base font-semibold ${destaque ? 'text-recusado' : ''}`}>{prod?.nome ?? 'Produto indisponível'}</span>
                <button
                  type="button"
                  aria-label={`Diminuir ${prod?.nome ?? ''}`}
                  disabled={!editavel}
                  onClick={() => p.aoRemover(i.produtoId)}
                  className="size-11 rounded-xl border border-borda-2 bg-superficie text-[22px] font-bold text-texto disabled:opacity-40"
                >
                  −
                </button>
                <span className="w-6 text-center text-[17px] font-extrabold" aria-label={`${i.quantidade} unidades`}>
                  {i.quantidade}
                </span>
                <button
                  type="button"
                  aria-label={`Aumentar ${prod?.nome ?? ''}`}
                  disabled={!editavel || (maxEstoque !== null && i.quantidade >= maxEstoque)}
                  onClick={() => p.aoAdicionar(i.produtoId)}
                  className="size-11 rounded-xl border border-borda-2 bg-superficie text-[22px] font-bold text-texto disabled:opacity-40"
                >
                  +
                </button>
                <span className="w-[84px] text-right text-base font-bold">{prod ? formatarCentavos(prod.precoCentavos * i.quantidade) : '—'}</span>
              </div>
              {destaque && (
                <span className="mt-1 flex items-center gap-1.5 text-sm font-bold text-recusado">
                  {destaque.motivo === 'BLOQUEADO' ? <IconeCadeado tamanho={14} /> : <IconeAlerta tamanho={14} />}
                  {destaque.motivo === 'BLOQUEADO'
                    ? 'Bloqueado para este aluno: remova do pedido'
                    : destaque.disponivel === 0
                      ? 'Esgotou: remova do pedido'
                      : `Só restam ${destaque.disponivel}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {estado.fase === 'ERRO_REDE' && (
        <div role="alert" className="mx-5 mb-2 rounded-2xl bg-aviso p-4 text-aviso-texto">
          <p className="m-0 text-base font-extrabold">Sem conexão. A venda NÃO foi confirmada.</p>
          <p className="m-0 mt-1 text-sm font-semibold">"Tentar de novo" não cobra duas vezes.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={p.aoTentarDeNovo} className="h-12 grow rounded-xl bg-aviso-texto text-base font-extrabold text-white">
              Tentar de novo
            </button>
            <button type="button" onClick={p.aoCancelarVenda} className="h-12 rounded-xl border-2 border-aviso-texto px-4 text-base font-bold">
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-borda px-5 pb-5 pt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[17px] font-semibold text-texto-2">Total</span>
          <span className="text-[30px] font-extrabold tracking-[-0.02em]">{formatarCentavos(p.totalCentavos)}</span>
        </div>
        <BotaoCobrar estado={estado} online={p.online} totalCentavos={p.totalCentavos} aoCobrar={p.aoCobrar} />
      </div>
    </aside>
  );
}

/** Botão principal (68 px). Exportado para os testes de componente. */
export function BotaoCobrar({ estado, online, totalCentavos, aoCobrar }: { estado: Estado; online: boolean; totalCentavos: number; aoCobrar: () => void }) {
  const desabilitado = 'h-[68px] rounded-2xl bg-neutro-2 text-[19px] font-extrabold text-texto-3';
  if (!online) {
    return (
      <button type="button" disabled className={desabilitado}>
        Sem conexão: vendas pausadas
      </button>
    );
  }
  if (estado.fase === 'COBRANDO') {
    return (
      <button type="button" disabled aria-busy="true" className="flex h-[68px] items-center justify-center gap-3 rounded-2xl bg-aprovado text-[21px] font-extrabold text-white opacity-80">
        <span className="size-6 animate-spin rounded-full border-[3px] border-white/40 border-t-white" aria-hidden="true" />
        Cobrando…
      </button>
    );
  }
  if (estado.fase === 'ERRO_REDE') return null; // a faixa âmbar acima tem o "Tentar de novo"
  if (!estado.aluno || estado.fase !== 'IDENTIFICADO') {
    return (
      <button type="button" disabled className={desabilitado}>
        {estado.itens.length === 0 ? 'Monte o pedido e leia a carteirinha' : 'Leia a carteirinha para cobrar'}
      </button>
    );
  }
  if (estado.itens.length === 0) {
    return (
      <button type="button" disabled className={desabilitado}>
        Adicione itens para cobrar
      </button>
    );
  }
  return (
    <button type="button" onClick={aoCobrar} className="h-[68px] rounded-2xl bg-aprovado text-[21px] font-extrabold text-white active:bg-aprovado-escuro">
      {estado.aluno.identificacao.tipo === 'PIN' ? `Digitar PIN e cobrar ${formatarCentavos(totalCentavos)}` : `Cobrar ${formatarCentavos(totalCentavos)}`}
    </button>
  );
}

function CartaoAluno({ aluno }: { aluno: NonNullable<Estado['aluno']> }) {
  const bloqueada = aluno.carteirinha === 'BLOQUEADA';
  return (
    <div className="mx-5 mt-5 flex items-center gap-4 rounded-[18px] border-2 border-texto bg-fundo p-4">
      <FotoAluno alunoId={aluno.id} nome={aluno.nome} tamanho={128} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-texto-3">Confira a foto</span>
        <span className="text-2xl font-extrabold leading-[1.15] tracking-[-0.01em]">{aluno.nome}</span>
        {aluno.turma && <span className="text-base font-semibold text-texto-2">{aluno.turma}</span>}
        {aluno.identificacao.tipo === 'PIN' ? (
          <span className="mt-0.5 self-start rounded-full bg-neutro-2 px-2.5 py-1 text-[13px] font-bold text-texto-4">Sem carteirinha (PIN)</span>
        ) : bloqueada ? (
          <span className="mt-0.5 flex items-center gap-1.5 self-start rounded-full bg-recusado px-2.5 py-1 text-[13px] font-bold text-white">
            <IconeCadeado tamanho={14} />
            Bloqueada pelo responsável
          </span>
        ) : (
          <span className="mt-0.5 flex items-center gap-1.5 self-start rounded-full bg-aprovado-suave px-2.5 py-1 text-[13px] font-bold text-aprovado-texto">
            <IconeCheck tamanho={14} />
            Carteirinha ativa
          </span>
        )}
      </div>
    </div>
  );
}
