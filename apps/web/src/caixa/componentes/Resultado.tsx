// Telas de resultado da cobrança (mockup, telas 3 e 4).
import { useEffect, useRef, useState } from 'react';
import { AVISO_PAIS_NOTIFICADOS, formatarCentavos, TEXTOS_RECUSA, type ItemPedido, type MotivoRecusa } from '@lanchei/shared';
import { IconeAprovado, IconeX } from '../../compartilhado/ui/Icones';
import { FotoAluno } from './FotoAluno';

export const SEGUNDOS_TELA_APROVADO = 3;

/** Aprovado: tela cheia verde; volta sozinha em 3 s (ou no botão). */
export function TelaAprovado(p: { nome: string; turma: string | null; totalCentavos: number; itens: ItemPedido[]; aoProximo: () => void }) {
  const [restam, setRestam] = useState(SEGUNDOS_TELA_APROVADO);
  // Ref: outras renderizações do pai não reiniciam a contagem.
  const aoProximo = useRef(p.aoProximo);
  aoProximo.current = p.aoProximo;
  useEffect(() => {
    if (restam <= 0) {
      aoProximo.current();
      return;
    }
    const t = setTimeout(() => setRestam((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [restam]);

  const resumo = [formatarCentavos(p.totalCentavos), p.nome, p.turma].filter(Boolean).join(' · ');
  return (
    <div role="status" aria-live="assertive" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-aprovado p-12 text-white">
      <div className="flex size-[148px] items-center justify-center rounded-full bg-white text-aprovado">
        <IconeAprovado tamanho={84} />
      </div>
      <h1 className="m-0 mt-2 text-[64px] font-extrabold tracking-[-0.03em]">Compra aprovada</h1>
      <p className="m-0 text-center text-[30px] font-semibold text-aprovado-suave">{resumo}</p>
      <p className="m-0 max-w-[900px] text-center text-xl font-medium text-[#CFEAD9]">
        {p.itens.map((i) => (i.quantidade > 1 ? `${i.quantidade}x ${i.nome}` : i.nome)).join(', ')}
      </p>
      <div className="mt-7 flex items-center gap-4">
        <span className="text-lg font-semibold text-[#CFEAD9]">Próximo aluno em {restam} s</span>
        <button type="button" onClick={p.aoProximo} className="h-16 rounded-2xl bg-white px-8 text-xl font-extrabold text-aprovado-escuro">
          Próximo aluno agora
        </button>
      </div>
    </div>
  );
}

/** Recusado: cartão com cabeçalho vermelho, o motivo e o que a atendente faz. */
export function TelaRecusado(p: {
  alunoId: number | null;
  nome: string;
  turma: string | null;
  totalCentavos: number;
  motivo: MotivoRecusa;
  aoEditar: () => void;
  aoCancelar: () => void;
}) {
  const texto = TEXTOS_RECUSA[p.motivo];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-fundo p-12">
      <div role="alertdialog" aria-labelledby="titulo-recusa" aria-describedby="orientacao-recusa" className="w-[760px] overflow-hidden rounded-[28px] border border-borda bg-superficie">
        <div className="flex items-center gap-6 bg-recusado px-10 py-8 text-white">
          <div className="flex size-[84px] shrink-0 items-center justify-center rounded-full bg-white text-recusado">
            <IconeX tamanho={48} strokeWidth={2.8} />
          </div>
          <div className="flex flex-col gap-1.5">
            <h1 id="titulo-recusa" className="m-0 text-[44px] font-extrabold tracking-[-0.02em]">
              Compra recusada
            </h1>
            <p className="m-0 text-[26px] font-bold text-recusado-suave">{texto.titulo}</p>
          </div>
        </div>
        <div className="flex flex-col gap-5 px-10 pb-8 pt-7">
          <div className="flex items-center gap-3.5">
            <FotoAluno alunoId={p.alunoId} nome={p.nome} tamanho={64} raio={12} />
            <div className="flex flex-col">
              <span className="text-xl font-extrabold">{p.nome}</span>
              <span className="text-base font-semibold text-texto-2">
                {[p.turma, `pedido de ${formatarCentavos(p.totalCentavos)}`].filter(Boolean).join(' · ')}
              </span>
            </div>
          </div>
          <p id="orientacao-recusa" className="m-0 rounded-[14px] bg-marca-suave px-5 py-4 text-lg font-semibold leading-[1.45] text-orientacao-texto">
            {texto.orientacaoCaixa} {AVISO_PAIS_NOTIFICADOS}
          </p>
          <div className="flex gap-3">
            <button type="button" onClick={p.aoEditar} className="h-16 grow rounded-2xl border-2 border-texto bg-superficie text-[19px] font-extrabold text-texto">
              Editar pedido
            </button>
            <button type="button" onClick={p.aoCancelar} className="h-16 grow rounded-2xl bg-texto text-[19px] font-extrabold text-white">
              Cancelar venda
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
