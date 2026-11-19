// Página do caixa (/caixa). Liga a máquina de estados (maquinaVenda.ts) à
// API e às telas. Aqui ficam os "efeitos" (rede, som, tempo); as regras do
// fluxo ficam todas no reducer puro.
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ErroApi,
  ErroRede,
  ErroSessao,
  ehErroApi,
  type AlunoIdentificado,
  type DetalhesFaltaEstoque,
  type DetalhesRecusa,
  type PedidoAprovado,
} from '@lanchei/shared';
import { api } from '../../compartilhado/api';
import { definirNomeDoCaixa, nomeDoCaixa } from '../../compartilhado/aparelho';
import { useConexao, useTelaLigada } from '../../compartilhado/hooks';
import { useSessao } from '../../compartilhado/sessao';
import { Modal } from '../../compartilhado/ui/Modal';
import {
  chaveDaCobranca,
  chaveDaCobrancaPin,
  estadoInicial,
  leituraAtiva,
  podeCobrar,
  podeCobrarComPin,
  reduzir,
  type Identificacao,
} from '../maquinaVenda';
import { som } from '../som';
import { atualizarDepoisDeMovimento, useCatalogo } from '../consultas';
import { Cabecalho } from '../componentes/Cabecalho';
import { Catalogo } from '../componentes/Catalogo';
import { PainelPedido } from '../componentes/PainelPedido';
import { TelaAprovado, TelaRecusado } from '../componentes/Resultado';
import { mensagemPinBloqueado, ModalSemCarteirinha, type AlunoEscolhido } from '../componentes/ModalSemCarteirinha';
import { GavetaVendasHoje } from '../componentes/GavetaVendasHoje';

const SEGUNDOS_AVISO = 3;
/** Privacidade: aluno identificado e parado por 60 s volta para OCIOSO (a foto some). */
const SEGUNDOS_IDENTIFICADO_PARADO = 60;

export function PaginaCaixa() {
  const { usuario, sair } = useSessao();
  const navegar = useNavigate();
  const qc = useQueryClient();
  const catalogo = useCatalogo();
  const conexao = useConexao();
  useTelaLigada();

  const [estado, despachar] = useReducer(reduzir, estadoInicial);
  const [modalPin, setModalPin] = useState(false);
  const [gaveta, setGaveta] = useState(false);
  const [nomeCaixa, setNomeCaixa] = useState(nomeDoCaixa);
  const [renomeando, setRenomeando] = useState(false);

  const produtos = useMemo(() => new Map((catalogo.data?.categorias ?? []).flatMap((c) => c.produtos).map((p) => [p.id, p])), [catalogo.data]);
  // Total só para MOSTRAR: o servidor recalcula com os preços do banco.
  const total = estado.itens.reduce((s, i) => s + (produtos.get(i.produtoId)?.precoCentavos ?? 0) * i.quantidade, 0);

  // Aviso curto (ex.: carteirinha não reconhecida) some sozinho.
  useEffect(() => {
    if (!estado.aviso) return;
    const t = setTimeout(() => despachar({ tipo: 'LIMPAR_AVISO' }), SEGUNDOS_AVISO * 1000);
    return () => clearTimeout(t);
  }, [estado.aviso]);

  // 60 s sem ação com um aluno na tela: limpa. Qualquer mudança no pedido reinicia a contagem.
  useEffect(() => {
    if (estado.fase !== 'IDENTIFICADO' || modalPin) return;
    const t = setTimeout(() => despachar({ tipo: 'TEMPO_ESGOTADO' }), SEGUNDOS_IDENTIFICADO_PARADO * 1000);
    return () => clearTimeout(t);
  }, [estado.fase, estado.itens, modalPin]);

  // ------------------------------------------------------------ leitura do QR
  const aoLerQr = useCallback(
    async (qrConteudo: string) => {
      som.leitura();
      despachar({ tipo: 'QR_LIDO', qrConteudo });
      try {
        const r = await api.post<AlunoIdentificado>('/v1/caixa/identificar', { qrConteudo });
        conexao.avisarSucesso();
        despachar({ tipo: 'IDENTIFICOU', aluno: { id: r.aluno.id, nome: r.aluno.nome, turma: r.aluno.turma, carteirinha: r.carteirinha.status } });
      } catch (e) {
        if (e instanceof ErroRede) conexao.avisarFalha();
        despachar({
          tipo: 'IDENTIFICACAO_FALHOU',
          mensagem: ehErroApi(e, 'CARTEIRINHA_INVALIDA')
            ? 'Carteirinha não reconhecida'
            : e instanceof ErroRede
              ? 'Sem conexão. Mostre a carteirinha de novo.'
              : 'Não foi possível ler a carteirinha',
        });
      }
    },
    [conexao],
  );

  // Gancho de teste (etapa5 §12): com localStorage "lanchei:modo-teste" = "1",
  // window.__lancheiLerQr("LCH1....") simula a câmera lendo uma carteirinha.
  // Serve para testes de ponta a ponta e para demonstrar o caixa num
  // computador sem câmera. Não dá acesso a nada além do que a câmera daria.
  useEffect(() => {
    let ligado = false;
    try {
      ligado = localStorage.getItem('lanchei:modo-teste') === '1';
    } catch {
      // sem armazenamento: sem gancho
    }
    if (!ligado) return;
    const w = window as unknown as { __lancheiLerQr?: (qr: string) => void };
    w.__lancheiLerQr = (qr) => void aoLerQr(qr);
    return () => {
      delete w.__lancheiLerQr;
    };
  }, [aoLerQr]);

  // ------------------------------------------------------------ cobrança
  async function enviarCobranca(chave: string, identificacao: Identificacao | { tipo: 'PIN'; alunoId: number; pin: string }) {
    try {
      const r = await api.post<PedidoAprovado>('/v1/caixa/pedidos', { identificacao, itens: estado.itens }, { idempotencyKey: chave });
      conexao.avisarSucesso();
      som.aprovado();
      setModalPin(false);
      despachar({ tipo: 'APROVOU', pedido: r.pedido });
      atualizarDepoisDeMovimento(qc);
    } catch (e) {
      tratarErroDaCobranca(e);
    }
  }

  function tratarErroDaCobranca(e: unknown) {
    if (e instanceof ErroSessao) return; // o app volta para o login sozinho
    // Sem resposta, ou o servidor quebrou no meio: NÃO sabemos se cobrou.
    // "Tentar de novo" usa a MESMA chave: se cobrou, a API devolve o mesmo resultado.
    if (e instanceof ErroRede || (e instanceof ErroApi && e.status >= 500)) {
      if (e instanceof ErroRede) conexao.avisarFalha();
      setModalPin(false);
      despachar({ tipo: 'ERRO_REDE' });
      return;
    }
    if (!(e instanceof ErroApi)) {
      setModalPin(false);
      despachar({ tipo: 'ERRO_COBRANCA', mensagem: 'Erro inesperado. Nada foi cobrado.' });
      return;
    }
    switch (e.codigo) {
      case 'COMPRA_RECUSADA':
        som.recusado();
        setModalPin(false);
        despachar({ tipo: 'RECUSOU', detalhes: e.detalhes as DetalhesRecusa, mensagem: e.message });
        void qc.invalidateQueries({ queryKey: ['caixa', 'vendas-hoje'] });
        return;
      case 'ESTOQUE_INSUFICIENTE':
        setModalPin(false);
        despachar({ tipo: 'FALTA_ESTOQUE', detalhes: e.detalhes as DetalhesFaltaEstoque });
        atualizarDepoisDeMovimento(qc);
        return;
      case 'PIN_INCORRETO':
        som.recusado();
        despachar({ tipo: 'FALHA_PIN', mensagem: 'PIN incorreto.', tentativasRestantes: (e.detalhes as { tentativasRestantes?: number })?.tentativasRestantes });
        return;
      case 'PIN_BLOQUEADO':
        som.recusado();
        despachar({ tipo: 'FALHA_PIN', mensagem: mensagemPinBloqueado((e.detalhes as { bloqueadoAte?: string })?.bloqueadoAte), bloqueado: true });
        return;
      case 'SEM_CARTEIRINHA_DESATIVADO':
        despachar({ tipo: 'FALHA_PIN', mensagem: e.message, bloqueado: true });
        return;
      default:
        setModalPin(false);
        despachar({ tipo: 'ERRO_COBRANCA', mensagem: `${e.message} Nada foi cobrado.` });
        if (e.codigo === 'PRODUTO_INDISPONIVEL') void catalogo.refetch();
    }
  }

  function cobrar() {
    if (!estado.aluno) return;
    if (estado.aluno.identificacao.tipo === 'PIN') {
      setModalPin(true); // o PIN é digitado de novo a cada cobrança
      return;
    }
    if (!podeCobrar(estado)) return;
    const chave = chaveDaCobranca(estado, crypto.randomUUID());
    despachar({ tipo: 'COBRAR', novaChave: chave });
    void enviarCobranca(chave, estado.aluno.identificacao);
  }

  function cobrarComPin(aluno: AlunoEscolhido, pin: string) {
    if (!podeCobrarComPin(estado)) return;
    const chave = chaveDaCobrancaPin(estado, aluno.id, crypto.randomUUID());
    despachar({ tipo: 'COBRAR_COM_PIN', aluno, novaChave: chave });
    void enviarCobranca(chave, { tipo: 'PIN', alunoId: aluno.id, pin }); // o PIN vai direto, não fica no estado
  }

  function tentarDeNovo() {
    if (!estado.aluno || !estado.chave) return;
    if (estado.aluno.identificacao.tipo === 'PIN') {
      setModalPin(true); // reabre o teclado: o PIN não ficou guardado (a chave sim)
      return;
    }
    despachar({ tipo: 'TENTAR_DE_NOVO' });
    void enviarCobranca(estado.chave, estado.aluno.identificacao);
  }

  function fecharModalPin() {
    setModalPin(false);
    // Fechou sem cobrar: o aluno escolhido pelo PIN sai da tela.
    if (estado.aluno?.identificacao.tipo === 'PIN' && estado.fase === 'IDENTIFICADO') despachar({ tipo: 'CANCELAR_LEITURA' });
  }

  const alunoPin: AlunoEscolhido | null =
    estado.aluno?.identificacao.tipo === 'PIN' ? { id: estado.aluno.id, nome: estado.aluno.nome, turma: estado.aluno.turma } : null;

  return (
    <div className="flex h-full flex-col">
      <Cabecalho
        nomeCaixa={nomeCaixa}
        online={conexao.online}
        operador={usuario?.nome ?? ''}
        ocupado={estado.fase === 'COBRANDO'}
        aoSemCarteirinha={() => setModalPin(true)}
        aoVendasDeHoje={() => setGaveta(true)}
        aoEstoque={() => navegar('/caixa/estoque')}
        aoRenomearCaixa={() => setRenomeando(true)}
        aoTrocarAtendente={async () => {
          await sair();
          navegar('/login');
        }}
      />
      <div className="flex min-h-0 grow">
        <Catalogo
          catalogo={catalogo.data}
          itens={estado.itens}
          destaques={estado.destaques}
          podeAdicionar={['OCIOSO', 'IDENTIFICANDO', 'IDENTIFICADO'].includes(estado.fase)}
          aoAdicionar={(produtoId) => despachar({ tipo: 'ADICIONAR', produtoId })}
        />
        <PainelPedido
          estado={estado}
          produtos={produtos}
          totalCentavos={total}
          online={conexao.online}
          leituraAtiva={leituraAtiva(estado) && !modalPin && !gaveta && !renomeando}
          aoLerQr={aoLerQr}
          aoAdicionar={(produtoId) => despachar({ tipo: 'ADICIONAR', produtoId })}
          aoRemover={(produtoId) => despachar({ tipo: 'REMOVER', produtoId })}
          aoLimpar={() => despachar({ tipo: 'LIMPAR_ITENS' })}
          aoCancelarLeitura={() => despachar({ tipo: 'CANCELAR_LEITURA' })}
          aoCobrar={cobrar}
          aoTentarDeNovo={tentarDeNovo}
          aoCancelarVenda={() => despachar({ tipo: 'CANCELAR_VENDA' })}
        />
      </div>

      <ModalSemCarteirinha
        aberto={modalPin}
        alunoInicial={alunoPin}
        temItens={estado.itens.length > 0}
        cobrando={estado.fase === 'COBRANDO'}
        erroPin={estado.erroPin}
        falhasPin={estado.falhasPin}
        aoFechar={fecharModalPin}
        aoConfirmar={cobrarComPin}
      />
      <GavetaVendasHoje aberta={gaveta} aoFechar={() => setGaveta(false)} />

      {estado.fase === 'APROVADO' && estado.aprovado && estado.aluno && (
        <TelaAprovado
          nome={estado.aluno.nome}
          turma={estado.aluno.turma}
          totalCentavos={estado.aprovado.totalCentavos}
          itens={estado.aprovado.itens}
          aoProximo={() => despachar({ tipo: 'PROXIMO' })}
        />
      )}
      {estado.fase === 'RECUSADO' && estado.recusa && estado.aluno && (
        <TelaRecusado
          alunoId={estado.aluno.id}
          nome={estado.aluno.nome}
          turma={estado.aluno.turma}
          totalCentavos={total}
          motivo={estado.recusa.motivo}
          aoEditar={() => despachar({ tipo: 'EDITAR_PEDIDO' })}
          aoCancelar={() => despachar({ tipo: 'CANCELAR_VENDA' })}
        />
      )}

      {renomeando && (
        <ModalNomeCaixa
          atual={nomeCaixa}
          aoFechar={() => setRenomeando(false)}
          aoSalvar={(nome) => {
            definirNomeDoCaixa(nome);
            setNomeCaixa(nomeDoCaixa());
            setRenomeando(false);
          }}
        />
      )}
    </div>
  );
}

function ModalNomeCaixa({ atual, aoFechar, aoSalvar }: { atual: string; aoFechar: () => void; aoSalvar: (n: string) => void }) {
  const [nome, setNome] = useState(atual);
  return (
    <Modal aberto aoFechar={aoFechar} rotulo="Nome deste caixa" className="w-[480px]">
      <form
        className="flex flex-col gap-4 p-8"
        onSubmit={(e) => {
          e.preventDefault();
          aoSalvar(nome);
        }}
      >
        <h2 className="m-0 text-2xl font-extrabold">Nome deste caixa</h2>
        <p className="m-0 text-base text-texto-2">Com dois tablets, use "Caixa 1" e "Caixa 2". Fica salvo neste aparelho.</p>
        <input aria-label="Nome do caixa" autoFocus maxLength={20} value={nome} onChange={(e) => setNome(e.target.value)} className="h-14 rounded-xl border-2 border-texto px-4 text-xl font-semibold" />
        <div className="flex gap-3">
          <button type="button" onClick={aoFechar} className="h-14 grow rounded-2xl border-2 border-texto text-lg font-extrabold">
            Cancelar
          </button>
          <button type="submit" className="h-14 grow rounded-2xl bg-texto text-lg font-extrabold text-white">
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}
