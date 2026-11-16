# Prompt para colar no Claude Code

> 1. Descompacte o `lanchei.zip` numa pasta e abra o terminal nela (onde está o `CLAUDE.md`).
> 2. (Recomendado) `git init && git add . && git commit -m "Base do projeto Lanchei"`. Assim cada etapa do Claude Code vira um commit e dá para voltar atrás.
> 3. Rode `claude` nessa pasta e cole o texto abaixo.

---

Este é o projeto **Lanchei**, um sistema de pagamento sem dinheiro para cantinas escolares que vai rodar de verdade numa escola. O planejamento está completo em `docs/` (etapas 1 a 8). O banco (`database/schema.sql`) e o **núcleo crítico da API** (autenticação, ledger, fluxo de compra, estorno e confirmação do Pix) já estão prontos e testados contra MySQL real (78 testes, incluindo concorrência).

Eu quero aprender com o projeto: explique as decisões importantes enquanto trabalha.

## Antes de tudo
1. Leia o `CLAUDE.md` e **todos** os arquivos de `docs/`, na ordem indicada no CLAUDE.md. Eles são a fonte da verdade: se algo que eu pedir contradisser os documentos, pergunte antes.
2. Prepare meu ambiente: confira se tenho Node 22+, Git e MySQL 8 disponíveis. Se faltar algo, me diga como instalar no meu sistema operacional. Crie `apps/api/.env` e `apps/api/.env.test` a partir dos `.example`, gerando os segredos, e me pergunte só o que não conseguir descobrir (ex.: a senha do MySQL).
3. Rode `npm install`, `npm run db:schema -w apps/api`, `npm run api:typecheck` e `npm run api:test`. Também rode `database/testar_schema.sh` e `database/testar_grants.sh` (veja o cabeçalho de cada um). Tudo precisa passar antes de seguir; se algo falhar, investigue e me explique a causa.

## Ordem do trabalho
**Pare ao fim de cada item**, mostre o que fez, o resultado do typecheck e dos testes, o que eu devo testar e os comandos, e espere eu confirmar.

1. **Etapa 4: backend restante** (`docs/etapa4-backend.md` §4), em blocos:
   - **4A:** e-mail + auth restante (cadastro, verificação, esqueci/redefinir) + plataforma (superadmin cria escola, primeiro ADMIN e primeiro ESCOLA).
   - **4B:** rotas da Diretoria (`ESCOLA`): turmas, alunos (foto, importação CSV com modelo), convites, carteirinhas (emissão individual e em lote), pendências, histórico do aluno com auditoria. Aplicar a **matriz de permissões** de `docs/etapa6-painel.md` §2 com testes de papel permitido e proibido.
   - **4C:** rotas da Cantina (`ADMIN`): catálogo, estoque, pedidos, estorno, venda manual, relatórios (+CSV), resumo do dia, ajustes, encerramento com reembolso, equipe, Mercado Pago OAuth.
   - **4D:** caixa restante + rotas `/me` do app dos pais (vínculo, regras, bloqueios, PIN, carteirinha, depósito Pix, extrato, notificações, LGPD) + **Web Push** (`docs/etapa7-app-pais.md` §3) + jobs (push, webhooks, depósitos pendentes, renovar token MP, reconciliação, limpeza) + modo cookie do refresh + servir os builds web em `/` e `/app/`.
2. **Monorepo de front:** `packages/shared` (cliente HTTP com refresh single-flight, tipos, dinheiro e datas) e os scripts `build`/`dev` da raiz.
3. **Etapa 5: tela do caixa** (`apps/web`, `docs/etapa5-caixa.md`): login, catálogo, leitura do QR pela câmera, máquina de estados da venda, resultado, sem carteirinha (PIN), vendas de hoje, estoque. Use o mockup do canvas "Lanchei — Tela do caixa (tablet)" como referência visual (as cores e medidas estão no doc).
4. **Etapa 6: painel admin** (`apps/web`, `docs/etapa6-painel.md`): Cantina, Diretoria e Plataforma, responsivo, incluindo a impressão das carteirinhas.
5. **Etapa 7: app dos pais** (`apps/pais`, `docs/etapa7-app-pais.md`): PWA com Web Push, vínculo, Pix, extrato, regras, bloqueios, carteirinha/PIN, guia de instalação no iPhone.
6. **Etapa 8: fechamento** (`docs/etapa8-testes-deploy.md`): completar os testes da §2, atualizar o CI com os testes de front, e me guiar **passo a passo** no deploy gratuito (Aiven + Render + Mercado Pago sandbox), conferindo comigo cada variável de ambiente.

## Regras para todo o trabalho
- Siga as **regras invioláveis** (`CLAUDE.md` e `docs/etapa4-backend.md` §2). Saldo só muda por `lancarTransacao`, estoque só por `movimentarEstoque`, a ordem dos locks é sempre a mesma, o `escolaId` vem do token e o caixa nunca recebe saldo.
- Imite os padrões do código existente (`compra.servico.ts`, `estorno.servico.ts`, `pagamento.servico.ts`, `tests/fixtures.ts`).
- **Custo zero:** não adicione serviço pago nem dependência de terceiros em tempo de execução sem me perguntar.
- Mercado Pago, Web Push e SMTP: **consulte a documentação oficial atual** antes de implementar.
- Toda mudança de schema: edite `database/schema.sql`, atualize `grants.sql` se criar tabela, rode os dois scripts de teste do banco e atualize `docs/etapa2-modelagem.md`.
- Se uma decisão mudar, atualize o documento correspondente em `docs/` no mesmo commit.
