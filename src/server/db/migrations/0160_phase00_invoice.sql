-- ===========================================================================
-- Phase 0 — the invoice that proves the foundation.
--
-- Phase 0 defines rules, not modules: statuses, numbering, department
-- approval routing, audit and record history. Those rules can only be shown
-- to work by putting a document through them, so this is the simplest
-- document that uses every one of them: an employee raises an invoice, it
-- takes its number from a series, it moves Draft → Pending Approval →
-- Approved, it routes to the manager of the department it was raised in, and
-- every step of it lands in the audit trail. It posts nothing: the ledger,
-- tax, customers and pricing belong to the accounting phases.
-- ===========================================================================

CREATE TABLE invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_no text NOT NULL,
  customer_name text NOT NULL,
  description text,
  amount numeric(19, 4) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'IQD',
  document_date date NOT NULL DEFAULT current_date,
  -- §5.2 — the department decides who approves it.
  department_code text NOT NULL REFERENCES department(code),
  -- §4.2 — a transaction belongs to exactly one branch.
  branch_code text NOT NULL REFERENCES branch(code),
  status document_status NOT NULL DEFAULT 'draft',
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_document_no_uniq UNIQUE (document_no),
  CONSTRAINT invoice_amount_positive CHECK (amount > 0),
  CONSTRAINT invoice_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_customer_present CHECK (length(btrim(customer_name)) > 0)
);--> statement-breakpoint

CREATE INDEX invoice_status_idx ON invoice (status, document_date DESC);--> statement-breakpoint
CREATE INDEX invoice_department_idx ON invoice (department_code);--> statement-breakpoint

-- §7 — a saved record is never deleted; it stays in the history.
CREATE OR REPLACE FUNCTION invoice_reject_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'An invoice is cancelled, never deleted (§7). Use the cancel action.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER invoice_no_delete
  BEFORE DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_reject_delete();--> statement-breakpoint

-- §4.1 — a person sees the invoices of the branches they hold scope for.
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY invoice_branch_scope ON invoice
  USING (app_is_super_user() OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR app_branch_allowed(branch_code));--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    -- No DELETE, deliberately.
    GRANT SELECT, INSERT, UPDATE ON invoice TO erp_app;
  END IF;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The document type, its status vocabulary and its approval route.
-- ---------------------------------------------------------------------------
INSERT INTO document_type (code, name, module, description) VALUES
  ('invoice', 'Invoice', 'finance',
   'Raised by an employee, approved by the manager of the department it was raised in (§5.2).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('invoice', 'draft',     'submitted'),
  ('invoice', 'draft',     'cancelled'),
  ('invoice', 'submitted', 'approved'),
  ('invoice', 'submitted', 'rejected'),
  ('invoice', 'submitted', 'draft'),      -- recalled by the raiser
  ('invoice', 'rejected',  'draft'),      -- corrected and resubmitted
  ('invoice', 'approved',  'cancelled');--> statement-breakpoint

-- §5.2 — the approver is the manager of the document's department, not a role.
INSERT INTO workflow_definition (id, document_type_code, version, is_active)
VALUES ('00000000-0000-4000-8000-000000000010', 'invoice', 1, true);--> statement-breakpoint

INSERT INTO workflow_step (definition_id, sequence, approver_kind, approver_role, allow_self_approval)
VALUES ('00000000-0000-4000-8000-000000000010', 1, 'department_manager', '', false);--> statement-breakpoint

-- §4.3 — every document takes a number from a series, and numbers are not reused.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('INVOICE', 'INV', '{PREFIX}-{YYYY}-{SERIAL}', 5, false, true);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Who may do what with it (§5.3).
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer',   'invoice', 'view'),
  ('accounting_officer',   'invoice', 'create'),
  ('accounting_officer',   'invoice', 'edit_draft'),
  ('accounting_officer',   'invoice', 'submit'),
  ('accounting_officer',   'invoice', 'print'),
  ('accounting_manager',   'invoice', 'view'),
  ('accounting_manager',   'invoice', 'create'),
  ('accounting_manager',   'invoice', 'edit_draft'),
  ('accounting_manager',   'invoice', 'submit'),
  ('accounting_manager',   'invoice', 'approve'),
  ('accounting_manager',   'invoice', 'reverse_cancel'),
  ('accounting_manager',   'invoice', 'export'),
  ('system_administrator', 'invoice', 'view'),
  ('system_administrator', 'invoice', 'approve'),
  ('system_administrator', 'invoice', 'administer')
ON CONFLICT DO NOTHING;
