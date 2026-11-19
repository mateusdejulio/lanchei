# Etapa 4: Backend

Modelo **híbrido**: o código crítico (dinheiro, concorrência, segurança) já foi escrito e testado contra MySQL 8 real. O restante está especificado abaixo e deve ser implementado **seguindo os mesmos padrões**.

Contratos de todas as rotas (método, rota, perfil, request/response, códigos de erro): **`docs/etapa3-api.md`**. Este documento não repete os contratos; ele diz *o que já existe*, *como implementar o resto* e *as regras que não podem ser quebradas*.

---

## 1. O que já está pronto e testado (577 testes passando)

| Arquivo | O que faz |
|---|---|
| `src/config/env.ts` | Variáveis de ambiente validadas com Zod; a API não sobe se faltar algo |
| `src/infra/db.ts` | Knex + mysql2: UTC, BOOLEAN→boolean, BIGINT/SUM→number, SSL para Aiven |
| `src/infra/aplicarSchema.ts` + `scripts/aplicarSchema.ts` | Aplica `database/schema.sql` pelo Node, entendendo `DELIMITER` (sem precisar do cliente `mysql`) |
| `src/infra/cripto.ts` | Token aleatório, SHA-256, argon2id (senha/PIN), AES-256-GCM (tokens do MP), login em tempo constante |
| `src/infra/mercadopago.ts` | Cliente MP (buscar pagamento, criar Pix) + validação da assinatura do webhook |
| `src/erros.ts`, `src/middlewares/erros.ts` | `ErroApi` e formato único de erro (`VALIDACAO` com campos, 404, 500 genérico sem vazar detalhes) |
| `src/middlewares/autenticacao.ts` | `autenticar`, `exigirPapel`, `exigirResponsavel`, `usuarioDaEscola` (escolaId sempre do token) |
| `src/middlewares/limites.ts` | Rate limit de login, refresh e caixa |
| `src/dominio/regrasCompra.ts` | **Ordem das validações** da compra como função pura |
| `src/dominio/periodos.ts` | Dia/semana/mês no fuso da escola (Luxon, semana ISO) |
| `src/dominio/diasPermitidos.ts` | Bitmask ↔ `["SEG", ...]` |
| `src/dominio/ledger.ts` | `travarConta`, `lancarTransacao`: **único lugar que mexe em saldo** |
| `src/dominio/estoque.ts` | `travarProdutosComEstoque`, `movimentarEstoque`: **único lugar que mexe em estoque** |
| `src/dominio/notificacoes.ts` | Outbox de notificações (insere na transação do negócio), `reais()`, `primeiroNome()` |
| `src/dominio/auditoria.ts` | `registrarAuditoria` |
| `src/modulos/auth/*` | Login equipe/responsável, refresh rotativo **com detecção de reuso**, logout |
| `src/modulos/caixa/identificacao.ts` | QR `LCH1.<token>` e PIN (5 erros = 30 min bloqueado + aviso aos pais) |
| `src/modulos/caixa/compra.servico.ts` | **Fluxo de compra completo** (locks, idempotência, regras, estoque, ledger, avisos) |
| `src/modulos/caixa/estorno.servico.ts` | Estorno (operador só no dia; admin qualquer data; estoque opcional) |
| `src/modulos/caixa/caixa.rotas.ts` | `POST /caixa/identificar`, `POST /caixa/pedidos`, `POST /caixa/pedidos/:id/estorno` |
| `src/modulos/depositos/pagamento.servico.ts` | Aplica pagamento do MP: crédito **uma vez**, confere valor, trata devolução |
| `src/modulos/webhooks/*` | `POST /webhooks/mercadopago` (assinatura → grava → 200 → processa) |
| `src/modulos/saude/*`, `src/jobs/keepAlive.ts` | `/health`, `/health/db` e keep-alive de 10 min |
| `src/infra/email.ts`, `src/infra/emailModelos.ts`, `src/config/urls.ts` | **(4A)** E-mail: SMTP (nodemailer) em produção, terminal em dev, memória nos testes; envio em segundo plano depois do COMMIT; modelos em PT-BR |
| `src/modulos/auth/tokensEmail.ts`, `cadastro.servico.ts`, `senha.servico.ts` | **(4A)** Cadastro sem enumeração de e-mail, verificação, reenviar, esqueci/redefinir (uso único, só o link mais recente vale, revoga sessões, auditoria `SENHA_REDEFINIR`) |
| `src/modulos/plataforma/*` | **(4A)** SUPERADMIN: escolas (criar, listar, editar, desativar derruba as sessões da equipe) e primeiro ADMIN/ESCOLA com convite de 72 h |
| `src/validacao.ts` | Pedaços de Zod reaproveitados (e-mail normalizado, senha nova, nome, id da URL) |
| `src/modulos/admin/*` (parte da Diretoria) | **(4B)** Turmas (+ virada de ano), alunos (cadastro, lista com pendências, ficha por papel, edição, solicitar encerramento), foto, importação CSV, convites e desvínculo, carteirinhas (individual, lote, desbloqueio), histórico + CSV com auditoria, dados da escola (permissão por campo) e **equipe dos dois perfis** |
| `src/modulos/admin/cantina.rotas.ts` + `catalogo`, `pedidos`, `vendaManual`, `conta`, `relatorios`, `resumo`, `auditoria`, `mercadopago` (`.servico.ts`) | **(4C)** Cantina: catálogo, pedidos e estorno de qualquer data, **venda manual**, **ajuste de saldo**, **encerramento com reembolso**, relatórios (+CSV), resumo do dia com alertas, auditoria por perfil e **OAuth do Mercado Pago** |
| `src/modulos/responsavel/*`, `src/modulos/depositos/deposito.servico.ts` | **(4D)** `/v1/me`: vínculo por código (com consentimento), filhos, extrato, regras, bloqueios, PIN, carteirinha, desvínculo, **depósito Pix**, notificações, aparelhos de push, perfil e LGPD; `/v1/termos/atual` e `/v1/push/chave-publica` |
| `src/modulos/caixa/consultas.servico.ts` | **(4D)** Caixa: catálogo, busca para a compra sem carteirinha, foto e vendas de hoje |
| `src/modulos/auth/cookie.ts` | **(4D)** Refresh token em cookie HttpOnly (header `X-Cliente`) |
| `src/infra/push.ts`, `src/jobs/*` | **(4D)** Web Push (VAPID) e os jobs: push, webhooks, depósitos vencidos, renovação do token do MP, reconciliação e limpeza |
| `src/infra/fronts.ts` | **(4D)** A API serve `apps/web/dist` em `/` e `apps/pais/dist` em `/app` (SPA, cache, CSP) |
| `src/modulos/estoque/*` | **(4C)** `/v1/estoque` (ADMIN e OPERADOR): lista com alerta de mínimo, entrada/perda/contagem, histórico |
| `src/dominio/codigoAtivacao.ts`, `csv.ts`, `importacaoAlunos.ts` | **(4B)** Funções puras: código de 8 caracteres, CSV para Excel pt-BR (com proteção contra CSV injection), validação da planilha |
| `src/infra/fotos.ts`, `src/middlewares/upload.ts`, `src/paginacao.ts` | **(4B)** sharp (400×400, sem EXIF), multer em memória, paginação por cursor |
| `tests/*` | Domínio puro, compra (incl. concorrência), depósitos/webhook, HTTP/auth, conta (cadastro/senha), plataforma, Diretoria, **matriz de permissões** |

Testes de concorrência que provam as garantias (rodando contra MySQL):
- 20 compras simultâneas de R$ 10 com saldo de R$ 50 → **exatamente 5** aprovadas, saldo 0.
- 8 requisições simultâneas com a mesma `Idempotency-Key` → **1** pedido, **1** débito.
- 10 alunos disputando 3 refrigerantes → **3** vendas, estoque 0, sem deadlock.
- 10 webhooks do mesmo pagamento em paralelo → crédito **uma vez**.
- 5 estornos simultâneos do mesmo pedido → **1** passa.
- Prova de que os testes pegam o bug: removendo o `FOR UPDATE` da conta, o teste de saldo falha (20 aprovadas em vez de 5).

---

## 2. Regras que NUNCA podem ser quebradas

1. **Saldo só muda por `lancarTransacao`** e **estoque só por `movimentarEstoque`**, dentro de `db.transaction`.
2. **Ordem de locks em todo o sistema:** `conta` → (`pedido` | `depósito`) → `produtos` em ordem crescente de id. Para travar um pedido/depósito, descubra a `conta_id` sem lock, chame `travarConta` e só então faça `forUpdate()` no pedido/depósito. (Ver `estorno.servico.ts` e `pagamento.servico.ts`.) Quando também for preciso travar a **linha do aluno** (encerramento), ela vem **depois da conta**: `conta` → `aluno` → (`pedido` | `depósito`) → `produtos`. As rotas da Diretoria que travam o aluno (carteirinha, foto, edição) nunca travam a conta depois, então não fecham ciclo com a compra.
3. **`escolaId` vem sempre do token** (`usuarioDaEscola(req)`), nunca de URL/body. Toda query de equipe filtra por `escola_id`.
4. **Recurso de outra escola ou de outro responsável = 404**, nunca 403.
5. **O caixa nunca recebe saldo** em nenhuma resposta.
6. **Dinheiro em centavos inteiros.** Valor vindo do MP passa por `reaisParaCentavos`.
7. **Notificações são inseridas na mesma transação** do evento (outbox); o push sai por job depois do COMMIT.
8. **Logs sem dados pessoais** (sem nome, e-mail, token, PIN, body).
9. **Toda entrada validada com Zod** no início da rota. Erros de negócio com `erros.regra(...)`/`erros.conflito(...)`.
10. **Toda ação sensível gera auditoria:** regras, bloqueios, PIN, carteirinha, foto vista, estorno, ajuste, reembolso, encerramento, desvínculo.

---

## 3. Estrutura e padrão de um módulo

```
src/modulos/<modulo>/
  <modulo>.rotas.ts      ← Router: autenticação/papel + Zod + chama o serviço + monta a resposta
  <assunto>.servico.ts   ← regras e acesso ao banco (recebe escolaId/ids já resolvidos)
```
- Serviços recebem `agora?: Date` quando a regra depende de data (testável).
- Converter `snake_case` (banco) → `camelCase` (API) **explicitamente** na resposta.
- Registrar o router em `src/app.ts`.
- Cada serviço novo ganha testes em `tests/` usando `tests/fixtures.ts` (cada teste cria a própria escola).

---

## 4. O que falta implementar (por módulo)

> **4.1 a 4.3: ✅ prontos (bloco 4A).** O texto abaixo continua como especificação. Detalhes decididos na implementação:
> - **E-mail em segundo plano** (`enviarEmailEmSegundoPlano`), sempre **depois do COMMIT**: a resposta não espera o SMTP, o tempo de resposta não revela se a conta existe, e falha de SMTP vai para o log (sem o endereço). `aguardarEmailsPendentes()` é usado nos testes e no desligamento (SIGTERM).
> - **Variáveis novas:** `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_SEGURO` (`true` = porta 465), `SMTP_USUARIO`, `SMTP_SENHA`, `EMAIL_REMETENTE`; `URL_PAINEL` e `URL_APP_PAIS` só para dev (em produção os links usam `URL_PUBLICA_API` e `URL_PUBLICA_API/app`). Em produção, `SMTP_HOST` e `URL_PUBLICA_API` são obrigatórios (a API não sobe sem eles).
> - **Links:** responsável → `/app/verificar-email`, `/app/redefinir-senha`, `/app/entrar`, `/app/esqueci-senha`; equipe → `/redefinir-senha` (esqueci) e `/definir-senha` (convite de 72 h). Os dois da equipe chamam o mesmo `POST /auth/senha/redefinir`.
> - **Gerar um token novo invalida os anteriores** do mesmo tipo e da mesma pessoa (só o link mais recente vale). Como a API não tem DELETE em `tokens_email_lanchei`, invalidar = preencher `usado_em`.
> - **Cadastro repetido** de um e-mail **não verificado** manda um link de verificação novo (em vez do aviso "você já tem conta"). Conta desativada não recebe nada.
> - **Redefinir a senha pelo link confirma o e-mail** do responsável (abrir o link prova que o e-mail é dele).
> - **Escola desativada:** além do login, o **refresh** também é recusado, e as sessões abertas da equipe são revogadas na hora (o access token já emitido vale até 15 min).
> - O SUPERADMIN pode criar **mais de um** ADMIN/ESCOLA por escola (ex.: o único admin da cantina saiu); quem perdeu o convite de 72 h usa "Esqueci minha senha".
> - Erros novos: `422 TOKEN_INVALIDO` (link inválido, vencido ou já usado) e `409 SLUG_JA_EXISTE`.
> - Rate limits: cadastro 10/h por IP; esqueci e reenviar 3/h por e-mail; verificar e redefinir 20/15 min por IP.

### 4.1 Infra de e-mail — `src/infra/email.ts`
- Interface `enviarEmail({ para, assunto, html, texto })`.
- Produção: SMTP via `nodemailer` (ou um provedor como Resend), com variáveis `SMTP_*`/`EMAIL_REMETENTE` adicionadas ao `env.ts`.
- Dev/test: implementação que guarda em memória/loga **sem** dados pessoais em produção.
- Templates simples em PT-BR: verificação de e-mail, redefinição de senha, convite de equipe, **código de ativação do responsável**, alerta de reconciliação.

### 4.2 Auth restante (`auth.rotas.ts`)
- `POST /auth/responsavel/cadastro`: sempre `201 { mensagem }`, inclusive se o e-mail já existe (nesse caso, envia um e-mail avisando "você já tem conta"). Isso evita enumeração de e-mails. Senha com mínimo de 8 caracteres e hash argon2id. Cria um token `VERIFICAR_EMAIL` (24 h) em `tokens_email_lanchei` (guarda só o SHA-256).
- `POST /auth/responsavel/verificar-email`: marca `email_verificado_em`; o token é de uso único.
- `POST /auth/responsavel/reenviar-verificacao`: sempre 202.
- `POST /auth/senha/esqueci`: sempre 202; token `REDEFINIR_SENHA` de 1 h.
- `POST /auth/senha/redefinir`: troca a senha e chama `revogarTodasSessoes`.
- Rate limit conforme a Etapa 3.

### 4.3 Plataforma (SUPERADMIN): `/v1/plataforma`
- CRUD de escolas e `POST /escolas/:id/usuarios` com `papel: 'ADMIN' | 'ESCOLA'` (primeiro usuário da Cantina e da Diretoria): cria o usuário com `senha_hash` de um valor aleatório e envia um token `REDEFINIR_SENHA` com **72 h** de validade como "defina sua senha".

### 4.4 Admin: `/v1/admin` (papéis por rota conforme a matriz da `etapa6-painel.md` §2: Cantina = `ADMIN`, Diretoria = `ESCOLA`)

> **Bloco 4D (caixa restante, app dos pais, push, jobs, cookie, fronts) ✅ pronto.** Com ele, a Etapa 4 está completa. Decisões tomadas na implementação:
> - **Caixa:** `GET /caixa/catalogo` → `{ categorias: [{ id, nome, produtos: [{ id, nome, precoCentavos, estoqueDisponivel, estoqueMinimo }] }] }` (só ativos; categoria sem produto ativo some). A busca casa com o começo do nome **e** com o começo de qualquer sobrenome ("Sil" → João Silva). `GET /caixa/pedidos/hoje` traz `aluno: { id, primeiroNome, turma }`. Nenhuma resposta do caixa traz saldo.
> - **Vínculo:** mesma mensagem (`422 CODIGO_INVALIDO`) para código inexistente, vencido, usado ou de outro e-mail. O contador de tentativas do convite é gravado **depois do COMMIT** (com o erro lançado dentro da transação, o ROLLBACK apagaria a tentativa; há teste que prova isso). Novos erros: `EMAIL_NAO_VERIFICADO`, `TERMO_DESATUALIZADO` (`detalhes.versaoAtual`), `409 JA_VINCULADO`. Quem já foi vinculado e saiu volta com um convite novo (o vínculo é reativado). O limite de 5 erros/hora fica ligado também nos testes.
> - **Alterações dos pais** (regras, bloqueios, PIN, carteirinha) travam a linha de `regras_aluno` do aluno: pai e mãe salvando juntos fazem fila. Só os **outros** responsáveis são avisados. Aluno ENCERRADO: os pais ainda consultam (extrato, compras), mas não alteram nada (`422 ALUNO_ENCERRADO`). O detalhe do filho traz `ultimaAlteracao: { por, em, oQue }`.
> - **PIN:** recusa repetidos, sequências (crescente e decrescente), ABAB, AABB e ABBA (`422 PIN_FRACO`); a senha errada do responsável dá `422 SENHA_INCORRETA` (não 401, para o app não confundir com sessão expirada). O PIN nunca vai para a auditoria. Definir ou remover avisa o outro responsável.
> - **Depósito Pix:** a chamada ao MP fica **fora** da transação. Repetir a Idempotency-Key devolve o mesmo depósito com **200** (a criação é 201); se o primeiro envio ainda espera o MP, `409 DEPOSITO_EM_PROCESSAMENTO` (o app tenta de novo com a mesma chave). Chave de outro responsável/aluno → `409 IDEMPOTENCY_KEY_REUTILIZADA`. MP fora do ar → depósito CANCELADO + `502`; repetir a mesma chave devolve o CANCELADO, e o app gera uma chave nova. Token do MP vencido também dá `MP_NAO_CONECTADO`. A descrição do Pix não leva o nome do aluno. `pixCopiaCola` só aparece enquanto o Pix está aberto. O histórico do filho mostra os depósitos de todos os responsáveis, com `feitoPorMim` e `feitoPor` (primeiro nome).
> - **Aparelhos de push:** upsert pelo SHA-256 do endpoint; o aparelho passa para quem logou por último. Desativar só vale para aparelho do próprio responsável. Endpoint precisa ser HTTPS.
> - **Troca de senha logado** (`POST /me/senha`): revoga todas as sessões e devolve um par novo para este aparelho (modo cookie respeitado).
> - **LGPD:** `GET /me/dados` (JSON para baixar, sem chaves de push nem hashes, auditado `DADOS_EXPORTAR`); `POST /me/solicitacoes-lgpd` vai por e-mail aos usuários ESCOLA de cada escola dos filhos (`422 SEM_ESCOLA` se não houver vínculo).
> - **Refresh em cookie:** header `X-Cliente: web` (painel/caixa, cookie `lanchei_rt`) ou `X-Cliente: pais` (app dos pais, cookie `lanchei_rt_pais`). Dois cookies porque os dois apps estão na mesma origem. Cookie `HttpOnly; SameSite=Strict; Path=/v1/auth`, `Secure` em produção, 30 dias. No modo cookie, o `refreshToken` **sai do JSON**. Refresh inválido limpa o cookie. Sem refresh, o `/refresh` agora responde `401` (antes, `400`). Em produção **não há CORS** (mesma origem).
> - **Web Push:** biblioteca `web-push` 3.6.7 (a 4.0 tinha menos de duas semanas). TTL de 24 h; `404/410` desativa o aparelho. Garantia "no máximo uma vez" (o lote é marcado antes do envio). Notificação com mais de 24 h sem sair não é mais enviada (`push_erro = EXPIRADA`). Payload: `{ titulo, corpo, url, notificacaoId }`, com `url` = `/app/filhos/:id/compras/:pedidoId`, `/app/filhos/:id/extrato` (depósito), `/app/filhos/:id` ou `/app/notificacoes`. Sem as chaves VAPID, o job de push não liga e `GET /push/chave-publica` dá `503 PUSH_NAO_CONFIGURADO`.
> - **Jobs** (`setInterval` com trava "rodando", sem dependência nova): push 15 s; webhooks 1 min (só eventos com mais de 1 min e menos de 3 dias); depósitos vencidos 5 min (margem de 2 min; **se a consulta ao MP falha, não cancela**); os diários (token do MP, reconciliação, limpeza) rodam alguns minutos depois de cada subida e a cada 24 h. A renovação do token grava o refresh novo com "trava otimista" (só se o refresh no banco ainda é o que foi usado), para não sobrescrever uma reconexão feita no meio. A reconciliação manda e-mail (só com quantidades) para os SUPERADMIN ativos. A **limpeza não apaga**: a API não tem DELETE nessas tabelas; ela marca sessões vencidas como revogadas e tokens de e-mail vencidos como usados. Apagar dados antigos (retenção LGPD) é tarefa administrativa com o usuário administrador do banco. Convites vencidos não são mexidos (são a pendência "convite vencido").
> - **Fronts:** `/app` é montado antes de `/`; `/assets/*` com cache de 1 ano (`immutable`); `index.html`, `sw.js` e o manifest com `no-cache`; arquivo inexistente e rota `/v1` inexistente continuam `404` em JSON. CSP: `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `img-src 'self' data: blob:`, `media-src 'self' blob:`, `frame-ancestors 'none'`, `style-src 'self' 'unsafe-inline'` (estilos inline do React/Vite).
> - **Variáveis novas:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `TERMO_VERSAO` (padrão `2026-11-v1`), `TERMO_URL` (vazio = `/app/termos`).
>
> **Bloco 4C (Cantina) ✅ pronto.** Decisões tomadas na implementação:
> - **Venda manual:** mesmos locks e mesma idempotência da compra; valida **só saldo e estoque**. O pedido fica com `created_at = ocorridoEm` (quando a venda aconteceu) e o lançamento no ledger com o instante real em que o saldo mudou. Motivo: assim a venda conta no **limite** e nos **relatórios** do dia em que ocorreu (com "agora", uma venda de segunda lançada na terça consumiria o limite diário da terça). `ocorridoEm` não pode ser futuro nem ter mais de 60 dias. Saldo insuficiente → `422 SALDO_INSUFICIENTE` com `detalhes.faltamCentavos` e **nada gravado**. Aluno INATIVO passa; ENCERRADO não. Produto precisa estar ativo.
> - **Ajuste de saldo:** ±R$ 5.000 no máximo, descrição obrigatória (5+ caracteres). Como o ledger não tem Idempotency-Key para ajustes, um ajuste **idêntico** (mesmo usuário, conta, valor e descrição) em menos de 1 minuto é recusado com `409 AJUSTE_DUPLICADO` (a checagem roda com a conta travada). Em conta ENCERRADA só se aceita **débito**.
> - **Encerramento:** trava a conta e depois o aluno; `409 JA_ENCERRADO`; com Pix **em aberto** (PENDENTE não vencido) → `409 DEPOSITO_PENDENTE` (senão o crédito cairia numa conta fechada); saldo > 0 sem `reembolso` → `422 SALDO_PENDENTE` (`detalhes.saldoCentavos`). O saldo **inteiro** sai como REEMBOLSO; a carteirinha viva e os convites pendentes são revogados; os responsáveis vinculados são avisados **por e-mail** (os vínculos continuam, para verem o extrato). Se um Pix pago no último segundo for creditado depois do encerramento, o resumo mostra o alerta `ENCERRADO_COM_SALDO` e a cantina zera com um ajuste negativo depois de devolver o valor. A criação de depósito recusa aluno ENCERRADO (4D).
> - **Catálogo:** nome repetido → `409 NOME_JA_EXISTE`; preço de R$ 0,01 a R$ 1.000; produto novo começa com estoque 0 (a quantidade entra como movimento ENTRADA); desligar `controlaEstoque` com estoque > 0 → `422 ZERAR_ESTOQUE_ANTES`. Criação e edição auditadas (`PRODUTO_*`, `CATEGORIA_*`).
> - **Estoque:** `abaixoDoMinimo` = `estoqueAtual <= estoqueMinimo`; a lista traz só produtos ativos com controle, os que estão acabando primeiro. O AJUSTE trava o produto **antes** de calcular a diferença. Não há auditoria à parte: o livro de movimentos é imutável e guarda o usuário. Erros: `SEM_DIFERENCA`, `MOTIVO_OBRIGATORIO`, `QUANTIDADE_INVALIDA`, `SEM_CONTROLE_ESTOQUE`.
> - **Relatórios:** `de` e `ate` obrigatórios (AAAA-MM-DD no fuso da escola, até 366 dias); agrupamento por dia feito no Node com Luxon (sem depender de `CONVERT_TZ`); depósitos pela data de aprovação, com os DEVOLVIDOS destacados; `saldos?formato=csv` lista o saldo por aluno e gera auditoria `SALDOS_EXPORTAR`.
> - **Resumo** (`GET /admin/resumo?data=`): vendas, pedidos, ticket médio, depósitos, recusas por motivo, estoque baixo e alertas `MP_DESCONECTADO`, `MP_EXPIRANDO` (< 30 dias), `DEPOSITO_DEVOLVIDO` e `DEPOSITO_VALOR_DIVERGENTE` (últimos 30 dias), `RECONCILIACAO`, `ENCERRADO_COM_SALDO`.
> - **Auditoria por perfil:** a Cantina vê as ações de `ACOES_CANTINA` + `ACOES_COMUNS` (`auditoria.servico.ts`); a Diretoria vê todo o resto + as comuns. Ação nova não classificada cai na Diretoria. IP e user-agent não são expostos; o nome de um responsável só aparece para a Diretoria.
> - **Mercado Pago OAuth** (conferido na documentação oficial em nov/2026): autorização em `https://auth.mercadopago.com/authorization` (`client_id`, `response_type=code`, `platform_id=mp`, `state`, `redirect_uri`); troca em `POST /oauth/token` (JSON); o `code` vale 10 min e é de uso único; o access token vale 180 dias e **renovar devolve um refresh token novo**. O `state` é um JWT de 10 min com `audience: mp-oauth` (não serve como token de acesso, e vice-versa); no callback confere-se de novo se quem começou ainda é ADMIN ativo. Conta MP já usada por outra escola → `MP_CONTA_EM_USO` (sem `ON DUPLICATE KEY UPDATE`, que atualizaria a linha da outra escola). O callback **sempre redireciona** para `URL_PAINEL/painel/cantina/configuracoes?mp=conectado` ou `?mp=erro&motivo=CODIGO`. Sem `MP_CLIENT_ID`/`MP_CLIENT_SECRET` → `409 MP_NAO_CONFIGURADO`. Variáveis: `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI` (vazio = `URL_PUBLICA_API + /v1/mercadopago/oauth/callback`). ⚠️ PKCE não é usado (se for ligado na aplicação do MP, o código precisa mudar) e a aplicação precisa do escopo `offline_access` (sem ele não vem `refresh_token`). A renovação automática do token é o job da 4D.
>
> **Bloco 4B (Diretoria) ✅ pronto.** Decisões tomadas na implementação:
> - **Equipe (`/admin/usuarios`) já feita para os dois perfis:** ADMIN gerencia ADMIN/OPERADOR, ESCOLA gerencia ESCOLA; usuário de outro perfil = 404 para quem pergunta. Ninguém desativa a si mesmo nem muda o próprio papel (`NAO_PODE_DESATIVAR_A_SI_MESMO`, `NAO_PODE_MUDAR_PROPRIO_PAPEL`). Desativar **ou mudar o papel** revoga as sessões (o papel antigo está dentro do token).
> - **`PATCH /admin/escola` com permissão por campo:** ESCOLA → `nome`, `timezone`; ADMIN → `depositoMinCentavos`, `depositoMaxCentavos` (R$ 1 a R$ 5.000). Campo de outro perfil → 403. Mínimo > máximo → `422 DEPOSITO_MIN_MAIOR_QUE_MAX`. O GET mostra `mercadoPagoConectado`.
> - **Ficha do aluno por papel (menor privilégio):** a Cantina vê dados, saldo e carteirinha; responsáveis (com e-mail), convites, regras e bloqueios só a Diretoria.
> - `GET /admin/turmas` liberado também para a Cantina (filtro da busca de alunos). Desativar turma com alunos → `422 TURMA_COM_ALUNOS` (mova antes).
> - **Convites:** convidar de novo o mesmo e-mail revoga o código pendente anterior; e-mail já vinculado → `409 RESPONSAVEL_JA_VINCULADO`; convite usado → `409 CONVITE_JA_USADO`. **`enviado_em` só é gravado quando o e-mail sai** (uma falha de SMTP, como o limite diário do plano gratuito, vira a pendência `CONVITE_NAO_ENVIADO`; a solução é "Reenviar", que gera código novo, porque o banco só tem o hash). SMTP com **pool** (2 conexões) para a importação não abrir centenas de conexões.
> - **Desvincular** avisa o responsável **por e-mail** (desvinculado, ele não vê mais o aluno no app, e não existe tipo de notificação para isso).
> - **Carteirinha em lote** só para alunos ATIVOS **sem** carteirinha viva (quem já tem não é afetado; trocar = emissão individual, que revoga a anterior na mesma transação e avisa os pais). A emissão trava a linha do aluno: emissões simultâneas fazem fila (teste com 5 em paralelo → 1 viva).
> - **Histórico (`/extrato`):** junta o ledger **e as compras recusadas** (tipo `RECUSADA`, com `motivoRecusa` e os itens; não mexem no saldo), mais novo primeiro, cursor `(data, origem, id)`. Auditoria `HISTORICO_VISUALIZAR` **só na abertura** (as páginas seguintes da rolagem não repetem). Filtros `de`/`ate` (AAAA-MM-DD no fuso da escola) e `tipo`. CSV: até 10.000 linhas, colunas `data_hora;tipo;descricao;valor_reais;saldo_apos_reais;motivo_recusa`, nome do arquivo com a matrícula (sem o nome do aluno).
> - **Importação:** exige UTF-8 (`422 ARQUIVO_NAO_UTF8` explicando como salvar no Excel); aceita BOM e os cabeçalhos `email_resp_1/2` além de `email_responsavel_1/2`; até 2.000 linhas; turma comparada sem diferenciar maiúsculas; turma desativada = erro na linha. Gravação **em lote** (500 por INSERT) numa transação só. Com erro: `422 IMPORTACAO_COM_ERROS` e o relatório em `detalhes`.
> - **Foto:** `sharp` com `.rotate()` (aplica a orientação antes de descartar o EXIF), recorte 400×400 com `position: attention`, JPEG 80 (mozjpeg), `limitInputPixels` de 60 MP contra "bomba de descompressão". Upsert via `INSERT ... ON DUPLICATE KEY UPDATE` (a API não tem DELETE). Arquivo que não é imagem → `422 IMAGEM_INVALIDA`.
> - **Pendências** (`GET /admin/pendencias`): `alunosAtivos, semCarteirinha, semFoto, semResponsavel, convitesVencidos, convitesNaoEnviados`; os mesmos nomes (em maiúsculas) servem de filtro `?pendencia=` em `GET /admin/alunos`.
> - Lista de alunos ordenada por nome, com `?busca=` (parte do nome ou matrícula exata; `%` e `_` são tratados como texto).
- **Escola:** GET/PATCH (fuso validado com Luxon; mínimo ≤ máximo de depósito).
- **Mercado Pago OAuth:**
  - `POST /admin/mercadopago/conectar` devolve a URL de autorização do MP, com `state` = JWT curto (10 min) contendo `escolaId` e `usuarioId`.
  - `GET /v1/mercadopago/oauth/callback?code&state` valida o `state`, troca o `code` por tokens (endpoint OAuth do MP: **conferir a documentação oficial**), salva `access_token_enc`/`refresh_token_enc` com `criptografar()`, `mp_user_id` e `token_expira_em`, e redireciona para o painel.
  - Variáveis novas: `MP_CLIENT_ID`, `MP_CLIENT_SECRET`, `MP_REDIRECT_URI`, `URL_PAINEL`.
- **Usuários da equipe:** criar (convite com token de 72 h), editar, desativar (+ `revogarTodasSessoes`). O admin não pode desativar a si mesmo.
- **Turmas:** CRUD sem delete (`ativo`).
- **Alunos:**
  - `POST /admin/alunos` numa transação: aluno + `regras_aluno` (padrão: seg–sex, alerta de R$ 10) + conta + um convite por e-mail de responsável. O e-mail sai **depois** do COMMIT.
  - **Importação CSV** (`POST /admin/alunos/importar`, multipart via `multer`, até 2 MB) e **`GET /admin/alunos/importar/modelo`**, que baixa o modelo. A escola preenche o **nosso** modelo:
    ```
    nome;matricula;turma;email_responsavel_1;email_responsavel_2
    João Pedro Silva;2026001;3º A;maria@email.com;jose@email.com
    ```
    UTF-8 (aceitar BOM), separador `;`. Valida tudo antes de gravar; `?simular=true` só devolve o relatório `{ validos, erros: [{ linha, campo, mensagem }] }`. Turma inexistente é **criada** no ano letivo atual e aparece no relatório. Matrícula duplicada (no arquivo ou no banco) é erro. Gravação em transação única: ou entra tudo ou nada.
  - `PUT /admin/alunos/:id/foto`: `multer` em memória (até 5 MB, JPEG/PNG/WebP) → `sharp(buffer).rotate().resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 })` (o sharp remove EXIF/GPS por padrão) → upsert em `fotos_alunos_lanchei` com `sha256`.
  - `GET .../foto`: bytes com `Content-Type`, `ETag` = sha256 hex e `Cache-Control: private, no-store`. **Auditoria `FOTO_VISUALIZAR`** em todo acesso (admin, caixa e responsável).
  - `POST /admin/alunos/:id/encerramento` numa transação: `travarConta` → se o saldo > 0, exige `reembolso` → insere em `reembolsos_lanchei` → `lancarTransacao(REEMBOLSO, -saldo, reembolsoId)` → aluno `ENCERRADO` + `encerrado_em` → carteirinha viva `REVOGADA` → auditoria.
  - `POST /admin/alunos/:id/ajustes`: `lancarTransacao(AJUSTE)` + auditoria.
- **Convites:** código de **8 caracteres** com alfabeto sem ambíguos (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), gerado com `crypto.randomInt`; guarda só o SHA-256 (normalizar para maiúsculas antes do hash); validade de 7 dias. Reenviar revoga o anterior.
- **Carteirinhas:**
  - Emitir: numa transação, **primeiro** `UPDATE ... status='REVOGADA', revogada_em` na carteirinha viva (por causa da UNIQUE `aluno_vivo`) e **depois** `INSERT` da nova com `sha256(token)`. Responde `qrConteudo = montarQr(token)` **só nesta resposta**.
  - Lote por turma: mesma lógica para os alunos ATIVOS sem carteirinha viva.
- **Catálogo:** CRUD de categorias e produtos (sem delete). Desligar `controlaEstoque` com estoque > 0 → `422 ZERAR_ESTOQUE_ANTES`.
- **Pedidos:** listagem/detalhe; `POST /admin/pedidos/:id/estorno` reusa `estornarPedido` com papel ADMIN.
- **Venda manual** (`POST /admin/vendas-manuais` + `Idempotency-Key`): criar `registrarVendaManual` no padrão de `compra.servico.ts`, com os mesmos locks e a mesma idempotência, mas **validando só saldo e estoque**. Usa `modo_identificacao='MANUAL'`, `carteirinha_id=null`, `operador_id=admin`, `observacao` e `ocorrido_em` obrigatórios, e notifica `COMPRA`.
- **Relatórios:** consultas agregadas sobre pedidos CONFIRMADOS, depósitos APROVADOS e soma dos saldos (agrupando por dia **no fuso da escola**: `CONVERT_TZ` precisa das tabelas de fuso no MySQL; alternativa segura é agrupar no Node com Luxon).
- **Auditoria:** listagem paginada por cursor (`id < cursor ORDER BY id DESC`).

### 4.5 Caixa restante (`caixa.rotas.ts`)
- `GET /caixa/catalogo`: categorias e produtos ativos + `estoqueDisponivel` (null se o produto não controla estoque).
- `GET /caixa/alunos/busca?q=&turmaId=`: `q` com no mínimo 3 caracteres; `nome LIKE 'q%'` (usa `ix_alunos_busca`); só ATIVOS; até 20 resultados; `aceitaPin` = `permite_sem_carteirinha && pin_hash != null`. Sem foto na lista.
- `GET /caixa/alunos/:id/foto` com auditoria.
- `GET /caixa/pedidos/hoje`: pedidos do operador logado no dia (fuso da escola), sem saldo.

### 4.6 Estoque: `/v1/estoque` (ADMIN e OPERADOR)
- `POST /estoque/movimentos`: ENTRADA/PERDA recebem quantidade positiva (a API aplica o sinal); AJUSTE recebe a **contagem real**, e a API calcula `real - atual` (diferença 0 → `422 SEM_DIFERENCA`; motivo obrigatório). Sempre via `movimentarEstoque`, com `usuarioId`.

### 4.7 Responsável: `/v1/me` (exigirResponsavel)
- Helper **`garantirVinculo(responsavelId, alunoId)`**: vínculo com `desvinculado_em IS NULL`; senão 404. Devolve `escolaId`. Usar em **toda** rota `/me/filhos/:alunoId/*`.
- `POST /me/vinculos`: e-mail verificado; normaliza o código → SHA-256 → convite não usado, não revogado e não expirado. O e-mail do convite precisa ser igual ao do responsável (se diferente, `tentativas_falhas++` no convite; com 5, revoga). Em transação: marca o convite como usado, insere o vínculo (se já existe desvinculado, reativa) e o consentimento `ACEITE`. Rate limit de 5 erros por hora por responsável.
- Filhos, detalhe e extrato: paginação por cursor = último `transacoes.id` (índice `ix_tx_extrato`).
- `PUT /regras`: converte dias com `diasParaMascara`; `permiteSemCarteirinha: true` exige PIN. Auditoria com antes/depois e `notificarResponsaveis(... REGRAS_ALTERADAS, excetoResponsavelId)`.
- `PUT /bloqueios`: em transação, valida que os ids pertencem à escola do aluno, faz delete + insert do conjunto, auditoria e aviso aos outros responsáveis.
- `PUT /pin`: confere a senha do responsável; rejeita PINs óbvios (`0000`…`9999` repetidos, `1234`, `4321`, `0123`, `9876`, `1212`…); grava hash argon2id, zera `pin_falhas` e auditoria. `POST /pin/remover` também desliga `permite_sem_carteirinha`.
- Carteirinha: bloquear (ATIVA→BLOQUEADA) e desbloquear (BLOQUEADA→ATIVA) + auditoria + aviso aos outros.
- **Depósito Pix** (`POST /me/filhos/:alunoId/depositos` + `Idempotency-Key`):
  1. Se já existe depósito com essa chave **deste responsável**, devolve o mesmo.
  2. Valida mínimo/máximo da escola e se o MP está conectado (`409 MP_NAO_CONECTADO`).
  3. INSERT `PENDENTE` (precisa do id para o `external_reference`), `expira_em = agora + 30 min`.
  4. `clienteMercadoPago.criarPix(...)` com o token da cantina, `idempotencyKey` do depósito, `externalReference = id`, `emailPagador` = e-mail do responsável e `notificationUrl = URL_PUBLICA_API + '/v1/webhooks/mercadopago'`.
  5. Salva `mp_payment_id` e `pix_copia_cola`. Se o MP falhar, marca `CANCELADO` e responde `502 GATEWAY_INDISPONIVEL`.
- `GET /me/depositos/:id`: só do próprio responsável.
- Notificações (listar, marcar lida), dispositivos push (formato Web Push/Expo em `etapa7-app-pais.md` §3), perfil, senha.
- **LGPD:** `GET /me/dados` (export JSON) e `POST /me/solicitacoes-lgpd` (e-mail aos usuários `ESCOLA`, pois a escola é a controladora, + auditoria). `POST /me/filhos/:id/desvincular` grava `desvinculado_em` + consentimento `REVOGACAO`.
- `GET /v1/termos/atual` (público): versão + URL do termo (config).

### 4.8 Jobs (`src/jobs/`, iniciados em `server.ts`)
| Job | Intervalo | Detalhes |
|---|---|---|
| Push | 15 s | Lê notificações sem `push_enviado_em` (limite de 100 por vez) e envia para os dispositivos ativos do responsável. Canal **WEB** via `web-push` (VAPID; `404`/`410` → `ativo=false`); canal **EXPO** só na fase 2. Grava `push_enviado_em`/`push_erro`. Ver `etapa7-app-pais.md` §3 |
| Reprocessar webhooks | 1 min | eventos válidos, não processados, com mais de 1 min → `processarEventoWebhook` (já existe) |
| Depósitos pendentes | 5 min | `PENDENTE` com `expira_em` passado → `sincronizarPagamento`; se o MP ainda disser pendente, marca `CANCELADO` |
| Renovar token MP | diário | renova tokens que expiram em menos de 30 dias |
| Reconciliação | diário | `vw_contas_divergentes_lanchei` e `vw_estoque_divergente_lanchei`; qualquer linha → e-mail para o superadmin |
| Limpeza | diário | sessões, tokens de e-mail e convites expirados |

Usar `setInterval` com uma flag "rodando" (evita sobreposição) ou `node-cron`. Uma instância só no Render, então não precisa de lock distribuído.

### 4.9 Dependências a adicionar
`multer`, `sharp`, `nodemailer` (ou SDK do provedor), `web-push`, `csv-parse`, `cookie-parser`.

---

## 5. Como rodar

```bash
# na raiz do repositório
npm install
cp apps/api/.env.example apps/api/.env            # ajuste o MySQL
cp apps/api/.env.test.example apps/api/.env.test  # banco *_test (é apagado nos testes)
npm run db:schema -w apps/api                     # cria o banco "lanchei"
npm run db:superadmin -w apps/api -- --nome "Mateus" --email voce@exemplo.com --senha "senha-forte-aqui"
npm run api:test                                  # 577 testes
npm run api:dev                                   # http://localhost:3333/health
```

## 6. O que testar antes de seguir (Etapa 5)
- `npm run api:test` passando (inclui concorrência).
- Login de operador → `POST /caixa/identificar` → `POST /caixa/pedidos` com `Idempotency-Key`, pelo Insomnia/Postman/Bruno.
- Clique duplo (mesma chave duas vezes) → mesma resposta e um débito só.
- Saldo insuficiente → `422 COMPRA_RECUSADA`.
