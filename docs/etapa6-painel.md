# Etapa 6: Painel administrativo (Cantina e Diretoria)

**Referência visual:** canvas "Lanchei — Painel admin" no claude.ai (início da Cantina no computador e no celular, lista de alunos e ficha do aluno da Diretoria). Mesmo visual do caixa (`etapa5-caixa.md` §8).

## 1. Decisões do Mateus
- **Dois perfis administrativos diferentes:**
  - **Cantina** (dono/gerente): administra vendas, estoque, produtos e configurações.
  - **Diretoria da escola** (diretoria/secretaria): cadastra alunos e consulta o **histórico de compras** de cada um quando os pais pedirem.
- **Aplicação web responsiva** (computador e celular), instalável como PWA. É o mesmo `apps/web` do caixa e é servida pela própria API (custo zero, mesma origem).

## 2. Perfis e matriz de permissões
Papel novo no banco: **`ESCOLA`** (`usuarios_lanchei.papel`). Já aplicado no `schema.sql` e no código, com teste.

| Funcionalidade | ADMIN (Cantina) | ESCOLA (Diretoria) | OPERADOR | SUPERADMIN |
|---|:-:|:-:|:-:|:-:|
| Caixa (vender, estornar no dia) | ✅ | — | ✅ | — |
| Estoque (entrada, perda, contagem) | ✅ | — | ✅ | — |
| Produtos e categorias | ✅ | — | — | — |
| Pedidos de qualquer data, estorno, venda manual | ✅ | — | — | — |
| Relatórios de vendas e depósitos | ✅ | — | — | — |
| Configurações de pagamento (Mercado Pago, mín./máx. de depósito) | ✅ | — | — | — |
| Equipe da cantina (criar ADMIN/OPERADOR) | ✅ | — | — | — |
| Dados da escola (nome, fuso) | — | ✅ | — | — |
| Turmas | — | ✅ | — | — |
| Alunos: cadastrar, editar, foto, importar CSV, inativar | — | ✅ | — | — |
| Convites de responsáveis, desvincular responsável | — | ✅ | — | — |
| Carteirinhas: emitir, emitir em lote, imprimir, desbloquear | — | ✅ | — | — |
| Equipe da escola (criar ESCOLA) | — | ✅ | — | — |
| **Consultar** aluno (nome, turma, status, saldo) | ✅ | ✅ | — | — |
| **Histórico do aluno** (extrato, compras, depósitos) + exportar | ✅ | ✅ | — | — |
| Ajuste de saldo | ✅ | — | — | — |
| Encerramento do aluno com reembolso | ✅ | — | — | — |
| Auditoria | ✅ (vendas, estoque, saldo) | ✅ (alunos, carteirinhas, vínculos) | — | — |
| Escolas e primeiro usuário de cada perfil | — | — | — | ✅ |

Notas:
- **Reembolso e ajuste são da Cantina** porque é a conta da cantina que devolve o dinheiro. A Diretoria pode **inativar** o aluno e usar o botão **"Solicitar encerramento"**, que avisa os ADMIN da cantina por e-mail e gera auditoria. A cantina então faz o encerramento com reembolso.
- **Toda consulta ao histórico** gera auditoria `HISTORICO_VISUALIZAR` (exportar gera `HISTORICO_EXPORTAR`): são dados de menores.
- O SUPERADMIN cria a escola, o **primeiro ADMIN** e o **primeiro ESCOLA**; depois, cada perfil cadastra a própria equipe.
- **Solicitações LGPD** do app (`/me/solicitacoes-lgpd`) vão por e-mail para os usuários **ESCOLA** (a escola é a controladora dos dados).
- Esta matriz **substitui a coluna "Acesso" das rotas `/v1/admin/*`** em `etapa3-api.md`. As rotas continuam com o mesmo caminho; cada uma declara seus papéis com `exigirPapel(...)`.

## 3. Navegação

Login único (o mesmo do caixa). Depois do login, cada papel vai para a sua área:

| Papel | Vai para |
|---|---|
| OPERADOR | `/caixa` |
| ADMIN | `/painel/cantina` (com atalho "Abrir caixa") |
| ESCOLA | `/painel/escola` |
| SUPERADMIN | `/painel/plataforma` |

**Menu da Cantina:** Início · Vendas · Produtos · Estoque · Alunos · Relatórios · Equipe · Configurações
**Menu da Diretoria:** Início · Alunos · Turmas · Carteirinhas · Equipe · Dados da escola

### Responsivo
- **≥ 1024 px:** menu lateral fixo (240 px) + conteúdo com largura máxima de 1200 px.
- **640–1023 px:** menu lateral recolhível (ícones).
- **< 640 px (celular):** barra inferior com os 4 itens principais + "Mais". **Tabelas viram cartões**; filtros vão para uma folha que abre de baixo; ações principais num botão fixo no rodapé.
- Alvos de toque ≥ 44 px; nada depende de hover.

## 4. Telas da Cantina

### 4.1 Início (`/painel/cantina`)
Resumo **de hoje**, no fuso da escola:
- cartões: **Vendas** (R$), **Pedidos**, **Ticket médio**, **Depósitos recebidos** (R$);
- **Recusas por motivo** (saldo, limite, bloqueio...), que mostra se os pais estão travando demais ou se falta recarga;
- **Estoque baixo** (produtos ≤ mínimo, com o botão "Lançar entrada");
- **Alertas** que exigem ação: depósito com valor divergente, Pix devolvido (`DEPOSITO_DEVOLVIDO`), Mercado Pago desconectado/expirando, reconciliação com divergência.
- Novo endpoint: `GET /v1/admin/resumo?data=AAAA-MM-DD`.

### 4.2 Vendas
Lista de pedidos com filtros (período, status, aluno, operador), paginada por cursor. O detalhe mostra itens, operador, modo (carteirinha/PIN/manual) e, se recusado, o motivo. Ações: **Estornar** (qualquer data, motivo e estoque opcional) e **Nova venda manual** (contingência: aluno, itens, data/hora em que aconteceu, observação obrigatória).

### 4.3 Produtos
Categorias (abas) e produtos (nome, preço, categoria, ativo, controla estoque, mínimo). Preço digitado em reais com máscara e enviado em centavos. Desativar em vez de excluir.

### 4.4 Estoque
Mesma lógica da tela do caixa (`etapa5-caixa.md` §6.6) + histórico de movimentos por produto.

### 4.5 Alunos (consulta)
Busca por nome/turma. A ficha mostra os dados básicos e o saldo, mais as abas **Histórico** e **Ações da cantina**: ajuste de saldo (valor ±, descrição obrigatória, confirmação dupla) e **Encerrar com reembolso** (mostra o saldo atual; forma PIX/TRANSFERÊNCIA/DINHEIRO; comprovante; confirmação digitando o nome do aluno).

### 4.6 Relatórios
Período + agrupamento (dia, produto, categoria, operador) para vendas; depósitos (bruto, taxa); saldos em aberto. Tabela + gráfico de barras simples. **Exportar CSV** (`?formato=csv`, separador `;`, UTF-8 com BOM para abrir no Excel).

### 4.7 Equipe
Lista de ADMIN/OPERADOR da escola. Convidar (nome, e-mail, papel) envia um e-mail para definir senha. Editar e desativar.

### 4.8 Configurações
- **Mercado Pago:** status (conectado/desconectado, conta, expiração do token) + "Conectar conta da cantina" (fluxo OAuth da `etapa4-backend.md` §4.4).
- **Depósitos:** mínimo e máximo (padrão R$ 25 e R$ 500).

## 5. Telas da Diretoria

### 5.1 Início (`/painel/escola`)
Cartões: alunos ativos, **sem carteirinha**, **sem foto**, **sem responsável vinculado**, convites vencidos. Cada cartão abre a lista já filtrada. É o "o que falta fazer" da secretaria no começo do ano.

### 5.2 Alunos
- Lista com busca e filtros (turma, status, pendências), mostrando foto pequena, nome, matrícula, turma, carteirinha e responsáveis vinculados/convidados.
- **Novo aluno:** nome, matrícula, turma e até 2 e-mails de responsáveis.
- **Importar planilha** (assistente em 3 passos):
  1. baixar o modelo + enviar o CSV;
  2. **simulação** (`?simular=true`): mostra quantos alunos são válidos, os erros por linha e as turmas que serão criadas;
  3. confirmar → importa tudo de uma vez.

### 5.3 Ficha do aluno (Diretoria)
- **Cabeçalho:** foto (trocar/tirar foto pela câmera do celular, recortada em quadrado), nome, matrícula, turma, status, **saldo**.
- **Aba Responsáveis:** vinculados (nome, e-mail, desde quando) com "Desvincular" (motivo obrigatório); convites pendentes com Reenviar/Revogar; "Convidar responsável".
- **Aba Carteirinha:** status, "Emitir nova" (aviso: a anterior para de funcionar) → abre a impressão (§5.5), "Desbloquear".
- **Aba Histórico** (igual para Cantina e Diretoria):
  - período (padrão: mês atual), tipo (compras, depósitos, estornos, ajustes, reembolso) e lista do extrato (data/hora, tipo, descrição com itens, valor, saldo após); compras recusadas aparecem com o motivo, em cinza;
  - **"Exportar para os responsáveis"**: gera uma página de impressão (A4, com o cabeçalho da escola e o período) para salvar como PDF pelo navegador (custo zero, sem biblioteca de PDF) e um CSV;
  - endpoints novos: `GET /v1/admin/alunos/:id/extrato?de=&ate=&tipo=&cursor=` e `GET /v1/admin/alunos/:id/extrato.csv`. Ambos com auditoria.
- **Aba Regras (só leitura):** limites, dias, bloqueios e se aceita PIN. Quem altera são os responsáveis; a escola só consulta, para atender dúvidas.
- **Ações:** inativar/reativar e "Solicitar encerramento à cantina".

### 5.4 Turmas
Lista por ano letivo; criar, renomear e desativar. "Virada de ano": ação em lote para mover alunos de uma turma para outra.

### 5.5 Carteirinhas (impressão)
- "Emitir em lote por turma" (alunos sem carteirinha viva) ou emissão individual.
- **O QR só existe na resposta da emissão.** A tela vai **direto** para a pré-visualização de impressão e avisa: "Imprima ou salve o PDF agora. Se fechar esta página, será preciso emitir de novo (as anteriores param de funcionar)."
- Layout: **A4 com 8 carteirinhas** no tamanho de cartão (85,6 × 54 mm), com linhas de corte. Cada cartão leva logo/nome da escola, foto, nome, turma e o **QR grande** (≥ 30 mm, nível de correção M). O QR é gerado no navegador (pacote `qrcode`, saída em SVG) e a impressão sai pelo CSS `@page` + `window.print()` (salvar como PDF).
- Dica impressa no rodapé da folha: plastificar com plástico **fosco** (o brilhante reflete e atrapalha a câmera).

### 5.6 Equipe da escola e Dados da escola
Equipe: igual à §4.7, só com o papel ESCOLA. Dados: nome e fuso horário.

## 6. Plataforma (SUPERADMIN): `/painel/plataforma`
Lista de escolas; "Nova escola" (nome, slug, fuso) + convite do primeiro ADMIN (cantina) e do primeiro ESCOLA (diretoria). Ativar e desativar escola. Nada de dados de alunos.

## 7. Backend necessário para esta etapa
Além do que já está em `etapa4-backend.md` §4.3/§4.4:
- **Aplicar a matriz da §2** com `exigirPapel(...)` em cada rota `/v1/admin/*` (ex.: alunos/turmas/carteirinhas/convites → `ESCOLA`; produtos/pedidos/relatórios/MP → `ADMIN`; consulta e histórico de aluno → `ADMIN, ESCOLA`).
- `POST /plataforma/escolas/:id/usuarios` com `papel: 'ADMIN' | 'ESCOLA'` (substitui `/admins`).
- Equipe: ADMIN só cria ADMIN/OPERADOR; ESCOLA só cria ESCOLA. Testar as duas regras.
- `GET /admin/resumo` (início da cantina) e `GET /admin/pendencias` (início da diretoria).
- `GET /admin/alunos/:id/extrato` + `.csv` com auditoria.
- `POST /admin/alunos/:id/solicitar-encerramento` (ESCOLA): e-mail para os ADMIN + auditoria.
- `PATCH /admin/turmas/mover-alunos` (virada de ano), em transação.
- Relatórios com `?formato=csv`.
- **Testes de permissão:** para cada grupo de rotas, um teste com o papel permitido e um com o proibido (403).

## 8. Estrutura sugerida (`apps/web/src`)
```
painel/
  layout/          MenuLateral, BarraInferior (mobile), Cabecalho
  cantina/         Inicio, Vendas, Produtos, Estoque, Alunos, Relatorios, Equipe, Configuracoes
  escola/          Inicio, Alunos, FichaAluno, ImportarCsv, Turmas, Carteirinhas, ImpressaoCarteirinhas, Equipe, DadosEscola
  plataforma/      Escolas
  compartilhado/   HistoricoAluno (usado pelas duas áreas), TabelaResponsiva, CampoDinheiro, FiltroPeriodo
```
- `CampoDinheiro`: o usuário digita em reais ("12,50") e o componente guarda **centavos inteiros** (1250). Nunca usar `parseFloat` para dinheiro.
- Formatação: `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })` e datas no fuso da escola.

## 9. Testes desta etapa
- API: permissões (matriz completa), extrato com auditoria, importação CSV (válido, linha com erro, matrícula duplicada, turma nova, `simular`), emissão em lote (revoga as anteriores na mesma transação).
- Web: `CampoDinheiro` (vírgula, colar valor, limites), redirecionamento por papel após o login, impressão das carteirinhas (8 por folha, QR legível; testar lendo o PDF impresso com o próprio caixa).
