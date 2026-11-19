// Hooks de aparelho: conexão com o servidor e tela sempre ligada.
import { useEffect, useState } from 'react';

/**
 * Online/Sem conexão (etapa5 §9). Junta três sinais:
 *   - o navegador (eventos online/offline);
 *   - um "ping" em /health a cada 30 s;
 *   - falhas de rede nas requisições do caixa (avisarFalha), que derrubam
 *     o indicador na hora, sem esperar o próximo ping.
 */
export function useConexao(intervaloMs = 30_000) {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    let cancelado = false;
    const pingar = async () => {
      try {
        const r = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!cancelado) setOnline(r.ok);
      } catch {
        if (!cancelado) setOnline(false);
      }
    };
    const aoFicarOnline = () => void pingar();
    const aoFicarOffline = () => setOnline(false);
    window.addEventListener('online', aoFicarOnline);
    window.addEventListener('offline', aoFicarOffline);
    const timer = setInterval(pingar, intervaloMs);
    void pingar();
    return () => {
      cancelado = true;
      clearInterval(timer);
      window.removeEventListener('online', aoFicarOnline);
      window.removeEventListener('offline', aoFicarOffline);
    };
  }, [intervaloMs]);

  return { online, avisarFalha: () => setOnline(false), avisarSucesso: () => setOnline(true) };
}

/**
 * Tela sempre ligada enquanto o caixa está aberto (Screen Wake Lock API).
 * O navegador solta a trava quando a aba sai de foco; pedimos de novo ao voltar.
 */
export function useTelaLigada() {
  useEffect(() => {
    let trava: WakeLockSentinel | null = null;
    const pedir = async () => {
      try {
        if (document.visibilityState === 'visible' && 'wakeLock' in navigator) trava = await navigator.wakeLock.request('screen');
      } catch {
        // sem suporte ou bateria fraca: segue sem
      }
    };
    void pedir();
    document.addEventListener('visibilitychange', pedir);
    return () => {
      document.removeEventListener('visibilitychange', pedir);
      void trava?.release();
    };
  }, []);
}
