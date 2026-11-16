# Contexto
Sou estudante de Desenvolvimento de Sistemas e quero criar um sistema de **pagamento sem dinheiro para cantinas escolares**. Hoje os alunos andam com cartão, dinheiro ou perdem tempo fazendo Pix na fila. Quero acabar com isso.

Você vai agir como arquiteto de software e desenvolvedor full-stack sênior. Me ajude a projetar e construir o sistema **por etapas**, explicando as decisões importantes, porque também quero aprender com o projeto.

# 1. Como o sistema funciona
- Cada aluno tem uma **carteirinha escolar com QR Code**.
- Na cantina, o aluno mostra a carteirinha. A atendente lê o QR Code, monta o pedido e o valor é **debitado do saldo do aluno**.
- Os **pais/responsáveis** usam um app no celular para:
  - **depositar dinheiro** na conta do filho (Pix pelo app);
  - definir um **limite de gasto** (por dia, semana ou mês);
  - **bloquear produtos ou categorias** que o filho não pode comprar (ex.: refrigerante, doces);
  - escolher em **quais dias da semana** o filho pode comprar;
  - ver o **extrato** com tudo que o filho comprou.

# 2. Perfis de usuário
1. **Responsável**: app mobile. Pode ter vários filhos.
2. **Aluno**: não precisa de login, só a carteirinha. (Alunos não podem usar celular na escola.)
3. **Operador da cantina**: tela web, pensada para tablet ou notebook com webcam/leitor de QR.
4. **Administrador da cantina/escola**: painel web para cadastrar produtos, preços, categorias, alunos e turmas, e ver relatórios de vendas.

Pense o sistema como **multi-escola** (multi-tenant) desde o começo, mesmo que o MVP tenha só uma escola.

# 3. Stack
- **Backend:** Node.js + Express, API REST, autenticação JWT
- **Banco:** MySQL
- **App dos responsáveis:** PWA (React + Vite) na fase 1; app de loja na fase 2
- **Tela da cantina + painel admin:** React com Vite
- **Pagamentos (depósitos):** gateway com Pix e webhook (Mercado Pago), usando sandbox no desenvolvimento

# 4. Regras de negócio importantes
- **Dinheiro sempre em centavos (inteiro)**, nunca float.
- O saldo vem de um **livro-razão (ledger)**: cada depósito, compra, estorno e ajuste é uma transação registrada e imutável. Nada de só fazer UPDATE num campo de saldo.
- Toda compra precisa ser **atômica** (transação no banco com lock da conta), para não haver saldo negativo nem débito duplicado se a atendente clicar duas vezes (use **idempotency key**).
- Antes de debitar, o backend valida, nesta ordem, e devolve um **motivo claro** se recusar:
  1. carteirinha válida e conta ativa;
  2. hoje é um dia permitido;
  3. nenhum item do pedido está bloqueado;
  4. a compra não ultrapassa o limite do período;
  5. saldo suficiente.
- A tela da cantina deve mostrar **nome e foto do aluno** depois da leitura, para a atendente confirmar que a carteirinha é dele.
- **Segurança do QR Code:** o QR não pode ser só o ID do aluno. Use um token aleatório que possa ser **revogado e reemitido** se a carteirinha for perdida. O responsável pode **bloquear a carteirinha** pelo app.
- Estorno/cancelamento de uma compra só por operador ou admin, gerando uma transação de estorno no ledger.
- O depósito só cai no saldo quando o **webhook do gateway confirmar** o pagamento.
- Notificações para o responsável (push): compra feita, saldo baixo, compra recusada.
- **LGPD:** são dados de menores de idade. Guarde só o necessário, proteja fotos e dados pessoais e explique o que precisa ser feito para estar em conformidade.

# 5. Como trabalhar
Siga estas etapas e **pare no fim de cada uma esperando confirmação**:

1. **Planejamento** ✅
2. **Modelagem** ✅
3. **Arquitetura da API** ✅
4. **Backend** (híbrido: núcleo pronto; restante especificado em `etapa4-backend.md`)
5. **Tela da cantina**: especificada em `etapa5-caixa.md`
6. **Painel admin**: especificado em `etapa6-painel.md` (Cantina + Diretoria)
7. **App dos responsáveis**: especificado em `etapa7-app-pais.md` (PWA + Web Push; loja na fase 2)
8. **Testes e deploy**: especificado em `etapa8-testes-deploy.md` (CI, permissões mínimas, Render + Aiven gratuitos)

Em cada etapa de código:
- entregue arquivos completos, com o caminho de cada um;
- comente as partes não óbvias;
- liste os comandos para instalar e rodar;
- diga o que testar antes de seguirmos.
