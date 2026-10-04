-- ===========================================================================
-- REQ-LOG-001 item 8 — the customs declaration (Q1, decided by default).
-- HAND-AUTHORED. Everything additive.
--
-- The PD pre-declares; the declaration is what the broker lodged for the
-- goods: its number, the import and the PD it clears against, and what was
-- *declared* — value, duty, taxes, fees, HS code. Those figures are the
-- declaration's words only. The money is where it always was: the customs
-- broker's invoice line charged to the import → `landed_cost_charge` → the
-- landed cost. The screen shows declared beside charged; nothing here posts.
--
-- Draft → Submitted → Accepted → Assessed → Cleared, or Cancelled / Rejected
-- on the way; forward only (`services/customs-declarations.ts`,
-- `domain/import-logistics.ts`). The figures are frozen once it leaves draft.
-- Every move is an audit row and a payable_event on the import.
-- ===========================================================================

CREATE TABLE "customs_declaration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- Our number, minted: CDN-{BRANCH}-{YYYY}-{SERIAL}.
	"declaration_no" text NOT NULL,
	-- The customs office's own number, once it gives one (typed, like a PD's).
	"customs_ref" text,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"pd_id" uuid REFERENCES "customs_pd"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"declaration_date" date NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"status_date" date NOT NULL,
	"hs_code" text,
	"currency" char(3) NOT NULL DEFAULT 'IQD',
	"declared_value" numeric(19, 4) NOT NULL DEFAULT 0,
	"declared_duty" numeric(19, 4) NOT NULL DEFAULT 0,
	"declared_taxes" numeric(19, 4) NOT NULL DEFAULT 0,
	"declared_fees" numeric(19, 4) NOT NULL DEFAULT 0,
	"note" text,
	"reason" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "customs_declaration_status_known" CHECK (
		"status" IN ('draft', 'submitted', 'accepted', 'assessed', 'cleared', 'cancelled', 'rejected')
	),
	CONSTRAINT "customs_declaration_figures_not_negative" CHECK (
		"declared_value" >= 0 AND "declared_duty" >= 0 AND "declared_taxes" >= 0 AND "declared_fees" >= 0
	),
	CONSTRAINT "customs_declaration_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	-- A declaration that ends badly says why.
	CONSTRAINT "customs_declaration_end_has_reason" CHECK (
		"status" NOT IN ('cancelled', 'rejected') OR coalesce(btrim("reason"), '') <> ''
	),
	-- Customs gives its number when it accepts the lodgement.
	CONSTRAINT "customs_declaration_accepted_has_ref" CHECK (
		"status" NOT IN ('accepted', 'assessed', 'cleared') OR coalesce(btrim("customs_ref"), '') <> ''
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customs_declaration_no_uniq" ON "customs_declaration" ("declaration_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "customs_declaration_ref_uniq" ON "customs_declaration" ("customs_ref")
	WHERE "customs_ref" IS NOT NULL AND "status" NOT IN ('cancelled', 'rejected');
--> statement-breakpoint
CREATE INDEX "customs_declaration_payable_idx" ON "customs_declaration" ("payable_id");
--> statement-breakpoint
CREATE INDEX "customs_declaration_pd_idx" ON "customs_declaration" ("pd_id");
--> statement-breakpoint

-- The declared figures are what was lodged: changed only while it is a draft.
CREATE FUNCTION customs_declaration_frozen() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'draft' AND (
		NEW.declared_value IS DISTINCT FROM OLD.declared_value
		OR NEW.declared_duty IS DISTINCT FROM OLD.declared_duty
		OR NEW.declared_taxes IS DISTINCT FROM OLD.declared_taxes
		OR NEW.declared_fees IS DISTINCT FROM OLD.declared_fees
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.hs_code IS DISTINCT FROM OLD.hs_code
		OR NEW.payable_id IS DISTINCT FROM OLD.payable_id
		OR NEW.pd_id IS DISTINCT FROM OLD.pd_id
		OR NEW.declaration_no IS DISTINCT FROM OLD.declaration_no
	) THEN
		RAISE EXCEPTION 'customs declaration % is %; what it declared is the record', OLD.declaration_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status IN ('cleared', 'cancelled', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
		RAISE EXCEPTION 'customs declaration % is %; it does not move again', OLD.declaration_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "customs_declaration_frozen"
	BEFORE UPDATE ON "customs_declaration"
	FOR EACH ROW EXECUTE FUNCTION customs_declaration_frozen();
--> statement-breakpoint
-- Never deleted: a mistaken one is cancelled with its reason.
CREATE TRIGGER "customs_declaration_no_delete"
	BEFORE DELETE ON "customs_declaration"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('CUSTOMS_DECLARATION', 'CDN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('DECLARATION_RAISED',  'pd', 'Customs declaration raised'),
	('DECLARATION_MOVED',   'pd', 'Customs declaration status changed'),
	('DECLARATION_CLEARED', 'pd', 'Customs declaration cleared')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE customs_declaration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customs_declaration FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customs_declaration_branch_scope ON customs_declaration
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON customs_declaration TO erp_app;
--> statement-breakpoint

-- Whoever keeps the PDs keeps the declarations; the reader reads them; the
-- manager cancels; whoever prints a PD prints a declaration.
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customs_declaration', g.verb
  FROM role_grant g
 WHERE g.object = 'customs_pd' AND g.verb IN ('view', 'create', 'edit_draft', 'print', 'export')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customs_declaration', 'submit'::permission_verb
  FROM role_grant g
 WHERE g.object = 'customs_pd' AND g.verb = 'edit_draft'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customs_declaration', 'reverse_cancel'::permission_verb
  FROM role_grant g
 WHERE g.object = 'customs_pd' AND g.verb = 'import'
ON CONFLICT DO NOTHING;
