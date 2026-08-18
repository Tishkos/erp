-- ===========================================================================
-- Organisation records are deactivated, never deleted — Phase 03.1, §1.1, §4.4.
--
-- HAND-AUTHORED. Drizzle does not model triggers.
--
-- 03.1 gate: *"Deactivating an organisation record referenced by a transaction
-- is permitted; deleting it is not."*
-- §1.1: *"No deletion of saved or posted records."*
--
-- Business partners, items, warehouses and bank accounts each got this guard in
-- Phase 03. Branches, departments and cost centres did not — and they are the
-- ones every posted line carries as a dimension. Deleting a branch would leave
-- journals pointing at a branch that no longer exists, which is not a broken
-- foreign key (those hold) but something worse: a reporting hierarchy that no
-- longer explains the figures beneath it.
--
-- The foreign keys already prevent deleting a *referenced* record. This guard
-- covers the rest: an organisation record that happens to have no transactions
-- yet is still part of the approved structure (§2.1), and removing it silently
-- changes what the company is. Deactivation says the same thing and keeps the
-- history readable.
-- ===========================================================================

CREATE FUNCTION organisation_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  v_code := OLD.code;

  RAISE EXCEPTION
    '% % cannot be deleted. Deactivate it instead — every posted line that carries it must stay explainable (§1.1, §4.4).',
    initcap(replace(TG_TABLE_NAME, '_', ' ')), v_code
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER branch_reject_delete
  BEFORE DELETE ON branch
  FOR EACH ROW EXECUTE FUNCTION organisation_reject_delete();--> statement-breakpoint

CREATE TRIGGER department_reject_delete
  BEFORE DELETE ON department
  FOR EACH ROW EXECUTE FUNCTION organisation_reject_delete();--> statement-breakpoint

CREATE TRIGGER cost_centre_reject_delete
  BEFORE DELETE ON cost_centre
  FOR EACH ROW EXECUTE FUNCTION organisation_reject_delete();--> statement-breakpoint

-- The application role never had DELETE on these; stated explicitly so a future
-- migration that grants table privileges in bulk does not quietly hand it over.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE DELETE ON branch, department, cost_centre FROM erp_app;
END;
$$;
