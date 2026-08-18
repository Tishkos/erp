CREATE TABLE "logistics_client_import_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_no" text NOT NULL,
	"client_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"opened_on" date NOT NULL,
	"origin_country" text,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_on" date,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_client_import_file_status" CHECK ("logistics_client_import_file"."status" in ('open', 'closed')),
	CONSTRAINT "logistics_client_import_file_closed_has_date" CHECK (("logistics_client_import_file"."status" <> 'closed' and "logistics_client_import_file"."closed_on" is null)
          or ("logistics_client_import_file"."status" = 'closed' and "logistics_client_import_file"."closed_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "logistics_client_import_file_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_file_id" uuid NOT NULL,
	"module" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_no" text NOT NULL,
	"note" text,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_client_import_file_reference_module" CHECK (btrim("logistics_client_import_file_reference"."module") <> '')
);
--> statement-breakpoint
ALTER TABLE "logistics_client_import_file" ADD CONSTRAINT "logistics_client_import_file_client_id_business_partner_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_import_file" ADD CONSTRAINT "logistics_client_import_file_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_import_file" ADD CONSTRAINT "logistics_client_import_file_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_import_file_reference" ADD CONSTRAINT "logistics_client_import_file_reference_import_file_id_client_import_file_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "public"."logistics_client_import_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_import_file_reference" ADD CONSTRAINT "logistics_client_import_file_reference_linked_by_app_user_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_client_import_file_no_uniq" ON "logistics_client_import_file" USING btree ("file_no");--> statement-breakpoint
CREATE INDEX "logistics_client_import_file_client_idx" ON "logistics_client_import_file" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "logistics_client_import_file_branch_idx" ON "logistics_client_import_file" USING btree ("branch_code","opened_on");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_client_import_file_reference_document_uniq" ON "logistics_client_import_file_reference" USING btree ("module","document_id");--> statement-breakpoint
CREATE INDEX "logistics_client_import_file_reference_file_idx" ON "logistics_client_import_file_reference" USING btree ("import_file_id","module");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.1 — the client import file, §11.
--
-- §11: "A logistics job can be linked to the same client import file as a Money
-- Transfer transaction without combining their accounting results." §2.2, §11.3
-- and §12.4 repeat it. A rule stated four times is one somebody expects to be
-- broken, so it is not written as a rule here at all.
--
-- logistics_client_import_file_reference has no amount, no currency, no debit, no credit
-- and no margin column. There is nothing on it to add up, so no report — however
-- it is written, by whoever writes it — can net a logistics job against a money
-- transfer through this table. The cross-reference report (§11.5) reads each
-- service's figures from that service's own tables and prints them side by side
-- because that is the only thing it *can* do.
--
-- Rejected alternative: a `combined_total_iqd` column on the file, kept in step
-- by a trigger. It would have made the §11.5 report a single SELECT. It was
-- rejected precisely because it would have made the forbidden number easy to
-- reach — the first person asked for "the total for this import" would have
-- found it sitting there, already computed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The client on an import file is a customer.
--
-- §6 gives a Business Partner two roles and the file belongs to the party being
-- served, not to a haulier being paid. Without this, a mistyped id would attach
-- an import to a supplier and the Client Balances report (§11.5) would show a
-- balance for a party that has no client account.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_import_file_client_is_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_customer boolean;
  v_code        text;
BEGIN
  SELECT is_customer, code INTO v_is_customer, v_code
    FROM business_partner WHERE id = NEW.client_id;

  IF NOT coalesce(v_is_customer, false) THEN
    RAISE EXCEPTION
      'Business partner % is not a customer, so it cannot be the client on import file % (blueprint 6). Give the partner the customer role first.',
      coalesce(v_code, NEW.client_id::text), NEW.file_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_import_file_client_is_customer
  BEFORE INSERT OR UPDATE OF client_id ON logistics_client_import_file
  FOR EACH ROW EXECUTE FUNCTION logistics_client_import_file_client_is_customer();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A cross-reference is created or removed. It is never edited.
--
-- Repointing a link would silently move a document from one import file to
-- another, and every report that had already been run against the old file
-- would be unreproducible. Unlinking is a decision somebody makes and the audit
-- trail records; mutating a row in place is not.
--
-- Two layers, as everywhere else: erp_app is granted no UPDATE (below), and this
-- trigger stops the owner and any future migration that forgets.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_import_file_reference_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A client import file cross-reference is created or removed, never edited (blueprint 11). Unlink document % and link it again.',
    OLD.document_no
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_import_file_reference_no_update
  BEFORE UPDATE ON logistics_client_import_file_reference
  FOR EACH ROW EXECUTE FUNCTION logistics_client_import_file_reference_no_update();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A closed file accepts no new references, and an open document keeps it open.
--
-- The second half — "which documents are still open?" — cannot be asked here:
-- it would need this migration to know every module's status column, including
-- Phase 09's, which does not exist yet. Each module answers for its own
-- documents; migration 0146 adds the logistics half once logistics_job exists.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_import_file_reference_file_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_no     text;
BEGIN
  SELECT status, file_no INTO v_status, v_no
    FROM logistics_client_import_file WHERE id = NEW.import_file_id;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION
      'Client import file % is closed; nothing further can be linked to it (blueprint 11). Reopen the file, or link the document to the file it belongs to.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_import_file_reference_file_is_open
  BEFORE INSERT ON logistics_client_import_file_reference
  FOR EACH ROW EXECUTE FUNCTION logistics_client_import_file_reference_file_is_open();--> statement-breakpoint

-- Numbering, document type and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_CLIENT_IMPORT_FILE', 'CIF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

-- Registered as a document type for the menu tree (Appendix A, menu 7) and for
-- §22's reporting, but given no status transitions: it carries no
-- document_status column because it has no accounting effect and Appendix B does
-- not list it. A type with no transitions is a type nothing can post.
INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_client_import_file', 'Client Import File', 'logistics',
   'The client consignment a logistics job and a money transfer may both reference. Holds no amounts: section 11 keeps the two services'' accounting apart.');--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_client_import_file', 'view'),
  ('accounting_officer', 'logistics_client_import_file', 'create'),
  ('accounting_officer', 'logistics_client_import_file', 'edit_draft'),
  ('accounting_officer', 'logistics_client_import_file', 'print'),
  ('accounting_manager', 'logistics_client_import_file', 'view'),
  ('accounting_manager', 'logistics_client_import_file', 'create'),
  ('accounting_manager', 'logistics_client_import_file', 'edit_draft'),
  ('accounting_manager', 'logistics_client_import_file', 'approve'),
  ('accounting_manager', 'logistics_client_import_file', 'configure'),
  ('accounting_manager', 'logistics_client_import_file', 'print'),
  ('accounting_manager', 'logistics_client_import_file', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_client_import_file, logistics_client_import_file_reference FROM erp_app;

  -- §1.1 keeps saved records: no DELETE on the file itself.
  GRANT SELECT, INSERT, UPDATE ON logistics_client_import_file TO erp_app;

  -- The reference is the exception, and deliberately so. A link is a statement
  -- that two documents concern the same shipment; when that turns out to be
  -- wrong the statement is withdrawn, not amended. Hence DELETE but no UPDATE.
  GRANT SELECT, INSERT, DELETE ON logistics_client_import_file_reference TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_client_import_file ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_client_import_file FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_client_import_file_branch_scope ON logistics_client_import_file
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

ALTER TABLE logistics_client_import_file_reference ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_client_import_file_reference FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- The reference carries no branch of its own — it belongs to the file's branch,
-- and denormalising it would create a second answer that could drift from the
-- first. §22 still requires the row to be out of scope for a user who cannot see
-- the file, so the policy reaches through the parent.
CREATE POLICY logistics_client_import_file_reference_branch_scope ON logistics_client_import_file_reference
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_client_import_file f
       WHERE f.id = logistics_client_import_file_reference.import_file_id
         AND f.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_client_import_file f
       WHERE f.id = logistics_client_import_file_reference.import_file_id
         AND f.branch_code = app_current_branch()
    )
  );
