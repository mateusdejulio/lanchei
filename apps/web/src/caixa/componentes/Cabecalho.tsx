// Cabeçalho do caixa (68 px): logo, nome do caixa, Online/Sem conexão,
// atalhos e o menu do operador. Medidas e cores do mockup (tela 1).
import { useState } from 'react';
import { IconeLogo } from '../../compartilhado/ui/Icones';
import { iniciais } from '../../compartilhado/sessao';

interface Props {
  nomeCaixa: string;
  online: boolean;
  operador: string;
  aoSemCarteirinha: () => void;
  aoVendasDeHoje: () => void;
  aoEstoque: () => void;
  aoRenomearCaixa: () => void;
  aoTrocarAtendente: () => void;
  /** Os atalhos ficam travados enquanto uma cobrança está em andamento. */
  ocupado?: boolean;
}

const botao = 'h-11 rounded-xl border border-borda-2 bg-superficie px-4 text-[15px] font-semibold text-texto active:bg-neutro disabled:opacity-50';

export function Cabecalho(p: Props) {
  const [menu, setMenu] = useState(false);
  return (
    <header className="relative z-20 flex h-[68px] shrink-0 items-center gap-4 border-b border-borda bg-superficie px-6">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-[10px] bg-marca text-white">
          <IconeLogo />
        </div>
        <span className="text-xl font-extrabold tracking-[-0.02em]">Lanchei</span>
        <span className="text-[15px] font-medium text-texto-3">Cantina · {p.nomeCaixa}</span>
      </div>
      <div className="grow" />

      {/* Status nunca só por cor: sempre com o texto. */}
      <div
        role="status"
        className={`flex items-center gap-2 rounded-full px-3 py-2 text-sm font-semibold ${p.online ? 'bg-aprovado-suave text-aprovado-texto' : 'bg-aviso text-aviso-texto'}`}
      >
        <span className={`size-2 rounded-full ${p.online ? 'bg-aprovado-ponto' : 'bg-aviso-texto'}`} />
        {p.online ? 'Online' : 'Sem conexão'}
      </div>

      <button type="button" className={botao} onClick={p.aoSemCarteirinha} disabled={p.ocupado}>
        Aluno sem carteirinha
      </button>
      <button type="button" className={botao} onClick={p.aoVendasDeHoje} disabled={p.ocupado}>
        Vendas de hoje
      </button>
      <button type="button" className={botao} onClick={p.aoEstoque} disabled={p.ocupado}>
        Estoque
      </button>

      <div className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="flex h-11 items-center gap-2 rounded-xl bg-neutro px-3.5 text-[15px] font-semibold text-texto"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-texto text-[13px] text-white">{iniciais(p.operador)}</span>
          {p.operador.split(/\s+/).slice(0, 2).join(' ')}
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 top-[52px] w-64 overflow-hidden rounded-2xl border border-borda bg-superficie shadow-lg">
            <button
              type="button"
              role="menuitem"
              className="block h-12 w-full px-4 text-left text-[15px] font-semibold active:bg-neutro"
              onClick={() => {
                setMenu(false);
                p.aoRenomearCaixa();
              }}
            >
              Nome deste caixa
            </button>
            <button
              type="button"
              role="menuitem"
              className="block h-12 w-full border-t border-borda px-4 text-left text-[15px] font-semibold text-recusado active:bg-neutro"
              onClick={() => {
                setMenu(false);
                p.aoTrocarAtendente();
              }}
            >
              Trocar atendente (sair)
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
