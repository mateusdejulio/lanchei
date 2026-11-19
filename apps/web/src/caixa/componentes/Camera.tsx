// Prévia da câmera (200 px) com a moldura de mira (mockup, tela 1).
import { useRef, useState } from 'react';
import { cameraPreferida, definirCamera, type Camera as TipoCamera } from '../../compartilhado/aparelho';
import { IconeLanterna, IconeTrocarCamera } from '../../compartilhado/ui/Icones';
import { useLeitorQr } from '../leitorQr';

interface Props {
  ativo: boolean;
  aviso: string | null;
  aoLer: (qr: string) => void;
}

export function Camera({ ativo, aviso, aoLer }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<TipoCamera>(cameraPreferida);
  const [tentativa, setTentativa] = useState(0);
  const leitor = useLeitorQr({ video, camera, ativo, aoLer, tentativa });

  const trocar = () => {
    const nova = camera === 'environment' ? 'user' : 'environment';
    definirCamera(nova); // a escolha fica salva NESTE aparelho
    setCamera(nova);
  };

  const semCamera = leitor.estado === 'NEGADA' || leitor.estado === 'SEM_CAMERA' || leitor.estado === 'ERRO';

  return (
    <div className="relative mx-5 mt-5 flex h-[200px] shrink-0 items-center justify-center overflow-hidden rounded-[18px] bg-camera">
      <video
        ref={video}
        muted
        playsInline
        aria-label="Imagem da câmera"
        className={`absolute inset-0 size-full object-cover ${camera === 'user' ? '-scale-x-100' : ''} ${semCamera ? 'hidden' : ''}`}
      />
      {semCamera ? (
        <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center text-white">
          <p className="m-0 text-[15px] font-semibold">
            {leitor.estado === 'NEGADA'
              ? 'Permita o uso da câmera nas configurações do navegador.'
              : leitor.estado === 'SEM_CAMERA'
                ? 'Nenhuma câmera encontrada neste aparelho.'
                : 'Não foi possível ligar a câmera.'}
          </p>
          <button type="button" className="h-11 rounded-xl bg-white/15 px-4 text-[15px] font-bold text-white" onClick={() => setTentativa((t) => t + 1)}>
            Tentar de novo
          </button>
        </div>
      ) : (
        <>
          <div className="relative z-10 size-[150px] rounded-[18px] border-[3px] border-white/85" />
          <div className="absolute inset-x-0 top-1/2 z-10 h-0.5 bg-marca opacity-90" />
        </>
      )}

      <div className="absolute left-3.5 top-3 z-10 flex items-center gap-2 text-[13px] font-semibold text-white">
        <span className={`size-2 rounded-full ${leitor.estado === 'ATIVA' && ativo ? 'bg-[#F03E3E]' : 'bg-white/40'}`} />
        {camera === 'environment' ? 'Câmera traseira' : 'Câmera frontal'}
      </div>
      <div className="absolute right-3 top-2.5 z-10 flex gap-2">
        {leitor.temLanterna && (
          <button
            type="button"
            aria-label={leitor.lanternaLigada ? 'Desligar lanterna' : 'Ligar lanterna'}
            aria-pressed={leitor.lanternaLigada}
            onClick={leitor.alternarLanterna}
            className={`flex size-11 items-center justify-center rounded-xl text-white ${leitor.lanternaLigada ? 'bg-marca' : 'bg-white/15'}`}
          >
            <IconeLanterna />
          </button>
        )}
        <button type="button" aria-label="Trocar câmera" onClick={trocar} className="flex size-11 items-center justify-center rounded-xl bg-white/15 text-white">
          <IconeTrocarCamera />
        </button>
      </div>

      {/* Carteirinha não reconhecida etc.: aviso por 3 s, sem nenhum dado de aluno. */}
      {aviso && (
        <div role="alert" className="absolute inset-x-4 bottom-3 z-20 rounded-xl bg-recusado px-4 py-2 text-center text-[15px] font-bold text-white">
          {aviso}
        </div>
      )}
    </div>
  );
}
