# Etapa 1: Decisões do planejamento

Sistema real, que vai rodar em produção numa escola. **A plataforma (Lanchei) é do Mateus; a escola é cliente.**

## Dinheiro e regulação
- O Pix do responsável cai **direto na conta da cantina** (conta Mercado Pago da cantina, conectada à plataforma via OAuth). A plataforma **só registra**, não custodia dinheiro.
- O saldo é **crédito pré-pago de consumo** na cantina (circuito fechado).
- **Não existe saque.** **Reembolso só no encerramento do vínculo** (aluno saiu da escola, formatura, conta encerrada), feito pelo admin, com motivo, gerando a transação `REEMBOLSO` no ledger. (Motivo: o CDC tende a considerar abusiva uma cláusula que impede devolver crédito não usado; validar com advogado antes de operar.)
- Depósito: **mínimo R$ 25,00, máximo R$ 500,00** por depósito (configurável por escola).
- Taxa do Pix: **a cantina absorve**. O crédito no ledger é o valor bruto; a taxa fica registrada só para relatório.
- Saldo negativo nunca existe (sem fiado).
- Dinheiro sempre em centavos (inteiro).

## Ledger e compra
- Ledger imutável é a fonte da verdade. A conta tem `saldo_centavos` materializado, atualizado **na mesma transação** que insere no ledger. Job de reconciliação confere saldo == SUM(ledger).
- Compra atômica com `SELECT ... FOR UPDATE` na conta + idempotency key gerada no cliente.
- Itens do pedido guardam snapshot de nome e preço.
- Sem item de valor livre.
- Estorno **total** (MVP). Operador estorna só pedidos do dia; admin estorna qualquer um.
- Ordem de validação: carteirinha/conta ativa → dia permitido → itens bloqueados → limite do período → saldo.
- Limites por períodos de **calendário** no fuso da escola (semana começa na segunda). Estornos devolvem o limite do período da compra.
- **Sem restrição de horário**, só dias da semana.

## Estoque
- Controle opcional por produto, com livro de movimentos (ENTRADA, VENDA, ESTORNO opcional, PERDA, AJUSTE) e estoque mínimo para alerta. Operador ("tia da cantina") e admin lançam movimentos.
- Falta de estoque bloqueia a venda, mas **não** gera pedido recusado nem push para os pais.

## Pessoas e acesso
- Tenant = **escola** (multi-tenant no modelo desde o início).
- A escola cadastra o aluno no painel admin (individual ou importação CSV no **modelo do Lanchei**) e informa os e-mails dos responsáveis. Cada responsável recebe **o próprio código de ativação** por e-mail (uso único, validade de 7 dias, válido só para aquele e-mail). Pai e mãe podem se vincular ao mesmo aluno.
- As **regras ficam no aluno**, editáveis por qualquer responsável vinculado, com **auditoria** (quem, quando, valor anterior, valor novo).
- Operadores com login individual (auditoria de vendas e estornos).
- **Dois perfis administrativos:** **Cantina** (`ADMIN`: vendas, estoque, produtos, pagamentos, relatórios, operadores, ajustes e reembolsos) e **Diretoria** (`ESCOLA`: alunos, turmas, carteirinhas, responsáveis e histórico de compras para atender os pais). Matriz completa em `etapa6-painel.md` §2. Painel web responsivo (computador e celular).
- **A atendente não vê o saldo do aluno**: só nome, foto, turma e o resultado (aprovado ou motivo da recusa).
- **Alunos não usam celular na escola**: a carteirinha física é o único meio de pagamento. Sem app do aluno.
- SUPERADMIN (Mateus) só cria escolas e o primeiro usuário de cada perfil (ADMIN e ESCOLA); não acessa dados de alunos.

## Carteirinha / QR
- Token aleatório (128 bits), conteúdo do QR `LCH1.<token>`. O banco guarda só o hash, então o QR só aparece na emissão: reimprimir = emitir nova. Revogável e reemitível. O responsável pode bloquear pelo app.
- Caixa em **tablet na horizontal**, leitura pela **câmera do tablet** (traseira por padrão). 1 ou 2 atendentes, cada um no seu tablet.
- **Carteirinha esquecida:** o operador busca por nome/turma, confirma a foto e o aluno digita um **PIN de 4 dígitos** definido pelo responsável. 5 erros = PIN bloqueado por 30 min + push. Registrada como "compra sem carteirinha", gera push específico, e o responsável pode desativar essa opção.

## Operação
- **Somente online.** Contingência: **venda manual** lançada depois pelo admin (`modo MANUAL`, valida só saldo e estoque).

## Stack e hospedagem
- TypeScript em tudo. Monorepo (`apps/api`, `apps/web`, `apps/pais`, `packages/shared`).
- Banco em produção acessado pelo usuário **`lanchei_api` com privilégios mínimos** (`database/grants.sql`): não consegue alterar/apagar ledger e auditoria nem apagar registros.
- API: Node 22 + Express 5, Knex (mysql2), Zod, JWT de 15 min + refresh token rotativo de 30 dias. **Hospedada no Render (plano gratuito).**
- **Custo zero por enquanto:** sem domínio próprio. O painel web (caixa + admin) é servido **pela própria API**, no mesmo serviço do Render (mesma URL/origem). O refresh token do web fica em cookie HttpOnly SameSite=Strict. Domínio próprio pode ser apontado depois, sem mudar código.
- Banco: MySQL 8 (InnoDB). Banco `lanchei`; tabelas e views com sufixo `_lanchei`; colunas sem sufixo.
- **Banco no Aiven for MySQL, plano gratuito** (backups automáticos incluídos). A avaliar: plano Developer (US$ 5/mês) antes de virar crítico.
- **Keep-alive:** job dentro da própria API chama a URL pública `GET /health/db` (faz `SELECT 1`) a cada 10 min, mantendo Render e Aiven acordados.
- Web (operador + admin): React + Vite. **App dos responsáveis: PWA** (React + Vite, instalável, em `/app/`) com **Web Push** (VAPID, gratuito). Publicação nas lojas fica para a **fase 2** (recomendação: empacotar o PWA com Capacitor; decidir quando chegar a hora).
- Gateway: **Mercado Pago** (sandbox no desenvolvimento), multi-tenant via OAuth, com tokens da cantina criptografados (AES-256-GCM). Webhook com validação de assinatura, idempotência e consulta ao MP antes de creditar.
- **Fotos dos alunos no próprio MySQL** (`fotos_alunos_lanchei`, JPEG 400×400 sem EXIF, ~30–60 KB), servidas só pela API autenticada e com auditoria.

## LGPD (dados de menores, art. 14)
- Consentimento específico do responsável coletado na ativação (data, versão do termo, IP).
- Escola = controladora; plataforma (Mateus) = operadora (contrato + política de privacidade).
- Dados mínimos do aluno: nome, turma, matrícula, foto. Sem CPF, nascimento ou endereço do aluno.
- Log de acesso a dados pessoais/fotos, política de retenção, canal para direitos do titular (exportação de dados + solicitações pelo app).

## Fora do MVP
Modo offline, estorno parcial, recarga automática, reembolso automático via Pix, relatórios avançados, operador multi-escola, restrição por horário, app do aluno, app nas lojas (fase 2).
