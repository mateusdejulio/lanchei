// Componentes do caixa (Testing Library): botão Cobrar, tela de recusa por
// motivo, selo dos produtos e o teclado do PIN.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEXTOS_RECUSA, type MotivoRecusa, type ProdutoCaixa } from '@lanchei/shared';
import { estadoInicial, reduzir, type Acao, type Estado } from '../src/caixa/maquinaVenda';
import { BotaoCobrar } from '../src/caixa/componentes/PainelPedido';
import { TelaRecusado } from '../src/caixa/componentes/Resultado';
import { seloDoProduto } from '../src/caixa/componentes/Catalogo';
import { TecladoNumerico } from '../src/compartilhado/ui/TecladoNumerico';

// A foto do aluno faz requisição: nos testes, nunca chega (fica "carregando").
vi.mock('../src/compartilhado/api', () => ({ api: { get: () => new Promise(() => undefined) } }));

const aplicar = (acoes: Acao[]) => acoes.reduce(reduzir, estadoInicial);
const identificado: Estado = aplicar([
  { tipo: 'ADICIONAR', produtoId: 1 },
  { tipo: 'QR_LIDO', qrConteudo: 'LCH1.x' },
  { tipo: 'IDENTIFICOU', aluno: { id: 1, nome: 'Ana', turma: '7º B', carteirinha: 'ATIVA' } },
]);

describe('botão Cobrar', () => {
  const botao = (e: Estado, online = true) => {
    render(<BotaoCobrar estado={e} online={online} totalCentavos={1800} aoCobrar={() => undefined} />);
    return screen.getByRole('button');
  };

  it('sem aluno: desabilitado, pedindo a carteirinha', () => {
    const b = botao(aplicar([{ tipo: 'ADICIONAR', produtoId: 1 }]));
    expect(b).toBeDisabled();
    expect(b).toHaveTextContent('Leia a carteirinha para cobrar');
  });

  it('com aluno e itens: verde, com o valor, e chama aoCobrar', async () => {
    const aoCobrar = vi.fn();
    render(<BotaoCobrar estado={identificado} online totalCentavos={1800} aoCobrar={aoCobrar} />);
    const b = screen.getByRole('button', { name: 'Cobrar R$ 18,00' });
    await userEvent.click(b);
    expect(aoCobrar).toHaveBeenCalledOnce();
  });

  it('cobrando: desabilitado com spinner (não dá para clicar duas vezes)', () => {
    const b = botao(reduzir(identificado, { tipo: 'COBRAR', novaChave: 'k' }));
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
  });

  it('sem conexão: vendas pausadas', () => {
    expect(botao(identificado, false)).toHaveTextContent('Sem conexão: vendas pausadas');
  });
});

describe('tela de recusa', () => {
  it.each(Object.keys(TEXTOS_RECUSA) as MotivoRecusa[])('%s: título e orientação para a atendente', (motivo) => {
    render(<TelaRecusado alunoId={1} nome="Ana Beatriz" turma="7º B" totalCentavos={1800} motivo={motivo} aoEditar={() => undefined} aoCancelar={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Compra recusada' })).toBeInTheDocument();
    expect(screen.getByText(TEXTOS_RECUSA[motivo].titulo)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TEXTOS_RECUSA[motivo].orientacaoCaixa.slice(0, 30)))).toHaveTextContent('Os responsáveis foram avisados no app.');
    expect(screen.getByText('7º B · pedido de R$ 18,00')).toBeInTheDocument();
  });

  it('o saldo NUNCA aparece (nem no saldo insuficiente)', () => {
    const { container } = render(
      <TelaRecusado alunoId={1} nome="Ana" turma={null} totalCentavos={1800} motivo="SALDO_INSUFICIENTE" aoEditar={() => undefined} aoCancelar={() => undefined} />,
    );
    expect(container.textContent).not.toMatch(/saldo de|saldo atual|R\$ \d+,\d+ de saldo/i);
  });
});

describe('selo do produto', () => {
  const p = (estoqueDisponivel: number | null, estoqueMinimo: number | null = null): ProdutoCaixa => ({ id: 1, nome: 'X', precoCentavos: 100, estoqueDisponivel, estoqueMinimo });
  it('prioridade: destaque > no pedido > esgotado > restam (mínimo) > unidades', () => {
    expect(seloDoProduto(p(3, 5), 0, { produtoId: 1, motivo: 'BLOQUEADO' })?.texto).toBe('Bloqueado');
    expect(seloDoProduto(p(3, 5), 0, { produtoId: 1, motivo: 'ESTOQUE', disponivel: 1 })?.texto).toBe('Só restam 1');
    expect(seloDoProduto(p(3, 5), 2, undefined)?.texto).toBe('2 no pedido');
    expect(seloDoProduto(p(0), 0, undefined)?.texto).toBe('Esgotado');
    expect(seloDoProduto(p(3, 5), 0, undefined)?.texto).toBe('Restam 3');
    expect(seloDoProduto(p(24, 5), 0, undefined)?.texto).toBe('24 un.');
    expect(seloDoProduto(p(null), 0, undefined)).toBeNull(); // sem controle de estoque
  });
});

describe('teclado numérico do PIN', () => {
  it('digita, apaga e só libera o OK quando o chamador permite', async () => {
    const digitos: string[] = [];
    const aoConfirmar = vi.fn();
    const { rerender } = render(
      <TecladoNumerico aoDigitar={(d) => digitos.push(d)} aoApagar={() => digitos.pop()} confirmar={{ rotulo: 'OK', aria: 'Confirmar PIN', habilitado: false, aoConfirmar }} />,
    );
    for (const d of ['4', '8', '2', '1']) await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    expect(digitos).toEqual(['4', '8', '2']);
    expect(screen.getByRole('button', { name: 'Confirmar PIN' })).toBeDisabled();

    rerender(<TecladoNumerico aoDigitar={() => undefined} aoApagar={() => undefined} confirmar={{ rotulo: 'OK', aria: 'Confirmar PIN', habilitado: true, aoConfirmar }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar PIN' }));
    expect(aoConfirmar).toHaveBeenCalledOnce();
  });
});
