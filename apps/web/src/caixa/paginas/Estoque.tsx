// Estoque para a "tia da cantina" (/caixa/estoque, etapa5 §6.6): os produtos
// que controlam estoque, os que estão acabando no topo, e três ações grandes.
// AJUSTE é pela CONTAGEM REAL ("contei e tem 7"): a API calcula a diferença.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ehErroApi, type ItemEstoque } from '@lanchei/shared';
import { api } from '../../compartilhado/api';
import { IconeVoltar } from '../../compartilhado/ui/Icones';
import { Modal } from '../../compartilhado/ui/Modal';
import { TecladoNumerico } from '../../compartilhado/ui/TecladoNumerico';
import { atualizarDepoisDeMovimento, useEstoque } from '../consultas';

type Tipo = 'ENTRADA' | 'PERDA' | 'AJUSTE';
const TITULO: Record<Tipo, string> = { ENTRADA: 'Chegou mercadoria', PERDA: 'Perda', AJUSTE: 'Contei e tem…' };
const MOTIVOS_PERDA = ['Venceu', 'Estragou', 'Caiu/quebrou'];

export function PaginaEstoque() {
  const navegar = useNavigate();
  const estoque = useEstoque();
  const [acao, setAcao] = useState<{ produto: ItemEstoque; tipo: Tipo } | null>(null);
  const itens = estoque.data?.itens ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[68px] shrink-0 items-center gap-4 border-b border-borda bg-superficie px-6">
        <button type="button" onClick={() => navegar('/caixa')} className="flex h-11 items-center gap-1 rounded-xl border border-borda-2 px-3 text-[15px] font-semibold">
          <IconeVoltar />
          Voltar ao caixa
        </button>
        <h1 className="m-0 text-2xl font-extrabold">Estoque</h1>
      </header>
      <main className="grow overflow-y-auto px-6 py-5">
        {estoque.isLoading && <p className="text-texto-3">Carregando…</p>}
        {estoque.isError && <p className="text-recusado">Não foi possível carregar. Verifique a conexão.</p>}
        {estoque.data && itens.length === 0 && (
          <p className="text-texto-3">Nenhum produto controla estoque. O administrador liga o controle no cadastro do produto.</p>
        )}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {itens.map((p) => (
            <li key={p.id} className={`flex items-center gap-4 rounded-2xl border bg-superficie px-5 py-4 ${p.abaixoDoMinimo ? 'border-2 border-aviso-texto' : 'border-borda-3'}`}>
              <div className="flex grow flex-col">
                <span className="text-xl font-extrabold">{p.nome}</span>
                <span className={`text-base font-semibold ${p.abaixoDoMinimo ? 'text-aviso-texto' : 'text-texto-3'}`}>
                  {p.estoqueAtual === 0 ? 'Esgotado' : `${p.estoqueAtual} un.`}
                  {p.abaixoDoMinimo && p.estoqueAtual > 0 && ' · acabando'}
                  {p.estoqueMinimo !== null && <span className="text-texto-3"> (mínimo {p.estoqueMinimo})</span>}
                </span>
              </div>
              {(['ENTRADA', 'PERDA', 'AJUSTE'] as Tipo[]).map((tipo) => (
                <button
                  key={tipo}
                  type="button"
                  onClick={() => setAcao({ produto: p, tipo })}
                  className={`h-14 rounded-xl px-4 text-base font-bold ${tipo === 'ENTRADA' ? 'bg-aprovado text-white' : 'border border-borda-2 bg-superficie'}`}
                >
                  {TITULO[tipo]}
                </button>
              ))}
            </li>
          ))}
        </ul>
      </main>
      {acao && <ModalMovimento produto={acao.produto} tipo={acao.tipo} aoFechar={() => setAcao(null)} />}
    </div>
  );
}

function ModalMovimento({ produto, tipo, aoFechar }: { produto: ItemEstoque; tipo: Tipo; aoFechar: () => void }) {
  const qc = useQueryClient();
  const [qtd, setQtd] = useState('');
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const numero = qtd === '' ? null : Number(qtd);
  const motivoValido = tipo !== 'AJUSTE' || motivo.trim().length >= 3;
  const valido = numero !== null && (tipo === 'AJUSTE' ? numero >= 0 : numero > 0) && motivoValido;

  const pergunta = tipo === 'ENTRADA' ? 'Quantas unidades chegaram?' : tipo === 'PERDA' ? 'Quantas unidades foram perdidas?' : 'Quantas unidades você contou na prateleira?';

  const salvar = async () => {
    if (!valido || numero === null) return;
    setEnviando(true);
    setErro(null);
    try {
      await api.post('/v1/estoque/movimentos', { produtoId: produto.id, tipo, quantidade: numero, ...(motivo.trim() ? { motivo: motivo.trim() } : {}) });
      atualizarDepoisDeMovimento(qc);
      aoFechar();
    } catch (e) {
      setErro(ehErroApi(e) ? e.message : 'Sem conexão. Nada foi lançado.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal aberto aoFechar={aoFechar} rotulo={TITULO[tipo]} className="w-[760px]">
      <div className="flex gap-8 p-8">
        <div className="flex grow flex-col gap-4">
          <h2 className="m-0 text-2xl font-extrabold">
            {TITULO[tipo]}: {produto.nome}
          </h2>
          <p className="m-0 text-base font-semibold text-texto-2">
            {pergunta} <span className="text-texto-3">(no sistema: {produto.estoqueAtual})</span>
          </p>
          <output aria-live="polite" className="flex h-16 items-center rounded-2xl border-2 border-texto px-5 text-4xl font-extrabold">
            {qtd || <span className="text-texto-3">0</span>}
          </output>
          {tipo === 'PERDA' && (
            <div className="flex flex-wrap gap-2">
              {MOTIVOS_PERDA.map((m) => (
                <button key={m} type="button" aria-pressed={motivo === m} onClick={() => setMotivo(m)} className={`h-11 rounded-full px-4 text-[15px] font-bold ${motivo === m ? 'bg-texto text-white' : 'border border-borda-2'}`}>
                  {m}
                </button>
              ))}
            </div>
          )}
          {tipo === 'AJUSTE' && (
            <label className="flex flex-col gap-1 text-[15px] font-bold text-texto-2">
              Motivo (obrigatório)
              <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={255} placeholder="Ex.: contagem de sexta" className="h-12 rounded-xl border-2 border-borda-2 px-4 text-base font-medium text-texto" />
            </label>
          )}
          {erro && (
            <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-2 font-semibold text-recusado">
              {erro}
            </p>
          )}
          <div className="mt-auto flex gap-3">
            <button type="button" onClick={aoFechar} className="h-14 grow rounded-2xl border-2 border-texto text-lg font-extrabold">
              Cancelar
            </button>
            <button type="button" onClick={salvar} disabled={!valido || enviando} className="h-14 grow rounded-2xl bg-texto text-lg font-extrabold text-white disabled:opacity-40">
              {enviando ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
        <TecladoNumerico aoDigitar={(d) => setQtd((x) => (x.length < 5 ? (x === '0' ? d : x + d) : x))} aoApagar={() => setQtd((x) => x.slice(0, -1))} />
      </div>
    </Modal>
  );
}
