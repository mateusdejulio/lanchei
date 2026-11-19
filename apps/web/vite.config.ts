// Vite do caixa + painel (apps/web). Ver docs/etapa5-caixa.md §2 e §3.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // `npm run dev:tablet`: HTTPS com certificado de desenvolvimento, para
    // testar no tablet pela rede local. O navegador só libera a câmera em
    // HTTPS (ou em localhost). Aceite o aviso do certificado no tablet.
    ...(mode === 'tablet' ? [basicSsl()] : []),
    VitePWA({
      registerType: 'autoUpdate',
      // O ícone e o manifesto aparecem quando a cantina "instala" o caixa no tablet.
      manifest: {
        name: 'Lanchei Caixa',
        short_name: 'Lanchei',
        description: 'Caixa da cantina do Lanchei',
        lang: 'pt-BR',
        start_url: '/caixa',
        scope: '/',
        display: 'fullscreen', // tela cheia, sem barra do navegador
        orientation: 'landscape', // tablet deitado
        background_color: '#F4F5F1',
        theme_color: '#E8590C',
        icons: [
          { src: '/icone-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icone-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // O leitor de QR em WebAssembly (~1 MB) também vai para o cache do aparelho.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        // A API e o app dos pais (/app, com o service worker dele) não passam por este.
        navigateFallbackDenylist: [/^\/v1\//, /^\/app(\/|$)/, /^\/health/],
      },
    }),
  ],
  build: {
    // Nunca embutir arquivos como "data:" no CSS/JS: a CSP da API (font-src 'self')
    // bloquearia, por exemplo, os pedaços pequenos da fonte. Tudo vira arquivo do app.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    // Em dev, o Vite repassa a API para o backend local: mesma origem, igual à
    // produção (o cookie do refresh funciona, não precisa de CORS).
    proxy: {
      '/v1': 'http://localhost:3333',
      '/health': 'http://localhost:3333',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/configurar.ts'],
    css: false,
  },
}));
