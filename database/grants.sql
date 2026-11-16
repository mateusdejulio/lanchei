-- =====================================================================
-- Lanchei: usuário da API com PRIVILÉGIOS MÍNIMOS (produção)
--
-- Rode UMA vez, com o usuário administrador do banco (no Aiven: avnadmin),
-- depois de aplicar o schema. Troque a senha antes!
--
-- Por quê: mesmo que alguém invada a API, o usuário dela NÃO consegue
-- apagar ou alterar o ledger, a auditoria, os consentimentos e os itens de
-- pedido (o banco recusa por falta de permissão, antes até dos triggers),
-- nem apagar alunos, contas, pedidos etc. Ninguém recebe DROP/ALTER.
-- =====================================================================

CREATE USER IF NOT EXISTS 'lanchei_api'@'%' IDENTIFIED BY 'TROQUE-ESTA-SENHA-forte-e-longa';

-- Tabelas imutáveis: só ler e inserir.
GRANT SELECT, INSERT ON lanchei.transacoes_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT ON lanchei.estoque_movimentos_lanchei TO 'lanchei_api'@'%';
GRANT SELECT, INSERT ON lanchei.auditoria_lanchei          TO 'lanchei_api'@'%';
GRANT SELECT, INSERT ON lanchei.consentimentos_lanchei     TO 'lanchei_api'@'%';
GRANT SELECT, INSERT ON lanchei.pedido_itens_lanchei       TO 'lanchei_api'@'%';

-- Configuração que pode ser removida (histórico fica na auditoria).
GRANT SELECT, INSERT, DELETE ON lanchei.bloqueios_categoria_lanchei TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, DELETE ON lanchei.bloqueios_produto_lanchei   TO 'lanchei_api'@'%';

-- Demais tabelas: ler, inserir e atualizar (nunca apagar).
GRANT SELECT, INSERT, UPDATE ON lanchei.escolas_lanchei              TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.escola_mercadopago_lanchei   TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.usuarios_lanchei             TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.responsaveis_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.sessoes_lanchei              TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.tokens_email_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.dispositivos_push_lanchei    TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.turmas_lanchei               TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.alunos_lanchei               TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.fotos_alunos_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.aluno_responsaveis_lanchei   TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.convites_responsavel_lanchei TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.carteirinhas_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.categorias_lanchei           TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.produtos_lanchei             TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.regras_aluno_lanchei         TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.contas_lanchei               TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.pedidos_lanchei              TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.depositos_lanchei            TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.reembolsos_lanchei           TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.webhook_eventos_lanchei      TO 'lanchei_api'@'%';
GRANT SELECT, INSERT, UPDATE ON lanchei.notificacoes_lanchei         TO 'lanchei_api'@'%';

-- Views de reconciliação: só leitura.
GRANT SELECT ON lanchei.vw_contas_divergentes_lanchei TO 'lanchei_api'@'%';
GRANT SELECT ON lanchei.vw_estoque_divergente_lanchei TO 'lanchei_api'@'%';

-- Tabela nova no schema? Adicione o GRANT aqui (o teste em
-- testar_grants.sh avisa se alguma tabela ficou sem permissão).
