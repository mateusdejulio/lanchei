// Máquina de estados da venda: todas as transições e a regra da Idempotency-Key.
import { describe, expect, it } from 'vitest';
import { estadoInicial, podeCobrar, reduzir, type Acao, type Estado } from '../src/caixa/maquinaVenda';

const aplicar = (acoes: Acao[], e: Estado = estadoInicial) => acoes.reduce(reduzir, e);
const ALUNO = { id: 42, nome: 'Ana Beatriz Souza', turma: '7º B', carteirinha: 'ATIVA' as const };
const QR = 'LCH1.abcdefghijklmnop';
const pedido = { id: 9, totalCentavos: 1800, itens: [] };

/** Atalho: pedido com 2 itens + aluno identificado pela carteirinha. */
const identificado = () => aplicar([{ tipo: 'ADICIONAR', produtoId: 1 }, { tipo: 'ADICIONAR', produtoId: 2 }, { tipo: 'QR_LIDO', qrConteudo: QR }, { tipo: 'IDENTIFICOU', aluno: ALUNO }]);

describe('montando o pedido', () => {
  it('+1/-1 agrupam por produto e somem ao zerar; pode montar antes ou depois da leitura', () => {
    let e = aplicar([{ tipo: 'ADICIONAR', produtoId: 7 }, { tipo: 'ADICIONAR', produtoId: 7 }, { tipo: 'ADICIONAR', produtoId: 3 }]);
    expect(e.itens).toEqual([{ produtoId: 7, quantidade: 2 }, { produtoId: 3, quantidade: 1 }]);
    e = aplicar([{ tipo: 'REMOVER', produtoId: 3 }], e);
    expect(e.itens).toEqual([{ produtoId: 7, quantidade: 2 }]);
    e = aplicar([{ tipo: 'QR_LIDO', qrConteudo: QR }, { tipo: 'IDENTIFICOU', aluno: ALUNO }, { tipo: 'ADICIONAR', produtoId: 5 }], e);
    expect(e.fase).toBe('IDENTIFICADO');
    expect(e.itens).toHaveLength(2);
  });

  it('"Cobrar" só com aluno IDENTIFICADO e pelo menos 1 item', () => {
    expect(podeCobrar(aplicar([{ tipo: 'ADICIONAR', produtoId: 1 }]))).toBe(false); // sem aluno
    expect(podeCobrar(aplicar([{ tipo: 'QR_LIDO', qrConteudo: QR }, { tipo: 'IDENTIFICOU', aluno: ALUNO }]))).toBe(false); // sem item
    expect(podeCobrar(identificado())).toBe(true);
    // COBRAR fora de hora é ignorado
    expect(aplicar([{ tipo: 'COBRAR', novaChave: 'k' }], aplicar([{ tipo: 'ADICIONAR', produtoId: 1 }])).fase).toBe('OCIOSO');
  });
});

describe('leitura da carteirinha', () => {
  it('OCIOSO → IDENTIFICANDO → IDENTIFICADO (guarda o QR para a cobrança)', () => {
    const e = identificado();
    expect(e.fase).toBe('IDENTIFICADO');
    expect(e.aluno).toMatchObject({ id: 42, identificacao: { tipo: 'CARTEIRINHA', qrConteudo: QR } });
  });

  it('carteirinha inválida: volta a OCIOSO com aviso e SEM dados de aluno', () => {
    const e = aplicar([{ tipo: 'QR_LIDO', qrConteudo: QR }, { tipo: 'IDENTIFICACAO_FALHOU', mensagem: 'Carteirinha não reconhecida' }]);
    expect(e).toMatchObject({ fase: 'OCIOSO', aluno: null, aviso: 'Carteirinha não reconhecida' });
    expect(aplicar([{ tipo: 'LIMPAR_AVISO' }], e).aviso).toBeNull();
  });

  it('outra leitura com aluno na tela é ignorada (a câmera só lê parada)', () => {
    const e = aplicar([{ tipo: 'QR_LIDO', qrConteudo: 'LCH1.outra-carteirinha' }], identificado());
    expect(e.aluno?.id).toBe(42);
  });

  it('cancelar leitura e 60 s parado limpam o aluno (privacidade), mas mantêm o pedido', () => {
    for (const tipo of ['CANCELAR_LEITURA', 'TEMPO_ESGOTADO'] as const) {
      const e = aplicar([{ tipo }], identificado());
      expect(e).toMatchObject({ fase: 'OCIOSO', aluno: null });
      expect(e.itens).toHaveLength(2);
    }
  });
});

describe('cobrança e Idempotency-Key', () => {
  it('COBRAR cria a chave; 201 → APROVADO e a chave é descartada; "Próximo" limpa tudo', () => {
    let e = aplicar([{ tipo: 'COBRAR', novaChave: 'chave-1' }], identificado());
    expect(e).toMatchObject({ fase: 'COBRANDO', chave: 'chave-1' });
    e = aplicar([{ tipo: 'APROVOU', pedido }], e);
    expect(e).toMatchObject({ fase: 'APROVADO', chave: null, aprovado: { pedidoId: 9 } });
    e = aplicar([{ tipo: 'PROXIMO' }], e);
    expect(e).toMatchObject({ fase: 'OCIOSO', itens: [], aluno: null });
  });

  it('ERRO_REDE → "Tentar de novo" usa a MESMA chave (não cobra duas vezes)', () => {
    let e = aplicar([{ tipo: 'COBRAR', novaChave: 'chave-1' }, { tipo: 'ERRO_REDE' }], identificado());
    expect(e).toMatchObject({ fase: 'ERRO_REDE', chave: 'chave-1' });
    e = aplicar([{ tipo: 'TENTAR_DE_NOVO' }], e);
    expect(e).toMatchObject({ fase: 'COBRANDO', chave: 'chave-1' });
  });

  it('mudar item ou aluno descarta a chave; a próxima cobrança usa uma nova', () => {
    const erroRede = aplicar([{ tipo: 'COBRAR', novaChave: 'chave-1' }, { tipo: 'ERRO_REDE' }], identificado());
    // Em ERRO_REDE o pedido está travado (não dá para editar no meio da dúvida).
    expect(aplicar([{ tipo: 'ADICIONAR', produtoId: 9 }], erroRede).itens).toEqual(erroRede.itens);
    // Cancelou e montou de novo: chave nova.
    let e = aplicar([{ tipo: 'CANCELAR_VENDA' }, { tipo: 'ADICIONAR', produtoId: 1 }, { tipo: 'QR_LIDO', qrConteudo: QR }, { tipo: 'IDENTIFICOU', aluno: ALUNO }], erroRede);
    e = aplicar([{ tipo: 'COBRAR', novaChave: 'chave-2' }], e);
    expect(e.chave).toBe('chave-2');
  });

  it('em COBRANDO nada muda o pedido nem cancela (esperando o servidor)', () => {
    const e = aplicar([{ tipo: 'COBRAR', novaChave: 'k' }], identificado());
    for (const a of [{ tipo: 'ADICIONAR', produtoId: 1 }, { tipo: 'LIMPAR_ITENS' }, { tipo: 'CANCELAR_VENDA' }, { tipo: 'CANCELAR_LEITURA' }] as Acao[]) {
      expect(reduzir(e, a)).toBe(e);
    }
  });

  it('422 → RECUSADO (chave descartada); "Editar pedido" volta ao aluno com chave NOVA na próxima', () => {
    let e = aplicar([{ tipo: 'COBRAR', novaChave: 'chave-1' }, { tipo: 'RECUSOU', detalhes: { motivo: 'ITEM_BLOQUEADO', pedidoId: 5, produtoIds: [2] }, mensagem: 'x' }], identificado());
    expect(e).toMatchObject({ fase: 'RECUSADO', chave: null, recusa: { motivo: 'ITEM_BLOQUEADO' } });
    expect(e.destaques).toEqual([{ produtoId: 2, motivo: 'BLOQUEADO' }]);
    e = aplicar([{ tipo: 'EDITAR_PEDIDO' }], e);
    expect(e.fase).toBe('IDENTIFICADO');
    // tirou o item bloqueado: o destaque some
    e = aplicar([{ tipo: 'REMOVER', produtoId: 2 }, { tipo: 'COBRAR', novaChave: 'chave-2' }], e);
    expect(e).toMatchObject({ destaques: [], chave: 'chave-2' });
  });

  it('"Cancelar venda" na recusa limpa tudo', () => {
    const e = aplicar([{ tipo: 'COBRAR', novaChave: 'k' }, { tipo: 'RECUSOU', detalhes: { motivo: 'SALDO_INSUFICIENTE', pedidoId: 5 }, mensagem: 'x' }, { tipo: 'CANCELAR_VENDA' }], identificado());
    expect(e).toMatchObject({ fase: 'OCIOSO', itens: [], aluno: null, recusa: null });
  });

  it('409 sem estoque: SEM tela vermelha, volta ao aluno com os itens destacados', () => {
    const e = aplicar([{ tipo: 'COBRAR', novaChave: 'k' }, { tipo: 'FALTA_ESTOQUE', detalhes: { itens: [{ produtoId: 1, disponivel: 0 }] } }], identificado());
    expect(e).toMatchObject({ fase: 'IDENTIFICADO', chave: null, destaques: [{ produtoId: 1, motivo: 'ESTOQUE', disponivel: 0 }] });
    expect(e.aluno?.id).toBe(42);
  });

  it('outro erro (ex.: produto desativado) volta ao aluno com aviso e chave descartada', () => {
    const e = aplicar([{ tipo: 'COBRAR', novaChave: 'k' }, { tipo: 'ERRO_COBRANCA', mensagem: 'Produto inexistente ou inativo.' }], identificado());
    expect(e).toMatchObject({ fase: 'IDENTIFICADO', chave: null, aviso: 'Produto inexistente ou inativo.' });
  });
});

describe('compra sem carteirinha (PIN)', () => {
  const ANA = { id: 42, nome: 'Ana Beatriz Souza', turma: '7º B' };
  const comItens = () => aplicar([{ tipo: 'ADICIONAR', produtoId: 1 }]);

  it('o PIN NUNCA entra no estado: só o aluno escolhido', () => {
    const e = aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k1' }], comItens());
    expect(e).toMatchObject({ fase: 'COBRANDO', chave: 'k1', aluno: { id: 42, identificacao: { tipo: 'PIN', alunoId: 42 } } });
    expect(JSON.stringify(e)).not.toMatch(/"pin"\s*:/);
  });

  it('sem itens não cobra', () => {
    expect(aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k' }]).fase).toBe('OCIOSO');
  });

  it('PIN errado: volta com o erro (para o teclado mostrar), conta a falha e descarta a chave', () => {
    const e = aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k1' }, { tipo: 'FALHA_PIN', mensagem: 'PIN incorreto.', tentativasRestantes: 3 }], comItens());
    expect(e).toMatchObject({ fase: 'IDENTIFICADO', chave: null, erroPin: { tentativasRestantes: 3 }, falhasPin: 1 });
    // nova tentativa limpa o erro
    expect(aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k2' }], e).erroPin).toBeNull();
  });

  it('rede caiu com PIN: a retentativa do MESMO aluno reaproveita a chave; outro aluno usa outra', () => {
    const e = aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k1' }, { tipo: 'ERRO_REDE' }], comItens());
    expect(aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: ANA, novaChave: 'k2' }], e).chave).toBe('k1');
    expect(aplicar([{ tipo: 'COBRAR_COM_PIN', aluno: { ...ANA, id: 77 }, novaChave: 'k3' }], e).chave).toBe('k3');
    // e o "Tentar de novo" da carteirinha não serve para PIN (reabre o teclado)
    expect(aplicar([{ tipo: 'TENTAR_DE_NOVO' }], e).fase).toBe('ERRO_REDE');
  });
});
