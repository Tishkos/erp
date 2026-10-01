-- ===========================================================================
-- Payables — Stage 4, PD / ASYCUDA (REQ-AP-001 §16, §21.8).
-- HAND-AUTHORED. Everything additive.
--
--   pd_status                     the ASYCUDA statuses, exactly as the customs
--                                 system names them, each with the flags the
--                                 rules read (allows payment, terminal,
--                                 expired). New statuses are rows (R4).
--   customs_pd                    one row per registration. Several per import;
--                                 a rejected or expired PD is re-registered as
--                                 a new row that supersedes it, never edited.
--   customs_pd_status_history     append-only: every status a PD has had, when,
--                                 from where (user, ASYCUDA screenshot, ASYCUDA
--                                 list, the sweep) and why.
--   payment_application.pd_id     now a foreign key: the PD the bank paid
--                                 against (§15.3 check 1).
-- ===========================================================================

CREATE TABLE "pd_status" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	-- The ASYCUDA screen's own spelling, for matching a pasted list.
	"asycuda_label" text NOT NULL,
	"sequence" smallint NOT NULL,
	"allows_payment" boolean NOT NULL DEFAULT false,
	"is_terminal" boolean NOT NULL DEFAULT false,
	"is_expired" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
INSERT INTO "pd_status" ("code", "name", "asycuda_label", "sequence", "allows_payment", "is_terminal", "is_expired") VALUES
	('submitted',                'Submitted',                     'Submited',                      1, false, false, false),
	('pre_approved',             'Pre-approved',                  'PreApproved',                   2, false, false, false),
	('validated',                'Validated',                     'Validated',                     3, true,  false, false),
	('partially_written_off',    'Partially written off',         'Partially Written Off',         4, true,  false, false),
	('totally_written_off',      'Totally written off',           'Totally Written Off',           5, false, true,  false),
	('rejected',                 'Rejected',                      'Rejected',                      6, false, true,  false),
	('expired_validated',        'Expired (validated)',           'Expired Validated',             7, false, true,  true),
	('expired_part_written_off', 'Expired (partly written off)',  'Expired Partially Written Off', 8, false, true,  true);
--> statement-breakpoint

CREATE TABLE "customs_pd" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- The ASYCUDA number, as customs issued it (an external identifier, like
	-- the supplier's invoice number — typed, not minted).
	"pd_no" text NOT NULL,
	-- Unlinked rows come only from the sheet import (§24.3: the customs officer
	-- links them from the holding list); every PD registered here names its
	-- import.
	"payable_id" uuid REFERENCES "payable"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"registration_date" date NOT NULL,
	"registration_year" smallint GENERATED ALWAYS AS (extract(year from "registration_date")::smallint) STORED,
	-- Typed, not computed: the validity is the customs office's (§16.1).
	"expiry_date" date NOT NULL,
	"bank_code" text REFERENCES "bank"("code"),
	"bank_swift" text,
	"status_code" text NOT NULL DEFAULT 'submitted' REFERENCES "pd_status"("code"),
	"status_date" date NOT NULL,
	"supersedes_pd_id" uuid REFERENCES "customs_pd"("id"),
	"last_note" text,
	"source" text NOT NULL DEFAULT 'erp',
	"source_row" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "customs_pd_no_not_blank" CHECK (btrim("pd_no") <> ''),
	CONSTRAINT "customs_pd_validity_forward" CHECK ("expiry_date" >= "registration_date"),
	CONSTRAINT "customs_pd_not_self_superseding" CHECK ("supersedes_pd_id" IS NULL OR "supersedes_pd_id" <> "id")
);
--> statement-breakpoint
-- §16.1 — unique per registration year.
CREATE UNIQUE INDEX "customs_pd_no_year_uniq" ON "customs_pd" ("pd_no", "registration_year");
--> statement-breakpoint
CREATE INDEX "customs_pd_payable_idx" ON "customs_pd" ("payable_id");
--> statement-breakpoint
CREATE INDEX "customs_pd_expiry_idx" ON "customs_pd" ("expiry_date");
--> statement-breakpoint
-- A PD is superseded once: the re-registration names it, and only one does.
CREATE UNIQUE INDEX "customs_pd_supersedes_uniq" ON "customs_pd" ("supersedes_pd_id")
	WHERE "supersedes_pd_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "customs_pd_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"pd_id" uuid NOT NULL REFERENCES "customs_pd"("id"),
	"status_code" text NOT NULL REFERENCES "pd_status"("code"),
	"effective_date" date NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"attachment_id" uuid,
	"recorded_by" uuid REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT "customs_pd_status_history_source" CHECK (
		"source" IN ('user', 'asycuda_screenshot', 'asycuda_list', 'sweep', 'sheet_import')
	)
);
--> statement-breakpoint
CREATE INDEX "customs_pd_status_history_pd_idx" ON "customs_pd_status_history" ("pd_id", "recorded_at");
--> statement-breakpoint
CREATE TRIGGER "customs_pd_status_history_append_only"
	BEFORE UPDATE OR DELETE ON "customs_pd_status_history"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- §15.3 — the PD the bank paid against.
ALTER TABLE "payment_application"
	ADD CONSTRAINT "payment_application_pd_fk" FOREIGN KEY ("pd_id") REFERENCES "customs_pd"("id");
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PD_NOTE', 'pd', 'PD note')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- §19.3 — an expired PD that is not settled stops the import until it is
-- re-registered. Limit 0: the day after expiry (D4 examples, editable).
INSERT INTO sweep_check (code, name, lane_code) VALUES
	('pd_expired', 'PD expired and not settled', 'pd')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO stage_time_limit (check_code, scope, limit_days, valid_from)
	SELECT 'pd_expired', 'all', 0, DATE '2026-01-01'
	 WHERE NOT EXISTS (SELECT 1 FROM stage_time_limit WHERE check_code = 'pd_expired');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Branch scope.
-- ---------------------------------------------------------------------------
ALTER TABLE customs_pd ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customs_pd FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customs_pd_branch_scope ON customs_pd
	USING (app_branch_allowed(branch_code))
	WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE customs_pd_status_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customs_pd_status_history FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customs_pd_status_history_branch_scope ON customs_pd_status_history
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM customs_pd d
		            WHERE d.id = customs_pd_status_history.pd_id
		              AND app_branch_allowed(d.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM customs_pd d
		            WHERE d.id = customs_pd_status_history.pd_id
		              AND app_branch_allowed(d.branch_code))
	);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions — D1: the customs officer keeps the PDs current; the accounting
-- officer holds the role's grants until users are assigned.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
	('customs_officer',    'customs_pd', 'view'),
	('customs_officer',    'customs_pd', 'create'),
	('customs_officer',    'customs_pd', 'edit_draft'),
	('accounting_officer', 'customs_pd', 'view'),
	('accounting_officer', 'customs_pd', 'create'),
	('accounting_officer', 'customs_pd', 'edit_draft'),
	('accounting_manager', 'customs_pd', 'view'),
	('accounting_manager', 'customs_pd', 'create'),
	('accounting_manager', 'customs_pd', 'edit_draft'),
	('accounting_manager', 'customs_pd', 'import'),
	('accounting_manager', 'customs_pd', 'export'),
	('accounting_officer', 'customs_pd', 'import'),
	('customs_officer',    'customs_pd', 'import'),
	('logistics_officer',  'customs_pd', 'view'),
	('ceo',                'customs_pd', 'view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON pd_status                 TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON customs_pd                TO erp_app;
	GRANT SELECT, INSERT         ON customs_pd_status_history TO erp_app;
END $$;
