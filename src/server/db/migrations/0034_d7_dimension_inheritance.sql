-- ===========================================================================
-- D7 — dimension rules are inherited from the account group. Decided 2026-08-17.
--
--   "Dimension rules are configured primarily at the account-group level. Child
--    accounts automatically inherit the group's rules for Branch, Project, Cost
--    Center and Department. Finance may override a rule for a specific account
--    when necessary. … This keeps the Chart of Accounts manageable as hundreds
--    or thousands of accounts are added."
--
-- `account_required_dimension` already held rules per account. What it could not
-- express is the difference between an account with **no rules of its own**
-- (inherit) and an account that has been **deliberately given none** (override
-- the group with nothing). Both looked like zero rows.
--
-- So an account either DECLARES its dimension rules or it does not, and the
-- effective rules are the nearest self-or-ancestor that declares. A group
-- declares once; a thousand accounts below it inherit; Finance overrides one by
-- making it declare its own set, which may be empty.
--
-- The alternative — copying the group's rows down to every child on creation —
-- was rejected: it makes the group's rule unchangeable in practice, because
-- editing it would have to find and update every copy, and any copy that had
-- been edited in the meantime would be silently overwritten or silently kept.
-- ===========================================================================

ALTER TABLE chart_of_account
  ADD COLUMN declares_dimensions boolean NOT NULL DEFAULT false;--> statement-breakpoint

COMMENT ON COLUMN chart_of_account.declares_dimensions IS
  'D7 (2026-08-17): true when this account states its own dimension rules. '
  'False means inherit from the nearest ancestor that declares. An account that '
  'declares with no rows requires nothing — an explicit override, not silence.';--> statement-breakpoint

-- Accounts that already carry rules were declaring them; nothing above them
-- did, so their behaviour is unchanged.
UPDATE chart_of_account c
   SET declares_dimensions = true
 WHERE EXISTS (SELECT 1 FROM account_required_dimension d WHERE d.account_id = c.id);--> statement-breakpoint

-- A rule can only exist on an account that declares. Otherwise a row would sit
-- there, invisible, while the account inherited something else.
CREATE FUNCTION account_dimension_requires_declaration() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_declares boolean;
  v_code     text;
BEGIN
  SELECT declares_dimensions, code INTO v_declares, v_code
    FROM chart_of_account WHERE id = NEW.account_id;

  IF NOT coalesce(v_declares, false) THEN
    RAISE EXCEPTION
      'Account % inherits its dimension rules, so a rule cannot be set on it directly (D7). Make it declare its own rules first, or set the rule on the group above it.',
      v_code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER account_dimension_requires_declaration
  BEFORE INSERT OR UPDATE ON account_required_dimension
  FOR EACH ROW EXECUTE FUNCTION account_dimension_requires_declaration();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The effective rules for an account: the nearest self-or-ancestor that
-- declares. Written in SQL as well as in the domain so that a report, a check
-- constraint or a hand-run query gets the same answer as the application.
-- ---------------------------------------------------------------------------
CREATE FUNCTION account_effective_dimensions(p_account_id uuid)
RETURNS SETOF dimension_type
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, declares_dimensions, 0 AS depth
      FROM chart_of_account
     WHERE id = p_account_id
    UNION ALL
    SELECT p.id, p.parent_id, p.declares_dimensions, c.depth + 1
      FROM chart_of_account p
      JOIN chain c ON c.parent_id = p.id
  ),
  declaring AS (
    SELECT id FROM chain WHERE declares_dimensions ORDER BY depth LIMIT 1
  )
  SELECT d.dimension
    FROM account_required_dimension d
    JOIN declaring ON declaring.id = d.account_id;
$$;--> statement-breakpoint

-- ===========================================================================
-- D7 — control accounts: proposed by the Officer, approved by the Manager, and
-- protected once they carry transactions. Decided 2026-08-17.
--
--   "The Accounting Officer may propose that an account is a control account
--    when creating it, but the Accounting Manager must approve the designation
--    before the account becomes active. … Once a control account has
--    transactions, changing or removing its control-account status should
--    require Accounting Manager approval and should not be allowed if doing so
--    would break existing accounting mappings."
--
-- The first half was already true and needed nothing: an account is raised as a
-- draft with whatever control-account kind the Officer proposes, and it accepts
-- no postings until the Manager approves it (`chart_of_account_active_requires_
-- approval`, migration 0003). Approving the account approves the designation.
--
-- The second half is what this adds. Two different protections, because they
-- fail differently:
--
--   * **Would break a mapping** — refused outright, here, by the database. If a
--     posting rule points at the account as a control account, removing the
--     designation would leave the mapping selecting an account that §14.3 no
--     longer protects, and the next automated posting would go somewhere the
--     reconciliation does not expect.
--
--   * **Has transactions** — allowed, but only through the service, which
--     requires the Accounting Manager. The database cannot tell an Accounting
--     Manager from anyone else; what it can do is refuse the change to everyone
--     unless the session has been marked as carrying that approval.
-- ===========================================================================
CREATE FUNCTION chart_of_account_control_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_posted   bigint;
  v_mappings bigint;
BEGIN
  IF NEW.control_account IS NOT DISTINCT FROM OLD.control_account THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_mappings
    FROM posting_rule WHERE account_id = OLD.id AND is_active;

  IF v_mappings > 0 AND NEW.control_account IS NULL THEN
    RAISE EXCEPTION
      'Account % is the account % accounting mapping(s) post to as a control account (blueprint 14.3). Removing the designation would leave those mappings posting to an unprotected account. Repoint the mappings first.',
      OLD.code, v_mappings
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_posted
    FROM journal_line WHERE account_id = OLD.id;

  IF v_posted > 0 AND coalesce(current_setting('app.control_account_change_approved', true), 'off') <> 'on' THEN
    RAISE EXCEPTION
      'Account % already carries % posted line(s), so its control-account status is not changed casually (D7). The Accounting Manager approves the change; it is made through the Chart of Accounts service, not by hand.',
      OLD.code, v_posted
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chart_of_account_control_change_guard
  BEFORE UPDATE ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_control_change_guard();--> statement-breakpoint

-- §24 — the control-account designation joins the fields frozen after approval,
-- with its own route for changing it. It was already listed there in migration
-- 0022; this records why the route exists.
UPDATE document_type_controlled_field
   SET note = 'Decides whether the account may be posted to manually (blueprint 14.3). '
              'Changed only by the Accounting Manager, and never while an accounting mapping depends on it (D7).'
 WHERE document_type_code = 'chart_of_account' AND field_name = 'control_account';
