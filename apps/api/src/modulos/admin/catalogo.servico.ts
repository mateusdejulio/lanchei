// Catálogo da cantina: categorias e produtos. Nada é apagado: desativa-se.
// (Pedidos antigos e bloqueios dos pais apontam para estes registros.)
//
// Preço: sempre centavos inteiros. Mudar o preço NÃO altera pedidos antigos,
// porque cada item de pedido guarda o nome e o preço do momento da venda.
import { db, ehChaveDuplicada, type Db } from '../../infra/db.js';
import { auditarUsuario, type AtorUsuario } from '../../dominio/auditoria.js';
import { erros } from '../../erros.js';

const nomeDuplicado = (oQue: string) => erros.conflito('NOME_JA_EXISTE', `Já existe ${oQue} com este nome.`);

// ------------------------------------------------------------ categorias

export async function listarCategorias(escolaId: number) {
  const linhas = (await db('categorias_lanchei as c')
    .where('c.escola_id', escolaId)
    .orderBy([{ column: 'c.ativo', order: 'desc' }, { column: 'c.nome' }])
    .select(
      'c.id', 'c.nome', 'c.ativo',
      db.raw('(SELECT COUNT(*) FROM produtos_lanchei p WHERE p.categoria_id = c.id AND p.ativo) AS qtd_produtos'),
    )) as { id: number; nome: string; ativo: boolean; qtd_produtos: number }[];
  return linhas.map((c) => ({ id: c.id, nome: c.nome, ativo: c.ativo, qtdProdutosAtivos: Number(c.qtd_produtos) }));
}

const categoriaParaApi = async (escolaId: number, id: number) => (await listarCategorias(escolaId)).find((c) => c.id === id)!;

export async function criarCategoria(escolaId: number, nome: string, ator: AtorUsuario) {
  try {
    const id = await db.transaction(async (trx) => {
      const [id] = await trx('categorias_lanchei').insert({ escola_id: escolaId, nome });
      await auditarUsuario(trx, ator, { escolaId, acao: 'CATEGORIA_CRIAR', entidade: 'categorias', entidadeId: id!, depois: { nome } });
      return id!;
    });
    return categoriaParaApi(escolaId, id);
  } catch (e) {
    if (ehChaveDuplicada(e)) throw nomeDuplicado('uma categoria');
    throw e;
  }
}

export async function editarCategoria(escolaId: number, id: number, d: { nome?: string | undefined; ativo?: boolean | undefined }, ator: AtorUsuario) {
  try {
    await db.transaction(async (trx) => {
      const antes = await trx('categorias_lanchei').where({ id, escola_id: escolaId }).forUpdate().first<{ nome: string; ativo: boolean } | undefined>('nome', 'ativo');
      if (!antes) throw erros.naoEncontrado('Categoria não encontrada.');
      const mudancas: Record<string, unknown> = {};
      if (d.nome !== undefined && d.nome !== antes.nome) mudancas.nome = d.nome;
      if (d.ativo !== undefined && d.ativo !== antes.ativo) mudancas.ativo = d.ativo;
      if (Object.keys(mudancas).length === 0) return;
      await trx('categorias_lanchei').where({ id }).update(mudancas);
      await auditarUsuario(trx, ator, { escolaId, acao: 'CATEGORIA_EDITAR', entidade: 'categorias', entidadeId: id, antes, depois: mudancas });
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw nomeDuplicado('uma categoria');
    throw e;
  }
  return categoriaParaApi(escolaId, id);
}

// ------------------------------------------------------------ produtos

interface LinhaProduto {
  id: number;
  nome: string;
  categoria_id: number;
  categoria_nome: string;
  preco_centavos: number;
  ativo: boolean;
  controla_estoque: boolean;
  estoque_atual: number;
  estoque_minimo: number | null;
}

const produtoParaApi = (p: LinhaProduto) => ({
  id: p.id,
  nome: p.nome,
  categoria: { id: p.categoria_id, nome: p.categoria_nome },
  precoCentavos: p.preco_centavos,
  ativo: p.ativo,
  controlaEstoque: p.controla_estoque,
  // null = produto sem controle (ex.: lanche feito na hora)
  estoqueAtual: p.controla_estoque ? p.estoque_atual : null,
  estoqueMinimo: p.controla_estoque ? p.estoque_minimo : null,
});

function consultaProdutos(escolaId: number) {
  return db('produtos_lanchei as p')
    .join('categorias_lanchei as c', 'c.id', 'p.categoria_id')
    .where('p.escola_id', escolaId)
    .select('p.id', 'p.nome', 'p.categoria_id', 'c.nome as categoria_nome', 'p.preco_centavos', 'p.ativo', 'p.controla_estoque', 'p.estoque_atual', 'p.estoque_minimo');
}

export async function listarProdutos(escolaId: number, f: { categoriaId?: number | undefined; ativo?: boolean | undefined }) {
  const q = consultaProdutos(escolaId).orderBy([{ column: 'c.nome' }, { column: 'p.nome' }]);
  if (f.categoriaId !== undefined) q.andWhere('p.categoria_id', f.categoriaId);
  if (f.ativo !== undefined) q.andWhere('p.ativo', f.ativo);
  return ((await q) as LinhaProduto[]).map(produtoParaApi);
}

async function buscarProduto(escolaId: number, id: number) {
  const p = (await consultaProdutos(escolaId).andWhere('p.id', id).first()) as LinhaProduto | undefined;
  if (!p) throw erros.naoEncontrado('Produto não encontrado.');
  return produtoParaApi(p);
}

/** Categoria precisa ser DESTA escola (o banco também garante, pela FK composta). */
async function exigirCategoria(conn: Db, escolaId: number, categoriaId: number) {
  const c = await conn('categorias_lanchei').where({ id: categoriaId, escola_id: escolaId }).first('id');
  if (!c) throw erros.naoEncontrado('Categoria não encontrada.');
}

export interface DadosProduto {
  nome: string;
  categoriaId: number;
  precoCentavos: number;
  controlaEstoque: boolean;
  estoqueMinimo?: number | null | undefined;
}

export async function criarProduto(escolaId: number, d: DadosProduto, ator: AtorUsuario) {
  try {
    const id = await db.transaction(async (trx) => {
      await exigirCategoria(trx, escolaId, d.categoriaId);
      const [id] = await trx('produtos_lanchei').insert({
        escola_id: escolaId,
        categoria_id: d.categoriaId,
        nome: d.nome,
        preco_centavos: d.precoCentavos,
        controla_estoque: d.controlaEstoque,
        // Estoque começa em 0: a quantidade entra depois, como movimento ENTRADA
        // (assim o livro de movimentos explica todo o estoque desde o começo).
        estoque_minimo: d.controlaEstoque ? (d.estoqueMinimo ?? null) : null,
      });
      await auditarUsuario(trx, ator, {
        escolaId,
        acao: 'PRODUTO_CRIAR',
        entidade: 'produtos',
        entidadeId: id!,
        depois: { nome: d.nome, categoriaId: d.categoriaId, precoCentavos: d.precoCentavos, controlaEstoque: d.controlaEstoque },
      });
      return id!;
    });
    return buscarProduto(escolaId, id);
  } catch (e) {
    if (ehChaveDuplicada(e)) throw nomeDuplicado('um produto');
    throw e;
  }
}

export async function editarProduto(escolaId: number, id: number, d: Partial<DadosProduto> & { ativo?: boolean | undefined }, ator: AtorUsuario) {
  try {
    await db.transaction(async (trx) => {
      // Trava o produto: uma venda em andamento termina antes (ou espera) e
      // nunca enxerga o produto "pela metade".
      const antes = await trx('produtos_lanchei')
        .where({ id, escola_id: escolaId })
        .forUpdate()
        .first<
          | { nome: string; categoria_id: number; preco_centavos: number; ativo: boolean; controla_estoque: boolean; estoque_atual: number; estoque_minimo: number | null }
          | undefined
        >('nome', 'categoria_id', 'preco_centavos', 'ativo', 'controla_estoque', 'estoque_atual', 'estoque_minimo');
      if (!antes) throw erros.naoEncontrado('Produto não encontrado.');

      const mudancas: Record<string, unknown> = {};
      if (d.nome !== undefined && d.nome !== antes.nome) mudancas.nome = d.nome;
      if (d.precoCentavos !== undefined && d.precoCentavos !== antes.preco_centavos) mudancas.preco_centavos = d.precoCentavos;
      if (d.ativo !== undefined && d.ativo !== antes.ativo) mudancas.ativo = d.ativo;
      if (d.categoriaId !== undefined && d.categoriaId !== antes.categoria_id) {
        await exigirCategoria(trx, escolaId, d.categoriaId);
        mudancas.categoria_id = d.categoriaId;
      }

      const controla = d.controlaEstoque ?? antes.controla_estoque;
      if (d.controlaEstoque !== undefined && d.controlaEstoque !== antes.controla_estoque) {
        // Desligar o controle com itens na prateleira faria esse estoque "sumir"
        // sem nenhum movimento que explique. Primeiro zera com AJUSTE (com motivo).
        if (!d.controlaEstoque && antes.estoque_atual > 0) {
          throw erros.regra('ZERAR_ESTOQUE_ANTES', 'Zere o estoque com um ajuste (contagem 0) antes de desligar o controle.', {
            estoqueAtual: antes.estoque_atual,
          });
        }
        mudancas.controla_estoque = d.controlaEstoque;
      }
      if (!controla) {
        if (antes.estoque_minimo !== null) mudancas.estoque_minimo = null;
      } else if (d.estoqueMinimo !== undefined && d.estoqueMinimo !== antes.estoque_minimo) {
        mudancas.estoque_minimo = d.estoqueMinimo;
      }
      if (Object.keys(mudancas).length === 0) return;

      await trx('produtos_lanchei').where({ id }).update(mudancas);
      const antesDosCampos = Object.fromEntries(Object.keys(mudancas).map((c) => [c, antes[c as keyof typeof antes]]));
      await auditarUsuario(trx, ator, { escolaId, acao: 'PRODUTO_EDITAR', entidade: 'produtos', entidadeId: id, antes: antesDosCampos, depois: mudancas });
    });
  } catch (e) {
    if (ehChaveDuplicada(e)) throw nomeDuplicado('um produto');
    throw e;
  }
  return buscarProduto(escolaId, id);
}
