#!/usr/bin/env bash
# Recria o banco "lanchei" do zero e testa se as regras de integridade
# realmente barram o que precisam barrar.
#
# Uso:  ./testar_schema.sh                 (usa: mysql -u root -p)
#       MYSQL="mysql -u root -psenha" ./testar_schema.sh
# ATENÇÃO: apaga e recria o banco "lanchei". Use só em ambiente local.
set -u
MYSQL=${MYSQL:-"mysql -u root -p"}
cd "$(dirname "$0")"

$MYSQL -e "DROP DATABASE IF EXISTS lanchei" || exit 1
$MYSQL < schema.sql || { echo "ERRO ao carregar schema.sql"; exit 1; }
$MYSQL < smoke_test.sql || { echo "ERRO no smoke_test.sql"; exit 1; }

falhas=0
deve_falhar() {
  if out=$($MYSQL lanchei -e "$2" 2>&1); then
    echo "❌ PASSOU (não deveria): $1"; falhas=$((falhas+1))
  else
    echo "✅ bloqueou: $1"
  fi
}

echo "--- dinheiro e ledger ---"
deve_falhar "saldo negativo" "UPDATE contas_lanchei SET saldo_centavos=-1 WHERE id=1"
deve_falhar "UPDATE no ledger" "UPDATE transacoes_lanchei SET valor_centavos=1 WHERE id=1"
deve_falhar "DELETE no ledger" "DELETE FROM transacoes_lanchei WHERE id=1"
deve_falhar "depósito creditado 2x" "INSERT INTO transacoes_lanchei (escola_id,conta_id,tipo,valor_centavos,saldo_apos_centavos,deposito_id) VALUES (1,1,'DEPOSITO',2500,3800,1)"
deve_falhar "compra lançada 2x" "INSERT INTO transacoes_lanchei (escola_id,conta_id,tipo,valor_centavos,saldo_apos_centavos,pedido_id) VALUES (1,1,'COMPRA',-1200,100,1)"
deve_falhar "compra com sinal positivo" "INSERT INTO transacoes_lanchei (escola_id,conta_id,tipo,valor_centavos,saldo_apos_centavos,pedido_id) VALUES (1,1,'COMPRA',100,1400,1)"
deve_falhar "estorno sem usuário" "INSERT INTO transacoes_lanchei (escola_id,conta_id,tipo,valor_centavos,saldo_apos_centavos,pedido_id) VALUES (1,1,'ESTORNO',1200,2500,1)"
deve_falhar "idempotency key repetida (clique duplo)" "INSERT INTO pedidos_lanchei (escola_id,aluno_id,conta_id,operador_id,modo_identificacao,carteirinha_id,idempotency_key,status,total_centavos) VALUES (1,1,1,3,'CARTEIRINHA',1,'k1','CONFIRMADO',100)"

echo "--- multi-escola e cadastros ---"
deve_falhar "2 carteirinhas vivas p/ o mesmo aluno" "INSERT INTO carteirinhas_lanchei (escola_id,aluno_id,token_hash,emitida_por_usuario_id) VALUES (1,1,UNHEX(SHA2('t2',256)),2)"
deve_falhar "aluno da escola A em turma da B" "INSERT INTO alunos_lanchei (escola_id,turma_id,nome,matricula) VALUES (1,2,'X','002')"
deve_falhar "bloqueio com categoria de outra escola" "INSERT INTO bloqueios_categoria_lanchei (escola_id,aluno_id,categoria_id,criado_por_responsavel_id) VALUES (1,1,2,1)"
deve_falhar "produto com preço zero" "INSERT INTO produtos_lanchei (escola_id,categoria_id,nome,preco_centavos) VALUES (1,1,'Gratis',0)"
deve_falhar "pedido recusado sem motivo" "INSERT INTO pedidos_lanchei (escola_id,aluno_id,conta_id,operador_id,modo_identificacao,carteirinha_id,idempotency_key,status,total_centavos) VALUES (1,1,1,3,'CARTEIRINHA',1,'k2','RECUSADO',100)"
deve_falhar "pedido por PIN com carteirinha" "INSERT INTO pedidos_lanchei (escola_id,aluno_id,conta_id,operador_id,modo_identificacao,carteirinha_id,idempotency_key,status,total_centavos) VALUES (1,1,1,3,'PIN',1,'k3','CONFIRMADO',100)"
deve_falhar "admin sem escola" "INSERT INTO usuarios_lanchei (escola_id,papel,nome,email,senha_hash) VALUES (NULL,'ADMIN','x','y@x.com','h')"
deve_falhar "dias_permitidos inválido" "UPDATE regras_aluno_lanchei SET dias_permitidos=200 WHERE aluno_id=1"

deve_falhar "venda MANUAL sem observação" "INSERT INTO pedidos_lanchei (escola_id,aluno_id,conta_id,operador_id,modo_identificacao,idempotency_key,status,total_centavos,ocorrido_em) VALUES (1,1,1,2,'MANUAL','k4','CONFIRMADO',100,NOW(3))"
deve_falhar "foto maior que 2 MB" "INSERT INTO fotos_alunos_lanchei (aluno_id,escola_id,conteudo,tamanho_bytes,sha256) VALUES (1,1,'x',3000000,UNHEX(SHA2('x',256)))"

deve_falhar "push WEB sem chaves" "INSERT INTO dispositivos_push_lanchei (responsavel_id,canal,identificador_hash,web_endpoint) VALUES (1,'WEB',UNHEX(SHA2('e',256)),'https://push.exemplo/x')"

echo "--- estoque ---"
deve_falhar "estoque negativo" "UPDATE produtos_lanchei SET estoque_atual=-1 WHERE id=1"
deve_falhar "estoque em produto sem controle" "INSERT INTO produtos_lanchei (escola_id,categoria_id,nome,preco_centavos,estoque_atual) VALUES (1,1,'Bala',100,5)"
deve_falhar "baixa de estoque 2x no mesmo pedido" "INSERT INTO estoque_movimentos_lanchei (escola_id,produto_id,tipo,quantidade,estoque_apos,pedido_id) VALUES (1,1,'VENDA',-2,6,1)"
deve_falhar "movimento deixando estoque negativo" "INSERT INTO estoque_movimentos_lanchei (escola_id,produto_id,tipo,quantidade,estoque_apos,usuario_id) VALUES (1,1,'PERDA',-9,-1,2)"
deve_falhar "entrada com quantidade negativa" "INSERT INTO estoque_movimentos_lanchei (escola_id,produto_id,tipo,quantidade,estoque_apos,usuario_id) VALUES (1,1,'ENTRADA',-1,7,2)"
deve_falhar "ajuste sem motivo" "INSERT INTO estoque_movimentos_lanchei (escola_id,produto_id,tipo,quantidade,estoque_apos,usuario_id) VALUES (1,1,'AJUSTE',1,9,2)"
deve_falhar "UPDATE em movimento de estoque" "UPDATE estoque_movimentos_lanchei SET quantidade=1 WHERE id=1"

echo
if [ "$falhas" -eq 0 ]; then echo "Tudo certo: todas as regras bloquearam."; else echo "$falhas regra(s) NÃO bloquearam."; exit 1; fi
