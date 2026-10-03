-- The database learns what the services were told on 2026-10-03.
--
-- By direction that day: "super user like qs@qs-groups.com has all approval
-- please no need second person". Twenty-two four-eyes checks in the services
-- gained `&& !ctx.principal.isSuperUser`, and the screens were brought into
-- line on 2026-10-04. The CHECK constraints were not, so the owner reached
-- the last gate and was refused by the database:
--
--   new row for relation "bank_loan" violates check constraint
--   "bank_loan_maker_checker"
--
-- A control that disagrees with the application it guards is worse than no
-- control: it refuses the right person at the last step, with a message about a
-- constraint rather than about the decision.
--
-- ── What this changes, stated plainly ───────────────────────────────────
-- A super user may now approve what they raised, in the database as well as in
-- the application. No control stands between that one account and the books.
-- That is the owner's decision for their own company, and it is why the flag
-- belongs to one account. Everybody else is unaffected: every constraint below
-- still refuses an ordinary user approving their own work, and the services
-- still refuse them first.
--
-- The audit trail is untouched, and is now the only record of who did both
-- halves — which makes it the thing to read rather than a formality.
--
-- ── How ─────────────────────────────────────────────────────────────────
-- One function, asked of the approver's own id. `SECURITY DEFINER` because the
-- row policy on `app_user` is not the question here — whether that account
-- carries the flag is. `STABLE` rather than `IMMUTABLE` on purpose: it reads a
-- table, and a CHECK re-reads it only when the row is written, which is exactly
-- the moment the question is asked.

CREATE OR REPLACE FUNCTION app_user_is_super(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT coalesce((SELECT is_super_user FROM app_user WHERE id = p_user), false);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_is_super(uuid) TO "erp_app";
--> statement-breakpoint

-- C-10 — a bank loan.
ALTER TABLE "bank_loan" DROP CONSTRAINT IF EXISTS "bank_loan_maker_checker";
--> statement-breakpoint
ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_maker_checker"
	CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by"));
--> statement-breakpoint

-- C-12 — a project budget document.
ALTER TABLE "project_budget_document" DROP CONSTRAINT IF EXISTS "project_budget_document_four_eyes";
--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_four_eyes"
	CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by"));
--> statement-breakpoint

-- A change order is agreed twice, by two people who are not its raiser.
ALTER TABLE "project_variation" DROP CONSTRAINT IF EXISTS "project_variation_four_eyes";
--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_four_eyes"
	CHECK (
		("commercial_approved_by" IS NULL OR "commercial_approved_by" <> "created_by"
			OR app_user_is_super("commercial_approved_by"))
		AND ("budget_approved_by" IS NULL OR "budget_approved_by" <> "created_by"
			OR app_user_is_super("budget_approved_by"))
	);
--> statement-breakpoint

-- C-13 — a project certificate.
ALTER TABLE "project_certificate" DROP CONSTRAINT IF EXISTS "project_certificate_four_eyes";
--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_four_eyes"
	CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by"));
--> statement-breakpoint

-- C-17 — a project settlement is posted by somebody other than its drafter.
ALTER TABLE "project_settlement" DROP CONSTRAINT IF EXISTS "project_settlement_four_eyes";
--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_four_eyes"
	CHECK ("posted_by" IS NULL OR "posted_by" <> "created_by" OR app_user_is_super("posted_by"));
--> statement-breakpoint

-- C-18 — hours on a project.
ALTER TABLE "project_timesheet" DROP CONSTRAINT IF EXISTS "project_timesheet_four_eyes";
--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_four_eyes"
	CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by"));
--> statement-breakpoint

-- C-21 — a leave request.
ALTER TABLE "leave_request" DROP CONSTRAINT IF EXISTS "leave_request_decider_not_requester";
--> statement-breakpoint
ALTER TABLE "leave_request" ADD CONSTRAINT "leave_request_decider_not_requester"
	CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by" OR app_user_is_super("decided_by"));
--> statement-breakpoint

-- C-24 — a payroll run is never approved by whoever prepared or sent it.
ALTER TABLE "payroll_run" DROP CONSTRAINT IF EXISTS "payroll_run_approver_not_preparer";
--> statement-breakpoint
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_approver_not_preparer"
	CHECK (
		"approved_by" IS NULL
		OR app_user_is_super("approved_by")
		OR ("approved_by" <> "created_by" AND "approved_by" IS DISTINCT FROM "submitted_by")
	);
--> statement-breakpoint

-- C-29 — an employee advance.
ALTER TABLE "employee_advance" DROP CONSTRAINT IF EXISTS "employee_advance_endorser_not_requester";
--> statement-breakpoint
ALTER TABLE "employee_advance" ADD CONSTRAINT "employee_advance_endorser_not_requester"
	CHECK ("endorsed_by" IS NULL OR "endorsed_by" <> "requested_by" OR app_user_is_super("endorsed_by"));
--> statement-breakpoint
ALTER TABLE "employee_advance" DROP CONSTRAINT IF EXISTS "employee_advance_approver_not_requester";
--> statement-breakpoint
ALTER TABLE "employee_advance" ADD CONSTRAINT "employee_advance_approver_not_requester"
	CHECK (
		"approved_by" IS NULL
		OR app_user_is_super("approved_by")
		OR ("approved_by" <> "requested_by" AND "approved_by" <> "endorsed_by")
	);
--> statement-breakpoint

-- C-36 — an employee request.
ALTER TABLE "employee_request" DROP CONSTRAINT IF EXISTS "employee_request_decider_not_requester";
--> statement-breakpoint
ALTER TABLE "employee_request" ADD CONSTRAINT "employee_request_decider_not_requester"
	CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by" OR app_user_is_super("decided_by"));
--> statement-breakpoint

-- C-09 — a high-risk payment batch. The shape is its own: the maker may not
-- approve it, may not execute it, and one person may not do both halves.
ALTER TABLE "payment_batch" DROP CONSTRAINT IF EXISTS "payment_batch_maker_checker";
--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_maker_checker"
	CHECK (
		NOT "high_risk"
		OR app_user_is_super(coalesce("approved_by", "executed_by"))
		OR (
			("approved_by" IS NULL OR "approved_by" <> "created_by")
			AND ("executed_by" IS NULL OR "executed_by" <> "created_by")
			AND ("executed_by" IS NULL OR "approved_by" IS NULL OR "executed_by" <> "approved_by")
		)
	);
