// Leitura do QR da carteirinha pela câmera do tablet (docs/etapa5-caixa.md §4).
//
// Duas partes:
//   1. criarFiltroQr: função PURA (testada) que decide se uma leitura vale:
//      só "LCH1." (QR de produto ou de site é ignorado em silêncio) e a mesma
//      carteirinha lida de novo em menos de 3 s é ignorada (o aluno ainda está
//      com ela na frente da câmera);
//   2. useLeitorQr: liga a câmera e procura QR ~8 vezes por segundo.
//
// Detector: a API BarcodeDetector nativa (Chrome no Android, rápida) e,
// sem ela (iPad/Safari), o "ponyfill" com ZXing em WebAssembly. O arquivo
// .wasm é servido pelo PRÓPRIO app (nunca de um CDN): nenhuma chamada a
// terceiros sai do tablet, e a CSP da API bloquearia o CDN de qualquer jeito.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Camera } from '../compartilhado/aparelho';

export const PREFIXO_QR = 'LCH1.';
export const JANELA_REPETICAO_MS = 3000;

export function criarFiltroQr(janelaMs = JANELA_REPETICAO_MS) {
  let ultimo: { conteudo: string; em: number } | null = null;
  return (conteudoBruto: string, agora: number): string | null => {
    const conteudo = conteudoBruto.trim();
    if (!conteudo.startsWith(PREFIXO_QR)) return null;
    if (ultimo && ultimo.conteudo === conteudo && agora - ultimo.em < janelaMs) {
      ultimo = { conteudo, em: agora }; // continua na frente da câmera: estende a janela
      return null;
    }
    ultimo = { conteudo, em: agora };
    return conteudo;
  };
}

// ---------------------------------------------------------------- detector

interface Detector {
  detect(fonte: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

let detectorPronto: Promise<Detector> | null = null;

async function criarDetector(): Promise<Detector> {
  const Nativo = (globalThis as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (Nativo && (await Nativo.getSupportedFormats()).includes('qr_code')) {
    return new Nativo({ formats: ['qr_code'] });
  }
  // Carregado só quando precisa (o Chrome Android nem baixa estes ~1 MB).
  const [{ BarcodeDetector, prepareZXingModule }, { default: urlWasm }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: { locateFile: (caminho: string, prefixo: string) => (caminho.endsWith('.wasm') ? urlWasm : prefixo + caminho) },
  });
  return new BarcodeDetector({ formats: ['qr_code'] }) as unknown as Detector;
}

// ---------------------------------------------------------------- hook da câmera

export type EstadoCamera = 'INICIANDO' | 'ATIVA' | 'NEGADA' | 'SEM_CAMERA' | 'ERRO';
const QUADROS_POR_SEGUNDO = 8;

export function useLeitorQr(op: { video: RefObject<HTMLVideoElement | null>; camera: Camera; ativo: boolean; aoLer: (conteudo: string) => void; tentativa: number }) {
  const [estado, setEstado] = useState<EstadoCamera>('INICIANDO');
  const [temLanterna, setTemLanterna] = useState(false);
  const [lanternaLigada, setLanternaLigada] = useState(false);
  const trilha = useRef<MediaStreamTrack | null>(null);
  // Refs: o laço de leitura sempre enxerga o valor ATUAL, sem reiniciar a câmera.
  const ativo = useRef(op.ativo);
  ativo.current = op.ativo;
  const aoLer = useRef(op.aoLer);
  aoLer.current = op.aoLer;

  useEffect(() => {
    let cancelado = false;
    let quadro = 0;
    let ultimaLeitura = 0;
    let stream: MediaStream | null = null;
    const filtro = criarFiltroQr();
    setEstado('INICIANDO');

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setEstado('SEM_CAMERA');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: op.camera, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const nome = (e as DOMException).name;
        setEstado(nome === 'NotAllowedError' || nome === 'SecurityError' ? 'NEGADA' : nome === 'NotFoundError' || nome === 'OverconstrainedError' ? 'SEM_CAMERA' : 'ERRO');
        return;
      }
      if (cancelado) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = op.video.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      trilha.current = stream.getVideoTracks()[0] ?? null;
      const capacidades = (trilha.current?.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTemLanterna(Boolean(capacidades.torch));
      setEstado('ATIVA');

      detectorPronto ??= criarDetector();
      const detector = await detectorPronto.catch(() => null);
      if (!detector || cancelado) return;

      let lendo = false;
      const laco = async (t: number) => {
        if (cancelado) return;
        quadro = requestAnimationFrame(laco);
        // ~8 leituras por segundo: rápido o bastante e sem esquentar o tablet.
        if (!ativo.current || lendo || t - ultimaLeitura < 1000 / QUADROS_POR_SEGUNDO || video.readyState < 2) return;
        ultimaLeitura = t;
        lendo = true;
        try {
          for (const c of await detector.detect(video)) {
            const valido = filtro(c.rawValue, Date.now());
            if (valido) {
              aoLer.current(valido);
              break;
            }
          }
        } catch {
          // quadro ruim (câmera trocando de foco etc.): tenta no próximo
        } finally {
          lendo = false;
        }
      };
      quadro = requestAnimationFrame(laco);
    })();

    return () => {
      cancelado = true;
      cancelAnimationFrame(quadro);
      stream?.getTracks().forEach((t) => t.stop()); // apaga a luz da câmera
      trilha.current = null;
      setLanternaLigada(false);
    };
  }, [op.camera, op.video, op.tentativa]);

  async function alternarLanterna() {
    const t = trilha.current;
    if (!t) return;
    const novo = !lanternaLigada;
    try {
      await t.applyConstraints({ advanced: [{ torch: novo } as MediaTrackConstraintSet] });
      setLanternaLigada(novo);
    } catch {
      setTemLanterna(false);
    }
  }

  return { estado, temLanterna, lanternaLigada, alternarLanterna };
}
