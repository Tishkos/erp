-- The advance, end to end (2026-10-06, by direction).
--
--   1. A payment application is sent for approval before it is approved:
--      Draft → Submitted (Send for approval) → Approved by somebody else.
--      ("once they fill the form they draft, send for approval, approved")
--   2. Whoever may raise one may send it for approval: `submit` beside `create`.
--   3. What each paper on an application is — "it has to be pointed out what
--      this attachment is": sent to the bank, rejected / cancelled, paid, or
--      other. The paper moves the application; this table remembers which
--      paper did it. Append-only.
--   4. The import's log names the new moments.

ALTER TABLE "payment_application" DROP CONSTRAINT "payment_application_status";
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_status" CHECK (
	"status" IN ('draft', 'submitted', 'approved', 'sent', 'confirmed', 'debited', 'rejected', 'cancelled')
);
--> statement-breakpoint

DELETE FROM "payment_application_transition" WHERE "from_status" = 'draft' AND "to_status" = 'approved';
--> statement-breakpoint
INSERT INTO "payment_application_transition" ("from_status", "to_status") VALUES
	('draft',     'submitted'),
	('submitted', 'approved'),
	('submitted', 'rejected'),
	('submitted', 'cancelled')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT g.role_code, 'payment_application', 'submit'::permission_verb
  FROM role_grant g
 WHERE g.object = 'payment_application' AND g.verb = 'create'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

CREATE TABLE "payment_application_paper" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_application_id" uuid NOT NULL REFERENCES "payment_application" ("id"),
	"attachment_id" uuid NOT NULL REFERENCES "attachment" ("id"),
	"kind" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user" ("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "payment_application_paper_kind" CHECK ("kind" IN ('sent_to_bank', 'rejected_cancelled', 'paid', 'other')),
	CONSTRAINT "payment_application_paper_attachment_uniq" UNIQUE ("attachment_id")
);
--> statement-breakpoint
CREATE INDEX "payment_application_paper_application_idx" ON "payment_application_paper" ("payment_application_id");
--> statement-breakpoint
CREATE TRIGGER "payment_application_paper_append_only"
	BEFORE UPDATE OR DELETE ON "payment_application_paper"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
ALTER TABLE payment_application_paper ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_application_paper FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_application_paper_branch_scope ON payment_application_paper
	USING (EXISTS (SELECT 1 FROM payment_application a
	        WHERE a.id = payment_application_paper.payment_application_id AND app_branch_allowed(a.branch_code)))
	WITH CHECK (EXISTS (SELECT 1 FROM payment_application a
	        WHERE a.id = payment_application_paper.payment_application_id AND app_branch_allowed(a.branch_code)));
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		GRANT SELECT, INSERT ON payment_application_paper TO erp_app;
	END IF;
END $$;
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PAYMENT_SUBMITTED', 'payment', 'Payment application sent for approval'),
	('PAPER_ADDED',       'payment', 'Payment paper added'),
	('ADVANCE_HELD',      'payment', 'Goods held until the advance is paid'),
	('ADVANCE_RELEASED',  'payment', 'Advance paid — goods moved to In Process')
ON CONFLICT (code) DO NOTHING;
