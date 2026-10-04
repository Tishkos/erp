-- Recurring Journals — REQ-ACC-001 Part D-7 (2026-10-04).
--
-- "Create repeatable accounting entries such as rent, depreciation,
-- subscriptions, accruals … Recurring journals must eventually create normal
-- GL journal entries through the existing journal engine. Do not create a
-- second posting mechanism."
--
-- So a recurring journal is a template and nothing more: its lines (account,
-- side, amount, department, note), how often it falls due, from when and until
-- when, and the date it is next due. Raising it is `journal.createDraft` +
-- `journal.addLine` — the ordinary draft journal, numbered from the ordinary
-- series, submitted, approved and posted by the ordinary people under the
-- ordinary period locks. The template never posts.
--
-- ── What the database holds ────────────────────────────────────────────────
--   * A template moves draft → active → (paused ↔ active) → ended. It is
--     activated by somebody other than whoever wrote it (four eyes, the
--     Super User excepted as everywhere since 0278); ended with a reason;
--     never deleted.
--   * Its lines change only while it is a draft: an active template is a
--     standing instruction somebody agreed to, and changing what it raises
--     after the agreement is a new template.
--   * A run is one row per template and due date: the same month cannot be
--     raised twice, whoever presses the button and however often. The run
--     names the journal it raised, so the template lists its journals and a
--     journal names its template.
--   * Row security by branch, as journals have.

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('RECURRING_JOURNAL', 'RJ', '{PREFIX}-{SERIAL}', 5, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('recurring_journal', 'Recurring Journal', 'finance',
	 'A template that raises the same draft journal on a schedule — rent, depreciation, subscriptions, accruals. It never posts; each journal it raises is approved and posted as any other (REQ-ACC-001).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

CREATE TABLE "recurring_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_no" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"frequency" text NOT NULL,
	"interval_count" smallint DEFAULT 1 NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"next_due_on" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" uuid REFERENCES "app_user"("id"),
	"activated_at" timestamp with time zone,
	"ended_by" uuid REFERENCES "app_user"("id"),
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "recurring_journal_frequency" CHECK ("frequency" IN ('monthly', 'quarterly', 'yearly')),
	CONSTRAINT "recurring_journal_interval" CHECK ("interval_count" BETWEEN 1 AND 12),
	CONSTRAINT "recurring_journal_status" CHECK ("status" IN ('draft', 'active', 'paused', 'ended')),
	CONSTRAINT "recurring_journal_dates" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
	CONSTRAINT "recurring_journal_name" CHECK (btrim("name") <> ''),
	-- Four eyes: activated by somebody other than whoever wrote it, unless that
	-- person is a Super User (0278's `app_user_is_super`).
	CONSTRAINT "recurring_journal_activator_not_creator" CHECK (
		"activated_by" IS NULL OR "activated_by" <> "created_by" OR app_user_is_super("activated_by")),
	CONSTRAINT "recurring_journal_activation_complete" CHECK (("activated_by" IS NULL) = ("activated_at" IS NULL)),
	CONSTRAINT "recurring_journal_active_was_activated" CHECK ("status" = 'draft' OR "status" = 'ended' OR "activated_at" IS NOT NULL),
	CONSTRAINT "recurring_journal_end_has_reason" CHECK (
		("status" <> 'ended') = ("ended_at" IS NULL)
		AND ("status" <> 'ended' OR (coalesce(btrim("end_reason"), '') <> '' AND "ended_by" IS NOT NULL)))
);--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journal_no_uniq" ON "recurring_journal" ("template_no");--> statement-breakpoint
CREATE INDEX "recurring_journal_due_idx" ON "recurring_journal" ("status", "next_due_on");--> statement-breakpoint

CREATE TABLE "recurring_journal_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_journal_id" uuid NOT NULL REFERENCES "recurring_journal"("id") ON DELETE CASCADE,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "chart_of_account"("id"),
	"debit" numeric(19, 4) DEFAULT 0 NOT NULL,
	"credit" numeric(19, 4) DEFAULT 0 NOT NULL,
	"department_code" text REFERENCES "department"("code"),
	"description" text,
	CONSTRAINT "recurring_journal_line_one_side" CHECK (
		("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journal_line_no_uniq" ON "recurring_journal_line" ("recurring_journal_id", "line_no");--> statement-breakpoint

-- Lines change only while the template is a draft.
CREATE FUNCTION recurring_journal_line_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_status text;
BEGIN
	SELECT status INTO v_status FROM recurring_journal
	 WHERE id = COALESCE(NEW.recurring_journal_id, OLD.recurring_journal_id);
	IF v_status IS DISTINCT FROM 'draft' THEN
		RAISE EXCEPTION
			'A recurring journal''s lines change only while it is a draft; this one is %. End it and write a new one (REQ-ACC-001).',
			v_status
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint
CREATE TRIGGER "recurring_journal_line_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "recurring_journal_line"
	FOR EACH ROW EXECUTE FUNCTION recurring_journal_line_frozen();--> statement-breakpoint

-- A template is ended, never deleted: the journals it raised name it.
CREATE TRIGGER "recurring_journal_no_delete"
	BEFORE DELETE ON "recurring_journal"
	FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

CREATE TABLE "recurring_journal_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_journal_id" uuid NOT NULL REFERENCES "recurring_journal"("id"),
	"due_on" date NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"raised_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- One journal per template and due date, whoever presses and however often.
CREATE UNIQUE INDEX "recurring_journal_run_due_uniq" ON "recurring_journal_run" ("recurring_journal_id", "due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journal_run_journal_uniq" ON "recurring_journal_run" ("journal_entry_id");--> statement-breakpoint
CREATE TRIGGER "recurring_journal_run_append_only"
	BEFORE UPDATE OR DELETE ON "recurring_journal_run"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Row security by branch, as journals have.
ALTER TABLE "recurring_journal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_journal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_journal_branch_scope" ON "recurring_journal"
	USING (app_is_super_user() OR app_branch_allowed("branch_code"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code"));--> statement-breakpoint
ALTER TABLE "recurring_journal_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_journal_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_journal_line_branch_scope" ON "recurring_journal_line"
	USING (EXISTS (SELECT 1 FROM recurring_journal h WHERE h.id = recurring_journal_line.recurring_journal_id
	                AND (app_is_super_user() OR app_branch_allowed(h.branch_code))))
	WITH CHECK (EXISTS (SELECT 1 FROM recurring_journal h WHERE h.id = recurring_journal_line.recurring_journal_id
	                     AND (app_is_super_user() OR app_branch_allowed(h.branch_code))));--> statement-breakpoint
ALTER TABLE "recurring_journal_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_journal_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recurring_journal_run_branch_scope" ON "recurring_journal_run"
	USING (EXISTS (SELECT 1 FROM recurring_journal h WHERE h.id = recurring_journal_run.recurring_journal_id
	                AND (app_is_super_user() OR app_branch_allowed(h.branch_code))))
	WITH CHECK (EXISTS (SELECT 1 FROM recurring_journal h WHERE h.id = recurring_journal_run.recurring_journal_id
	                     AND (app_is_super_user() OR app_branch_allowed(h.branch_code))));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE         ON recurring_journal      TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_journal_line TO erp_app;
	GRANT SELECT, INSERT                 ON recurring_journal_run  TO erp_app;
END;
$$;
