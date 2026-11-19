# Etapa 8: Testes, como rodar e deploy (custo zero)

## 1. O que já está testado (rodando contra MySQL 8 real)

| Suite | Onde | O que garante |
|---|---|---|
| Integridade do banco (26 regras) | `database/testar_schema.sh` | O próprio MySQL recusa: saldo negativo, UPDATE/DELETE no ledger, crédito/débito duplicado, idempotency key repetida, 2 carteirinhas vivas, dados cruzados entre escolas, estoque negativo, venda manual sem observação, push sem chaves… |
| Permissões mínimas | `database/testar_grants.sh` | O usuário `lanchei_api` **não consegue** alterar/apagar ledger e auditoria, apagar alunos/pedidos, nem DROP/ALTER; toda tabela tem GRANT |
| API com usuário restrito | (procedimento abaixo, §1.1) | Os **577 testes passam** logados como `lanchei_api`: a API funciona sem nenhum privilégio a mais |
| Regras puras | `apps/api/tests/dominio.test.ts` (18) | Ordem das validações, limites, dias (bitmask), fuso da escola, aplicador de schema, assinatura do webhook |
| Compra | `tests/compra.test.ts` (30) | Aprovação, cada motivo de recusa, idempotência, **concorrência** (saldo, estoque, clique duplo, estorno), PIN, estorno |
| Depósito/Pix | `tests/deposito.test.ts` (13) | Crédito só com `approved`, **uma vez** mesmo com 10 webhooks em paralelo, valor divergente, devolução, assinatura, reprocessamento |
| Conta | `tests/conta.test.ts` (18) | Cadastro **sem enumeração de e-mail**, verificação e redefinição (uso único, expiração, só o link mais recente, clique duplo, revoga sessões, auditoria) |
| Plataforma | `tests/plataforma.test.ts` (10) | Escolas (slug, fuso, desativar derruba a equipe), primeiro ADMIN/ESCOLA com convite de 72 h, permissões (só SUPERADMIN) |
| Diretoria | `tests/admin-alunos.test.ts` (18), `tests/admin-vinculos.test.ts` (15), `tests/dominio-admin.test.ts` (9) | Cadastro com convites, pendências, ficha por papel, foto sem EXIF, importação CSV (simular, erro = nada gravado, UTF-8), turmas, convites, desvínculo, carteirinhas (revoga a anterior; 5 emissões simultâneas = 1 viva; lote), histórico + CSV com auditoria, equipe por perfil |
| App dos pais | `tests/responsavel.test.ts` (25) | Vínculo (consentimento, e-mail verificado, termo vigente, e-mail diferente conta tentativa, 5 erros = 429), `garantirVinculo` (filho de outro = 404 em todas as rotas), extrato com recusas, regras e bloqueios (auditoria, aviso só aos outros, valem na hora no caixa), PIN, carteirinha, desvínculo (REVOGACAO), notificações, aparelhos (transferência), LGPD |
| Depósito Pix e jobs do MP | `tests/deposito-app.test.ts` (14) | Pix na conta da cantina, idempotência (6 simultâneos = 1), mín./máx., MP fora do ar → CANCELADO + 502, aluno encerrado; jobs: pago sem webhook → credita, não pago → cancela, MP fora do ar → não cancela, job + webhook juntos = crédito uma vez, reprocessar webhook |
| Jobs | `tests/jobs.test.ts` (10) | Push (vários aparelhos, 410 desativa, sem aparelho, notificação velha), renovação do token do MP (refresh novo, falha, reconexão no meio), reconciliação com e-mail, limpeza |
| Caixa e web | `tests/caixa-web.test.ts` (12) | Catálogo, busca, vendas de hoje, refresh em cookie (HttpOnly, rotação, reuso, logout), fronts em `/` e `/app` (SPA, cache), CSP, rotas públicas |
| Cantina (dinheiro) | `tests/cantina-dinheiro.test.ts` (22) | Venda manual (só saldo/estoque, idempotência com 8 envios simultâneos, limite do dia em que ocorreu), ajuste (nunca negativo; 6 idênticos simultâneos = 1), encerramento com reembolso (5 simultâneos = 1; disputa com 10 compras fecha zerado), estorno de outro dia só pelo admin |
| Cantina | `tests/cantina.test.ts` (24) | Catálogo (snapshot de preço, `ZERAR_ESTOQUE_ANTES`), estoque (contagem disputando com vendas), pedidos, relatórios e CSV, resumo com alertas, auditoria por perfil, **OAuth do MP** (tokens criptografados, state inválido/vencido/adulterado, conta em uso, MP fora do ar) |
| Matriz de permissões | `tests/permissoes.test.ts` (321) | Cada rota de `/v1/admin`, `/v1/estoque`, `/v1/caixa`, `/v1/me` (+ plataforma) × 5 papéis: permitido passa, proibido = 403 |
| Caixa (front) | `apps/web/tests/*` (37) | Máquina de estados da venda (todas as transições, regra da Idempotency-Key, PIN fora do estado), filtro do leitor (`LCH1.` + 3 s), versões do ZXing iguais, botão Cobrar, tela de recusa por motivo (sem saldo), selos dos produtos, teclado do PIN |
| Pacote compartilhado | `packages/shared/tests/*` (15) | Refresh **single-flight** (5 requisições com token vencido = 1 refresh; prova de mutação), sessão encerrada, erros de rede/tempo/cancelamento, formato de erro; dinheiro sem float; datas no fuso da escola; contagem regressiva |
| HTTP/Auth | `tests/http.test.ts` (17) | Login, refresh rotativo com **detecção de reuso**, permissões por papel (incl. ESCOLA ≠ caixa), formato de erro, caixa sem saldo na resposta |

Prova de que os testes pegam bugs de verdade: removendo o `FOR UPDATE` da conta, o teste "20 compras simultâneas com saldo para 5" falha (aprova as 20).

### 1.1 Rodar a API com o usuário restrito (opcional, recomendado antes do deploy)
```bash
# 1) como admin, cria o banco de teste (o globalSetup normalmente faz isso)
npm run api:test
# 2) cria o usuário restrito apontando para o banco de teste
sed "s/lanchei\./lanchei_test./g; s/TROQUE-ESTA-SENHA-forte-e-longa/restrito-123/" database/grants.sql | mysql -u root -p
# 3) roda os testes SEM recriar o banco, como lanchei_api
cd apps/api && PULAR_SETUP_SCHEMA=1 DB_USER=lanchei_api DB_PASSWORD=restrito-123 npx vitest run
```

## 2. Testes que cada etapa ainda precisa adicionar
(Detalhes nas seções "Testes" de cada documento; aqui fica a lista de aceitação.)

**Etapa 4 (backend restante):** cadastro sem enumeração de e-mail; verificação e redefinição (uso único, expiração, revoga sessões); vínculo por código (e-mail diferente conta tentativa; 5 erros = 429; consentimento gravado); depósito (mín./máx., idempotência por responsável, MP fora do ar → CANCELADO + 502); `garantirVinculo` (filho de outro → 404); regras/bloqueios (auditoria + aviso só aos *outros* responsáveis); emissão de carteirinha (revoga a anterior na mesma transação); encerramento com reembolso (saldo zera, ledger REEMBOLSO, carteirinha revogada); venda manual (só saldo/estoque); jobs (push 410 desativa; pendente vencido → sincroniza; reconciliação manda alerta).

**Etapa 6 (permissões):** para cada grupo de rotas `/v1/admin/*`, um teste com papel permitido e um com papel proibido (matriz da `etapa6-painel.md` §2); ADMIN não cria ESCOLA e vice-versa; histórico gera auditoria.

**Etapas 5 e 7 (front):** `maquinaVenda` (todas as transições e a regra da Idempotency-Key), leitor de QR (prefixo `LCH1.` + anti-repetição), refresh single-flight, `CampoDinheiro`, tela do Pix (pendente → aprovado/expirado).

**Manual, em aparelhos reais (antes de abrir para a escola):**
- [ ] Tablet Android: ler carteirinha impressa e plastificada (fosco), com luz fraca, a 15–30 cm.
- [ ] 2 tablets vendendo ao mesmo tempo para alunos diferentes e para o **mesmo** aluno.
- [ ] Derrubar o Wi-Fi no meio do "Cobrar" → "Tentar de novo" não cobra duas vezes.
- [ ] Pix no **sandbox** do Mercado Pago: copia e cola → saldo aparece sozinho.
- [ ] PWA dos pais instalado no Android e no iPhone (pela Tela de Início): push chega com o app fechado.
- [ ] Imprimir uma folha de carteirinhas e ler todas no caixa.

## 3. Integração contínua (gratuita)
`.github/workflows/ci.yml`: a cada push, o GitHub Actions sobe um MySQL 8, roda o typecheck de todos os workspaces, os testes do `packages/shared`, `testar_schema.sh`, `testar_grants.sh`, os testes da API, os testes do `apps/web` e o build de produção. Fica dentro da cota gratuita do GitHub para um projeto deste tamanho. Quando o `apps/web` e o `apps/pais` existirem, acrescentar os testes deles no mesmo workflow.

## 4. Rodar tudo na sua máquina
Requisitos: **Node 22+**, **MySQL 8** (instalador oficial, Docker ou o próprio serviço gratuito do Aiven) e Git.

```bash
git clone <seu-repositorio> lanchei && cd lanchei
npm install
cp apps/api/.env.example apps/api/.env              # preencha o MySQL e gere os segredos
cp apps/api/.env.test.example apps/api/.env.test    # banco terminado em _test (é apagado nos testes)
npm run db:schema -w apps/api                       # cria o banco "lanchei"
npm run db:superadmin -w apps/api -- --nome "Mateus" --email voce@exemplo.com --senha "senha-forte-12+"
npm run api:test                                    # tudo verde antes de continuar
npm run api:dev                                     # API em http://localhost:3333
# quando existirem:
npm run dev -w apps/web                             # caixa/painel em http://localhost:5173 (proxy /v1 → 3333)
npm run dev -w apps/pais                            # app dos pais em http://localhost:5174/app/
```
Testar o caixa no **tablet** pela rede local: `etapa5-caixa.md` §3 (HTTPS de desenvolvimento).

Gerar segredos:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"         # CHAVE_CRIPTOGRAFIA
npx web-push generate-vapid-keys                                                 # VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

## 5. Deploy de produção (custo zero)

Arquitetura: **1 Web Service gratuito no Render** (API + `apps/web` em `/` + `apps/pais` em `/app/`) + **1 MySQL gratuito no Aiven**. Sem domínio próprio por enquanto.

### 5.1 Banco no Aiven
1. Criar conta → **Create service → MySQL → plano Free**. Escolher a **região mais próxima da região do Render** (ex.: Aiven em Nova York ↔ Render em Virginia/Ohio), porque cada consulta atravessa essa distância.
2. No painel: copiar host, porta, usuário (`avnadmin`), senha e **baixar o certificado CA**.
3. Na sua máquina, com um `.env` apontando para o Aiven (`DB_SSL_CA` = conteúdo do CA):
   ```bash
   npm run db:schema -w apps/api
   ```
   - Se der erro ao criar **TRIGGER** (alguns MySQL gerenciados exigem privilégio especial com binlog ligado), rode `npm run db:schema -w apps/api -- --sem-triggers`. A imutabilidade do ledger continua garantida pelo passo 4, que vira **obrigatório**.
4. **Criar o usuário restrito da API:** abrir `database/grants.sql`, trocar a senha e executar no Aiven com o `avnadmin` (pelo cliente `mysql`, MySQL Workbench ou DBeaver). A API em produção usa **só** o `lanchei_api`; o `avnadmin` fica guardado para migrações.
5. Criar o superadmin: `npm run db:superadmin -w apps/api -- ...` (com o `.env` apontando para o Aiven).
6. **Atenção ao plano gratuito:** o Aiven pode desligar serviços gratuitos sem uso e **avisa por e-mail antes**. O keep-alive da API mantém o banco em uso, mas entre no console do Aiven de vez em quando e não ignore esses e-mails. Os backups automáticos estão incluídos no plano gratuito.

### 5.2 API + painel + app dos pais no Render
1. Subir o repositório no GitHub (privado).
2. Render → **New → Web Service** → conectar o repositório → instância **Free**.
3. Configuração:
   - **Build command:** `npm ci --include=dev && npm run build`. O `--include=dev` é obrigatório: com `NODE_ENV=production`, o `npm ci` pula as devDependencies, e sem o TypeScript e o Vite o build falha. O script `build` da raiz roda o `build` de cada workspace, na ordem `packages/*` → `apps/*` (o `packages/shared` é distribuído como código-fonte TypeScript e compilado pelo Vite de cada app).
   - **Start command:** `node apps/api/dist/server.js`
   - **Health check path:** `/health`
   - **Node:** 22 (`engines` do package.json).
4. **Variáveis de ambiente** (aba Environment):

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | do Aiven (`DB_NAME=lanchei`) |
| `DB_USER`, `DB_PASSWORD` | **`lanchei_api`** e a senha do grants.sql |
| `DB_SSL_CA` | conteúdo do certificado CA do Aiven |
| `JWT_SECRET`, `CHAVE_CRIPTOGRAFIA` | gerados (§4), **diferentes** dos de dev |
| `URL_PUBLICA_API` | `https://<seu-servico>.onrender.com` (liga o keep-alive) |
| `MP_WEBHOOK_SECRET`, `MP_CLIENT_ID`, `MP_CLIENT_SECRET` | do painel de desenvolvedores do Mercado Pago (§5.3) |
| `MP_REDIRECT_URI` | opcional: vazio usa `URL_PUBLICA_API + /v1/mercadopago/oauth/callback` (tem que ser igual à URL cadastrada no MP) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | gerados (§4), **diferentes** dos de dev; subject = `mailto:` seu |
| `TERMO_VERSAO`, `TERMO_URL` | versão do termo publicado e o link dele (§6) |
| `SMTP_*`, `EMAIL_REMETENTE` | §5.4 |

5. Fatos do plano gratuito do Render que afetam o Lanchei:
   - o serviço **dorme após 15 min sem tráfego** e demora ~1 min para acordar; o **keep-alive de 10 min** resolve;
   - são **750 horas grátis por mês** por workspace: um serviço ligado o mês inteiro cabe (~744 h), mas **não crie outro serviço gratuito sempre ligado** no mesmo workspace (seu outro projeto pode estar em outro workspace ou já dividir essas horas: confira no painel);
   - o disco é temporário (some a cada deploy), e por isso as fotos ficam no banco, não em arquivo;
   - o Render pode reiniciar o serviço a qualquer momento: a API desliga limpo com SIGTERM, e a idempotência protege vendas em andamento.

### 5.3 Mercado Pago
1. Painel de desenvolvedores do MP → criar a **aplicação Lanchei** (modelo de integração com OAuth/marketplace, para a cantina autorizar a plataforma).
2. **Sandbox primeiro:** criar usuários de teste (vendedor = "cantina", comprador = "pai") e conectar a conta de teste da cantina pelo painel admin (Configurações → Mercado Pago).
3. Webhook: URL `https://<seu-servico>.onrender.com/v1/webhooks/mercadopago`, evento **payment**, e copiar a **chave secreta** para `MP_WEBHOOK_SECRET`.
4. Redirect do OAuth: `https://<seu-servico>.onrender.com/v1/mercadopago/oauth/callback`.
5. ⚠️ Conferir na documentação oficial atual do MP: formato do `x-signature`, payload do Pix e fluxo OAuth (pontos marcados com ⚠️ em `src/infra/mercadopago.ts`).
6. Só trocar para as credenciais de **produção** depois de todo o checklist do §2 passar no sandbox.

### 5.4 E-mail sem custo
Usar SMTP de um provedor com **plano gratuito** para e-mail transacional (conferir os limites diários atuais) ou, no começo, uma conta de e-mail com senha de app. Volume esperado: convites no início do ano + verificações + redefinições, baixo. Configurar SPF/DKIM do provedor para não cair no spam (sem domínio próprio, usar o remetente do provedor).

## 6. Checklist antes de abrir para a escola
**Técnico**
- [ ] CI verde; `testar_schema.sh` e `testar_grants.sh` verdes **contra o Aiven** (ou rodados localmente com o mesmo schema).
- [ ] API em produção usando `lanchei_api` (não o `avnadmin`).
- [ ] `/health/db` respondendo; keep-alive ativo nos logs ("keep-alive ativo").
- [ ] Job de reconciliação rodou e não acusou divergência.
- [ ] Teste de restauração: restaurar um backup do Aiven num serviço/banco de teste pelo menos uma vez.
- [ ] Segredos de produção diferentes dos de dev; `.env` fora do git.

**Pessoas e regras (não é código, mas é obrigatório num sistema real)**
- [ ] **Termos de uso e política de privacidade** publicados (versão referenciada em `/v1/termos/atual`), explicando dados de menores, finalidade, retenção e canal de contato.
- [ ] **Contrato com a escola** definindo papéis LGPD (escola = controladora, Mateus = operador), responsabilidades, suporte e custo.
- [ ] Regras de reembolso no encerramento escritas nos termos (validar com advogado, `etapa1-decisoes.md`).
- [ ] Conta Mercado Pago **da cantina** (no nome/CNPJ dela) conectada; o dinheiro nunca passa pela sua conta.
- [ ] Conferir com um contador o enquadramento para **você cobrar a escola** pelo serviço de software.
- [ ] Treinar a "tia da cantina" (caixa, sem carteirinha, estorno do dia, estoque) e a secretaria (importação, carteirinhas, convites).
- [ ] Combinar a contingência: se cair a internet, anotar as vendas e a cantina lança como "venda manual" depois.

## 7. Quando sair do custo zero (sinais)
- Ninguém pode esperar ~1 min de "acordar": Render pago (sem hibernação).
- Banco perto de 1 GB, ou risco de desligamento inaceitável: Aiven Developer (US$ 5/mês, ligado 24/7 com backups).
- Pais pedindo o app na loja: fase 2 da `etapa7-app-pais.md` §10.
- Mais de uma escola: domínio próprio (opcional) e revisão de custos.
