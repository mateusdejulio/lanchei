// Foto do aluno (ou as iniciais, se a escola ainda não cadastrou a foto).
import { iniciais } from '../../compartilhado/sessao';
import { useFotoAluno } from '../fotoAluno';

interface Props {
  alunoId: number | null;
  nome: string;
  tamanho: number;
  raio?: number;
}

export function FotoAluno({ alunoId, nome, tamanho, raio = 14 }: Props) {
  const foto = useFotoAluno(alunoId);
  const estilo = { width: tamanho, height: tamanho, borderRadius: raio };
  if (foto.tipo === 'OK') {
    return <img src={foto.url} alt={`Foto de ${nome}`} style={estilo} className="shrink-0 object-cover" draggable={false} />;
  }
  return (
    <div
      role="img"
      aria-label={foto.tipo === 'CARREGANDO' ? 'Carregando foto' : 'Aluno sem foto cadastrada'}
      style={estilo}
      className="flex shrink-0 flex-col items-center justify-center bg-placeholder text-center font-bold text-texto-4"
    >
      {foto.tipo === 'SEM_FOTO' ? (
        <>
          <span style={{ fontSize: tamanho / 3 }}>{iniciais(nome)}</span>
          {tamanho >= 100 && <span className="text-[12px]">sem foto</span>}
        </>
      ) : null}
    </div>
  );
}
