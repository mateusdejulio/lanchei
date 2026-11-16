-- Smoke test do schema: cada bloco "DEVE FALHAR" precisa dar erro.
USE lanchei;
SET time_zone = '+00:00';

INSERT INTO escolas_lanchei (id, nome, slug) VALUES (1,'Escola A','a'), (2,'Escola B','b');
INSERT INTO usuarios_lanchei (id, escola_id, papel, nome, email, senha_hash) VALUES
  (1, NULL, 'SUPERADMIN','Mateus','m@x.com','h'),
  (2, 1, 'ADMIN','Admin A','admin@a.com','h'),
  (3, 1, 'OPERADOR','Op A','op@a.com','h');
INSERT INTO turmas_lanchei (id, escola_id, nome, ano_letivo) VALUES (1,1,'3A',2026), (2,2,'3B',2026);
INSERT INTO alunos_lanchei (id, escola_id, turma_id, nome, matricula) VALUES (1,1,1,'Joao','001');
INSERT INTO regras_aluno_lanchei (aluno_id) VALUES (1);
INSERT INTO contas_lanchei (id, escola_id, aluno_id) VALUES (1,1,1);
INSERT INTO categorias_lanchei (id, escola_id, nome) VALUES (1,1,'Bebidas'), (2,2,'Doces B');
INSERT INTO produtos_lanchei (id, escola_id, categoria_id, nome, preco_centavos) VALUES (1,1,1,'Suco',600);
INSERT INTO carteirinhas_lanchei (escola_id, aluno_id, token_hash, emitida_por_usuario_id) VALUES (1,1,UNHEX(SHA2('t1',256)),2);
INSERT INTO responsaveis_lanchei (id, nome, email, senha_hash) VALUES (1,'Maria','maria@x.com','h');

-- depósito + crédito
INSERT INTO depositos_lanchei (id, escola_id, conta_id, responsavel_id, valor_centavos, idempotency_key, status, aprovado_em)
  VALUES (1,1,1,1,2500,UUID(),'APROVADO',NOW(3));
INSERT INTO transacoes_lanchei (escola_id, conta_id, tipo, valor_centavos, saldo_apos_centavos, deposito_id) VALUES (1,1,'DEPOSITO',2500,2500,1);
UPDATE contas_lanchei SET saldo_centavos = 2500 WHERE id = 1;

-- compra
INSERT INTO pedidos_lanchei (id, escola_id, aluno_id, conta_id, operador_id, modo_identificacao, carteirinha_id, idempotency_key, status, total_centavos)
  VALUES (1,1,1,1,3,'CARTEIRINHA',1,'k1','CONFIRMADO',1200);
INSERT INTO pedido_itens_lanchei (pedido_id, produto_id, categoria_id, nome_produto, preco_unitario_centavos, quantidade) VALUES (1,1,1,'Suco',600,2);
INSERT INTO transacoes_lanchei (escola_id, conta_id, tipo, valor_centavos, saldo_apos_centavos, pedido_id) VALUES (1,1,'COMPRA',-1200,1300,1);
UPDATE contas_lanchei SET saldo_centavos = 1300 WHERE id = 1;

SELECT 'subtotal gerado' AS teste, subtotal_centavos FROM pedido_itens_lanchei WHERE id=1;
SELECT 'divergentes (esperado 0)' AS teste, COUNT(*) FROM vw_contas_divergentes_lanchei;

-- estoque: produto com controle, entrada de 10, venda de 2
UPDATE produtos_lanchei SET controla_estoque = TRUE WHERE id = 1;
INSERT INTO estoque_movimentos_lanchei (escola_id, produto_id, tipo, quantidade, estoque_apos, usuario_id) VALUES (1,1,'ENTRADA',10,10,2);
UPDATE produtos_lanchei SET estoque_atual = 10 WHERE id = 1;
INSERT INTO estoque_movimentos_lanchei (escola_id, produto_id, tipo, quantidade, estoque_apos, pedido_id) VALUES (1,1,'VENDA',-2,8,1);
UPDATE produtos_lanchei SET estoque_atual = 8 WHERE id = 1;
SELECT 'estoque divergente (esperado 0)' AS teste, COUNT(*) FROM vw_estoque_divergente_lanchei;
