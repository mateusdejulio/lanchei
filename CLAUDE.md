# Lanchei: instruções para o Claude Code

Sistema de **pagamento sem dinheiro para cantinas escolares**: o aluno paga com a carteirinha (QR Code) e os pais depositam via Pix, definem limites e bloqueios e acompanham o extrato pelo app. Projeto **real** (vai rodar numa escola), multi-escola desde o início. O dono da plataforma é o Mateus; a escola é cliente.

O Mateus é estudante de Desenvolvimento de Sistemas e **quer aprender com o projeto**: explique as decisões importantes, comente o que não é óbvio e prefira código legível a código esperto.

## Leia antes de qualquer tarefa
1. `docs/etapa1-decisoes.md`: todas as decisões de produto, regulação e LGPD (fonte da verdade).
2. `docs/etapa2-modelagem.md` + `database/schema.sql`: modelo de dados (MySQL 8).
3. `docs/etapa3-api.md`: contrato de todas as rotas.
4. `docs/etapa4-backend.md`: o que já está pronto, o que falta e **as regras invioláveis**.
5. `docs/etapa5-caixa.md`: tela do caixa (tablet + câmera). Referência visual: canvas "Lanchei — Tela do caixa (tablet)" no claude.ai.
6. `docs/etapa6-painel.md`: painel admin com **dois perfis** (Cantina = `ADMIN`, Diretoria = `ESCOLA`) e a **matriz de permissões**. Referência visual: canvas "Lanchei — Painel admin".
7. `docs/etapa7-app-pais.md`: app dos responsáveis como **PWA** (`apps/pais`, servido em `/app/`) com **Web Push**; loja fica para a fase 2. Referência visual: canvas "Lanchei — App dos pais".
8. `docs/etapa8-testes-deploy.md`: testes de aceitação, como rodar, CI e deploy gratuito (Render + Aiven).
9. `docs/contexto-inicial.md`: o pedido original, com o processo por etapas.

Se um pedido contradizer esses documentos, **pergunte antes** de implementar. Se uma decisão mudar, atualize o documento correspondente no mesmo commit.

## Stack
- Monorepo npm workspaces: `apps/api` (Node 22 + Express 5 + TypeScript + Knex/mysql2 + Zod 4), depois `apps/web` (React + Vite: caixa + painel admin, servido em `/`), `apps/pais` (React + Vite PWA: app dos pais, servido em `/app/`), `packages/shared` (cliente HTTP, tipos/schemas Zod, dinheiro e datas). App de loja (Capacitor ou Expo) só na fase 2.
- MySQL 8 (produção: Aiven, plano gratuito). API no Render (plano gratuito), **servindo também o build do `apps/web`** (mesma origem). Pix: Mercado Pago (OAuth por cantina; o dinheiro cai direto na conta da cantina).
- **Custo zero por enquanto:** não adicione serviços pagos nem dependências de terceiros em tempo de execução sem perguntar.

## Comandos
```bash
npm install                    # na raiz
npm run dev                    # sobe API (+ painel e app dos pais, quando existirem) juntos
npm run typecheck              # todos os workspaces
npm run build                  # build de produção (shared → apps)
npm run shared:test            # testes do packages/shared (sem banco)
npm test -w apps/web           # testes do caixa/painel (jsdom, sem banco)
npm run db:demo -w apps/api    # escola de demonstração (cardápio do mockup, logins e QR)
npm run api:test               # testes da API (MySQL real; banco *_test é recriado)
npm run api:typecheck
npm run api:dev                # API em http://localhost:3333
npm run db:schema -w apps/api  # aplica database/schema.sql (--sem-triggers só se o provedor recusar)
MYSQL="mysql -u root -p" database/testar_schema.sh   # 26 regras de integridade
MYSQL="mysql -u root -p" database/testar_grants.sh   # permissões mínimas do usuário da API
```
Antes de dizer que algo está pronto: `typecheck`, `shared:test`, `api:test`, `npm test -w apps/web` e `npm run build` precisam passar (e os dois scripts do banco, se mexeu no schema). O CI (`.github/workflows/ci.yml`) roda tudo isso a cada push.

## Regras invioláveis (resumo; detalhes em docs/etapa4-backend.md §2)
- Dinheiro **sempre em centavos inteiros**. Nunca float.
- Saldo só muda por `lancarTransacao()` (`src/dominio/ledger.ts`); estoque só por `movimentarEstoque()` (`src/dominio/estoque.ts`). O ledger é imutável (triggers).
- Ordem de locks: **conta → (aluno) → pedido/depósito → produtos (id crescente)**. A linha do aluno só é travada junto com a conta no encerramento; rotas que travam só o aluno nunca travam a conta depois.
- `escolaId` vem **do token**, nunca da requisição. Recurso de outro tenant/responsável → **404**.
- O caixa **nunca** recebe saldo do aluno.
- Notificações entram na mesma transação (outbox); o push sai por job.
- Logs sem dados pessoais (dados de menores, LGPD).
- Toda entrada validada com Zod; erros no formato `{ erro: { codigo, mensagem, detalhes? } }`.
- Ações sensíveis geram registro em `auditoria_lanchei`.
- Nomenclatura do banco: tabelas e views com sufixo `_lanchei`; colunas sem sufixo, em `snake_case`. A API responde em `camelCase`.

## Convenções de código
- Identificadores, comentários, mensagens e docs em **português**.
- Módulos em `src/modulos/<nome>/` com `*.rotas.ts` (HTTP) e `*.servico.ts` (regras + banco).
- Regras de negócio complexas viram **funções puras** em `src/dominio/` (fáceis de testar).
- Fronts: dependências com **versão exata** (sem `~`/`^`) e publicadas há mais de 2 semanas. O `barcode-detector` e o `zxing-wasm` precisam usar o MESMO ZXing (há teste que confere).
- Cada funcionalidade nova vem com testes em `apps/api/tests/`, usando `tests/fixtures.ts` (cada teste cria a própria escola, então os testes não interferem entre si).
- Mudança de schema: edite `database/schema.sql`, adicione o GRANT da tabela nova em `database/grants.sql`, rode `testar_schema.sh` e `testar_grants.sh` e atualize `docs/etapa2-modelagem.md`.
- Em produção a API usa o usuário `lanchei_api` (privilégios mínimos): **nunca** escreva código que dependa de DELETE em tabelas fora de `bloqueios_*`, nem de DDL em tempo de execução.

## Forma de trabalhar
- Siga as etapas na ordem. **Ao fim de cada etapa, pare**, liste o que foi feito, o que testar e os comandos, e espere a confirmação do Mateus.
- Entregue arquivos completos; comente as partes não óbvias.
- Integrações externas (Mercado Pago, Web Push, SMTP): **confira a documentação oficial atual** antes de implementar; os pontos marcados com ⚠️ no código precisam dessa conferência.
