# Etapa 7: App dos responsáveis

**Referência visual:** canvas "Lanchei — App dos pais" no claude.ai (início do filho, depósito Pix, extrato, regras, carteirinha e PIN).

## 1. Decisão do Mateus: opção 3 (PWA agora, loja depois)
- **Fase 1 (agora, custo zero):** app web instalável (**PWA**). O responsável abre um link, toca em "Instalar" ou "Adicionar à Tela de Início" e o app fica com ícone, em tela cheia, igual a um aplicativo. Funciona em Android e iPhone.
- **Fase 2 (quando fizer sentido pagar as lojas):** publicar na Google Play (US$ 25 uma vez) e na App Store (US$ 99 por ano). Ver §10.

## 2. Plataforma
- Novo app **`apps/pais`** (React + Vite + TypeScript + `vite-plugin-pwa`), **separado** do `apps/web`. Motivos:
  - os pais baixam um app pequeno, sem nada do caixa ou do painel (menos código e menos superfície de ataque);
  - manifesto e service worker próprios (nome "Lanchei", ícone e `start_url` dos pais).
- Servido **pela própria API** em **`/app/`** (Vite `base: '/app/'`), na mesma origem do resto: o cookie seguro do refresh funciona igual ao painel (`etapa5-caixa.md` §7) e continua custo zero.
- Código compartilhado em **`packages/shared`**: cliente HTTP (refresh single-flight), schemas Zod/tipos das respostas, formatação de dinheiro e datas, tokens visuais. O `apps/web` e o `apps/pais` (e a fase 2) usam o mesmo pacote.
- Layout **mobile-first** (referência de 390×844); no computador, a coluna central fica com no máximo 480 px.

## 3. Push gratuito: Web Push (substitui o Expo Push nesta fase)
- Padrão W3C com chaves **VAPID** (geradas uma vez, grátis). Biblioteca `web-push` no backend.
- **Android (Chrome):** funciona no navegador e no app instalado.
- **iPhone/iPad:** **só funciona com o app instalado na Tela de Início** (iOS 16.4 ou mais novo). Por isso o app mostra um guia de instalação no iPhone (§6.1).
- O pedido de permissão aparece **num momento que faz sentido**: depois do primeiro vínculo, com a explicação "Quer ser avisado de cada compra e quando o saldo ficar baixo?" + botão. Nunca ao abrir o app (o iOS exige um toque do usuário).
- O service worker recebe o push e mostra a notificação; tocar nela abre a tela certa. O payload (JSON) é `{ titulo, corpo, url, notificacaoId }`, e a API já manda a `url`: `/app/filhos/:alunoId/compras/:pedidoId` (compra/estorno/recusa), `/app/filhos/:alunoId/extrato` (depósito), `/app/filhos/:alunoId` ou `/app/notificacoes`. **As rotas do app precisam existir com esses caminhos.**
- Sem push (recusado ou não suportado): a caixa de entrada do app funciona do mesmo jeito; o push é só o "toque" no celular.

### Mudanças no backend
- **Schema (já aplicado e testado):** `dispositivos_push_lanchei` agora tem `canal` (`WEB` | `EXPO`), as chaves da subscription Web Push e `identificador_hash` único.
- Variáveis novas: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` do Mateus). Gerar com `npx web-push generate-vapid-keys`.
- `GET /v1/push/chave-publica` (público) → `{ chave }`.
- `POST /v1/me/dispositivos` passa a aceitar os dois formatos:
  - `{ canal: 'WEB', subscription: { endpoint, keys: { p256dh, auth } }, plataforma }`
  - `{ canal: 'EXPO', expoPushToken, plataforma }` (fase 2)

  Faz upsert por `identificador_hash`: se o endpoint já existe com outro responsável (celular compartilhado), **transfere** para o atual.
- `POST /v1/me/dispositivos/desativar` com `{ endpoint }` ou `{ expoPushToken }`.
- **Job de push** (`etapa4-backend.md` §4.8): canal WEB via `web-push` (payload JSON com `titulo`, `corpo`, `url`; TTL de 24 h); `404`/`410` do serviço de push → `ativo = false`. Canal EXPO fica para a fase 2.
- **Payload sem dados sensíveis:** o texto da notificação aparece na tela bloqueada. Usar o primeiro nome e o valor (como já está em `notificacoes.ts`), nunca o nome completo ou a turma.

## 4. Servir o app dos pais pela API
- `express.static(<apps/pais/dist>)` montado em `/app`, com fallback de SPA para `/app/*` → `apps/pais/dist/index.html`. Registrar antes do fallback do painel (`/`).
- `sw.js` e `manifest.webmanifest` com `Cache-Control: no-cache` (senão a atualização do app demora a chegar); `/app/assets/*` com cache longo.
- Links dos e-mails apontam para o app: `URL_PUBLICA_API + '/app/verificar-email?token=…'`, `'/app/redefinir-senha?token=…'`, `'/app/vincular?codigo=…'` (o código já vem preenchido).

## 5. Fluxos de entrada
1. **Convite por e-mail** (enviado pela Diretoria): "Ative o Lanchei para acompanhar as compras de João na cantina", com o botão que abre `/app/vincular?codigo=ABCD2345`.
2. Sem conta → **Criar conta** (nome, e-mail, senha; o e-mail já vem preenchido se veio do convite) → **verificar e-mail** (link) → volta para o vínculo.
3. **Vincular:** código (preenchido) + **termo de uso e privacidade** (resumo em linguagem simples + link do texto completo + caixa "Li e concordo, como responsável por este aluno") → `POST /me/vinculos`.
4. Sucesso → pergunta do push (§3) → guia de instalação (§6.1) → Início.

## 6. Telas

### 6.1 Instalação
- Android/Chrome: botão "Instalar o app" (`beforeinstallprompt`).
- iPhone (Safari, fora do modo instalado): cartão com 3 passos ilustrados (ícone Compartilhar → "Adicionar à Tela de Início" → abrir pelo ícone) e o aviso: "Sem isso o iPhone não mostra as notificações."
- Não insistir: "Agora não" esconde por 7 dias.

### 6.2 Início
- Com 1 filho, vai direto para a tela dele; com 2 ou mais, cartões com nome, escola e saldo.
- **Tela do filho:** saldo grande; botão principal **"Adicionar dinheiro"**; status da carteirinha (ativa/bloqueada); avisos (saldo baixo, PIN bloqueado, regras alteradas por outro responsável); **últimas compras** (data, itens resumidos, valor; as recusadas aparecem com o motivo); atalhos para Extrato, Regras, Bloqueios e Carteirinha.

### 6.3 Adicionar dinheiro (Pix)
1. Valores rápidos (**R$ 25, 50, 100, 200**) + "Outro valor" (com o mínimo e o máximo da escola: R$ 25 a R$ 500). `CampoDinheiro` em centavos.
2. "Gerar Pix" → `POST /me/filhos/:id/depositos` com `Idempotency-Key` (gerada ao confirmar o valor e reutilizada em retentativas de rede).
3. Tela do Pix:
   - **Botão principal: "Copiar código Pix"**, porque quem paga pelo celular usa o app do banco no **mesmo aparelho**. Depois de copiar: "Agora abra o app do seu banco → Pix → Copia e Cola";
   - QR Code abaixo (gerado no aparelho com o pacote `qrcode` a partir de `pixCopiaCola`), para pagar de outro aparelho;
   - contagem regressiva até `expiraEm` (30 min);
   - consulta `GET /me/depositos/:id` a cada 3 s enquanto a tela está aberta e visível (`document.visibilityState`), e para quando sai da tela.
4. **Confirmado** → tela de sucesso ("R$ 50,00 creditados para João") + saldo atualizado. Expirado → "Este Pix expirou. Gere outro." Se a pessoa sair da tela antes, o push "Depósito confirmado" avisa.
5. O dinheiro vai para a conta da cantina; o app mostra "Pagamento para: [nome da cantina] · via Mercado Pago" (transparência).

### 6.4 Extrato
Lista agrupada por dia (`GET /me/filhos/:id/extrato`, rolagem infinita por cursor), com filtros (tudo, compras, depósitos, estornos) e período. Tocar numa compra mostra os itens (`/pedidos/:pedidoId`). As recusadas aparecem em cinza com o motivo ("Limite diário atingido. Nada foi cobrado.").

### 6.5 Regras
- Limites: três linhas (Por dia / Por semana / Por mês), cada uma com uma chave liga/desliga + valor. Desligado = sem limite.
- Dias da semana: 7 chips (SEG … DOM).
- Alerta de saldo baixo: valor (ou desligado).
- Salvar → `PUT /me/filhos/:id/regras`. Abaixo: "Última alteração: Maria, 05/11 às 10:12" (os responsáveis veem as alterações um do outro).

### 6.6 Bloqueios
Lista de categorias com chave liga/desliga; tocar na categoria mostra os produtos com chave própria. Uma categoria bloqueada bloqueia todos os produtos dela. Salvar → `PUT /me/filhos/:id/bloqueios`.

### 6.7 Carteirinha e PIN
- Status + **"Bloquear carteirinha"** (botão grande, confirmação: "Ninguém conseguirá comprar com ela até você desbloquear") / "Desbloquear".
- "Perdeu a carteirinha? Bloqueie aqui e peça uma nova na secretaria."
- **Compra sem carteirinha:** chave liga/desliga + "Definir PIN" / "Trocar PIN" / "Remover PIN" (teclado numérico, digitar 2 vezes + senha da conta). Explicação: "Se seu filho esquecer a carteirinha, ele pode comprar digitando este PIN no caixa. Você recebe um aviso a cada compra assim."

### 6.8 Notificações
Caixa de entrada (`GET /me/notificacoes`), com as não lidas marcadas, "Marcar todas como lidas" e a chave de push deste aparelho.

### 6.9 Conta
Nome, telefone, trocar senha, sair; **Meus dados** (baixar JSON: `GET /me/dados`), **Solicitar correção ou exclusão** (`POST /me/solicitacoes-lgpd`), **Desvincular-me de um filho** (confirmação forte), termos de uso e privacidade.

## 7. Visual
Mesmos tokens do caixa/painel (`etapa5-caixa.md` §8). Mobile: alvos ≥ 48 px, botão principal fixo no rodapé nas telas de ação, saldo em 40 px+. Status sempre com ícone + texto.

## 8. Estrutura sugerida
```
apps/pais/
  vite.config.ts            base '/app/', vite-plugin-pwa (manifest + sw próprio com handler de push)
  src/
    sw/push.ts              eventos 'push' e 'notificationclick'
    paginas/                Entrar, CriarConta, VerificarEmail, Vincular, Inicio, Filho,
                            Depositar, Pix, Extrato, DetalheCompra, Regras, Bloqueios,
                            Carteirinha, Notificacoes, Conta
    componentes/            CartaoSaldo, ListaMovimentos, ChaveLimite, ChipsDias,
                            TecladoPin, GuiaInstalacaoIos, PedidoPermissaoPush
packages/shared/src/
  api/                      cliente HTTP + tipos
  dinheiro.ts               centavos <-> "R$ 12,50", parse de digitação
  datas.ts                  formatação no fuso da escola
```

## 9. Testes desta etapa
- Unitários: `CampoDinheiro`/parse de dinheiro, montagem do payload de regras (dias → lista), regra da Idempotency-Key do depósito, cálculo da contagem regressiva.
- Componentes: fluxo de vínculo (código + termo obrigatório), estados da tela do Pix (pendente → aprovado, expirado, erro).
- API: `POST /me/dispositivos` (upsert por endpoint, transferência entre responsáveis), job de push com o serviço simulado (410 desativa).
- **Manual em aparelhos reais:** Android com Chrome (instalar, push, Pix copia e cola no app do banco no sandbox) e iPhone (instalar pela Tela de Início, push com o app fechado).

## 10. Fase 2: app nas lojas (registrar decisão quando chegar a hora)
Recomendação: **empacotar o próprio PWA com Capacitor** em vez de reescrever em React Native/Expo. Reaproveita 100% do código do `apps/pais` e troca o Web Push pelo push nativo (FCM/APNs) usando o canal já previsto no banco. O Expo (stack original) também atende, mas exigiria reescrever as telas. **Decidir com o Mateus antes de começar a fase 2.**
