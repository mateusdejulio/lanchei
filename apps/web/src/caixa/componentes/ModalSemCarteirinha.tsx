// Aluno sem carteirinha (mockup, tela 5): busca por nome (mínimo 3 letras,
// espera 300 ms depois da última tecla) → escolhe o aluno → confere a foto
// → o ALUNO digita o PIN no teclado próprio → OK cobra o pedido montado.
//
// O PIN mora só neste componente, só até ser enviado: o OK passa o PIN para
// a cobrança e limpa as bolinhas na hora (etapa5 §6.4).
import { useEffect, useRef, useState } from 'react';
import { formatarHora, type AlunoBuscaCaixa } from '@lanchei/shared';
import { api } from '../../compartilhado/api';
import { IconeX } from '../../compartilhado/ui/Icones';
import { Modal } from '../../compartilhado/ui/Modal';
import { TecladoNumerico } from '../../compartilhado/ui/TecladoNumerico';
import { FotoAluno } from './FotoAluno';

export interface AlunoEscolhido {
  id: number;
  nome: string;
  turma: string | null;
}

interface Props {
  aberto: boolean;
  /** Aluno já escolhido (retentativa depois de PIN errado ou falta de rede). */
  alunoInicial: AlunoEscolhido | null;
  temItens: boolean;
  cobrando: boolean;
  erroPin: { mensagem: string; tentativasRestantes?: number; bloqueado?: boolean } | null;
  /** Muda a cada PIN recusado: faz as bolinhas tremerem de novo. */
  falhasPin: number;
  aoFechar: () => void;
  aoConfirmar: (aluno: AlunoEscolhido, pin: string) => void;
}

export function ModalSemCarteirinha(p: Props) {
  return (
    <Modal aberto={p.aberto} aoFechar={p.aoFechar} rotulo="Aluno sem carteirinha" className="h-[680px] w-[1120px]">
      {p.aberto && <Conteudo {...p} />}
    </Modal>
  );
}

function Conteudo(p: Props) {
  const [busca, setBusca] = useState(p.alunoInicial?.nome.split(' ').slice(0, 2).join(' ') ?? '');
  const [resultados, setResultados] = useState<AlunoBuscaCaixa[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [escolhido, setEscolhido] = useState<AlunoEscolhido | null>(p.alunoInicial);
  const [pin, setPin] = useState('');
  const bolinhas = useRef<HTMLDivElement>(null);

  // Busca com espera de 300 ms (não dispara uma requisição por tecla).
  useEffect(() => {
    const q = busca.trim();
    if (q.length < 3) {
      setResultados(null);
      return;
    }
    const controle = new AbortController();
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await api.get<{ itens: AlunoBuscaCaixa[] }>('/v1/caixa/alunos/busca', { query: { q }, signal: controle.signal });
        setResultados(r.itens);
      } catch {
        if (!controle.signal.aborted) setResultados([]);
      } finally {
        if (!controle.signal.aborted) setBuscando(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      controle.abort();
    };
  }, [busca]);

  // PIN recusado: treme as bolinhas e limpa o que foi digitado.
  useEffect(() => {
    if (p.falhasPin === 0) return;
    setPin('');
    const el = bolinhas.current;
    if (!el) return;
    el.classList.remove('tremer');
    void el.offsetWidth; // reinicia a animação
    el.classList.add('tremer');
  }, [p.falhasPin]);

  // O erro do PIN (incorreto, bloqueado) vale só para o aluno a que ele se refere.
  const erro = escolhido && p.alunoInicial && escolhido.id === p.alunoInicial.id ? p.erroPin : null;

  const escolher = (a: AlunoBuscaCaixa) => {
    setEscolhido({ id: a.id, nome: a.nome, turma: a.turma });
    setPin('');
  };
  const confirmar = () => {
    if (!escolhido || pin.length !== 4) return;
    const digitado = pin;
    setPin(''); // o PIN não fica guardado na tela
    p.aoConfirmar(escolhido, digitado);
  };

  return (
    <div className="flex h-full">
      <section className="flex w-[540px] shrink-0 flex-col gap-4 border-r border-borda p-8">
        <div className="flex items-center justify-between">
          <h1 className="m-0 text-[28px] font-extrabold tracking-[-0.02em]">Aluno sem carteirinha</h1>
          <button type="button" aria-label="Fechar" onClick={p.aoFechar} className="flex size-11 items-center justify-center rounded-xl border border-borda-2 bg-superficie text-texto">
            <IconeX />
          </button>
        </div>
        <label htmlFor="busca-aluno" className="text-[15px] font-bold text-texto-2">
          Nome do aluno (mínimo 3 letras)
        </label>
        <input
          id="busca-aluno"
          type="search"
          autoComplete="off"
          autoFocus={!p.alunoInicial}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="h-14 rounded-[14px] border-2 border-texto px-[18px] text-xl font-semibold text-texto outline-none"
        />
        <ul className="m-0 flex list-none flex-col gap-2 overflow-y-auto p-0" aria-live="polite" aria-busy={buscando}>
          {resultados?.length === 0 && <li className="text-[15px] text-texto-3">Nenhum aluno ativo com esse nome.</li>}
          {resultados?.map((a) => {
            const selecionado = escolhido?.id === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={!a.aceitaPin}
                  aria-pressed={selecionado}
                  onClick={() => escolher(a)}
                  className={`flex min-h-16 w-full items-center gap-3 rounded-[14px] px-4 py-2.5 text-left ${
                    selecionado
                      ? 'border-2 border-texto bg-fundo'
                      : a.aceitaPin
                        ? 'border border-borda-3 bg-superficie'
                        : 'border border-dashed border-borda-tracejada bg-fundo text-texto-3'
                  }`}
                >
                  <span className="flex grow flex-col">
                    <span className="text-lg font-bold">{a.nome}</span>
                    <span className="text-sm font-semibold text-texto-3">{a.turma ?? 'Sem turma'}</span>
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-[13px] font-bold ${a.aceitaPin ? 'bg-aprovado-suave text-aprovado-texto' : 'bg-neutro-2 text-texto-4'}`}>
                    {a.aceitaPin ? 'Aceita PIN' : 'PIN desativado'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mb-0 mt-auto text-sm leading-[1.45] text-texto-3">
          Só aparece "Aceita PIN" para alunos cujos responsáveis liberaram a compra sem carteirinha no app. Os responsáveis recebem aviso a cada compra feita assim.
        </p>
      </section>

      <section className="flex grow flex-col items-center gap-4 bg-fundo p-8">
        {escolhido ? (
          <>
            <div className="flex items-center gap-4 self-stretch">
              <FotoAluno alunoId={escolhido.id} nome={escolhido.nome} tamanho={104} />
              <div className="flex flex-col gap-1">
                <span className="text-[13px] font-bold uppercase tracking-[0.06em] text-texto-3">Confira a foto</span>
                <span className="text-2xl font-extrabold">{escolhido.nome}</span>
                {escolhido.turma && <span className="text-base font-semibold text-texto-2">{escolhido.turma}</span>}
              </div>
            </div>
            <p className="mb-0 mt-2 text-xl font-bold">Vire o tablet para o aluno digitar o PIN</p>
            <div ref={bolinhas} className="flex gap-4" role="img" aria-label={`PIN: ${pin.length} de 4 dígitos`}>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`size-[22px] rounded-full ${i < pin.length ? 'bg-texto' : 'border-2 border-[#9AA39D]'}`} />
              ))}
            </div>
            {erro && (
              <p role="alert" className="m-0 rounded-xl bg-recusado-suave px-4 py-2 text-center text-base font-bold text-recusado">
                {erro.mensagem}
                {erro.tentativasRestantes !== undefined && ` ${erro.tentativasRestantes} tentativa${erro.tentativasRestantes === 1 ? '' : 's'} restante${erro.tentativasRestantes === 1 ? '' : 's'}.`}
              </p>
            )}
            {!p.temItens && <p className="m-0 text-base font-bold text-aviso-texto">Monte o pedido antes de pedir o PIN.</p>}
            <TecladoNumerico
              desabilitado={p.cobrando || Boolean(erro?.bloqueado)}
              aoDigitar={(d) => setPin((x) => (x.length < 4 ? x + d : x))}
              aoApagar={() => setPin((x) => x.slice(0, -1))}
              confirmar={{ rotulo: p.cobrando ? '…' : 'OK', aria: 'Confirmar PIN', habilitado: pin.length === 4 && p.temItens, aoConfirmar: confirmar }}
            />
            <span className="text-sm font-semibold text-texto-3">5 tentativas erradas bloqueiam o PIN por 30 minutos</span>
          </>
        ) : (
          <p className="m-auto max-w-[360px] text-center text-lg font-semibold text-texto-3">Busque o aluno pelo nome e toque nele para pedir o PIN.</p>
        )}
      </section>
    </div>
  );
}

/** "PIN bloqueado... até 10:45" a partir do detalhe da API. */
export const mensagemPinBloqueado = (bloqueadoAte: string | undefined, fuso?: string) =>
  bloqueadoAte ? `PIN bloqueado por excesso de tentativas. Liberado às ${formatarHora(bloqueadoAte, fuso)}.` : 'PIN bloqueado por excesso de tentativas.';
