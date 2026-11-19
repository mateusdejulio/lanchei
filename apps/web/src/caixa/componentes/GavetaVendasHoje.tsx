// Gaveta lateral "Vendas de hoje" (etapa5 §6.5): os pedidos de HOJE deste
// operador, para estornar quando errou. Pedidos de outros dias não aparecem:
// esses, só o administrador estorna (pelo painel).
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ehErroApi, formatarCentavos, formatarHora, TEXTOS_RECUSA, type PedidoDeHoje } from '@lanchei/shared';
import { api } from '../../compartilhado/api';
import { IconeX } from '../../compartilhado/ui/Icones';
import { Modal } from '../../compartilhado/ui/Modal';
import { atualizarDepoisDeMovimento, useVendasDeHoje } from '../consultas';

const MOTIVOS = ['Item errado', 'Aluno desistiu', 'Cobrado em dobro'];

export function GavetaVendasHoje({ aberta, aoFechar }: { aberta: boolean; aoFechar: () => void }) {
  const vendas = useVendasDeHoje(aberta);
  const [estornando, setEstornando] = useState<PedidoDeHoje | null>(null);
  if (!aberta) return null;

  const itens = vendas.data?.itens ?? [];
  const totalConfirmado = itens.filter((p) => p.status === 'CONFIRMADO').reduce((s, p) => s + p.totalCentavos, 0);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-modal-fundo/60" onClick={aoFechar}>
      <aside
        aria-label="Vendas de hoje"
        className="gaveta-entrar flex h-full w-[480px] flex-col bg-superficie"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-borda px-6 py-5">
          <div>
            <h2 className="m-0 text-2xl font-extrabold">Vendas de hoje</h2>
            <p className="m-0 mt-1 text-sm font-semibold text-texto-3">
              Suas vendas · {formatarCentavos(totalConfirmado)} confirmados
            </p>
          </div>
          <button type="button" aria-label="Fechar" onClick={aoFechar} className="flex size-11 items-center justify-center rounded-xl border border-borda-2">
            <IconeX />
          </button>
        </div>
        <ul className="m-0 flex grow list-none flex-col overflow-y-auto p-0">
          {vendas.isLoading && <li className="px-6 py-4 text-texto-3">Carregando…</li>}
          {vendas.isError && <li className="px-6 py-4 text-recusado">Não foi possível carregar. Verifique a conexão.</li>}
          {vendas.data && itens.length === 0 && <li className="px-6 py-4 text-texto-3">Nenhuma venda sua hoje.</li>}
          {itens.map((p) => (
            <li key={p.id} className="flex items-center gap-3 border-b border-borda px-6 py-3">
              <span className="w-14 text-[15px] font-bold text-texto-2">{formatarHora(p.criadoEm)}</span>
              <span className="flex grow flex-col">
                <span className="text-base font-bold">
                  {p.aluno.primeiroNome}
                  {p.aluno.turma && <span className="font-semibold text-texto-3"> · {p.aluno.turma}</span>}
                </span>
                <span className={`text-sm font-semibold ${p.status === 'CONFIRMADO' ? 'text-aprovado-texto' : p.status === 'ESTORNADO' ? 'text-texto-3' : 'text-recusado'}`}>
                  {p.status === 'CONFIRMADO' ? 'Aprovada' : p.status === 'ESTORNADO' ? 'Estornada' : `Recusada: ${p.motivoRecusa ? TEXTOS_RECUSA[p.motivoRecusa].titulo : ''}`}
                  {p.modoIdentificacao === 'PIN' && ' · sem carteirinha'}
                </span>
              </span>
              <span className={`text-base font-extrabold ${p.status === 'CONFIRMADO' ? '' : 'text-texto-3 line-through'}`}>{formatarCentavos(p.totalCentavos)}</span>
              {p.status === 'CONFIRMADO' && (
                <button type="button" onClick={() => setEstornando(p)} className="h-11 rounded-xl border border-borda-2 px-3 text-sm font-bold text-recusado">
                  Estornar
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
      {estornando && <ModalEstorno pedido={estornando} aoFechar={() => setEstornando(null)} />}
    </div>
  );
}

function ModalEstorno({ pedido, aoFechar }: { pedido: PedidoDeHoje; aoFechar: () => void }) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState<string | null>(null);
  const [outro, setOutro] = useState('');
  const [devolverEstoque, setDevolverEstoque] = useState(false); // desligado: lanche comido não volta
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const motivoFinal = motivo === 'OUTRO' ? outro.trim() : motivo;

  const confirmar = async () => {
    if (!motivoFinal || motivoFinal.length < 3) return;
    setEnviando(true);
    setErro(null);
    try {
      await api.post(`/v1/caixa/pedidos/${pedido.id}/estorno`, { motivo: motivoFinal, devolverEstoque });
      atualizarDepoisDeMovimento(qc);
      aoFechar();
    } catch (e) {
      setErro(ehErroApi(e) ? e.message : 'Sem conexão. O estorno não foi feito.');
    } finally {
      setEnviando(false);
    }
  };

  const chip = (ativo: boolean) => `h-12 rounded-full px-5 text-base font-bold ${ativo ? 'bg-texto text-white' : 'border border-borda-2 bg-superficie'}`;
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Modal aberto aoFechar={aoFechar} rotulo="Estornar venda" className="w-[560px]">
        <div className="flex flex-col gap-4 p-8">
          <h2 className="m-0 text-2xl font-extrabold">Estornar {formatarCentavos(pedido.totalCentavos)}?</h2>
          <p className="m-0 text-base text-texto-2">
            {pedido.aluno.primeiroNome} recebe o valor de volta no saldo e os responsáveis são avisados.
          </p>
          <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
            <legend className="mb-2 text-[15px] font-bold text-texto-2">Motivo</legend>
            {MOTIVOS.map((m) => (
              <button key={m} type="button" aria-pressed={motivo === m} className={chip(motivo === m)} onClick={() => setMotivo(m)}>
                {m}
              </button>
            ))}
            <button type="button" aria-pressed={motivo === 'OUTRO'} className={chip(motivo === 'OUTRO')} onClick={() => setMotivo('OUTRO')}>
              Outro…
            </button>
          </fieldset>
          {motivo === 'OUTRO' && (
            <input
              aria-label="Descreva o motivo"
              autoFocus
              value={outro}
              onChange={(e) => setOutro(e.target.value)}
              maxLength={200}
              className="h-12 rounded-xl border-2 border-borda-2 px-4 text-base"
            />
          )}
          <label className="flex min-h-12 items-center gap-3 text-base font-semibold">
            <input type="checkbox" checked={devolverEstoque} onChange={(e) => setDevolverEstoque(e.target.checked)} className="size-6 accent-texto" />
            Devolver os itens ao estoque (o produto voltou intacto)
          </label>
          {erro && (
            <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-2 font-semibold text-recusado">
              {erro}
            </p>
          )}
          <div className="flex gap-3">
            <button type="button" onClick={aoFechar} className="h-14 grow rounded-2xl border-2 border-texto text-lg font-extrabold">
              Voltar
            </button>
            <button
              type="button"
              onClick={confirmar}
              disabled={enviando || !motivoFinal || motivoFinal.length < 3}
              className="h-14 grow rounded-2xl bg-recusado text-lg font-extrabold text-white disabled:opacity-50"
            >
              {enviando ? 'Estornando…' : 'Confirmar estorno'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
