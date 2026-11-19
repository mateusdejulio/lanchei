// Janela modal acessível: usa o <dialog> nativo do navegador, que já cuida
// do foco (Tab fica preso dentro) e anuncia o diálogo para leitores de tela.
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  aberto: boolean;
  aoFechar: () => void;
  rotulo: string;
  children: ReactNode;
  /** Classes do cartão (largura, altura, padding). */
  className?: string;
}

export function Modal({ aberto, aoFechar, rotulo, children, className = '' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (aberto && !d.open) d.showModal?.();
    if (!aberto && d.open) d.close?.();
  }, [aberto]);

  if (!aberto) return null;
  return (
    <dialog
      ref={ref}
      aria-label={rotulo}
      // "cancel" = tecla Esc: fecha pelo nosso estado, não pelo navegador.
      onCancel={(e) => {
        e.preventDefault();
        aoFechar();
      }}
      className={`m-auto max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)] overflow-hidden rounded-[28px] border-0 bg-superficie p-0 text-texto backdrop:bg-modal-fundo/90 ${className}`}
    >
      {children}
    </dialog>
  );
}
