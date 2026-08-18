-- Database role separation.
--
-- TECHSTACK.md A3 / risk register: "Postgres RLS is bypassed by table owners and
-- superusers." This is the mitigation, and it must exist before the first table
-- is created — retrofitting it means re-granting every object.
--
--   erp_owner  owns the schema, runs migrations, BYPASSES RLS.
--              Used by drizzle-kit and by src/server/db/migrate.ts. Never by the app.
--
--   erp_app    the application's runtime role. Owns nothing, so FORCE ROW LEVEL
--              SECURITY applies to it. This is the role every request runs as.
--
-- Blueprint §25: "deny-by-default, server-side authorisation for every page, API
-- and record." §22: "Row-level security is enforced in the query layer."

-- erp_owner is created by the container entrypoint from POSTGRES_USER.

CREATE ROLE erp_app WITH LOGIN PASSWORD 'app_dev_password';

-- Connect and use the schema, but create nothing.
GRANT CONNECT ON DATABASE erp TO erp_app;
GRANT USAGE ON SCHEMA public TO erp_app;
REVOKE CREATE ON SCHEMA public FROM erp_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Default privileges for objects erp_owner creates later.
-- Deliberately: no blanket UPDATE or DELETE. Migrations grant those per table,
-- and ledger and audit tables never receive them (A2, blueprint §5.4 and §24).
ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO erp_app;

-- Test database, same shape.
CREATE DATABASE erp_test OWNER erp_owner;
GRANT CONNECT ON DATABASE erp_test TO erp_app;
