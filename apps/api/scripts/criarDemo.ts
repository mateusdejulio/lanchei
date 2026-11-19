// Dados de DEMONSTRAÇÃO para o desenvolvimento (nunca em produção):
//   npm run db:demo -w apps/api
//
// Cria a "Escola Demonstração" com o mesmo cardápio do mockup do caixa,
// uma atendente, a Cantina e a Diretoria, e a aluna Ana Beatriz (7º B) com
// saldo, carteirinha e PIN. No fim, imprime os logins e o conteúdo do QR
// (para gerar a carteirinha num site de QR e testar com a câmera do tablet).
// Rodar de novo não duplica nada: se a escola já existe, só avisa.
import { db } from '../src/infra/db.js';
import { env } from '../src/config/env.js';
import { hashSenha, sha256, tokenAleatorio } from '../src/infra/cripto.js';
import { lancarTransacao } from '../src/dominio/ledger.js';
import { movimentarEstoque } from '../src/dominio/estoque.js';
import { montarQr } from '../src/modulos/caixa/identificacao.js';

if (env.NODE_ENV === 'production') {
  console.error('db:demo é só para desenvolvimento.');
  process.exit(1);
}

const SENHA = 'demo-lanchei-123';
const SLUG = 'demo';

if (await db('escolas_lanchei').where({ slug: SLUG }).first()) {
  console.log(`A escola de demonstração já existe. Logins: cida@demo.lanchei, cantina@demo.lanchei, secretaria@demo.lanchei (senha ${SENHA}).`);
  console.log('Para recriar do zero: npm run db:schema -w apps/api -- --recriar && npm run db:demo -w apps/api');
  await db.destroy();
  process.exit(0);
}

const senhaHash = await hashSenha(SENHA);
const qrToken = tokenAleatorio(16);

await db.transaction(async (trx) => {
  const [escolaId] = await trx('escolas_lanchei').insert({ nome: 'Escola Demonstração', slug: SLUG });
  const usuario = async (papel: string, nome: string, email: string) =>
    (await trx('usuarios_lanchei').insert({ escola_id: escolaId, papel, nome, email, senha_hash: senhaHash }))[0]!;
  const adminId = await usuario('ADMIN', 'Carlos Cantina', 'cantina@demo.lanchei');
  await usuario('OPERADOR', 'Tia Cida', 'cida@demo.lanchei');
  const diretoriaId = await usuario('ESCOLA', 'Secretaria', 'secretaria@demo.lanchei');

  // Cardápio do mockup ("Lanchei — Tela do caixa (tablet)").
  const cardapio: Record<string, [string, number, number | null, number | null][]> = {
    // [nome, preço em centavos, estoque inicial (null = não controla), estoque mínimo]
    Salgados: [['Pão de queijo', 400, null, null], ['Coxinha', 650, null, null], ['Misto quente', 750, null, null], ['Esfiha de carne', 600, null, null]],
    Bebidas: [['Suco natural', 650, null, null], ['Água 500 ml', 300, 24, 5], ['Refrigerante lata', 550, 3, 5], ['Achocolatado', 450, 12, 4]],
    Doces: [['Chocolate', 400, 0, 5], ['Bala de goma', 150, 40, 10]],
    Frutas: [['Salada de frutas', 600, null, null], ['Banana', 200, null, null]],
  };
  for (const [categoria, produtos] of Object.entries(cardapio)) {
    const [categoriaId] = await trx('categorias_lanchei').insert({ escola_id: escolaId, nome: categoria });
    for (const [nome, preco, estoque, minimo] of produtos) {
      const [produtoId] = await trx('produtos_lanchei').insert({
        escola_id: escolaId, categoria_id: categoriaId, nome, preco_centavos: preco, controla_estoque: estoque !== null, estoque_minimo: minimo,
      });
      if (estoque) await movimentarEstoque(trx, { escolaId: escolaId!, produtoId: produtoId!, tipo: 'ENTRADA', quantidade: estoque, usuarioId: adminId });
    }
  }

  const [turmaId] = await trx('turmas_lanchei').insert({ escola_id: escolaId, nome: '7º B', ano_letivo: new Date().getFullYear() });
  const [alunoId] = await trx('alunos_lanchei').insert({
    escola_id: escolaId, turma_id: turmaId, nome: 'Ana Beatriz Souza', matricula: 'DEMO-001', pin_hash: await hashSenha('4821'),
  });
  // Todos os dias liberados (para a demonstração funcionar no fim de semana), compra sem carteirinha ligada.
  await trx('regras_aluno_lanchei').insert({ aluno_id: alunoId, dias_permitidos: 127, permite_sem_carteirinha: true, limite_diario_centavos: 3000 });
  const [contaId] = await trx('contas_lanchei').insert({ escola_id: escolaId, aluno_id: alunoId });
  await trx('carteirinhas_lanchei').insert({ escola_id: escolaId, aluno_id: alunoId, token_hash: sha256(qrToken), emitida_por_usuario_id: diretoriaId });

  // Um responsável fictício e um depósito de R$ 50,00 já aprovado (o caminho normal é o Pix).
  const [respId] = await trx('responsaveis_lanchei').insert({ nome: 'Marina Souza', email: 'marina@demo.lanchei', senha_hash: senhaHash, email_verificado_em: new Date() });
  const [conviteId] = await trx('convites_responsavel_lanchei').insert({
    escola_id: escolaId, aluno_id: alunoId, email: 'marina@demo.lanchei', codigo_hash: sha256(tokenAleatorio()), expira_em: new Date(), usado_em: new Date(),
    usado_por_responsavel_id: respId, criado_por_usuario_id: diretoriaId,
  });
  await trx('aluno_responsaveis_lanchei').insert({ aluno_id: alunoId, responsavel_id: respId, convite_id: conviteId });
  const [depositoId] = await trx('depositos_lanchei').insert({
    escola_id: escolaId, conta_id: contaId, responsavel_id: respId, valor_centavos: 5000, idempotency_key: crypto.randomUUID(), status: 'APROVADO', aprovado_em: new Date(),
  });
  await lancarTransacao(trx, { escolaId: escolaId!, contaId: contaId!, tipo: 'DEPOSITO', valorCentavos: 5000, depositoId: depositoId!, descricao: 'Depósito de demonstração' });
});

console.log(`
Escola de demonstração criada.
  Caixa (atendente):  cida@demo.lanchei
  Cantina (ADMIN):    cantina@demo.lanchei
  Diretoria (ESCOLA): secretaria@demo.lanchei
  App dos pais:       marina@demo.lanchei
  Senha de todos:     ${SENHA}

Aluna: Ana Beatriz Souza (7º B), saldo R$ 50,00, limite diário R$ 30,00, PIN 4821.
Conteúdo do QR da carteirinha (gere um QR com este texto para testar com a câmera):
  ${montarQr(qrToken)}
`);
await db.destroy();
