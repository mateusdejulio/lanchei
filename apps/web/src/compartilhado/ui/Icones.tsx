// Ícones em SVG inline (traço), os mesmos do mockup. Sem biblioteca de ícones.
// Decorativos (aria-hidden): o texto ao lado, ou o aria-label do botão, é que diz o que são.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { tamanho?: number };
const base = ({ tamanho = 20, ...p }: P) => ({
  width: tamanho,
  height: tamanho,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const IconeLogo = (p: P) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M4 11h16" />
    <path d="M5 11a7 7 0 0 1 14 0" />
    <path d="M4 15h16l-1.5 4h-13z" />
  </svg>
);

export const IconeTrocarCamera = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M3 7h3l2-3h8l2 3h3v12H3z" />
    <path d="M9 13a3 3 0 0 0 5.2 2" />
    <path d="M15 11a3 3 0 0 0-5.2-2" />
  </svg>
);

export const IconeLanterna = (p: P) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M8 2h8l-1 6H9z" />
    <path d="M9 8v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8" />
    <path d="M12 12v3" />
  </svg>
);

export const IconeCheck = (p: P) => (
  <svg {...base({ strokeWidth: 3, ...p })}>
    <path d="M5 12l5 5 9-10" />
  </svg>
);

export const IconeAprovado = (p: P) => (
  <svg {...base({ strokeWidth: 2.6, ...p })}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const IconeX = (p: P) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </svg>
);

export const IconeCadeado = (p: P) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

export const IconeAlerta = (p: P) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5" />
    <path d="M12 18h.01" />
  </svg>
);

export const IconeVoltar = (p: P) => (
  <svg {...base({ strokeWidth: 2.4, ...p })}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const IconeApagar = (p: P) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M21 5H9l-6 7 6 7h12z" />
    <path d="M17 9l-6 6" />
    <path d="M11 9l6 6" />
  </svg>
);
