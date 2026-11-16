#!/usr/bin/env bash
# Confere o grants.sql num banco LOCAL já criado pelo testar_schema.sh.
# Uso: MYSQL="mysql -u root -p" ./testar_grants.sh
set -u
MYSQL=${MYSQL:-"mysql -u root -p"}
cd "$(dirname "$0")"

SENHA_TESTE='senha-local-de-teste-123'
$MYSQL -e "DROP USER IF EXISTS 'lanchei_api'@'%'" || exit 1
sed "s/TROQUE-ESTA-SENHA-forte-e-longa/$SENHA_TESTE/" grants.sql | $MYSQL || { echo "ERRO ao aplicar grants.sql"; exit 1; }

API="mysql -h 127.0.0.1 -u lanchei_api -p$SENHA_TESTE lanchei"
falhas=0
pode()      { if $API -e "$2" >/dev/null 2>&1; then echo "✅ permitido: $1"; else echo "❌ deveria permitir: $1"; falhas=$((falhas+1)); fi; }
nao_pode()  { if $API -e "$2" >/dev/null 2>&1; then echo "❌ deveria NEGAR: $1"; falhas=$((falhas+1)); else echo "✅ negado: $1"; fi; }

pode     "ler o ledger"                    "SELECT COUNT(*) FROM transacoes_lanchei"
pode     "ler a view de reconciliação"     "SELECT COUNT(*) FROM vw_contas_divergentes_lanchei"
pode     "atualizar saldo materializado"   "UPDATE contas_lanchei SET saldo_centavos = saldo_centavos WHERE id = 1"
pode     "apagar bloqueio (configuração)"  "DELETE FROM bloqueios_produto_lanchei WHERE aluno_id = 0"
nao_pode "UPDATE no ledger"                "UPDATE transacoes_lanchei SET descricao = 'x' WHERE id = 1"
nao_pode "DELETE no ledger"                "DELETE FROM transacoes_lanchei WHERE id = 1"
nao_pode "UPDATE na auditoria"             "UPDATE auditoria_lanchei SET acao = 'x' WHERE id = 1"
nao_pode "apagar aluno"                    "DELETE FROM alunos_lanchei WHERE id = 1"
nao_pode "apagar pedido"                   "DELETE FROM pedidos_lanchei WHERE id = 1"
nao_pode "DROP TABLE"                      "DROP TABLE escolas_lanchei"
nao_pode "ALTER TABLE"                     "ALTER TABLE contas_lanchei ADD COLUMN x INT"

# Toda tabela do schema precisa ter algum GRANT para a API.
sem_grant=$($MYSQL -N -e "
  SELECT t.table_name FROM information_schema.tables t
  WHERE t.table_schema = 'lanchei'
    AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges p
                    WHERE p.table_schema = 'lanchei' AND p.table_name = t.table_name
                      AND p.grantee = \"'lanchei_api'@'%'\")")
if [ -n "$sem_grant" ]; then echo "❌ tabelas sem GRANT: $sem_grant"; falhas=$((falhas+1)); else echo "✅ todas as tabelas têm GRANT"; fi

$MYSQL -e "DROP USER IF EXISTS 'lanchei_api'@'%'"
echo
if [ "$falhas" -eq 0 ]; then echo "Tudo certo: permissões mínimas conferidas."; else echo "$falhas problema(s)."; exit 1; fi
