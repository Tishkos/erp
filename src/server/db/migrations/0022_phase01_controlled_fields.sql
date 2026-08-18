CREATE TABLE "document_type_controlled_field" (
	"document_type_code" text NOT NULL,
	"field_name" text NOT NULL,
	"note" text,
	CONSTRAINT "document_type_controlled_field_document_type_code_field_name_pk" PRIMARY KEY("document_type_code","field_name")
);
--> statement-breakpoint
ALTER TABLE "document_type_controlled_field" ADD CONSTRAINT "document_type_controlled_field_document_type_code_document_type_code_fk" FOREIGN KEY ("document_type_code") REFERENCES "public"."document_type"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.7, §24.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  -- Configuration, changed by an administrator through the application under
  -- the `configure` verb — not by a module in passing.
  REVOKE ALL ON document_type_controlled_field FROM erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON document_type_controlled_field TO erp_app;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The initial configuration for the document types that exist so far.
--
-- The principle applied: a field is controlled when changing it would change
-- what the approver agreed to. The account an entry posts to, the amount, the
-- date that decides its period and the branch it belongs to are all of that
-- kind. A description is not — and being able to correct one without a recall
-- is what keeps recall meaningful.
--
-- This is a starting position, not a final one: §28.1 makes the list the
-- Business Process Owner's to set, and the Administration screen edits it.
-- ---------------------------------------------------------------------------
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('chart_of_account', 'account_type',
   'Decides the normal balance and the code. An approved account that changed type would misstate every balance derived from it.'),
  ('chart_of_account', 'parent_id',
   'Decides where the account sits in the hierarchy, and so which totals include it.'),
  ('chart_of_account', 'control_account',
   'Decides whether the account may be posted to manually (§14.3).'),
  ('chart_of_account', 'currency_restriction',
   'Decides which currencies may post to the account.'),

  ('journal_entry', 'posting_date',
   'Decides the accounting period. §14.6 — a posting date moved after approval can land in a closed period.'),
  ('journal_entry', 'document_date',
   'The business date the approver saw.'),
  ('journal_entry', 'branch_code',
   'A journal belongs to one branch (Appendix C, Manual Standard Journal).'),
  ('journal_entry', 'total_debit_iqd',
   'The amount approved.'),
  ('journal_entry', 'total_credit_iqd',
   'The amount approved.'),

  ('department_request', 'department_code',
   'Decides who approves it (§5.2).');
