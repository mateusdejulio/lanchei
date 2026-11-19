// Foto do aluno no caixa. A API serve a foto só com o token (e audita cada
// acesso), então não dá para usar <img src="/v1/..."> direto: baixamos com
// fetch autenticado, criamos um endereço local (objectURL) e, ao limpar a
// tela, REVOGAMOS esse endereço (etapa5 §5): a foto de uma criança não fica
// guardada na memória do tablet depois que o aluno sai.
import { useEffect, useState } from 'react';
import { ErroApi } from '@lanchei/shared';
import { api } from '../compartilhado/api';

export type Foto = { tipo: 'CARREGANDO' } | { tipo: 'OK'; url: string } | { tipo: 'SEM_FOTO' };

export function useFotoAluno(alunoId: number | null): Foto {
  const [foto, setFoto] = useState<Foto>({ tipo: 'CARREGANDO' });
  useEffect(() => {
    if (!alunoId) {
      setFoto({ tipo: 'SEM_FOTO' });
      return;
    }
    let url: string | null = null;
    const controle = new AbortController();
    setFoto({ tipo: 'CARREGANDO' });
    api
      .get<Blob>(`/v1/caixa/alunos/${alunoId}/foto`, { resposta: 'blob', signal: controle.signal })
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setFoto({ tipo: 'OK', url });
      })
      .catch((e: unknown) => {
        if (!controle.signal.aborted) setFoto(e instanceof ErroApi ? { tipo: 'SEM_FOTO' } : { tipo: 'SEM_FOTO' });
      });
    return () => {
      controle.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [alunoId]);
  return foto;
}
