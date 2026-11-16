-- =====================================================================
-- Lanchei: schema do banco (MySQL 8.0+)
-- Etapa 2: Modelagem
--
-- Convenções:
--   * Banco "lanchei"; toda tabela e view termina em "_lanchei" (identificação
--     do projeto num servidor compartilhado). Colunas não levam sufixo.
--   * Dinheiro: sempre INTEIRO em centavos (*_centavos). Nunca DECIMAL/FLOAT.
--   * Datas: DATETIME(3) em UTC. A API faz SET time_zone = '+00:00' na conexão.
--     O "dia" e a "semana" de uma escola são calculados na API com escolas.timezone.
--   * Multi-tenant: toda tabela de negócio tem escola_id. FKs compostas
--     (id, escola_id) impedem, no próprio banco, que um registro de uma escola
--     aponte para outra (ex.: aluno da escola A numa turma da escola B).
--   * Nada é apagado de verdade (sem DELETE). Alunos são encerrados/anonimizados.
--     Única exceção: bloqueios de categoria/produto (configuração auditada).
--   * Ledger (transacoes), auditoria, consentimentos e itens de pedido são
--     imutáveis: triggers bloqueiam UPDATE e DELETE.
-- =====================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS lanchei
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;
USE lanchei;

-- ---------------------------------------------------------------------
-- 1. TENANT
-- ---------------------------------------------------------------------

CREATE TABLE escolas_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome                    VARCHAR(150)    NOT NULL,
  slug                    VARCHAR(60)     NOT NULL,          -- identificador curto (ex.: "cotil")
  timezone                VARCHAR(64)     NOT NULL DEFAULT 'America/Sao_Paulo',
  deposito_min_centavos   INT UNSIGNED    NOT NULL DEFAULT 2500,   -- R$ 25,00
  deposito_max_centavos   INT UNSIGNED    NOT NULL DEFAULT 50000,  -- R$ 500,00
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_escolas_slug (slug),
  CONSTRAINT ck_escolas_deposito CHECK (deposito_min_centavos > 0 AND deposito_max_centavos >= deposito_min_centavos)
) ENGINE=InnoDB;

-- Conta Mercado Pago da cantina, conectada via OAuth.
-- Os depósitos são criados com o access token DA CANTINA, então o dinheiro
-- cai direto na conta dela. Tokens são criptografados na aplicação
-- (AES-256-GCM, chave fora do banco) antes de chegar aqui.
CREATE TABLE escola_mercadopago_lanchei (
  escola_id               BIGINT UNSIGNED NOT NULL,
  mp_user_id              VARCHAR(32)     NOT NULL,          -- id do vendedor no MP (vem no webhook)
  access_token_enc        VARBINARY(1024) NOT NULL,
  refresh_token_enc       VARBINARY(1024) NOT NULL,
  public_key              VARCHAR(128)    NULL,
  token_expira_em         DATETIME(3)     NOT NULL,
  conectado_em            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (escola_id),
  UNIQUE KEY uq_escola_mp_user (mp_user_id),
  CONSTRAINT fk_escola_mp_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. PESSOAS E AUTENTICAÇÃO
-- ---------------------------------------------------------------------

-- Equipe:
--   SUPERADMIN: você, dono da plataforma (escola_id NULL); só cria escolas e o 1º usuário de cada perfil
--   ADMIN:      administração da CANTINA (vendas, estoque, catálogo, pagamentos, operadores)
--   ESCOLA:     diretoria/secretaria da ESCOLA (alunos, turmas, carteirinhas, responsáveis, histórico)
--   OPERADOR:   atendente do caixa
CREATE TABLE usuarios_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NULL,
  papel                   ENUM('SUPERADMIN','ADMIN','ESCOLA','OPERADOR') NOT NULL,
  nome                    VARCHAR(150)    NOT NULL,
  email                   VARCHAR(254)    NOT NULL,
  senha_hash              VARCHAR(255)    NOT NULL,          -- argon2id/bcrypt
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  ultimo_login_em         DATETIME(3)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_usuarios_email (email),
  UNIQUE KEY uq_usuarios_id_escola (id, escola_id),
  KEY ix_usuarios_escola (escola_id, papel),
  CONSTRAINT fk_usuarios_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id),
  -- superadmin não pertence a escola; os demais sempre pertencem
  CONSTRAINT ck_usuarios_escola CHECK ((papel = 'SUPERADMIN') = (escola_id IS NULL))
) ENGINE=InnoDB;

-- Responsáveis são GLOBAIS (sem escola_id): um pai pode ter filhos em escolas diferentes.
-- LGPD: guardamos o mínimo. CPF é opcional (só se o Mercado Pago exigir).
CREATE TABLE responsaveis_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nome                    VARCHAR(150)    NOT NULL,
  email                   VARCHAR(254)    NOT NULL,
  email_verificado_em     DATETIME(3)     NULL,
  senha_hash              VARCHAR(255)    NOT NULL,
  cpf                     CHAR(11)        NULL,
  telefone                VARCHAR(20)     NULL,
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_responsaveis_email (email)
) ENGINE=InnoDB;

-- Refresh tokens (sessões). Guardamos só o hash SHA-256 do token.
-- Exatamente um dos dois "donos" é preenchido.
CREATE TABLE sessoes_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id              BIGINT UNSIGNED NULL,
  responsavel_id          BIGINT UNSIGNED NULL,
  token_hash              BINARY(32)      NOT NULL,
  expira_em               DATETIME(3)     NOT NULL,
  revogada_em             DATETIME(3)     NULL,
  user_agent              VARCHAR(255)    NULL,
  ip                      VARCHAR(45)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessoes_token (token_hash),
  KEY ix_sessoes_usuario (usuario_id),
  KEY ix_sessoes_responsavel (responsavel_id),
  CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT fk_sessoes_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT ck_sessoes_dono CHECK ((usuario_id IS NULL) <> (responsavel_id IS NULL))
) ENGINE=InnoDB;

-- Tokens enviados por e-mail: verificação de e-mail e redefinição de senha.
CREATE TABLE tokens_email_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id              BIGINT UNSIGNED NULL,
  responsavel_id          BIGINT UNSIGNED NULL,
  tipo                    ENUM('VERIFICAR_EMAIL','REDEFINIR_SENHA') NOT NULL,
  token_hash              BINARY(32)      NOT NULL,
  expira_em               DATETIME(3)     NOT NULL,
  usado_em                DATETIME(3)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tokens_email_hash (token_hash),
  CONSTRAINT fk_tokens_email_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT fk_tokens_email_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT ck_tokens_email_dono CHECK ((usuario_id IS NULL) <> (responsavel_id IS NULL))
) ENGINE=InnoDB;

-- Destinos de push de cada responsável. Dois canais:
--   WEB  = Web Push (PWA dos pais; padrão W3C com chaves VAPID, gratuito).
--          Guarda a "subscription" do navegador: endpoint + chaves p256dh/auth.
--   EXPO = app nativo futuro (token do Expo Push).
-- identificador_hash = SHA-256 do endpoint (WEB) ou do token (EXPO): o endpoint
-- pode passar de 700 caracteres, longo demais para um índice UNIQUE direto.
CREATE TABLE dispositivos_push_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  responsavel_id          BIGINT UNSIGNED NOT NULL,
  canal                   ENUM('WEB','EXPO') NOT NULL,
  identificador_hash      BINARY(32)      NOT NULL,
  web_endpoint            TEXT            NULL,
  web_p256dh              VARCHAR(255)    NULL,
  web_auth                VARCHAR(255)    NULL,
  expo_push_token         VARCHAR(255)    NULL,
  plataforma              ENUM('ANDROID','IOS','DESKTOP','OUTRA') NOT NULL DEFAULT 'OUTRA',
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  ultimo_uso_em           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_identificador (identificador_hash),
  KEY ix_push_responsavel (responsavel_id, ativo),
  CONSTRAINT fk_push_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT ck_push_canal CHECK (
       (canal = 'WEB'  AND web_endpoint IS NOT NULL AND web_p256dh IS NOT NULL AND web_auth IS NOT NULL AND expo_push_token IS NULL)
    OR (canal = 'EXPO' AND expo_push_token IS NOT NULL AND web_endpoint IS NULL))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. ESCOLA: TURMAS E ALUNOS
-- ---------------------------------------------------------------------

CREATE TABLE turmas_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  nome                    VARCHAR(60)     NOT NULL,          -- ex.: "3º A"
  ano_letivo              SMALLINT UNSIGNED NOT NULL,
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_turmas_nome (escola_id, ano_letivo, nome),
  UNIQUE KEY uq_turmas_id_escola (id, escola_id),            -- alvo das FKs compostas
  CONSTRAINT fk_turmas_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id)
) ENGINE=InnoDB;

CREATE TABLE alunos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  turma_id                BIGINT UNSIGNED NULL,
  nome                    VARCHAR(150)    NOT NULL,
  matricula               VARCHAR(40)     NOT NULL,
  status                  ENUM('ATIVO','INATIVO','ENCERRADO') NOT NULL DEFAULT 'ATIVO',
  -- PIN de 4 dígitos para "compra sem carteirinha" (definido pelo responsável)
  pin_hash                VARCHAR(255)    NULL,
  pin_falhas              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  pin_bloqueado_ate       DATETIME(3)     NULL,
  encerrado_em            DATETIME(3)     NULL,
  anonimizado_em          DATETIME(3)     NULL,              -- LGPD: após o prazo de retenção
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_alunos_matricula (escola_id, matricula),
  UNIQUE KEY uq_alunos_id_escola (id, escola_id),
  KEY ix_alunos_busca (escola_id, status, nome),             -- busca por nome (compra sem carteirinha)
  KEY ix_alunos_turma (turma_id, escola_id),
  CONSTRAINT fk_alunos_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id),
  -- FK composta: a turma precisa ser da MESMA escola do aluno
  CONSTRAINT fk_alunos_turma FOREIGN KEY (turma_id, escola_id) REFERENCES turmas_lanchei (id, escola_id),
  CONSTRAINT ck_alunos_encerrado CHECK ((status = 'ENCERRADO') = (encerrado_em IS NOT NULL))
) ENGINE=InnoDB;

-- Foto do aluno guardada no próprio banco (JPEG ~400x400, ~30-60 KB).
-- Assim não dependemos de storage externo, e a foto SÓ sai pela API
-- autenticada (com auditoria). Tabela separada para não pesar nas
-- consultas de alunos_lanchei.
CREATE TABLE fotos_alunos_lanchei (
  aluno_id                BIGINT UNSIGNED NOT NULL,
  escola_id               BIGINT UNSIGNED NOT NULL,
  conteudo                MEDIUMBLOB      NOT NULL,
  mime_type               VARCHAR(30)     NOT NULL DEFAULT 'image/jpeg',
  tamanho_bytes           INT UNSIGNED    NOT NULL,
  sha256                  BINARY(32)      NOT NULL,          -- ETag para cache
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (aluno_id),
  CONSTRAINT fk_fotos_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT ck_fotos_tamanho CHECK (tamanho_bytes BETWEEN 1 AND 2097152)   -- máx. 2 MB
) ENGINE=InnoDB;

-- Vínculo responsável <-> aluno (pai e mãe podem estar vinculados ao mesmo aluno).
CREATE TABLE aluno_responsaveis_lanchei (
  aluno_id                BIGINT UNSIGNED NOT NULL,
  responsavel_id          BIGINT UNSIGNED NOT NULL,
  convite_id              BIGINT UNSIGNED NOT NULL,          -- qual código de ativação criou o vínculo
  vinculado_em            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  desvinculado_em         DATETIME(3)     NULL,
  PRIMARY KEY (aluno_id, responsavel_id),
  KEY ix_ar_responsavel (responsavel_id),
  CONSTRAINT fk_ar_aluno FOREIGN KEY (aluno_id) REFERENCES alunos_lanchei (id),
  CONSTRAINT fk_ar_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id)
  -- fk para convites_responsavel adicionada depois (tabela criada abaixo)
) ENGINE=InnoDB;

-- Códigos de ativação enviados por e-mail pelo admin.
-- Um código por e-mail de responsável, uso único, com validade.
-- O código só vale para o responsável logado com ESSE e-mail (verificado).
CREATE TABLE convites_responsavel_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  email                   VARCHAR(254)    NOT NULL,
  codigo_hash             BINARY(32)      NOT NULL,
  expira_em               DATETIME(3)     NOT NULL,
  tentativas_falhas       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  usado_em                DATETIME(3)     NULL,
  usado_por_responsavel_id BIGINT UNSIGNED NULL,
  revogado_em             DATETIME(3)     NULL,
  criado_por_usuario_id   BIGINT UNSIGNED NOT NULL,
  enviado_em              DATETIME(3)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_convites_codigo (codigo_hash),
  KEY ix_convites_aluno (aluno_id),
  KEY ix_convites_email (email),
  CONSTRAINT fk_convites_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT fk_convites_responsavel FOREIGN KEY (usado_por_responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT fk_convites_criador FOREIGN KEY (criado_por_usuario_id, escola_id) REFERENCES usuarios_lanchei (id, escola_id),
  CONSTRAINT ck_convites_uso CHECK ((usado_em IS NULL) = (usado_por_responsavel_id IS NULL))
) ENGINE=InnoDB;

ALTER TABLE aluno_responsaveis_lanchei
  ADD CONSTRAINT fk_ar_convite FOREIGN KEY (convite_id) REFERENCES convites_responsavel_lanchei (id);

-- Consentimento LGPD (art. 14). Registro imutável: revogar = inserir nova linha.
CREATE TABLE consentimentos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  responsavel_id          BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  evento                  ENUM('ACEITE','REVOGACAO') NOT NULL,
  versao_termo            VARCHAR(20)     NOT NULL,          -- ex.: "2026-11-v1"
  ip                      VARCHAR(45)     NULL,
  user_agent              VARCHAR(255)    NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_consent (responsavel_id, aluno_id, created_at),
  CONSTRAINT fk_consent_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT fk_consent_aluno FOREIGN KEY (aluno_id) REFERENCES alunos_lanchei (id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. CARTEIRINHAS (QR CODE)
-- ---------------------------------------------------------------------
-- O QR contém um token aleatório de 128 bits (base64url). Guardamos só o
-- SHA-256 dele: quem tiver acesso ao banco não consegue gerar QR válido.
--   ATIVA     -> pode comprar
--   BLOQUEADA -> responsável bloqueou (reversível pelo responsável)
--   REVOGADA  -> perdida/substituída (definitivo; admin reemite outra)
CREATE TABLE carteirinhas_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  token_hash              BINARY(32)      NOT NULL,
  status                  ENUM('ATIVA','BLOQUEADA','REVOGADA') NOT NULL DEFAULT 'ATIVA',
  emitida_por_usuario_id  BIGINT UNSIGNED NOT NULL,
  emitida_em              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revogada_em             DATETIME(3)     NULL,
  motivo_revogacao        VARCHAR(255)    NULL,
  -- Truque: MySQL não tem índice único parcial. Esta coluna gerada vale
  -- aluno_id quando a carteirinha está "viva" e NULL quando revogada.
  -- UNIQUE ignora NULLs => no máximo UMA carteirinha viva por aluno.
  aluno_vivo              BIGINT UNSIGNED AS (IF(status <> 'REVOGADA', aluno_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_carteirinhas_token (token_hash),
  UNIQUE KEY uq_carteirinhas_viva (aluno_vivo),
  KEY ix_carteirinhas_aluno (aluno_id),
  CONSTRAINT fk_carteirinhas_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT fk_carteirinhas_emissor FOREIGN KEY (emitida_por_usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT ck_carteirinhas_revogada CHECK ((status = 'REVOGADA') = (revogada_em IS NOT NULL))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 5. CATÁLOGO
-- ---------------------------------------------------------------------

CREATE TABLE categorias_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  nome                    VARCHAR(80)     NOT NULL,
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_categorias_nome (escola_id, nome),
  UNIQUE KEY uq_categorias_id_escola (id, escola_id),
  CONSTRAINT fk_categorias_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id)
) ENGINE=InnoDB;

CREATE TABLE produtos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  categoria_id            BIGINT UNSIGNED NOT NULL,
  nome                    VARCHAR(120)    NOT NULL,
  preco_centavos          INT UNSIGNED    NOT NULL,
  ativo                   BOOLEAN         NOT NULL DEFAULT TRUE,
  -- Estoque (opcional por produto). Mesmo padrão do saldo: estoque_atual é um
  -- cache de estoque_movimentos_lanchei, atualizado na mesma transação, com
  -- lock (FOR UPDATE) na linha do produto durante a venda.
  controla_estoque        BOOLEAN         NOT NULL DEFAULT FALSE,
  estoque_atual           INT             NOT NULL DEFAULT 0,
  estoque_minimo          INT UNSIGNED    NULL,              -- alerta de "acabando" no painel
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_produtos_nome (escola_id, nome),
  UNIQUE KEY uq_produtos_id_escola (id, escola_id),
  KEY ix_produtos_categoria (categoria_id),
  CONSTRAINT fk_produtos_categoria FOREIGN KEY (categoria_id, escola_id) REFERENCES categorias_lanchei (id, escola_id),
  CONSTRAINT ck_produtos_preco CHECK (preco_centavos > 0),
  CONSTRAINT ck_produtos_estoque CHECK (estoque_atual >= 0 AND (controla_estoque OR estoque_atual = 0))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 6. REGRAS DO ALUNO (definidas pelos responsáveis)
-- ---------------------------------------------------------------------

-- Uma linha por aluno, criada junto com o aluno.
-- dias_permitidos é um bitmask: bit 0 = segunda ... bit 6 = domingo.
--   31  (0011111) = segunda a sexta (padrão)
--   127 (1111111) = todos os dias
-- Para checar o dia ISO d (1=seg..7=dom): (dias_permitidos >> (d-1)) & 1
-- Limite NULL = sem limite naquele período.
CREATE TABLE regras_aluno_lanchei (
  aluno_id                    BIGINT UNSIGNED NOT NULL,
  limite_diario_centavos      INT UNSIGNED    NULL,
  limite_semanal_centavos     INT UNSIGNED    NULL,
  limite_mensal_centavos      INT UNSIGNED    NULL,
  dias_permitidos             TINYINT UNSIGNED NOT NULL DEFAULT 31,
  permite_sem_carteirinha     BOOLEAN         NOT NULL DEFAULT FALSE,  -- só pode ligar com PIN definido (API valida)
  alerta_saldo_baixo_centavos INT UNSIGNED    NULL DEFAULT 1000,       -- push quando saldo < R$ 10
  updated_at                  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (aluno_id),
  CONSTRAINT fk_regras_aluno FOREIGN KEY (aluno_id) REFERENCES alunos_lanchei (id),
  CONSTRAINT ck_regras_dias CHECK (dias_permitidos <= 127),
  CONSTRAINT ck_regras_limites CHECK (
        (limite_diario_centavos  IS NULL OR limite_diario_centavos  > 0)
    AND (limite_semanal_centavos IS NULL OR limite_semanal_centavos > 0)
    AND (limite_mensal_centavos  IS NULL OR limite_mensal_centavos  > 0))
) ENGINE=InnoDB;

CREATE TABLE bloqueios_categoria_lanchei (
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  categoria_id            BIGINT UNSIGNED NOT NULL,
  criado_por_responsavel_id BIGINT UNSIGNED NOT NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (aluno_id, categoria_id),
  CONSTRAINT fk_bc_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT fk_bc_categoria FOREIGN KEY (categoria_id, escola_id) REFERENCES categorias_lanchei (id, escola_id),
  CONSTRAINT fk_bc_responsavel FOREIGN KEY (criado_por_responsavel_id) REFERENCES responsaveis_lanchei (id)
) ENGINE=InnoDB;

CREATE TABLE bloqueios_produto_lanchei (
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  produto_id              BIGINT UNSIGNED NOT NULL,
  criado_por_responsavel_id BIGINT UNSIGNED NOT NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (aluno_id, produto_id),
  CONSTRAINT fk_bp_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT fk_bp_produto FOREIGN KEY (produto_id, escola_id) REFERENCES produtos_lanchei (id, escola_id),
  CONSTRAINT fk_bp_responsavel FOREIGN KEY (criado_por_responsavel_id) REFERENCES responsaveis_lanchei (id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 7. CONTA, PEDIDOS, DEPÓSITOS, REEMBOLSOS E LEDGER
-- ---------------------------------------------------------------------

-- Uma conta por aluno. saldo_centavos é um CACHE do ledger:
-- só muda na MESMA transação de banco que insere em `transacoes`,
-- e a compra faz SELECT ... FOR UPDATE nesta linha (lock).
-- O CHECK garante no próprio banco que o saldo nunca fica negativo.
CREATE TABLE contas_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  saldo_centavos          BIGINT          NOT NULL DEFAULT 0,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contas_aluno (aluno_id),
  UNIQUE KEY uq_contas_id_escola (id, escola_id),
  CONSTRAINT fk_contas_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT ck_contas_saldo CHECK (saldo_centavos >= 0)
) ENGINE=InnoDB;

-- Pedido feito no caixa. Recusas também são gravadas (auditoria, push de
-- "compra recusada" e suporte). O limite de gasto é calculado somando
-- pedidos CONFIRMADOS do período; um pedido ESTORNADO deixa de contar,
-- e assim o estorno "devolve" o limite do período em que a compra foi feita.
CREATE TABLE pedidos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NOT NULL,
  conta_id                BIGINT UNSIGNED NOT NULL,
  operador_id             BIGINT UNSIGNED NOT NULL,
  modo_identificacao      ENUM('CARTEIRINHA','PIN','MANUAL') NOT NULL,  -- MANUAL = contingência lançada pelo admin
  carteirinha_id          BIGINT UNSIGNED NULL,
  idempotency_key         VARCHAR(64)     NOT NULL,          -- gerada pela tela do caixa (UUID v4)
  status                  ENUM('CONFIRMADO','RECUSADO','ESTORNADO') NOT NULL,
  motivo_recusa           ENUM(
                            'CONTA_INATIVA','CARTEIRINHA_BLOQUEADA','DIA_NAO_PERMITIDO',
                            'ITEM_BLOQUEADO','LIMITE_DIARIO','LIMITE_SEMANAL','LIMITE_MENSAL',
                            'SALDO_INSUFICIENTE') NULL,
  total_centavos          INT UNSIGNED    NOT NULL,
  estornado_em            DATETIME(3)     NULL,
  estornado_por_usuario_id BIGINT UNSIGNED NULL,
  motivo_estorno          VARCHAR(255)    NULL,
  observacao              VARCHAR(255)    NULL,              -- obrigatória na venda MANUAL
  ocorrido_em             DATETIME(3)     NULL,              -- venda MANUAL: quando aconteceu de fato
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pedidos_idem (escola_id, idempotency_key),   -- clique duplo = mesmo pedido
  UNIQUE KEY uq_pedidos_id_escola (id, escola_id),
  KEY ix_pedidos_limite (aluno_id, status, created_at),      -- cálculo de limite por período
  KEY ix_pedidos_relatorio (escola_id, created_at),          -- relatórios de vendas
  KEY ix_pedidos_operador (operador_id, created_at),
  CONSTRAINT fk_pedidos_aluno FOREIGN KEY (aluno_id, escola_id) REFERENCES alunos_lanchei (id, escola_id),
  CONSTRAINT fk_pedidos_conta FOREIGN KEY (conta_id, escola_id) REFERENCES contas_lanchei (id, escola_id),
  CONSTRAINT fk_pedidos_operador FOREIGN KEY (operador_id, escola_id) REFERENCES usuarios_lanchei (id, escola_id),
  CONSTRAINT fk_pedidos_carteirinha FOREIGN KEY (carteirinha_id) REFERENCES carteirinhas_lanchei (id),
  CONSTRAINT fk_pedidos_estornador FOREIGN KEY (estornado_por_usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT ck_pedidos_modo    CHECK ((modo_identificacao = 'CARTEIRINHA') = (carteirinha_id IS NOT NULL)),
  CONSTRAINT ck_pedidos_recusa  CHECK ((status = 'RECUSADO')  = (motivo_recusa IS NOT NULL)),
  CONSTRAINT ck_pedidos_manual  CHECK ((modo_identificacao = 'MANUAL') = (observacao IS NOT NULL AND ocorrido_em IS NOT NULL)),
  CONSTRAINT ck_pedidos_estorno CHECK ((status = 'ESTORNADO') = (estornado_em IS NOT NULL AND estornado_por_usuario_id IS NOT NULL))
) ENGINE=InnoDB;

-- Itens com SNAPSHOT de nome, categoria e preço no momento da venda.
CREATE TABLE pedido_itens_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pedido_id               BIGINT UNSIGNED NOT NULL,
  produto_id              BIGINT UNSIGNED NOT NULL,
  categoria_id            BIGINT UNSIGNED NOT NULL,
  nome_produto            VARCHAR(120)    NOT NULL,
  preco_unitario_centavos INT UNSIGNED    NOT NULL,
  quantidade              SMALLINT UNSIGNED NOT NULL,
  subtotal_centavos       INT UNSIGNED AS (preco_unitario_centavos * quantidade) STORED,
  PRIMARY KEY (id),
  KEY ix_itens_pedido (pedido_id),
  KEY ix_itens_produto (produto_id),
  CONSTRAINT fk_itens_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos_lanchei (id),
  CONSTRAINT fk_itens_produto FOREIGN KEY (produto_id) REFERENCES produtos_lanchei (id),
  CONSTRAINT fk_itens_categoria FOREIGN KEY (categoria_id) REFERENCES categorias_lanchei (id),
  CONSTRAINT ck_itens_qtd CHECK (quantidade > 0)
) ENGINE=InnoDB;

-- Depósito via Pix (Mercado Pago). Só vira saldo quando o webhook confirma
-- E a API consulta o pagamento no MP e vê status "approved".
-- A cantina absorve a taxa: o crédito no ledger é sempre valor_centavos (bruto).
CREATE TABLE depositos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  conta_id                BIGINT UNSIGNED NOT NULL,
  responsavel_id          BIGINT UNSIGNED NOT NULL,
  valor_centavos          INT UNSIGNED    NOT NULL,          -- min/max validados com escolas.deposito_*
  taxa_centavos           INT UNSIGNED    NULL,              -- informativo (relatório da cantina)
  status                  ENUM('PENDENTE','APROVADO','CANCELADO','REJEITADO','DEVOLVIDO') NOT NULL DEFAULT 'PENDENTE',
  idempotency_key         CHAR(36)        NOT NULL,          -- enviada ao MP no header X-Idempotency-Key
  mp_payment_id           VARCHAR(32)     NULL,
  pix_copia_cola          TEXT            NULL,              -- o QR é gerado a partir deste texto no app
  expira_em               DATETIME(3)     NULL,
  aprovado_em             DATETIME(3)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_depositos_idem (idempotency_key),
  UNIQUE KEY uq_depositos_mp (mp_payment_id),
  KEY ix_depositos_conta (conta_id, created_at),
  KEY ix_depositos_responsavel (responsavel_id, created_at),
  KEY ix_depositos_pendentes (status, expira_em),            -- job que expira/reconcilia pendentes
  CONSTRAINT fk_depositos_conta FOREIGN KEY (conta_id, escola_id) REFERENCES contas_lanchei (id, escola_id),
  CONSTRAINT fk_depositos_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT ck_depositos_valor CHECK (valor_centavos > 0),
  CONSTRAINT ck_depositos_aprovado CHECK (status NOT IN ('APROVADO','DEVOLVIDO') OR aprovado_em IS NOT NULL)
) ENGINE=InnoDB;

-- Reembolso de saldo SÓ no encerramento do vínculo (feito manualmente pelo admin).
CREATE TABLE reembolsos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  conta_id                BIGINT UNSIGNED NOT NULL,
  valor_centavos          INT UNSIGNED    NOT NULL,
  forma                   ENUM('PIX','TRANSFERENCIA','DINHEIRO') NOT NULL,
  comprovante_ref         VARCHAR(255)    NULL,              -- id do Pix / observação
  motivo                  VARCHAR(255)    NOT NULL,
  usuario_id              BIGINT UNSIGNED NOT NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_reembolsos_conta (conta_id),
  CONSTRAINT fk_reembolsos_conta FOREIGN KEY (conta_id, escola_id) REFERENCES contas_lanchei (id, escola_id),
  CONSTRAINT fk_reembolsos_usuario FOREIGN KEY (usuario_id, escola_id) REFERENCES usuarios_lanchei (id, escola_id),
  CONSTRAINT ck_reembolsos_valor CHECK (valor_centavos > 0)
) ENGINE=InnoDB;

-- LEDGER: livro-razão imutável. Fonte da verdade do saldo.
--   valor_centavos > 0 = crédito, < 0 = débito.
--   saldo_apos_centavos = saldo da conta logo após este lançamento
--   (facilita o extrato e permite auditar a sequência).
-- Os CHECKs garantem que cada tipo tem o sinal e a referência corretos.
-- As UNIQUEs garantem que um depósito/compra/estorno nunca é lançado 2x,
-- mesmo que a aplicação tenha um bug (ex.: webhook processado em paralelo).
CREATE TABLE transacoes_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  conta_id                BIGINT UNSIGNED NOT NULL,
  tipo                    ENUM('DEPOSITO','COMPRA','ESTORNO','REEMBOLSO','AJUSTE') NOT NULL,
  valor_centavos          BIGINT          NOT NULL,
  saldo_apos_centavos     BIGINT          NOT NULL,
  pedido_id               BIGINT UNSIGNED NULL,
  deposito_id             BIGINT UNSIGNED NULL,
  reembolso_id            BIGINT UNSIGNED NULL,
  usuario_id              BIGINT UNSIGNED NULL,              -- quem fez (estorno/reembolso/ajuste)
  descricao               VARCHAR(255)    NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tx_pedido (pedido_id, tipo),                 -- 1 COMPRA e no máx. 1 ESTORNO por pedido
  UNIQUE KEY uq_tx_deposito (deposito_id, tipo),             -- 1 crédito por depósito
  UNIQUE KEY uq_tx_reembolso (reembolso_id),
  KEY ix_tx_extrato (conta_id, id),                          -- extrato paginado
  KEY ix_tx_escola (escola_id, created_at),
  CONSTRAINT fk_tx_conta FOREIGN KEY (conta_id, escola_id) REFERENCES contas_lanchei (id, escola_id),
  CONSTRAINT fk_tx_pedido FOREIGN KEY (pedido_id, escola_id) REFERENCES pedidos_lanchei (id, escola_id),
  CONSTRAINT fk_tx_deposito FOREIGN KEY (deposito_id) REFERENCES depositos_lanchei (id),
  CONSTRAINT fk_tx_reembolso FOREIGN KEY (reembolso_id) REFERENCES reembolsos_lanchei (id),
  CONSTRAINT fk_tx_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT ck_tx_saldo CHECK (saldo_apos_centavos >= 0),
  CONSTRAINT ck_tx_tipo CHECK (
       (tipo = 'DEPOSITO'  AND valor_centavos > 0 AND deposito_id  IS NOT NULL AND pedido_id IS NULL AND reembolso_id IS NULL)
    OR (tipo = 'COMPRA'    AND valor_centavos < 0 AND pedido_id    IS NOT NULL AND deposito_id IS NULL AND reembolso_id IS NULL)
    OR (tipo = 'ESTORNO'   AND valor_centavos > 0 AND pedido_id    IS NOT NULL AND usuario_id IS NOT NULL)
    OR (tipo = 'REEMBOLSO' AND valor_centavos < 0 AND reembolso_id IS NOT NULL AND usuario_id IS NOT NULL)
    OR (tipo = 'AJUSTE'    AND valor_centavos <> 0 AND usuario_id  IS NOT NULL AND descricao IS NOT NULL)
  )
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 7b. ESTOQUE
-- ---------------------------------------------------------------------
-- Livro de movimentos de estoque (mesma ideia do ledger de dinheiro).
-- Só produtos com controla_estoque = TRUE geram movimentos.
--   ENTRADA  (+) chegou mercadoria            -> exige quem lançou
--   VENDA    (-) baixa automática do pedido   -> exige pedido
--   ESTORNO  (+) devolução opcional no estorno (lanche já comido não volta)
--   PERDA    (-) estragou, venceu, caiu...    -> exige quem lançou
--   AJUSTE   (+/-) contagem física/inventário -> exige quem lançou e motivo
-- Falta de estoque NÃO gera pedido recusado nem push para os pais: a culpa
-- não é do aluno. A API devolve erro só para a tela do caixa.
CREATE TABLE estoque_movimentos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NOT NULL,
  produto_id              BIGINT UNSIGNED NOT NULL,
  tipo                    ENUM('ENTRADA','VENDA','ESTORNO','PERDA','AJUSTE') NOT NULL,
  quantidade              INT             NOT NULL,          -- com sinal
  estoque_apos            INT             NOT NULL,
  pedido_id               BIGINT UNSIGNED NULL,
  usuario_id              BIGINT UNSIGNED NULL,
  motivo                  VARCHAR(255)    NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_estoque_pedido (pedido_id, produto_id, tipo), -- 1 baixa e no máx. 1 devolução por produto/pedido
  KEY ix_estoque_produto (produto_id, id),
  KEY ix_estoque_escola (escola_id, created_at),
  CONSTRAINT fk_estoque_produto FOREIGN KEY (produto_id, escola_id) REFERENCES produtos_lanchei (id, escola_id),
  CONSTRAINT fk_estoque_pedido FOREIGN KEY (pedido_id, escola_id) REFERENCES pedidos_lanchei (id, escola_id),
  CONSTRAINT fk_estoque_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT ck_estoque_apos CHECK (estoque_apos >= 0),
  CONSTRAINT ck_estoque_tipo CHECK (
       (tipo = 'ENTRADA' AND quantidade > 0 AND usuario_id IS NOT NULL AND pedido_id IS NULL)
    OR (tipo = 'VENDA'   AND quantidade < 0 AND pedido_id  IS NOT NULL)
    OR (tipo = 'ESTORNO' AND quantidade > 0 AND pedido_id  IS NOT NULL AND usuario_id IS NOT NULL)
    OR (tipo = 'PERDA'   AND quantidade < 0 AND usuario_id IS NOT NULL AND pedido_id IS NULL)
    OR (tipo = 'AJUSTE'  AND quantidade <> 0 AND usuario_id IS NOT NULL AND motivo IS NOT NULL AND pedido_id IS NULL)
  )
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 8. INTEGRAÇÕES, NOTIFICAÇÕES E AUDITORIA
-- ---------------------------------------------------------------------

-- Log bruto de todo webhook recebido (antes de processar).
-- Serve para depurar, reprocessar e provar o que o gateway mandou.
CREATE TABLE webhook_eventos_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provedor                ENUM('MERCADO_PAGO') NOT NULL,
  request_id              VARCHAR(64)     NULL,              -- header x-request-id
  escola_id               BIGINT UNSIGNED NULL,              -- resolvido pelo user_id do vendedor
  tipo                    VARCHAR(60)     NULL,              -- ex.: "payment"
  recurso_id              VARCHAR(64)     NULL,              -- ex.: id do pagamento
  assinatura_valida       BOOLEAN         NOT NULL,
  payload                 JSON            NOT NULL,
  recebido_em             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processado_em           DATETIME(3)     NULL,
  erro                    TEXT            NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_request (provedor, request_id),
  KEY ix_webhook_pendentes (processado_em, recebido_em),
  KEY ix_webhook_recurso (recurso_id),
  CONSTRAINT fk_webhook_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id)
) ENGINE=InnoDB;

-- Caixa de entrada do app + fila de push (outbox).
CREATE TABLE notificacoes_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  responsavel_id          BIGINT UNSIGNED NOT NULL,
  aluno_id                BIGINT UNSIGNED NULL,
  tipo                    ENUM('COMPRA','COMPRA_SEM_CARTEIRINHA','COMPRA_RECUSADA','SALDO_BAIXO',
                               'DEPOSITO_CONFIRMADO','CARTEIRINHA','REGRAS_ALTERADAS','ESTORNO') NOT NULL,
  titulo                  VARCHAR(120)    NOT NULL,
  corpo                   VARCHAR(500)    NOT NULL,
  dados                   JSON            NULL,              -- ex.: {"pedidoId": 123}
  push_enviado_em         DATETIME(3)     NULL,
  push_erro               VARCHAR(255)    NULL,
  lida_em                 DATETIME(3)     NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_notif_responsavel (responsavel_id, created_at),
  KEY ix_notif_push_pendente (push_enviado_em, created_at),
  CONSTRAINT fk_notif_responsavel FOREIGN KEY (responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT fk_notif_aluno FOREIGN KEY (aluno_id) REFERENCES alunos_lanchei (id)
) ENGINE=InnoDB;

-- Auditoria genérica e imutável: alteração de regras, bloqueio/revogação de
-- carteirinha, troca de PIN, visualização de foto, estornos, ajustes, etc.
CREATE TABLE auditoria_lanchei (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  escola_id               BIGINT UNSIGNED NULL,
  ator_tipo               ENUM('RESPONSAVEL','USUARIO','SISTEMA') NOT NULL,
  ator_responsavel_id     BIGINT UNSIGNED NULL,
  ator_usuario_id         BIGINT UNSIGNED NULL,
  acao                    VARCHAR(64)     NOT NULL,          -- ex.: "REGRAS_ATUALIZAR", "FOTO_VISUALIZAR"
  entidade                VARCHAR(64)     NOT NULL,          -- ex.: "regras_aluno"
  entidade_id             BIGINT UNSIGNED NULL,
  aluno_id                BIGINT UNSIGNED NULL,              -- facilita "histórico do aluno"
  antes                   JSON            NULL,
  depois                  JSON            NULL,
  ip                      VARCHAR(45)     NULL,
  user_agent              VARCHAR(255)    NULL,
  created_at              DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_aud_aluno (aluno_id, created_at),
  KEY ix_aud_entidade (entidade, entidade_id),
  KEY ix_aud_escola (escola_id, created_at),
  CONSTRAINT fk_aud_escola FOREIGN KEY (escola_id) REFERENCES escolas_lanchei (id),
  CONSTRAINT fk_aud_responsavel FOREIGN KEY (ator_responsavel_id) REFERENCES responsaveis_lanchei (id),
  CONSTRAINT fk_aud_usuario FOREIGN KEY (ator_usuario_id) REFERENCES usuarios_lanchei (id),
  CONSTRAINT fk_aud_aluno FOREIGN KEY (aluno_id) REFERENCES alunos_lanchei (id),
  CONSTRAINT ck_aud_ator CHECK (
       (ator_tipo = 'RESPONSAVEL' AND ator_responsavel_id IS NOT NULL AND ator_usuario_id IS NULL)
    OR (ator_tipo = 'USUARIO'     AND ator_usuario_id IS NOT NULL AND ator_responsavel_id IS NULL)
    OR (ator_tipo = 'SISTEMA'     AND ator_usuario_id IS NULL AND ator_responsavel_id IS NULL))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 9. IMUTABILIDADE (triggers)
-- ---------------------------------------------------------------------
-- Defesa em profundidade: além da API nunca fazer UPDATE/DELETE nessas
-- tabelas, o banco recusa. Em produção, o usuário MySQL da API também
-- não recebe privilégio de UPDATE/DELETE nelas (ver fim do arquivo).

DELIMITER $$

CREATE TRIGGER trg_transacoes_no_update BEFORE UPDATE ON transacoes_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transacoes_lanchei e imutavel: lance uma nova transacao (ESTORNO/AJUSTE)'; END$$
CREATE TRIGGER trg_transacoes_no_delete BEFORE DELETE ON transacoes_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'transacoes_lanchei e imutavel'; END$$

CREATE TRIGGER trg_auditoria_no_update BEFORE UPDATE ON auditoria_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auditoria_lanchei e imutavel'; END$$
CREATE TRIGGER trg_auditoria_no_delete BEFORE DELETE ON auditoria_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'auditoria_lanchei e imutavel'; END$$

CREATE TRIGGER trg_consent_no_update BEFORE UPDATE ON consentimentos_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consentimentos_lanchei e imutavel: registre uma REVOGACAO'; END$$
CREATE TRIGGER trg_consent_no_delete BEFORE DELETE ON consentimentos_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consentimentos_lanchei e imutavel'; END$$

CREATE TRIGGER trg_itens_no_update BEFORE UPDATE ON pedido_itens_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pedido_itens_lanchei e imutavel'; END$$
CREATE TRIGGER trg_itens_no_delete BEFORE DELETE ON pedido_itens_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pedido_itens_lanchei e imutavel'; END$$

CREATE TRIGGER trg_estoque_no_update BEFORE UPDATE ON estoque_movimentos_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'estoque_movimentos_lanchei e imutavel: lance um AJUSTE'; END$$
CREATE TRIGGER trg_estoque_no_delete BEFORE DELETE ON estoque_movimentos_lanchei FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'estoque_movimentos_lanchei e imutavel'; END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 10. RECONCILIAÇÃO (consulta usada por um job diário)
-- ---------------------------------------------------------------------
-- Deve retornar ZERO linhas. Qualquer linha = saldo divergente do ledger.
CREATE VIEW vw_contas_divergentes_lanchei AS
SELECT c.id AS conta_id, c.escola_id, c.saldo_centavos,
       COALESCE(SUM(t.valor_centavos), 0) AS saldo_ledger
FROM contas_lanchei c
LEFT JOIN transacoes_lanchei t ON t.conta_id = c.id
GROUP BY c.id, c.escola_id, c.saldo_centavos
HAVING c.saldo_centavos <> COALESCE(SUM(t.valor_centavos), 0);

-- Mesma ideia para o estoque: deve retornar ZERO linhas.
CREATE VIEW vw_estoque_divergente_lanchei AS
SELECT p.id AS produto_id, p.escola_id, p.estoque_atual,
       COALESCE(SUM(m.quantidade), 0) AS estoque_movimentos
FROM produtos_lanchei p
LEFT JOIN estoque_movimentos_lanchei m ON m.produto_id = p.id
WHERE p.controla_estoque
GROUP BY p.id, p.escola_id, p.estoque_atual
HAVING p.estoque_atual <> COALESCE(SUM(m.quantidade), 0);

-- ---------------------------------------------------------------------
-- 11. USUÁRIO DA API EM PRODUÇÃO
-- ---------------------------------------------------------------------
-- Ver database/grants.sql (privilégios mínimos: SELECT/INSERT nas tabelas
-- imutáveis, SELECT/INSERT/UPDATE nas demais, DELETE só nos bloqueios) e
-- database/testar_grants.sh, que confere essas permissões.
