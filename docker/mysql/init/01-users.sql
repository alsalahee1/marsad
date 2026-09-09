-- Runs once, when the docker-compose MySQL volume is first created.
-- LOCAL DEVELOPMENT CREDENTIALS. On the VPS, run the same statements by hand with real
-- passwords (see README.md → "Database accounts") and put those in .env.
--
-- Two accounts, on purpose:
--   marsad_migrate  owns the schema: DDL, triggers, and the GRANT OPTION needed to hand
--                   table-level privileges to the app user. Used only by `pnpm db:migrate`.
--   marsad_app      the engine at runtime. It gets table-level grants from the migration
--                   runner (apps/engine/src/db/grants.ts) — SELECT and INSERT on `events`,
--                   never UPDATE or DELETE — and no schema-wide privilege, ever.

CREATE DATABASE IF NOT EXISTS marsad CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS marsad_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'marsad_migrate'@'%' IDENTIFIED BY 'marsad_migrate_dev';
GRANT ALL PRIVILEGES ON marsad.* TO 'marsad_migrate'@'%' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON marsad_test.* TO 'marsad_migrate'@'%' WITH GRANT OPTION;
-- Binary logging is on by default in MySQL 8, and then CREATE TRIGGER needs one global
-- privilege on top of TRIGGER. SET_USER_ID is the narrow one on 8.0 (verified on 8.0.46).
-- On MySQL 8.4 grant SET_ANY_DEFINER instead. Never SUPER.
GRANT SET_USER_ID ON *.* TO 'marsad_migrate'@'%';

CREATE USER IF NOT EXISTS 'marsad_app'@'%' IDENTIFIED BY 'marsad_app_dev';
-- No grants here. The migration runner grants exactly APP_TABLE_PRIVILEGES after the tables exist.

FLUSH PRIVILEGES;
