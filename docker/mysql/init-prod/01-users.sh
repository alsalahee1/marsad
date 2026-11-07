# Runs once, when the production MySQL data volume is first created (docker-compose.prod.yml
# mounts this directory). The mysql image *sources* this file, so docker_process_sql is in scope
# and nothing here may `set -u` or `exit`.
#
# Same two accounts as docker/mysql/init/01-users.sql, with the passwords taken from the
# environment compose passes in (.env → MYSQL_PASSWORD, MYSQL_MIGRATE_PASSWORD). Nothing is
# written to disk; the users live in the data volume.
#
#   marsad_migrate  owns the schema (DDL, triggers, GRANT OPTION) — used by the migrate service only.
#   marsad_app      the engine at runtime — no grants here; the migration runner grants exactly
#                   APP_TABLE_PRIVILEGES (SELECT+INSERT on events, never UPDATE/DELETE).

marsad_require() {
  if [ -z "${!1:-}" ]; then
    echo >&2 "init-prod/01-users.sh: $1 is not set (compose passes it from .env)"
    return 1
  fi
}
marsad_require MARSAD_APP_PASSWORD || return 1
marsad_require MARSAD_MIGRATE_PASSWORD || return 1

# Quote a value for use inside a single-quoted SQL string literal.
marsad_sql_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\'/\\\'}"
  printf '%s' "$s"
}

marsad_db="${MYSQL_DATABASE:-marsad}"
marsad_app_user="$(marsad_sql_escape "${MARSAD_APP_USER:-marsad_app}")"
marsad_app_pw="$(marsad_sql_escape "$MARSAD_APP_PASSWORD")"
marsad_mig_user="$(marsad_sql_escape "${MARSAD_MIGRATE_USER:-marsad_migrate}")"
marsad_mig_pw="$(marsad_sql_escape "$MARSAD_MIGRATE_PASSWORD")"

docker_process_sql <<SQL
CREATE DATABASE IF NOT EXISTS \`${marsad_db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS '${marsad_mig_user}'@'%' IDENTIFIED BY '${marsad_mig_pw}';
GRANT ALL PRIVILEGES ON \`${marsad_db}\`.* TO '${marsad_mig_user}'@'%' WITH GRANT OPTION;
-- Binary logging is on by default in MySQL 8, and CREATE TRIGGER then needs this one global
-- privilege on top of TRIGGER. On MySQL 8.4 use SET_ANY_DEFINER instead. Never SUPER.
GRANT SET_USER_ID ON *.* TO '${marsad_mig_user}'@'%';

CREATE USER IF NOT EXISTS '${marsad_app_user}'@'%' IDENTIFIED BY '${marsad_app_pw}';
-- No grants: the migration runner (apps/engine/src/db/grants.ts) grants table privileges only.

FLUSH PRIVILEGES;
SQL

unset marsad_db marsad_app_user marsad_app_pw marsad_mig_user marsad_mig_pw
