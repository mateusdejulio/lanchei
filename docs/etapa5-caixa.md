# Etapa 5: Tela da cantina (caixa)

**Mockup aprovado como referência visual:** canvas "Lanchei — Tela do caixa (tablet)" no claude.ai (5 telas: montando o pedido, aluno identificado, aprovada, recusada, sem carteirinha). As cores, tamanhos e textos abaixo vêm dele.

## 1. Contexto de uso (decisões do Mateus)
- **Tablet na horizontal** (referência: 1280×800 CSS px; deve funcionar de 1024×768 até 1366×1024).
- **Leitura do QR pela câmera do próprio tablet.**
- **1 ou 2 atendentes** ao mesmo tempo. Cada tablet fica logado com **um** operador; com 2 atendentes, são 2 tablets (o backend já aguenta caixas simultâneos, como provam os testes de concorrência).

## 2. Plataforma
- `apps/web`: **um só app React + Vite + TypeScript** para o caixa (`/caixa/*`) e o painel admin (`/admin/*`, Etapa 6). Login decide para onde ir pelo papel.
- **Hospedagem custo zero (decisão do Mateus):** o build do `apps/web` é servido **pela própria API** no mesmo serviço gratuito do Render (`https://<servico>.onrender.com/` = painel/caixa, `/v1/*` = API). Uma só URL, uma só origem: sem CORS, cookie seguro funciona, e o keep-alive de 10 min mantém tudo acordado. Se um dia houver domínio próprio, basta apontá-lo para esse serviço, sem mudar código.
- **PWA instalável** (`vite-plugin-pwa`): `display: "fullscreen"`, `orientation: "landscape"`, ícone Lanchei. Na cantina, o tablet abre o app instalado em tela cheia.
- **Tela sempre ligada** durante o uso: Screen Wake Lock API (`navigator.wakeLock.request('screen')`), reativando ao voltar o foco.
- Bibliotecas: React Router, **TanStack Query** (dados do servidor + cache), Tailwind CSS (com os tokens da §8), `barcode-detector` (leitura do QR, §4). Estado do fluxo de venda: `useReducer` com uma máquina de estados pura (§5).
- **Recomendação de aparelho:** tablet **Android** com Chrome. O leitor nativo de QR (BarcodeDetector) é mais rápido lá, e o Android permite "fixar o app" (modo quiosque simples). iPad também funciona, usando o fallback em WebAssembly.

## 3. HTTPS e câmera (importante!)
O navegador só libera a câmera em **contexto seguro (HTTPS)** ou em `localhost`.
- **Produção:** o serviço do Render já é HTTPS (painel e API na mesma URL).
- **Desenvolvimento no tablet real:** rodar `vite --host` com `@vitejs/plugin-basic-ssl` e abrir `https://<ip-do-computador>:5173` no tablet (aceitar o aviso do certificado).
- No dev, o Vite faz **proxy** de `/v1` para `http://localhost:3333`, então o app e a API ficam na mesma origem.

## 4. Leitura do QR
- Usar a API **BarcodeDetector** nativa quando existir; senão, o ponyfill **`barcode-detector`** (ZXing em WebAssembly). Conferir na documentação atual do pacote como fazer o import do ponyfill e qual é o suporte de cada navegador.
- `getUserMedia({ video: { facingMode: 'environment' } })`: **câmera traseira por padrão** (com o tablet num suporte virado para a atendente, a traseira aponta para o aluno do outro lado do balcão). O botão "Trocar câmera" alterna entre frontal e traseira, e a escolha fica salva **no aparelho** (`localStorage`).
- Laço de leitura em ~8 quadros por segundo sobre o `<video>` (via `requestAnimationFrame` + throttle). Usar `formats: ['qr_code']`.
- **Só aceita conteúdo que começa com `LCH1.`**. Outros QRs (de produto, de site) são ignorados em silêncio.
- **Anti-repetição:** o mesmo conteúdo lido de novo em menos de 3 s é ignorado.
- Ao ler: **bipe curto** (Web Audio, sem arquivo) + `navigator.vibrate(60)` se existir → `POST /v1/caixa/identificar`.
- A leitura **pausa** nos estados IDENTIFICADO, COBRANDO, APROVADO e RECUSADO, e retoma ao voltar para OCIOSO.
- Lanterna opcional: se a track suportar `torch`, mostrar o botão de lanterna.
- Câmera negada ou sem câmera: no lugar do preview, a mensagem "Permita o uso da câmera nas configurações do navegador", com o botão "Tentar de novo". "Aluno sem carteirinha" continua funcionando.

## 5. Máquina de estados da venda (`caixa/maquinaVenda.ts`, função pura + testes)

```
            +itens / -itens (em qualquer estado não-final)
OCIOSO ──QR lido──▶ IDENTIFICANDO ──200──▶ IDENTIFICADO ──"Cobrar"──▶ COBRANDO
  ▲                     │404 CARTEIRINHA_INVALIDA (aviso 3 s)               │
  │                     ▼                                                   ├─201──▶ APROVADO ──3 s ou "Próximo"──▶ OCIOSO (limpa tudo)
  │◀────────────────── OCIOSO                                              ├─422 COMPRA_RECUSADA──▶ RECUSADO
  │                                                                         ├─409 ESTOQUE_INSUFICIENTE──▶ IDENTIFICADO (itens destacados)
  │◀──"Cancelar leitura" / 60 s parado em IDENTIFICADO──────────────────────┤
  │                                                                         └─rede/timeout/5xx──▶ ERRO_REDE ──"Tentar de novo"──▶ COBRANDO (MESMA chave)
RECUSADO ──"Editar pedido"──▶ IDENTIFICADO (com NOVA chave na próxima cobrança)
RECUSADO ──"Cancelar venda"──▶ OCIOSO
```

Regras:
- O pedido pode ser montado **antes ou depois** da leitura. "Cobrar" só habilita com aluno IDENTIFICADO **e** pelo menos 1 item.
- **Idempotency-Key** (`crypto.randomUUID()`):
  - criada ao entrar em COBRANDO **se ainda não existir**;
  - **reutilizada** em ERRO_REDE → COBRANDO (se a 1ª tentativa chegou ao servidor, a 2ª devolve o mesmo resultado sem cobrar de novo);
  - **descartada** quando muda item, quantidade ou aluno, e após qualquer resposta final (201, 422, 409).
- Botão "Cobrar" desabilitado durante COBRANDO (com spinner); timeout de 15 s → ERRO_REDE.
- **Privacidade:** a foto e o nome **somem** ao voltar para OCIOSO; aluno IDENTIFICADO por 60 s sem ação → volta para OCIOSO (sem deixar a foto de uma criança parada na tela). A foto é baixada com `fetch` autenticado → `URL.createObjectURL` e **revogada** (`revokeObjectURL`) ao limpar.
- **Nunca** exibir saldo (a API também não envia).

## 6. Telas e componentes

### 6.1 Login (`/caixa/login`)
E-mail e senha, botões grandes. Após o login, abre `/caixa`. O nome do caixa ("Caixa 1", "Caixa 2") é configurável no aparelho, salvo em `localStorage`.

### 6.2 Caixa (`/caixa`), mockup telas 1 e 2
- **Cabeçalho (68 px):** logo, nome do caixa, indicador **Online/Sem conexão**, botões "Aluno sem carteirinha", "Vendas de hoje", "Estoque" e o menu do operador ("Trocar atendente" = logout).
- **Esquerda (catálogo):** abas de categoria + grade de 4 colunas de botões de produto (112 px de altura). Selo do produto: quantidade no pedido (laranja) | estoque ("Restam 3" em âmbar quando ≤ `estoqueMinimo`) | "Esgotado" (desabilitado). Tocar = +1 no pedido.
- **Direita (440 px):**
  - OCIOSO: preview da câmera (200 px de altura) com moldura de mira e o texto "Mostre a carteirinha atrás do tablet";
  - IDENTIFICADO: cartão com **foto 128×128**, nome, turma e status da carteirinha (ativa / **bloqueada pelo responsável**, em vermelho) + "Não é este aluno — cancelar leitura";
  - lista do pedido com −/+ (botões de 44 px), "Limpar", total e o botão principal de 68 px ("Leia a carteirinha para cobrar" desabilitado → "Cobrar R$ X" em verde).
- Catálogo via `GET /v1/caixa/catalogo` (TanStack Query, `staleTime` de 60 s, invalidado após cada venda/estorno/movimento de estoque).

### 6.3 Resultado
- **Aprovado** (tela 3): tela cheia verde, ✓ grande, "Compra aprovada", valor · nome · turma, itens; volta sozinha em 3 s ou pelo "Próximo aluno agora".
- **Recusado** (tela 4): cartão com cabeçalho vermelho, o **motivo** em destaque e uma orientação para a atendente (tabela abaixo); "Editar pedido" e "Cancelar venda". Bipe grave.

| `detalhes.motivo` | Título | Orientação para a atendente |
|---|---|---|
| CONTA_INATIVA | Conta inativa | Nada foi cobrado. Peça para o aluno procurar a secretaria. |
| CARTEIRINHA_BLOQUEADA | Carteirinha bloqueada | O responsável bloqueou esta carteirinha. Nada foi cobrado. |
| DIA_NAO_PERMITIDO | Compra não liberada hoje | Os responsáveis não liberaram compras neste dia da semana. |
| ITEM_BLOQUEADO | Item bloqueado | Itens destacados não são permitidos para este aluno. Remova-os e cobre de novo. (destacar `detalhes.produtoIds`) |
| LIMITE_DIARIO / SEMANAL / MENSAL | Limite diário/semanal/mensal atingido | Nada foi cobrado. O limite definido pelos responsáveis já foi usado. |
| SALDO_INSUFICIENTE | Saldo insuficiente | Nada foi cobrado. Peça para o aluno avisar os responsáveis para recarregar. |

Os responsáveis já recebem aviso pelo app; a tela diz isso.

- **Sem estoque (409):** sem tela vermelha. Volta para IDENTIFICADO com os itens em falta destacados ("Só restam N") e o catálogo atualizado.
- **Erro de rede:** faixa âmbar "Sem conexão. A venda NÃO foi confirmada." + "Tentar de novo" (mesma chave).

### 6.4 Aluno sem carteirinha (tela 5)
- Modal: busca `GET /v1/caixa/alunos/busca?q=` (mínimo 3 letras, debounce de 300 ms), resultados com o selo "Aceita PIN" ou "PIN desativado" (desabilitado).
- Ao escolher: a foto aparece (`GET /v1/caixa/alunos/:id/foto`) + teclado numérico próprio (botões de 64 px, sem teclado do sistema) com 4 bolinhas.
- "OK" com 4 dígitos → `POST /v1/caixa/pedidos` com `identificacao: { tipo: 'PIN', alunoId, pin }` e o pedido montado. `PIN_INCORRETO` → treme as bolinhas + "PIN incorreto. N tentativas restantes". `423 PIN_BLOQUEADO` → mensagem com o horário de liberação.
- O PIN **nunca** fica guardado depois do envio (limpa o estado).

### 6.5 Vendas de hoje (gaveta lateral)
`GET /v1/caixa/pedidos/hoje` → hora, aluno (primeiro nome + turma), total e status. "Estornar" abre um modal com o motivo (atalhos: "Item errado", "Aluno desistiu", "Cobrado em dobro", "Outro…") + a chave "Devolver itens ao estoque" (desligada por padrão) → `POST /v1/caixa/pedidos/:id/estorno`. Pedidos de outros dias não aparecem (só o admin estorna).

### 6.6 Estoque (`/caixa/estoque`), simples, para a "tia da cantina"
Lista dos produtos que controlam estoque (os abaixo do mínimo no topo). Por produto: "Chegou mercadoria" (ENTRADA), "Perda" e "Contei e tem…" (AJUSTE pela contagem real, com motivo) → `POST /v1/estoque/movimentos`. Teclado numérico grande.

## 7. Autenticação no web (requer ajuste no backend)
- Access token **só em memória**. Refresh token em **cookie `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth`** (em dev sem HTTPS, `Secure` fica desligado), para o refresh não ficar acessível a JavaScript (protege contra roubo por XSS).
- **Backend (✅ pronto, 4D):** quando a requisição de login/refresh/logout vier com o header `X-Cliente: web`, a API grava/lê o refresh no cookie `lanchei_rt` em vez do JSON (o app dos pais usa `X-Cliente: pais` e o cookie `lanchei_rt_pais`, para os dois apps da mesma origem não se deslogarem). O app de loja (fase 2) continua recebendo no JSON.
- Funciona porque **painel e API são a mesma origem** (a API serve o painel, §2). Em dev, o proxy do Vite dá o mesmo efeito.
- **Refresh "single-flight"** no cliente HTTP: se várias requisições recebem 401 `TOKEN_EXPIRADO` ao mesmo tempo, **um** refresh roda e as outras esperam na fila. Isso é obrigatório, porque a API derruba todas as sessões ao detectar reuso de refresh.
- Ao abrir o app (reload): tenta o refresh pelo cookie; se falhar, vai para o login.

## 8. Visual (tokens do mockup)
- Fonte: **Plus Jakarta Sans** (400–800).
- Cores: fundo `#F4F5F1`, superfície `#FFFFFF`, borda `#E2E5DD`/`#D5D9D0`, texto `#17201B`, texto secundário `#3D4741`/`#5B6660`; **marca** `#E8590C` (laranja); **aprovado** `#1F7A4D`; **recusado** `#B42318`; âmbar de aviso `#FFF1D6`/`#8A4B00`; verde suave `#E7F4EC`/`#166A3F`.
- Raios: 12 px (botões), 16 px (cartões e produtos), 28 px (modais). Alvos de toque **≥ 44 px** (principais: 64–68 px).
- Status nunca só por cor: sempre ícone + texto.

## 9. Conexão
- Indicador Online/Sem conexão: `navigator.onLine` + falha de requisição + ping em `GET /health` a cada 30 s quando parado.
- Sem conexão: "Cobrar" fica desabilitado com o texto "Sem conexão: vendas pausadas". **Somente online** (decisão da Etapa 1); a contingência é a venda manual pelo admin depois.

## 10. Estrutura sugerida
```
apps/web/src/
  main.tsx, rotas.tsx
  compartilhado/api/      cliente HTTP (fetch + refresh single-flight + erros tipados)
  compartilhado/auth/     contexto de sessão
  compartilhado/ui/       Botao, Modal, TecladoNumerico, Selo...
  caixa/
    maquinaVenda.ts       reducer puro (testado)
    leitorQr.ts           câmera + BarcodeDetector + anti-repetição
    som.ts                bipes (Web Audio)
    paginas/              Login, Caixa, Estoque
    componentes/          Catalogo, PainelPedido, CartaoAluno, Resultado, ModalSemCarteirinha, GavetaVendasHoje
```

## 11. Backend necessário para esta etapa
Já especificado em `etapa4-backend.md` §4.5/§4.6: `GET /caixa/catalogo`, `GET /caixa/alunos/busca`, `GET /caixa/alunos/:id/foto`, `GET /caixa/pedidos/hoje`, `POST /estoque/movimentos`, `GET /estoque`. Mais:
- o **modo cookie** do refresh (§7), com `cookie-parser`;
- **servir o painel**: em produção, `express.static(<apps/web/dist>)` com cache longo para `/assets/*` (arquivos com hash) e `no-cache` para `index.html`, mais um fallback de SPA (qualquer GET fora de `/v1`, `/health*` e de arquivos → `index.html`). Registrar **depois** das rotas da API e **antes** do 404 JSON;
- **CSP do helmet** ajustada para o painel: `img-src 'self' blob:` (foto via objectURL), `media-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'` (ZXing WASM do leitor de QR), `connect-src 'self'`;
- fonte **Plus Jakarta Sans servida pelo próprio app** (`@fontsource/plus-jakarta-sans`), sem Google Fonts: nenhuma chamada a terceiros a partir do tablet (melhor para a LGPD e para a CSP);
- o CORS deixa de ser necessário para o painel (mesma origem); manter liberado só `http://localhost:5173` em dev.

## 12. Testes desta etapa
- **Unitários (Vitest):** `maquinaVenda` (todas as transições, regra da Idempotency-Key, limpeza de foto/PIN), filtro `LCH1.` + anti-repetição do leitor, single-flight do refresh.
- **Componentes (Testing Library):** botão Cobrar habilita/desabilita; mensagens por motivo de recusa; teclado do PIN.
- **E2E (Playwright, opcional):** fluxo completo com a API real de teste, injetando o QR por um gancho de teste (sem câmera).
- **No tablet real:** leitura com luz fraca, carteirinha plastificada (reflexo), distância de 15–30 cm, 2 tablets vendendo ao mesmo tempo.
