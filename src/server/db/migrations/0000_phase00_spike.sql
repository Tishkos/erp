-- ===========================================================================
-- Phase 00 — STACK VALIDATION SPIKE
--
-- These objects are prefixed spike_ and are DROPPED in Phase 01. They exist to
-- prove, against a real PostgreSQL instance, that the four hardest constraints
-- in TECHSTACK.md Part A are achievable on the chosen stack — before Phases 01
-- and 02 are built on top of them.
--
--   A2  append-only ledgers and audit      (§5.4, §24)
--   A3  row-level security that cannot be bypassed  (§22, §25)
--   A4  exact money and rate precision     (§1.1, §24)
--   A5  idempotent posting                 (§3.1, §23, §24)
--   A6  gapless numbering under concurrency (§3.4, §14.2)
--
-- Every assertion here has a matching integration test in
-- tests/integration/phase00-constraints.test.ts. If a test fails, the stack
-- choice is wrong and must be raised under blueprint §28.2 before Phase 01.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A4 — money and rate precision
--
-- Money is numeric(19,4). Rates are numeric(18,8) and are stored IQD-per-USD.
-- Storing the inverse at 4dp would round 0.000763 to 0.0008 — a ~5% error on
-- every USD reporting figure the blueprint requires (§1.1).
--
-- Domains give the precision a name so no table can quietly declare its own.
-- ---------------------------------------------------------------------------
CREATE DOMAIN money_amount AS numeric(19, 4);
CREATE DOMAIN fx_rate      AS numeric(18, 8) CHECK (VALUE > 0);
CREATE DOMAIN currency_code AS char(3) CHECK (VALUE ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- A2 — append-only enforcement
--
-- Two layers, because either alone is insufficient:
--   1. REVOKE UPDATE, DELETE from the app role  — stops the application
--   2. A trigger raising an exception           — stops anyone, including the
--      owner role and any future migration that forgets
-- ---------------------------------------------------------------------------
CREATE FUNCTION spike_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. Corrections create a new linked entry (blueprint §24).',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- A3 — row-level security scope
--
-- The policy reads a session variable set per transaction by the application.
-- current_setting(..., true) returns NULL when unset, so an unscoped
-- connection sees NOTHING. That is deny-by-default (§25), not an accident.
-- ---------------------------------------------------------------------------
CREATE FUNCTION spike_current_branch() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.branch_code', true), '');
$$;

-- ---------------------------------------------------------------------------
-- Scope table
-- ---------------------------------------------------------------------------
CREATE TABLE spike_branch (
  code text PRIMARY KEY,
  name text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Ledger entry — carries A2, A3, A4, A5 and A6 together
-- ---------------------------------------------------------------------------
CREATE TABLE spike_ledger_entry (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- A6: human-readable number, allocated under an advisory lock
  entry_no        text NOT NULL UNIQUE,

  -- A3: the dimension RLS filters on
  branch_code     text NOT NULL REFERENCES spike_branch(code),

  -- A4: the four-part money tuple required by §24 —
  -- transaction amount + currency, IQD ledger amount, USD reporting amount,
  -- and the historical rate that produced it
  amount_txn      money_amount  NOT NULL,
  currency        currency_code NOT NULL,
  amount_iqd      money_amount  NOT NULL,
  amount_usd      money_amount  NOT NULL,
  rate_iqd_per_usd fx_rate      NOT NULL,

  -- A10: business date and system instant are different types
  posting_date    date        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- A5: deterministic source reference — the idempotency key
  source_module   text NOT NULL,
  source_doc_id   text NOT NULL,
  source_event    text NOT NULL,

  -- A6: optimistic concurrency
  version         integer NOT NULL DEFAULT 1
);

-- A5: the same source event can only ever post once (§24)
CREATE UNIQUE INDEX spike_ledger_source_uniq
  ON spike_ledger_entry (source_module, source_doc_id, source_event);

-- A2: append-only
CREATE TRIGGER spike_ledger_append_only
  BEFORE UPDATE OR DELETE ON spike_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION spike_reject_mutation();

-- A3: RLS. FORCE is the critical word — without it the table owner bypasses
-- the policy entirely and every scope test passes for the wrong reason.
ALTER TABLE spike_ledger_entry ENABLE  ROW LEVEL SECURITY;
ALTER TABLE spike_ledger_entry FORCE   ROW LEVEL SECURITY;

CREATE POLICY spike_ledger_branch_scope ON spike_ledger_entry
  USING (branch_code = spike_current_branch())
  WITH CHECK (branch_code = spike_current_branch());

-- ---------------------------------------------------------------------------
-- A6 — gapless document numbering under concurrency
--
-- pg_advisory_xact_lock serialises allocation for one sequence key and releases
-- at commit. Blueprint §14.2: numbers are "generated automatically and never
-- reused"; §3.4 requires unique document numbering.
-- ---------------------------------------------------------------------------
CREATE TABLE spike_sequence (
  key       text PRIMARY KEY,
  prefix    text NOT NULL,
  next_no   bigint NOT NULL DEFAULT 1
);

CREATE FUNCTION spike_next_document_no(p_key text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
  v_no     bigint;
BEGIN
  -- Serialise on a hash of the sequence key for the rest of this transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_key));

  UPDATE spike_sequence
     SET next_no = next_no + 1
   WHERE key = p_key
  RETURNING prefix, next_no - 1 INTO v_prefix, v_no;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown document sequence: %', p_key;
  END IF;

  RETURN v_prefix || '-' || lpad(v_no::text, 6, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants for the application role.
--
-- SELECT and INSERT only. No UPDATE, no DELETE — the second half of A2.
-- Note this is belt-and-braces with the trigger above: the trigger stops
-- everyone, the grant stops the application even if a trigger is ever dropped.
-- ---------------------------------------------------------------------------
-- Granted per-database so this migration is self-contained and works against
-- erp_test as well as erp (ALTER DEFAULT PRIVILEGES is per-database).
--
-- Guarded on the role existing so the migration is not coupled to whether
-- scripts/sql/00-init-roles.sql has run. Without the role the schema still
-- builds; the application simply cannot connect, which is the correct failure.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT USAGE ON SCHEMA public TO erp_app;

    GRANT SELECT, INSERT ON spike_branch       TO erp_app;
    GRANT SELECT, INSERT ON spike_ledger_entry TO erp_app;
    GRANT SELECT, UPDATE ON spike_sequence     TO erp_app;
    GRANT EXECUTE ON FUNCTION spike_next_document_no(text) TO erp_app;
    GRANT EXECUTE ON FUNCTION spike_current_branch()       TO erp_app;
  ELSE
    RAISE WARNING
      'Role erp_app does not exist — grants skipped. Run scripts/sql/00-init-roles.sql.';
  END IF;
END;
$$;
