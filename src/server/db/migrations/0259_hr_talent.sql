-- REQ-HR-001 Stage HR-5 — recruitment and performance (§11a).
--
--   vacancy                  VAC-{BRANCH}-{YYYY}-{SERIAL}: a seat to fill — a
--                            position, how many, from when. draft → open →
--                            filled (as many hired as wanted) or closed (a
--                            reason); cancelled with a reason before it opens.
--   applicant                APL-{BRANCH}-{YYYY}-{SERIAL}: a person who applied
--                            for a vacancy, moved through the stages applied →
--                            screening → interview → offer → hired; rejected or
--                            withdrawn with a note. Hired, they are an employee
--                            made through `employees.create` (one record per
--                            person, R1) in the same transaction.
--   applicant_stage          every move of an applicant, append-only.
--   review_cycle             a period people are reviewed for — master data on
--                            HR Settings; draft → open → closed.
--   performance_review       REV-{BRANCH}-{YYYY}-{SERIAL}: one person, one cycle,
--                            their reviewer (the manager by the employee
--                            record's link). draft (goals set, then rated) →
--                            rated (the weights make 100, every goal rated, the
--                            overall computed, R2) → signed off by an HR manager
--                            who is neither the reviewer nor the person; or
--                            cancelled with a reason. The person reads it and
--                            may add their word once.
--   review_goal              a review's goals: a weight (the weights make 100),
--                            a target, the rating 1–5 and the comment — changed
--                            only while the review is a draft (trigger).

CREATE TABLE "vacancy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vacancy_no" text NOT NULL,
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"position_code" text NOT NULL REFERENCES "position"("code"),
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"headcount" smallint NOT NULL DEFAULT 1,
	"hired" smallint NOT NULL DEFAULT 0,
	"employment_kind" text NOT NULL DEFAULT 'permanent',
	"opens_on" date NOT NULL,
	"closes_on" date,
	"description" text NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"opened_by" uuid REFERENCES "app_user"("id"),
	"opened_at" timestamptz,
	"closed_by" uuid REFERENCES "app_user"("id"),
	"closed_at" timestamptz,
	"close_reason" text,
	CONSTRAINT "vacancy_status" CHECK ("status" IN ('draft', 'open', 'filled', 'closed', 'cancelled')),
	CONSTRAINT "vacancy_headcount" CHECK ("headcount" BETWEEN 1 AND 500 AND "hired" >= 0 AND "hired" <= "headcount"),
	CONSTRAINT "vacancy_kind" CHECK ("employment_kind" IN ('permanent', 'contract', 'daily')),
	CONSTRAINT "vacancy_dates" CHECK ("closes_on" IS NULL OR "closes_on" >= "opens_on"),
	CONSTRAINT "vacancy_filled" CHECK (("status" = 'filled') = ("hired" = "headcount")),
	CONSTRAINT "vacancy_close_reason" CHECK ("status" NOT IN ('closed', 'cancelled') OR nullif(btrim("close_reason"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "vacancy_no_uniq" ON "vacancy" ("vacancy_no");--> statement-breakpoint
CREATE INDEX "vacancy_status_idx" ON "vacancy" ("status", "branch_code");--> statement-breakpoint

CREATE TABLE "applicant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_no" text NOT NULL,
	"vacancy_id" uuid NOT NULL REFERENCES "vacancy"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"full_name_en" text NOT NULL,
	"full_name_ar" text,
	"phone" text,
	"email" text,
	"source" text,
	"stage" text NOT NULL DEFAULT 'applied',
	"note" text,
	"employee_id" uuid REFERENCES "employee"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "applicant_stage" CHECK ("stage" IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
	CONSTRAINT "applicant_hired_is_employee" CHECK (("stage" = 'hired') = ("employee_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "applicant_no_uniq" ON "applicant" ("applicant_no");--> statement-breakpoint
CREATE INDEX "applicant_vacancy_idx" ON "applicant" ("vacancy_id", "stage");--> statement-breakpoint

CREATE TABLE "applicant_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL REFERENCES "applicant"("id"),
	"from_stage" text,
	"to_stage" text NOT NULL,
	"note" text,
	"moved_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"moved_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "applicant_stage_closing_note" CHECK ("to_stage" NOT IN ('rejected', 'withdrawn') OR nullif(btrim("note"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "applicant_stage_applicant_idx" ON "applicant_stage" ("applicant_id", "moved_at");--> statement-breakpoint
CREATE TRIGGER "applicant_stage_append_only"
	BEFORE UPDATE OR DELETE ON "applicant_stage"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "review_cycle" (
	"code" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "review_cycle_status" CHECK ("status" IN ('draft', 'open', 'closed')),
	CONSTRAINT "review_cycle_period" CHECK ("period_to" >= "period_from")
);--> statement-breakpoint

CREATE TABLE "performance_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_no" text NOT NULL,
	"cycle_code" text NOT NULL REFERENCES "review_cycle"("code"),
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"reviewer_user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"status" text NOT NULL DEFAULT 'draft',
	"overall_rating" numeric(4, 2),
	"reviewer_comment" text,
	"employee_comment" text,
	"employee_commented_at" timestamptz,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"rated_at" timestamptz,
	"signed_off_by" uuid REFERENCES "app_user"("id"),
	"signed_off_at" timestamptz,
	"sign_off_note" text,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancel_reason" text,
	CONSTRAINT "performance_review_status" CHECK ("status" IN ('draft', 'rated', 'signed_off', 'cancelled')),
	CONSTRAINT "performance_review_rating" CHECK ("overall_rating" IS NULL OR ("overall_rating" >= 1 AND "overall_rating" <= 5)),
	CONSTRAINT "performance_review_rated" CHECK ("status" NOT IN ('rated', 'signed_off') OR "overall_rating" IS NOT NULL),
	CONSTRAINT "performance_review_signed_off" CHECK (("status" = 'signed_off') = ("signed_off_by" IS NOT NULL)),
	CONSTRAINT "performance_review_signer_not_reviewer" CHECK ("signed_off_by" IS NULL OR "signed_off_by" <> "reviewer_user_id"),
	CONSTRAINT "performance_review_cancel_reason" CHECK ("status" <> 'cancelled' OR nullif(btrim("cancel_reason"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "performance_review_no_uniq" ON "performance_review" ("review_no");--> statement-breakpoint
-- One review per person per cycle.
CREATE UNIQUE INDEX "performance_review_cycle_employee_uniq" ON "performance_review" ("cycle_code", "employee_id");--> statement-breakpoint

CREATE TABLE "review_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL REFERENCES "performance_review"("id"),
	"line_no" smallint NOT NULL,
	"title" text NOT NULL,
	"target" text,
	"weight" smallint NOT NULL,
	"rating" smallint,
	"comment" text,
	CONSTRAINT "review_goal_weight" CHECK ("weight" BETWEEN 1 AND 100),
	CONSTRAINT "review_goal_rating" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);--> statement-breakpoint
CREATE UNIQUE INDEX "review_goal_line_uniq" ON "review_goal" ("review_id", "line_no");--> statement-breakpoint

-- A review is the person's, read by their reviewer: neither reviews themself,
-- nor does the person sign their own off. Once signed off or cancelled it is
-- the record — only the person's word may still be added, once.
CREATE FUNCTION performance_review_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	person uuid;
BEGIN
	SELECT e.app_user_id INTO person FROM employee e WHERE e.id = NEW.employee_id;
	IF person IS NOT NULL AND NEW.reviewer_user_id = person THEN
		RAISE EXCEPTION 'A person does not review themself (%).', NEW.review_no USING ERRCODE = 'check_violation';
	END IF;
	IF person IS NOT NULL AND NEW.signed_off_by = person THEN
		RAISE EXCEPTION 'A person does not sign off their own review (%).', NEW.review_no USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'UPDATE' AND OLD.status IN ('signed_off', 'cancelled') THEN
		IF OLD.employee_comment IS NULL AND NEW.employee_comment IS NOT NULL
		   AND (to_jsonb(NEW) - 'employee_comment' - 'employee_commented_at' - 'updated_at') = (to_jsonb(OLD) - 'employee_comment' - 'employee_commented_at' - 'updated_at') THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION '% is %; it is the record and is not changed.', OLD.review_no, OLD.status USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "performance_review_guard"
	BEFORE INSERT OR UPDATE ON "performance_review"
	FOR EACH ROW EXECUTE FUNCTION performance_review_guard();--> statement-breakpoint

-- Goals are set and rated on a draft; a rated review is reopened to change one.
CREATE FUNCTION review_goal_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	review_status text;
	review uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.review_id ELSE NEW.review_id END;
BEGIN
	SELECT r.status INTO review_status FROM performance_review r WHERE r.id = review;
	IF review_status IS DISTINCT FROM 'draft' THEN
		RAISE EXCEPTION 'The review is %; its goals change only while it is a draft.', review_status USING ERRCODE = 'check_violation';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "review_goal_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "review_goal"
	FOR EACH ROW EXECUTE FUNCTION review_goal_frozen();--> statement-breakpoint

-- Who the review is to the reader: the person, or its reviewer.
CREATE FUNCTION app_review_reach(p_review uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1
		  FROM performance_review r
		  JOIN employee e ON e.id = r.employee_id
		 WHERE r.id = p_review
		   AND (e.app_user_id = app_current_user() OR r.reviewer_user_id = app_current_user())
	);
$$;--> statement-breakpoint

-- A cycle is company-wide: closing it counts every branch's reviews still
-- open, past the reader's row scope — a number, no review read.
CREATE FUNCTION app_cycle_open_reviews(p_cycle text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT count(*)::int FROM performance_review r WHERE r.cycle_code = p_cycle AND r.status IN ('draft', 'rated');
$$;--> statement-breakpoint

ALTER TABLE "vacancy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "vacancy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY vacancy_scope ON "vacancy"
	USING (app_is_super_user() OR app_branch_allowed("branch_code"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code"));--> statement-breakpoint
ALTER TABLE "applicant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applicant" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- An applicant is somebody outside the company: read by recruitment's own
-- grant, not by everyone in the branch.
CREATE POLICY applicant_scope ON "applicant"
	USING (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('recruitment', 'view')))
	WITH CHECK (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('recruitment', 'view')));--> statement-breakpoint
ALTER TABLE "applicant_stage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applicant_stage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY applicant_stage_scope ON "applicant_stage"
	USING (EXISTS (SELECT 1 FROM applicant a WHERE a.id = "applicant_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM applicant a WHERE a.id = "applicant_id"));--> statement-breakpoint
ALTER TABLE "review_cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_cycle" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY review_cycle_scope ON "review_cycle" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "performance_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "performance_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY performance_review_scope ON "performance_review"
	USING (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('performance_review', 'view')) OR app_review_reach("id"))
	WITH CHECK (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('performance_review', 'view')) OR app_review_reach("id") OR "reviewer_user_id" = app_current_user());--> statement-breakpoint
ALTER TABLE "review_goal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_goal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY review_goal_scope ON "review_goal"
	USING (EXISTS (SELECT 1 FROM performance_review r WHERE r.id = "review_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM performance_review r WHERE r.id = "review_id"));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_review_reach(uuid), app_cycle_open_reviews(text) TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "vacancy", "applicant", "review_cycle", "performance_review" TO erp_app;
	GRANT SELECT, INSERT ON "applicant_stage" TO erp_app;
	-- A draft review's goals are set and replaced; the trigger-free table is guarded by the service's status check.
	GRANT SELECT, INSERT, UPDATE, DELETE ON "review_goal" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('VACANCY', 'VAC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 4, true, true),
	('APPLICANT', 'APL', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true),
	('PERFORMANCE_REVIEW', 'REV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('vacancy', 'Vacancy', 'hr', 'A position to fill: how many, from when (REQ-HR-001 HR-5).'),
	('applicant', 'Applicant', 'hr', 'A person who applied for a vacancy, and the stages they moved through (REQ-HR-001 HR-5).'),
	('performance_review', 'Performance review', 'hr', 'One person''s review for a cycle: goals, ratings, sign-off (REQ-HR-001 HR-5).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- HR runs recruitment; the HR manager opens a vacancy and hires. Reviews are
-- prepared by HR or by the reviewer (the person's manager, by the link, with
-- no grant), and signed off by the HR manager. The CEO reads.
INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, o.object, v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['recruitment', 'performance_review']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'edit_draft', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager', 'recruitment',        'approve'),
	('hr_manager', 'performance_review', 'approve'),
	('hr_officer', 'attachment',         'view'),
	('ceo',        'recruitment',        'view'),
	('ceo',        'performance_review', 'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The sweep tells the HR managers of an open vacancy past its closing day.
INSERT INTO notification_rule (code, description, event_type, recipient_role, channels) VALUES
	('hr_vacancy_overdue', 'An open vacancy is past its closing day (REQ-HR-001 HR-5).', 'hr.vacancy_overdue', 'hr_manager', ARRAY['in_app'])
ON CONFLICT (code) DO NOTHING;
