# Etapa 3: Arquitetura da API (Lanchei)

API REST em Node + Express + TypeScript, hospedada no Render. Banco MySQL no Aiven.

---

## 1. Convenções gerais

| Item | Regra |
|---|---|
| Base | `/v1` (versionada desde o início; o app mobile antigo continua funcionando quando sair a v2) |
| Formato | JSON, `camelCase` nos campos (o banco usa `snake_case`; a API converte) |
| Dinheiro | Sempre inteiro em centavos, campo terminando em `Centavos` (`valorCentavos: 2500` = R$ 25,00) |
| Datas | ISO 8601 em UTC (`2026-11-05T19:30:00.000Z`). O app converte para o fuso local |
| IDs | Numéricos. A segurança vem da autorização em toda rota, não de ID "difícil de adivinhar" |
| Paginação | Por cursor: `?limite=20&cursor=<opaco>` → resposta `{ itens: [...], proximoCursor: "..." \| null }` |
| Idempotência | Header `Idempotency-Key: <uuid v4>` **obrigatório** em `POST /caixa/pedidos` e `POST /me/filhos/:id/depositos` |
| Tenant | Para a equipe, o `escolaId` vem **sempre do token**, nunca da URL ou do body. Não existe como pedir dados de outra escola |
| Acesso negado a recurso alheio | **404**, não 403 (não confirma que o recurso existe; evita enumeração de alunos) |

### Formato de erro (único em toda a API)

```json
{
  "erro": {
    "codigo": "LIMITE_DIARIO",
    "mensagem": "O limite diário deste aluno foi atingido.",
    "detalhes": { }
  }
}
```

`codigo` é estável (o front decide o que fazer por ele); `mensagem` é para mostrar ao usuário.

| HTTP | Quando | Códigos |
|---|---|---|
| 400 | Body/parâmetros inválidos (Zod) | `VALIDACAO` (com `detalhes.campos`) |
| 401 | Sem token, token expirado ou inválido | `NAO_AUTENTICADO`, `TOKEN_EXPIRADO` |
| 403 | Logado, mas o papel não permite | `SEM_PERMISSAO` |
| 404 | Não existe ou não é seu | `NAO_ENCONTRADO`, `CARTEIRINHA_INVALIDA` |
| 409 | Conflito de estado | `ESTOQUE_INSUFICIENTE`, `EMAIL_JA_CADASTRADO`, `SLUG_JA_EXISTE`, `MATRICULA_JA_EXISTE`, `TURMA_JA_EXISTE`, `RESPONSAVEL_JA_VINCULADO`, `CONVITE_JA_USADO`, `NOME_JA_EXISTE`, `AJUSTE_DUPLICADO`, `JA_ENCERRADO`, `DEPOSITO_PENDENTE`, `MP_NAO_CONFIGURADO`, `MP_CONTA_EM_USO`, `IDEMPOTENCY_KEY_REUTILIZADA`, `JA_ESTORNADO`, `MP_NAO_CONECTADO` |
| 422 | Regra de negócio recusou | `COMPRA_RECUSADA` (+ `detalhes.motivo`), `CODIGO_INVALIDO`, `TOKEN_INVALIDO` (link de e-mail inválido/vencido/usado), `ALUNO_ENCERRADO`, `TURMA_INATIVA`, `TURMA_COM_ALUNOS`, `IMAGEM_INVALIDA`, `ARQUIVO_NAO_UTF8`, `IMPORTACAO_COM_ERROS`, `DEPOSITO_MIN_MAIOR_QUE_MAX`, `SALDO_INSUFICIENTE`, `ZERAR_ESTOQUE_ANTES`, `SEM_DIFERENCA`, `MOTIVO_OBRIGATORIO`, `DATA_NO_FUTURO`, `DATA_MUITO_ANTIGA`, `PERIODO_INVALIDO`, `PERIODO_GRANDE_DEMAIS`, `MP_STATE_INVALIDO`, `PIN_INCORRETO`, `VALOR_FORA_DO_LIMITE`, `SALDO_PENDENTE` |
| 423 | Bloqueado temporariamente | `PIN_BLOQUEADO`, `CONTA_TEMPORARIAMENTE_BLOQUEADA` |
| 429 | Muitas tentativas | `MUITAS_TENTATIVAS` |

### Autenticação

- **Access token:** JWT assinado (HS256), validade de **15 min**. Payload:
  `{ sub, tipo: "USUARIO" | "RESPONSAVEL", papel?: "SUPERADMIN" | "ADMIN" | "ESCOLA" | "OPERADOR", escolaId? }`.
- **Refresh token:** string aleatória opaca, validade de **30 dias**, guardada como hash em `sessoes_lanchei`. É **rotacionado** a cada uso: o antigo é revogado e um novo é emitido. Se um refresh token já revogado for usado de novo, a API revoga **todas** as sessões daquele usuário, porque é sinal de roubo.
- **Onde guardar:** web (caixa/painel) e PWA dos pais guardam o access token em memória e o refresh em cookie `HttpOnly; Secure; SameSite=Strict` (mesma origem; ver `etapa5-caixa.md` §7). Um app de loja (fase 2) recebe os dois no JSON e guarda no armazenamento seguro do aparelho.
- Senhas com **argon2id**. Política mínima: 8 caracteres.

### Perfis e prefixos de rota

| Prefixo | Quem acessa |
|---|---|
| `/v1/auth/*` | Público (com rate limit) |
| `/v1/plataforma/*` | `SUPERADMIN` (você) |
| `/v1/admin/*` | `ADMIN` (Cantina) e/ou `ESCOLA` (Diretoria), rota a rota, conforme a matriz da `etapa6-painel.md` §2 |
| `/v1/caixa/*` | `OPERADOR` e `ADMIN` |
| `/v1/estoque/*` | `OPERADOR` e `ADMIN` |
| `/v1/me/*` | `RESPONSAVEL` |
| `/v1/webhooks/*`, `/v1/mercadopago/oauth/callback` | Público, validado por assinatura/state |
| `/health*` | Público |

O SUPERADMIN **não** opera dados de escola (não vê alunos nem extratos). Ele só cria escolas e o primeiro usuário de cada perfil (ADMIN e ESCOLA). É o princípio do menor privilégio, e ajuda na LGPD: você, como operador da plataforma, não acessa dados de crianças no dia a dia.

---

## 2. Endpoints

Legenda de acesso: **P** = público, **S** = superadmin, **A** = admin, **O** = operador, **R** = responsável.

### 2.1 Saúde e keep-alive

| Método | Rota | Acesso | Descrição |
|---|---|---|---|
| GET | `/health` | P | `{ status: "ok" }`. Não toca no banco |
| GET | `/health/db` | P | Faz `SELECT 1` no MySQL e responde `{ status: "ok", db: "ok", latenciaMs }`. **É o alvo do ping de keep-alive** |

**Keep-alive:** um job dentro da própria API chama a **URL pública** `GET https://<api>.onrender.com/health/db` a cada **10 minutos**. Como a requisição entra "de fora", conta como tráfego para o Render, e o `SELECT 1` mantém o Aiven ativo. É o mesmo esquema que já funciona no seu outro projeto.

### 2.2 Autenticação (`/v1/auth`)

| Método | Rota | Acesso | Body | Resposta |
|---|---|---|---|---|
| POST | `/auth/equipe/login` | P | `{ email, senha }` | `{ accessToken, refreshToken, usuario: { id, nome, papel, escola: { id, nome } \| null } }` |
| POST | `/auth/responsavel/cadastro` | P | `{ nome, email, senha, telefone? }` | `201 { mensagem }`. Envia e-mail de verificação |
| POST | `/auth/responsavel/verificar-email` | P | `{ token }` | `{ mensagem }` |
| POST | `/auth/responsavel/reenviar-verificacao` | P | `{ email }` | `202` (sempre, mesmo se o e-mail não existir) |
| POST | `/auth/responsavel/login` | P | `{ email, senha }` | `{ accessToken, refreshToken, responsavel: { id, nome, emailVerificado } }` |
| POST | `/auth/refresh` | P | `{ refreshToken }` | `{ accessToken, refreshToken }` (novo par) |
| POST | `/auth/logout` | P | `{ refreshToken }` | `204` |
| POST | `/auth/senha/esqueci` | P | `{ email, perfil: "EQUIPE" \| "RESPONSAVEL" }` | `202` (sempre) |
| POST | `/auth/senha/redefinir` | P | `{ token, novaSenha }` | `204`. Revoga todas as sessões |

Rate limit: login com **5 tentativas por 15 min** por e-mail + IP; esqueci-senha com 3 por hora por e-mail.

### 2.3 Plataforma (`/v1/plataforma`), somente SUPERADMIN

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/plataforma/escolas` | | `{ itens: [{ id, nome, slug, timezone, depositoMinCentavos, depositoMaxCentavos, ativo, criadoEm, equipe: { admin, escola } }] }` (`equipe` = usuários ativos de cada perfil) |
| POST | `/plataforma/escolas` | `{ nome, slug, timezone? }` | `201 { escola }`. Slug: minúsculas, números e hífen. Repetido: `409 SLUG_JA_EXISTE` |
| PATCH | `/plataforma/escolas/:escolaId` | `{ nome?, ativo? }` | `{ escola }`. Desativar revoga as sessões da equipe da escola |
| POST | `/plataforma/escolas/:escolaId/usuarios` | `{ nome, email, papel: "ADMIN" \| "ESCOLA" }` | `201 { usuario: { id, nome, email, papel, ativo } }`. Cria o usuário da Cantina ou da Diretoria e envia o convite para definir a senha (72 h) |

### 2.4 Administração (`/v1/admin`): Cantina (`ADMIN`) e Diretoria (`ESCOLA`)

> Quem acessa cada grupo de rotas abaixo está na **matriz de permissões** da `etapa6-painel.md` §2 (ex.: turmas, alunos, convites e carteirinhas → ESCOLA; catálogo, pedidos, relatórios e Mercado Pago → ADMIN; consulta e histórico de aluno → os dois). Equipe: ADMIN cadastra ADMIN/OPERADOR; ESCOLA cadastra ESCOLA.

**Escola e Mercado Pago**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/admin/escola` | | Dados e configurações da escola |
| PATCH | `/admin/escola` | `{ nome?, timezone?, depositoMinCentavos?, depositoMaxCentavos? }` | |
| GET | `/admin/mercadopago/status` | | `{ conectado, configurado, mpUserId?, conectadoEm?, tokenExpiraEm?, expirando? }` (`configurado: false` = a plataforma ainda não tem `MP_CLIENT_ID`) |
| POST | `/admin/mercadopago/conectar` | | `{ url }`: URL de autorização do MP com `state` assinado. O admin abre, faz login na conta da cantina e autoriza |
| GET | `/mercadopago/oauth/callback?code&state` | P (valida `state`) | Troca o `code` pelos tokens, criptografa, salva e **redireciona (303)** para `/painel/cantina/configuracoes?mp=conectado` ou `?mp=erro&motivo=CODIGO` (`MP_STATE_INVALIDO`, `AUTORIZACAO_NEGADA`, `MP_CONTA_EM_USO`, `GATEWAY_INDISPONIVEL`...) |

**Equipe**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/admin/usuarios` | | Admins e operadores da escola |
| POST | `/admin/usuarios` | `{ nome, email, papel: "ADMIN" \| "OPERADOR" }` | Cria e envia e-mail para definir senha |
| PATCH | `/admin/usuarios/:id` | `{ nome?, papel?, ativo? }` | Desativar também revoga as sessões. Um admin não pode desativar a si mesmo |

**Turmas**

| Método | Rota | Body |
|---|---|---|
| GET | `/admin/turmas?anoLetivo=` | |
| POST | `/admin/turmas` | `{ nome, anoLetivo }` |
| PATCH | `/admin/turmas/:id` | `{ nome?, ativo? }` |
| PATCH | `/admin/turmas/mover-alunos` | `{ deTurmaId, paraTurmaId, alunoIds? }` (virada de ano; sem `alunoIds` move todos) |

**Alunos**

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/admin/alunos` | `?busca=&turmaId=&status=&limite=&cursor=` | Lista com `{ id, nome, matricula, turma, status, temFoto, carteirinha: status, saldoCentavos, qtdResponsaveis }` |
| POST | `/admin/alunos` | `{ nome, matricula, turmaId, emailsResponsaveis: string[] }` | Cria aluno + `regras_aluno` + conta, numa transação. Para cada e-mail, cria um convite e envia o código |
| POST | `/admin/alunos/importar` | `multipart: arquivo CSV` + `?simular=true` | Importação em massa (`nome;matricula;turma;email_responsavel_1;email_responsavel_2`, UTF-8, `;`; `GET /admin/alunos/importar/modelo` baixa o modelo). Com `simular=true`, só valida e devolve o relatório de erros, sem gravar |
| GET | `/admin/alunos/:id` | | Detalhe: dados, saldo, regras (só leitura), responsáveis vinculados, convites pendentes, carteirinha |
| PATCH | `/admin/alunos/:id` | `{ nome?, matricula?, turmaId?, status?: "ATIVO" \| "INATIVO" }` | `INATIVO` bloqueia compras temporariamente |
| PUT | `/admin/alunos/:id/foto` | `multipart: foto` (JPEG/PNG, máx. 5 MB na entrada) | A API redimensiona para 400×400, recomprime em JPEG e **remove metadados (EXIF/GPS)** antes de salvar |
| GET | `/admin/alunos/:id/foto` | | Bytes da imagem. `Cache-Control: private, no-store`. Gera auditoria `FOTO_VISUALIZAR` |
| POST | `/admin/alunos/:id/encerramento` | `{ motivo, reembolso?: { forma: "PIX" \| "TRANSFERENCIA" \| "DINHEIRO", comprovanteRef? } }` | Encerra o vínculo. Se houver saldo, `reembolso` é **obrigatório** (senão `422 SALDO_PENDENTE`), e o saldo inteiro sai como transação `REEMBOLSO`. Tudo numa transação. Revoga a carteirinha |
| POST | `/admin/alunos/:id/ajustes` | `{ valorCentavos (±), descricao }` | Ajuste manual no ledger (ex.: Pix contestado). Nunca deixa o saldo negativo |

**Convites e vínculos**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| POST | `/admin/alunos/:id/convites` | `{ email }` | Gera código de ativação (8 caracteres, validade de **7 dias**) e envia por e-mail |
| POST | `/admin/convites/:id/reenviar` | | Revoga o código anterior e envia um novo |
| POST | `/admin/convites/:id/revogar` | | |
| POST | `/admin/alunos/:id/responsaveis/:responsavelId/desvincular` | `{ motivo }` | Ex.: guarda judicial alterada. Notifica o responsável |

**Carteirinhas**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| POST | `/admin/alunos/:id/carteirinhas` | `{ motivo? }` | Emite carteirinha nova. Se já existir uma viva, ela é **revogada** na mesma transação. Resposta: `{ carteirinhaId, qrConteudo }` |
| POST | `/admin/turmas/:id/carteirinhas` | | Emissão em lote para os alunos da turma **sem** carteirinha viva. Resposta: `{ itens: [{ alunoId, nome, matricula, turma, temFoto, carteirinhaId, qrConteudo }] }` para impressão |
| POST | `/admin/alunos/:id/carteirinha/desbloquear` | | Admin também pode desbloquear (ex.: responsável sem acesso ao app) |

> ⚠️ **O `qrConteudo` só aparece na resposta da emissão.** O banco guarda apenas o hash, então não dá para "reimprimir" a mesma carteirinha depois: reimprimir = emitir uma nova (e a antiga para de funcionar). Isso é intencional: uma impressão vazada não vira acesso permanente. A tela de impressão (Etapa 6) gera o PDF da carteirinha logo após a emissão.

`qrConteudo` tem o formato `LCH1.<token-base64url>`. O prefixo `LCH1` identifica o sistema e a versão do formato, e a tela do caixa usa isso para recusar na hora um QR qualquer lido por engano.

**Catálogo**

| Método | Rota | Body |
|---|---|---|
| GET | `/admin/categorias` | |
| POST | `/admin/categorias` | `{ nome }` |
| PATCH | `/admin/categorias/:id` | `{ nome?, ativo? }` |
| GET | `/admin/produtos?categoriaId=&ativo=` | |
| POST | `/admin/produtos` | `{ nome, categoriaId, precoCentavos, controlaEstoque, estoqueMinimo? }` |
| PATCH | `/admin/produtos/:id` | `{ nome?, categoriaId?, precoCentavos?, ativo?, controlaEstoque?, estoqueMinimo? }`. Desligar `controlaEstoque` com estoque > 0 exige zerar com AJUSTE antes |

**Pedidos, vendas manuais e relatórios**

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/admin/pedidos` | `?de=&ate=&status=&alunoId=&operadorId=&cursor=` | |
| GET | `/admin/pedidos/:id` | | Com itens |
| POST | `/admin/pedidos/:id/estorno` | `{ motivo, devolverEstoque: boolean }` | Admin estorna pedido de qualquer data |
| POST | `/admin/vendas-manuais` | `{ alunoId, itens: [{ produtoId, quantidade }], ocorridoEm, observacao }` + `Idempotency-Key` | **Contingência** (internet caiu). Valida só saldo e estoque, já que a venda já aconteceu fisicamente. Fica marcada como `MANUAL`. `ocorridoEm` em ISO 8601 com fuso, até 60 dias atrás. `201 { pedido }`; sem saldo: `422 SALDO_INSUFICIENTE` e nada gravado |
| GET | `/admin/relatorios/vendas` | `?de=&ate=&agrupar=dia\|produto\|categoria\|operador&formato=json\|csv` | `{ de, ate, agrupar, totais: { totalCentavos, pedidos, ticketMedioCentavos }, linhas: [{ chave, rotulo, totalCentavos, quantidade }] }` (só CONFIRMADOS; `de`/`ate` obrigatórios, até 366 dias) |
| GET | `/admin/relatorios/depositos` | `?de=&ate=&formato=` | `{ totais: { brutoCentavos, taxaCentavos, liquidoCentavos, quantidade }, devolvidos: { quantidade, centavos }, linhas: [por dia] }` |
| GET | `/admin/relatorios/saldos` | `?formato=` | `{ totalCentavos, contasComSaldo, maiorSaldoCentavos }` (o que a cantina "deve" em consumo). CSV: saldo por aluno, auditado |
| GET | `/admin/resumo` | `?data=AAAA-MM-DD` | Início da Cantina: `{ data, vendas, depositos, recusasPorMotivo, estoqueBaixo, alertas: [{ tipo, mensagem, quantidade? }] }` |
| GET | `/admin/auditoria` | `?alunoId=&acao=&de=&ate=&limite=&cursor=` | (ADMIN, ESCOLA) Trilha de auditoria; cada perfil vê a sua parte. Itens: `{ id, acao, entidade, entidadeId, alunoId, ator: { tipo, id, nome }, antes, depois, criadoEm }` |
| GET | `/admin/pendencias` | | (ESCOLA) Contagens do "o que falta fazer" (etapa6 §5.1) |
| GET | `/admin/alunos/:id/extrato` | `?de=&ate=&tipo=&limite=&cursor=` | (ADMIN, ESCOLA) Ledger + compras recusadas (`tipo: RECUSADA`). Auditado |
| GET | `/admin/alunos/:id/extrato.csv` | `?de=&ate=&tipo=` | (ADMIN, ESCOLA) CSV para Excel. Auditado |
| POST | `/admin/alunos/:id/solicitar-encerramento` | `{ motivo }` | (ESCOLA) E-mail aos ADMIN da cantina + auditoria. `202` |

### 2.5 Caixa (`/v1/caixa`): OPERADOR e ADMIN

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/caixa/catalogo` | | Categorias e produtos ativos, com `estoqueDisponivel` (null se não controla) |
| POST | `/caixa/identificar` | `{ qrConteudo }` | Lê a carteirinha (ver abaixo) |
| GET | `/caixa/alunos/busca` | `?q=&turmaId=` | Busca para **compra sem carteirinha**. Mínimo 3 letras. Retorna `{ id, nome, turma, aceitaPin }` (sem foto na lista) |
| GET | `/caixa/alunos/:id/foto` | | Foto para confirmar a identidade. Auditada |
| POST | `/caixa/pedidos` | ver abaixo + `Idempotency-Key` | **Fluxo de compra** |
| GET | `/caixa/pedidos/hoje` | | Pedidos do dia **deste operador** (para estornar se errou) |
| POST | `/caixa/pedidos/:id/estorno` | `{ motivo, devolverEstoque: boolean }` | O operador estorna **só pedidos do dia**; pedidos antigos, só o admin |

#### `POST /caixa/identificar`

Request: `{ "qrConteudo": "LCH1.Xk3..." }`

Resposta 200:
```json
{
  "aluno": { "id": 42, "nome": "João Silva", "turma": "3º A" },
  "carteirinha": { "status": "ATIVA" },
  "contaAtiva": true
}
```
- A tela busca a foto em seguida por `GET /caixa/alunos/42/foto`.
- **Nunca devolve saldo** (decisão da Etapa 2).
- Se `carteirinha.status` for `BLOQUEADA`, a tela já avisa a atendente ("Carteirinha bloqueada pelo responsável"). A recusa formal, com push para os pais, acontece se ela tentar finalizar.
- QR desconhecido ou revogado: `404 CARTEIRINHA_INVALIDA`, sem nenhum dado de aluno.

#### `POST /caixa/pedidos`: o coração do sistema

Request:
```http
POST /v1/caixa/pedidos
Idempotency-Key: 7f9c2b1e-4a8d-4f3e-9b6a-2d1c0e8f7a55
```
```json
{
  "identificacao": { "tipo": "CARTEIRINHA", "qrConteudo": "LCH1.Xk3..." },
  "itens": [
    { "produtoId": 7, "quantidade": 1 },
    { "produtoId": 12, "quantidade": 2 }
  ]
}
```
Compra sem carteirinha: `"identificacao": { "tipo": "PIN", "alunoId": 42, "pin": "4821" }`.

A identificação vai de novo no pedido (em vez de só o `alunoId`) para que o caixa não consiga "inventar" um aluno: o servidor sempre resolve o aluno pela carteirinha ou pelo PIN.

**Respostas:**

| Situação | HTTP | Body |
|---|---|---|
| Aprovado | 201 | `{ pedido: { id, status: "CONFIRMADO", totalCentavos, itens: [...] } }` |
| Recusado por regra | 422 | `{ erro: { codigo: "COMPRA_RECUSADA", mensagem, detalhes: { motivo: "LIMITE_DIARIO", pedidoId } } }` |
| Sem estoque | 409 | `{ erro: { codigo: "ESTOQUE_INSUFICIENTE", detalhes: { itens: [{ produtoId, disponivel }] } } }`. **Nenhum pedido é gravado** |
| PIN errado | 422 | `PIN_INCORRETO` (`detalhes.tentativasRestantes`). Depois de **5 erros**, o PIN fica bloqueado por **30 min** (`423 PIN_BLOQUEADO`) e os pais recebem push |
| Mesma `Idempotency-Key` de novo | (igual à 1ª) | **Exatamente a mesma resposta da primeira vez**, sem processar de novo |

`motivo` possíveis, na ordem em que são checados: `CONTA_INATIVA`, `CARTEIRINHA_BLOQUEADA`, `DIA_NAO_PERMITIDO`, `ITEM_BLOQUEADO` (com `detalhes.produtoIds`), `LIMITE_DIARIO`, `LIMITE_SEMANAL`, `LIMITE_MENSAL`, `SALDO_INSUFICIENTE`.

**Passo a passo dentro do servidor** (uma única transação MySQL):

```
1. Valida o body (Zod). Agrupa itens repetidos do mesmo produto.
2. Resolve o aluno: hash do token → carteirinha → aluno  (ou alunoId + PIN).
3. BEGIN
4. SELECT ... FROM contas_lanchei WHERE aluno_id = ? FOR UPDATE      ← lock do aluno
5. Procura pedido com (escola_id, idempotency_key).
   Se existe → COMMIT e devolve o resultado gravado (clique duplo).
   (A checagem vem DEPOIS do lock: duas requisições simultâneas com a
    mesma chave ficam em fila no passo 4 e a segunda sempre acha a primeira.)
6. Carrega produtos do pedido (ativos, da escola). Os que controlam estoque:
   SELECT ... FOR UPDATE, ordenados por id                             ← lock de estoque
   (ordem fixa evita deadlock entre dois caixas vendendo os mesmos itens)
   Falta estoque → ROLLBACK → 409 (nada gravado, sem push).
7. Calcula o total com os preços ATUAIS do banco (nunca confia em preço vindo do front).
8. Validações na ordem 1→5 da regra de negócio.
   • "hoje" e "esta semana/mês" calculados no fuso da escola.
   • Consumo do período = SUM(total) dos pedidos CONFIRMADOS do aluno no período.
9a. Recusou → INSERT pedido RECUSADO + itens + notificação (outbox) → COMMIT → 422
9b. Aprovou → INSERT pedido CONFIRMADO + itens
             INSERT transacao COMPRA (saldo_apos)  + UPDATE conta.saldo
             INSERT movimentos de estoque VENDA    + UPDATE produto.estoque_atual
             INSERT notificações (compra; saldo baixo se cruzou o limite de alerta)
             COMMIT → 201
10. Fora da transação: o job de push envia as notificações pendentes.
```

### 2.6 Estoque (`/v1/estoque`): OPERADOR e ADMIN

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/estoque` | `?baixo=true` | Produtos que controlam estoque: `{ id, nome, estoqueAtual, estoqueMinimo, abaixoDoMinimo }` |
| POST | `/estoque/movimentos` | `{ produtoId, tipo: "ENTRADA" \| "PERDA" \| "AJUSTE", quantidade, motivo? }` | Para AJUSTE, `quantidade` é a **contagem real** (a API calcula a diferença e exige `motivo`). ENTRADA e PERDA recebem quantidade positiva; a API aplica o sinal |
| GET | `/estoque/movimentos` | `?produtoId=&de=&ate=&limite=&cursor=` | Histórico: `{ id, produto, tipo, quantidade (com sinal), estoqueApos, pedidoId, motivo, usuario, criadoEm }` |

### 2.7 App dos responsáveis (`/v1/me`): RESPONSAVEL

Todas as rotas `/me/filhos/:alunoId/*` verificam se existe um vínculo **ativo** entre o responsável e o aluno; senão, `404`.

**Perfil e dispositivos**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/me` | | Perfil |
| PATCH | `/me` | `{ nome?, telefone? }` | |
| POST | `/me/senha` | `{ senhaAtual, novaSenha }` | Revoga as outras sessões |
| POST | `/me/dispositivos` | `{ canal: "WEB", subscription: { endpoint, keys: { p256dh, auth } }, plataforma }` ou `{ canal: "EXPO", expoPushToken, plataforma }` | Registra ou reativa o destino de push (upsert por endpoint/token). Ver `etapa7-app-pais.md` §3 |
| GET | `/push/chave-publica` (P) | | `{ chave }`: chave pública VAPID para o navegador assinar o push |
| POST | `/me/dispositivos/desativar` | `{ endpoint }` ou `{ expoPushToken }` | No logout |

**Vínculo (código de ativação)**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/termos/atual` | (P) | `{ versao, url }` do termo de uso e privacidade |
| POST | `/me/vinculos` | `{ codigo, aceiteTermo: { versao } }` | Exige e-mail **verificado** e igual ao e-mail do convite. Cria o vínculo e grava o consentimento (IP, user-agent, versão). Código errado: `422 CODIGO_INVALIDO`. Após 5 erros em 1 hora, o responsável fica 1 hora sem poder tentar (`429`). Código certo usado com **outro e-mail** conta como tentativa no próprio convite; com 5, o convite é invalidado e o admin precisa reenviar |

**Filhos, extrato e regras**

| Método | Rota | Body / Query | Descrição |
|---|---|---|---|
| GET | `/me/filhos` | | `[{ id, nome, escola: { id, nome }, turma, saldoCentavos, carteirinha: { status }, temFoto }]` |
| GET | `/me/filhos/:alunoId` | | Detalhe + regras + bloqueios + outros responsáveis vinculados (só nome) |
| GET | `/me/filhos/:alunoId/foto` | | Bytes da foto |
| GET | `/me/filhos/:alunoId/extrato` | `?de=&ate=&limite=&cursor=` | Linhas do ledger: `{ id, tipo, valorCentavos, saldoAposCentavos, descricao, criadoEm, pedidoId?, depositoId? }` |
| GET | `/me/filhos/:alunoId/pedidos/:pedidoId` | | Itens da compra (inclui recusados, com motivo) |
| GET | `/me/filhos/:alunoId/regras` | | Ver abaixo |
| PUT | `/me/filhos/:alunoId/regras` | Ver abaixo | Grava auditoria (antes/depois) e notifica **os outros** responsáveis (`REGRAS_ALTERADAS`) |
| GET | `/me/filhos/:alunoId/catalogo` | | Categorias e produtos da escola com `bloqueado: true/false` |
| PUT | `/me/filhos/:alunoId/bloqueios` | `{ categoriaIds: number[], produtoIds: number[] }` | Substitui o conjunto inteiro (mais simples para o app). Auditado e notificado como as regras |
| PUT | `/me/filhos/:alunoId/pin` | `{ pin, senhaResponsavel }` | Define ou troca o PIN de 4 dígitos. Pede a senha do responsável para confirmar. Rejeita PINs óbvios (`0000`, `1234`...) |
| POST | `/me/filhos/:alunoId/pin/remover` | `{ senhaResponsavel }` | Remove o PIN e desliga a compra sem carteirinha |
| POST | `/me/filhos/:alunoId/carteirinha/bloquear` | `{ motivo?: "PERDIDA" \| "OUTRO" }` | Efeito imediato. Notifica os outros responsáveis |
| POST | `/me/filhos/:alunoId/carteirinha/desbloquear` | | |
| POST | `/me/filhos/:alunoId/desvincular` | `{ confirmacao: true }` | O responsável sai do vínculo (equivale a revogar o consentimento; grava `REVOGACAO`) |

`PUT /me/filhos/:alunoId/regras`, body:
```json
{
  "limiteDiarioCentavos": 1500,
  "limiteSemanalCentavos": null,
  "limiteMensalCentavos": 20000,
  "diasPermitidos": ["SEG", "TER", "QUA", "QUI", "SEX"],
  "alertaSaldoBaixoCentavos": 1000,
  "permiteSemCarteirinha": true
}
```
A API converte `diasPermitidos` para o bitmask do banco. O app nunca vê o número mágico. `permiteSemCarteirinha: true` exige PIN definido (senão `422`).

**Depósitos (Pix)**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| POST | `/me/filhos/:alunoId/depositos` | `{ valorCentavos }` + `Idempotency-Key` | Ver abaixo |
| GET | `/me/depositos/:id` | | Status (o app consulta a cada poucos segundos enquanto mostra o QR) |
| GET | `/me/filhos/:alunoId/depositos` | `?cursor=` | Histórico |

`POST /me/filhos/:alunoId/depositos`, resposta 201:
```json
{
  "deposito": {
    "id": 310,
    "status": "PENDENTE",
    "valorCentavos": 5000,
    "pixCopiaCola": "00020126...6304ABCD",
    "expiraEm": "2026-11-05T20:00:00.000Z"
  }
}
```
- Valida `depositoMinCentavos` ≤ valor ≤ `depositoMaxCentavos` da escola (`422 VALOR_FORA_DO_LIMITE`).
- `409 MP_NAO_CONECTADO` se a cantina ainda não conectou o Mercado Pago.
- O Pix é criado no MP com o **token da cantina**, `X-Idempotency-Key` = a idempotency key do depósito, `external_reference` = id do depósito e validade de 30 min.
- O QR é desenhado no app a partir do `pixCopiaCola`.

**Notificações**

| Método | Rota | Query | Descrição |
|---|---|---|---|
| GET | `/me/notificacoes` | `?cursor=&naoLidas=true` | Caixa de entrada |
| POST | `/me/notificacoes/:id/lida` | | |
| POST | `/me/notificacoes/lidas` | | Marca todas |

**LGPD**

| Método | Rota | Body | Descrição |
|---|---|---|---|
| GET | `/me/dados` | | Exporta tudo que existe sobre o responsável e os filhos vinculados (JSON). Direito de acesso |
| POST | `/me/solicitacoes-lgpd` | `{ tipo: "CORRECAO" \| "EXCLUSAO" \| "OUTRO", mensagem }` | Encaminha por e-mail aos usuários `ESCOLA` (a escola é a controladora) e grava auditoria |

### 2.8 Webhook do Mercado Pago

| Método | Rota | Acesso |
|---|---|---|
| POST | `/v1/webhooks/mercadopago` | P (assinatura `x-signature` validada com o segredo do app) |

```
1. Valida a assinatura (HMAC). Inválida → grava em webhook_eventos_lanchei com
   assinatura_valida = false e responde 401.
2. Grava o evento bruto (UNIQUE em request_id descarta duplicata).
3. Responde 200 NA HORA (o MP reenvia se demorarmos).
4. Processamento assíncrono:
   a. Descobre a escola pelo user_id do vendedor.
   b. CONSULTA o pagamento na API do MP com o token da cantina.
      Nunca confia só no corpo do webhook.
   c. BEGIN; SELECT deposito FOR UPDATE; SELECT conta FOR UPDATE
   d. approved  e depósito PENDENTE → APROVADO + transacao DEPOSITO + saldo + push
      cancelled/expired → CANCELADO;  rejected → REJEITADO
      refunded/charged_back após aprovado → DEVOLVIDO + alerta ao admin (sem mexer no saldo)
   e. COMMIT; marca o evento como processado.
   Se falhar: guarda o erro e o job tenta de novo.
```

A `UNIQUE (deposito_id, tipo)` do ledger garante que, mesmo processando o mesmo pagamento duas vezes em paralelo, o crédito entra **uma vez só**.

---

## 3. Jobs em segundo plano (dentro da API, com `node-cron`)

| Job | Frequência | O que faz |
|---|---|---|
| Keep-alive | 10 min | `GET <URL pública>/health/db` |
| Envio de push | 15 s | Lê `notificacoes_lanchei` sem `push_enviado_em` e envia por Web Push (VAPID). Marca enviado/erro e desativa destinos que o serviço de push diz não existirem mais (404/410). Ver `etapa7-app-pais.md` §3 |
| Reprocessar webhooks | 1 min | Eventos com erro ou não processados |
| Depósitos pendentes | 5 min | Consulta no MP os depósitos `PENDENTE` vencidos (caso o webhook tenha se perdido) e atualiza |
| Renovar token MP | diário | Renova tokens OAuth das cantinas perto de expirar |
| Reconciliação | diário 3h | Consulta `vw_contas_divergentes_lanchei` e `vw_estoque_divergente_lanchei`. Se aparecer qualquer linha, e-mail de alerta para você |
| Limpeza | diário | Expira sessões, tokens de e-mail e convites vencidos |

Como a API roda numa instância só no Render, os jobs rodam no mesmo processo. Se um dia houver mais de uma instância, os jobs passam a usar um lock no banco (`GET_LOCK` do MySQL), para só uma executar.

---

## 4. Notificações push (quem recebe o quê)

Todos os responsáveis com vínculo ativo recebem, exceto onde indicado.

| Evento | Tipo | Exemplo de texto |
|---|---|---|
| Compra aprovada | `COMPRA` | "João comprou R$ 12,00 na cantina." |
| Compra sem carteirinha | `COMPRA_SEM_CARTEIRINHA` | "João comprou R$ 8,00 usando o PIN (sem carteirinha)." |
| Compra recusada | `COMPRA_RECUSADA` | "Uma compra de João foi recusada: limite diário atingido." (no máx. 1 push por motivo a cada 30 min, para não virar spam) |
| Saldo baixo | `SALDO_BAIXO` | Só quando o saldo **cruza** o valor de alerta (de ≥ para <), não a cada compra |
| Depósito confirmado | `DEPOSITO_CONFIRMADO` | "R$ 50,00 creditados para João." |
| Carteirinha | `CARTEIRINHA` | Bloqueada, desbloqueada, reemitida ou PIN bloqueado por tentativas |
| Regras alteradas | `REGRAS_ALTERADAS` | Só para **os outros** responsáveis: "Maria alterou o limite diário de João." |
| Estorno | `ESTORNO` | "Uma compra de R$ 6,00 foi estornada." |

---

## 5. Segurança (checklist da API)

- `helmet`, limite de body (100 KB JSON; 5 MB no upload de foto), painel servido pela própria API (mesma origem, sem CORS em produção; em dev, CORS só para `http://localhost:5173`).
- Rate limit por IP + identificador em: login, cadastro, esqueci-senha, vínculo por código, identificar QR (um caixa não precisa de mais que ~1 leitura por segundo) e PIN.
- Toda query de equipe filtra por `escola_id` do token, e o banco reforça isso com as FKs compostas.
- Logs **sem dados pessoais**: nada de nome de aluno, e-mail, token, PIN ou corpo de requisição nos logs. Só ids e códigos.
- Tokens do Mercado Pago criptografados com AES-256-GCM; a chave fica numa variável de ambiente do Render, nunca no banco nem no git.
- Respostas de foto com `Cache-Control: private, no-store`.
- Validação de todo input com Zod; o mesmo schema gera os tipos TypeScript usados pelo front (`packages/shared`).

---

## 6. Estrutura que isso gera no backend (prévia da Etapa 4)

```
apps/api/src/
  modulos/
    auth/  plataforma/  admin/  caixa/  estoque/  responsavel/  webhooks/  saude/
      (cada módulo: <modulo>.rotas.ts + <assunto>.servico.ts; ver etapa4-backend.md §3)
  dominio/
    compra.ts        ← regras de compra puras (fácil de testar sem banco)
    ledger.ts        ← lancarTransacao(trx, ...) — ÚNICO lugar que mexe em saldo
    estoque.ts       ← movimentarEstoque(trx, ...) — ÚNICO lugar que mexe em estoque
    periodos.ts      ← início/fim de dia, semana e mês no fuso da escola
  infra/
    db.ts  mercadopago.ts  email.ts  push.ts  cripto.ts  fotos.ts
  jobs/
  middlewares/       ← autenticar, exigirPapel, rateLimit, erros, idempotencia
```
