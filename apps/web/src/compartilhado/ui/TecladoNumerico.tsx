// Teclado numérico próprio (PIN e quantidades de estoque). Botões grandes,
// sem abrir o teclado do sistema, que cobriria metade da tela do tablet.
import { IconeApagar } from './Icones';

interface Props {
  aoDigitar: (digito: string) => void;
  aoApagar: () => void;
  /** Botão verde do canto (ex.: "OK"). Sem ele, o canto fica vazio. */
  confirmar?: { rotulo: string; aria: string; habilitado: boolean; aoConfirmar: () => void };
  desabilitado?: boolean;
  /** Altura das teclas em px (mockup: 64). */
  altura?: number;
}

const DIGITOS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function TecladoNumerico({ aoDigitar, aoApagar, confirmar, desabilitado = false, altura = 64 }: Props) {
  const tecla = 'rounded-2xl border border-borda-2 bg-superficie text-[26px] font-extrabold text-texto active:bg-neutro disabled:opacity-50';
  return (
    <div className="grid w-[330px] grid-cols-3 gap-2.5">
      {DIGITOS.map((d) => (
        <button key={d} type="button" className={tecla} style={{ height: altura }} disabled={desabilitado} onClick={() => aoDigitar(d)}>
          {d}
        </button>
      ))}
      <button
        type="button"
        aria-label="Apagar"
        className="flex items-center justify-center rounded-2xl bg-neutro-2 text-texto active:brightness-95 disabled:opacity-50"
        style={{ height: altura }}
        disabled={desabilitado}
        onClick={aoApagar}
      >
        <IconeApagar tamanho={26} />
      </button>
      <button type="button" className={tecla} style={{ height: altura }} disabled={desabilitado} onClick={() => aoDigitar('0')}>
        0
      </button>
      {confirmar ? (
        <button
          type="button"
          aria-label={confirmar.aria}
          className="rounded-2xl bg-aprovado text-[22px] font-extrabold text-white disabled:bg-neutro-2 disabled:text-texto-3"
          style={{ height: altura }}
          disabled={desabilitado || !confirmar.habilitado}
          onClick={confirmar.aoConfirmar}
        >
          {confirmar.rotulo}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
