-- ===========================================================================
-- Platform phase · Agent 7 — the Exception Center: the finding itself (2026-10-04).
-- HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   exception           EXC-{SERIAL}: one persisted, de-duplicated finding — a thing
--                       that is wrong or late *now* and needs a person. Its identity
--                       is `finding_key` (detector + subject), so the same condition
--                       found on the next sweep is the same row, never a second one.
--
--       open ──────────────► acknowledged     a person, with a note (the screen's action)
--       open | acknowledged ─► resolved       the sweep, and only when the detector no
--                                              longer finds the condition
--       resolved ──────────► open             re-detected: reopened, history kept
--       acknowledged ──────► open             the finding got worse (severity rose)
--
--   The Exception Center never repairs, posts or edits business data: it reads (in a
--   transaction PostgreSQL holds read-only) and writes its own three tables here.
--
--   exception_history   append-only. Written by `exception_history_writer` on every
--                       step, so no code path can move a finding without leaving a line.
--   exception_sweep_run one row per run of the detectors: what ran, what it found, what
--                       it changed, what failed. Append-only.
--
--   Who may see a finding: a person holding `view` on `exception`, AND `view` on the
--   permission object the finding is about (`permission_object`), AND — where the
--   finding belongs to a branch — that branch. The service additionally asks the
--   affected record's own access rule (attachments.mayAccessParent) for a record kind
--   that has one (a task, a customs PD); that rule is application-side by nature.
-- ===========================================================================

CREATE TABLE "exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exception_no" text NOT NULL,
	"finding_key" text NOT NULL,
	"detector" text NOT NULL,
	"subject" text NOT NULL,
	"domain" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"permission_object" text NOT NULL,
	"branch_code" text REFERENCES "branch"("code"),
	-- The English wording at the time of the last sweep. Screens draw the viewer's language
	-- from `facts` and the message catalogue; this is the fallback and what a notification stores.
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	-- The numbers and names the wording is made of, and the rows the detector found.
	"facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"content_hash" text NOT NULL,
	-- The affected record and where to go to deal with it.
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"record_label" text NOT NULL,
	"href" text NOT NULL,
	"party_code" text,
	"owner_user_id" uuid REFERENCES "app_user"("id"),
	"owner_name" text,
	"first_detected_at" timestamptz NOT NULL,
	"last_seen_at" timestamptz NOT NULL,
	"resolved_at" timestamptz,
	"acknowledged_at" timestamptz,
	"acknowledged_by" uuid REFERENCES "app_user"("id"),
	"acknowledgement_note" text,
	-- 1 on first detection; one more for every time a resolved finding came back.
	"occurrence" integer NOT NULL DEFAULT 1,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "exception_status_known" CHECK ("status" IN ('open', 'acknowledged', 'resolved')),
	CONSTRAINT "exception_severity_known" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "exception_domain_known" CHECK ("domain" IN ('accounting', 'receivables', 'payables', 'inventory', 'logistics', 'tasks', 'approvals', 'platform')),
	CONSTRAINT "exception_key_is_detector_and_subject" CHECK ("finding_key" = "detector" || '|' || "subject"),
	CONSTRAINT "exception_detector_shape" CHECK ("detector" ~ '^[a-z]+\.[a-z0-9_]+$'),
	CONSTRAINT "exception_text_present" CHECK (nullif(btrim("title"), '') IS NOT NULL AND nullif(btrim("explanation"), '') IS NOT NULL),
	CONSTRAINT "exception_record_present" CHECK (nullif(btrim("record_type"), '') IS NOT NULL AND nullif(btrim("record_id"), '') IS NOT NULL AND nullif(btrim("record_label"), '') IS NOT NULL),
	CONSTRAINT "exception_href_local" CHECK ("href" ~ '^/[^/\\]'),
	CONSTRAINT "exception_facts_object" CHECK (jsonb_typeof("facts") = 'object'),
	CONSTRAINT "exception_evidence_array" CHECK (jsonb_typeof("evidence") = 'array' AND jsonb_array_length("evidence") <= 50),
	CONSTRAINT "exception_seen_after_first" CHECK ("last_seen_at" >= "first_detected_at"),
	CONSTRAINT "exception_occurrence_positive" CHECK ("occurrence" >= 1),
	-- The lifecycle's facts agree with the status.
	CONSTRAINT "exception_open_has_no_resolution" CHECK ("status" <> 'open' OR ("resolved_at" IS NULL AND "acknowledged_at" IS NULL AND "acknowledged_by" IS NULL AND "acknowledgement_note" IS NULL)),
	CONSTRAINT "exception_acknowledged_has_person_and_note" CHECK ("status" <> 'acknowledged' OR ("resolved_at" IS NULL AND "acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL AND nullif(btrim("acknowledgement_note"), '') IS NOT NULL)),
	CONSTRAINT "exception_resolved_has_moment" CHECK ("status" <> 'resolved' OR "resolved_at" IS NOT NULL),
	CONSTRAINT "exception_note_length" CHECK ("acknowledgement_note" IS NULL OR char_length("acknowledgement_note") <= 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "exception_no_uniq" ON "exception" ("exception_no");--> statement-breakpoint
CREATE UNIQUE INDEX "exception_key_uniq" ON "exception" ("finding_key");--> statement-breakpoint
CREATE INDEX "exception_live_idx" ON "exception" ("status", "severity") WHERE "status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "exception_domain_idx" ON "exception" ("domain", "status");--> statement-breakpoint
CREATE INDEX "exception_object_idx" ON "exception" ("permission_object");--> statement-breakpoint
CREATE INDEX "exception_record_idx" ON "exception" ("record_type", "record_id");--> statement-breakpoint
CREATE INDEX "exception_branch_idx" ON "exception" ("branch_code") WHERE "branch_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "exception_owner_idx" ON "exception" ("owner_user_id") WHERE "owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "exception_seen_idx" ON "exception" ("last_seen_at");--> statement-breakpoint

-- Never deleted: a resolved finding is the record that it was found.
CREATE FUNCTION exception_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'An exception is never deleted (%); it resolves when the cause is gone.', OLD.exception_no USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "exception_no_delete"
	BEFORE DELETE ON "exception"
	FOR EACH ROW EXECUTE FUNCTION exception_no_delete();--> statement-breakpoint

-- Is this statement the sweep's? (`markSystemSweep`: set by the scheduled job and by the
-- refresh action on their own transactions; no other web request sets it.)
CREATE FUNCTION exception_is_sweep() RETURNS boolean
LANGUAGE sql STABLE AS $$
	SELECT coalesce(current_setting('app.system_sweep', true), '') = 'on';
$$;--> statement-breakpoint

CREATE FUNCTION exception_severity_rank(p_severity text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
	SELECT array_position(ARRAY['low', 'medium', 'high', 'critical'], p_severity);
$$;--> statement-breakpoint

-- The road, who walks it, and the moments the database stamps.
CREATE FUNCTION exception_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	actor uuid := app_current_user();
	sweep boolean := exception_is_sweep();
	person_only text[] := ARRAY['status', 'acknowledged_at', 'acknowledged_by', 'acknowledgement_note', 'updated_at'];
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NOT sweep THEN
			RAISE EXCEPTION 'An exception is raised by the sweep, not by hand (%).', NEW.exception_no USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.status <> 'open' OR NEW.occurrence <> 1 THEN
			RAISE EXCEPTION 'An exception starts open, on its first occurrence (%).', NEW.exception_no USING ERRCODE = 'check_violation';
		END IF;
		NEW.created_at := now();
		NEW.updated_at := now();
		RETURN NEW;
	END IF;

	IF NEW.id <> OLD.id OR NEW.exception_no <> OLD.exception_no OR NEW.finding_key <> OLD.finding_key
	   OR NEW.detector <> OLD.detector OR NEW.subject <> OLD.subject OR NEW.domain <> OLD.domain
	   OR NEW.first_detected_at <> OLD.first_detected_at OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION '%: the number, the key, the detector, the subject, the domain and the first detection never change.', OLD.exception_no USING ERRCODE = 'check_violation';
	END IF;

	IF NOT sweep THEN
		-- A person's one step: acknowledge, with a note. Nothing else about the finding is theirs.
		IF NOT (OLD.status = 'open' AND NEW.status = 'acknowledged') THEN
			RAISE EXCEPTION '%: only the sweep moves a finding; a person acknowledges an open one.', OLD.exception_no USING ERRCODE = 'check_violation';
		END IF;
		IF actor IS NULL THEN
			RAISE EXCEPTION '%: acknowledging names the person.', OLD.exception_no USING ERRCODE = 'check_violation';
		END IF;
		IF nullif(btrim(NEW.acknowledgement_note), '') IS NULL THEN
			RAISE EXCEPTION '%: say what you know and what will be done (the acknowledgement note).', OLD.exception_no USING ERRCODE = 'check_violation';
		END IF;
		IF (to_jsonb(NEW) - person_only) IS DISTINCT FROM (to_jsonb(OLD) - person_only) THEN
			RAISE EXCEPTION '%: an acknowledgement changes nothing but the acknowledgement.', OLD.exception_no USING ERRCODE = 'check_violation';
		END IF;
		NEW.acknowledged_by := actor;
		NEW.acknowledged_at := now();
		NEW.updated_at := now();
		RETURN NEW;
	END IF;

	-- The sweep.
	IF NEW.status = 'acknowledged' AND OLD.status <> 'acknowledged' THEN
		RAISE EXCEPTION '%: acknowledging is a person''s.', OLD.exception_no USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status <> OLD.status AND NOT EXISTS (
		SELECT 1
		  FROM (VALUES
			-- allowed pairs (from, to) — mirrored by domain/exceptions.ts › allowedPairs()
			('open', 'acknowledged'),
			('open', 'resolved'),
			('acknowledged', 'open'),
			('acknowledged', 'resolved'),
			('resolved', 'open')
		  ) AS p(from_status, to_status)
		 WHERE p.from_status = OLD.status AND p.to_status = NEW.status
	) THEN
		RAISE EXCEPTION '% is %; it cannot become %.', OLD.exception_no, OLD.status, NEW.status USING ERRCODE = 'check_violation';
	END IF;
	-- A finding that got worse is not "handled" any more.
	IF OLD.status = 'acknowledged' AND NEW.status = 'acknowledged' AND exception_severity_rank(NEW.severity) > exception_severity_rank(OLD.severity) THEN
		RAISE EXCEPTION '%: a finding that got worse reopens.', OLD.exception_no USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status = 'acknowledged' AND NEW.status = 'open' AND exception_severity_rank(NEW.severity) <= exception_severity_rank(OLD.severity) THEN
		RAISE EXCEPTION '%: an acknowledged finding reopens only when it got worse.', OLD.exception_no USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.status <> OLD.status THEN
		IF NEW.status = 'resolved' THEN
			NEW.resolved_at := now();
			NEW.acknowledged_at := OLD.acknowledged_at;
			NEW.acknowledged_by := OLD.acknowledged_by;
			NEW.acknowledgement_note := OLD.acknowledgement_note;
			NEW.occurrence := OLD.occurrence;
		ELSIF NEW.status = 'open' THEN
			NEW.resolved_at := NULL;
			NEW.acknowledged_at := NULL;
			NEW.acknowledged_by := NULL;
			NEW.acknowledgement_note := NULL;
			IF OLD.status = 'resolved' THEN
				NEW.occurrence := OLD.occurrence + 1;
			END IF;
		END IF;
	ELSE
		-- The acknowledgement and the resolution are not the sweep's to rewrite.
		NEW.resolved_at := OLD.resolved_at;
		NEW.acknowledged_at := OLD.acknowledged_at;
		NEW.acknowledged_by := OLD.acknowledged_by;
		NEW.acknowledgement_note := OLD.acknowledgement_note;
		NEW.occurrence := OLD.occurrence;
	END IF;
	-- A resolved finding is touched only to come back.
	IF OLD.status = 'resolved' AND NEW.status = 'resolved' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
		RAISE EXCEPTION '%: a resolved finding is final until it is found again.', OLD.exception_no USING ERRCODE = 'check_violation';
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "exception_lifecycle_guard"
	BEFORE INSERT OR UPDATE ON "exception"
	FOR EACH ROW EXECUTE FUNCTION exception_lifecycle_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The history: append-only, and written by the database on every step.
-- ---------------------------------------------------------------------------
CREATE TABLE "exception_history" (
	"id" bigserial PRIMARY KEY,
	"exception_id" uuid NOT NULL REFERENCES "exception"("id"),
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"from_severity" text,
	"to_severity" text NOT NULL,
	"occurrence" integer NOT NULL,
	-- Null: the sweep did it.
	"actor_user_id" uuid REFERENCES "app_user"("id"),
	"note" text,
	"occurred_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "exception_history_event_known" CHECK ("event" IN ('detected', 'acknowledged', 'resolved', 'reopened', 'escalated', 'severity_raised', 'severity_lowered'))
);--> statement-breakpoint
CREATE INDEX "exception_history_exception_idx" ON "exception_history" ("exception_id", "id");--> statement-breakpoint
CREATE TRIGGER "exception_history_append_only"
	BEFORE UPDATE OR DELETE ON "exception_history"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE FUNCTION exception_history_writer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	sweep boolean := exception_is_sweep();
	ev text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO exception_history (exception_id, event, from_status, to_status, from_severity, to_severity, occurrence, actor_user_id)
		VALUES (NEW.id, 'detected', NULL, NEW.status, NULL, NEW.severity, NEW.occurrence, NULL);
		RETURN NEW;
	END IF;

	IF NEW.status <> OLD.status THEN
		ev := CASE
			WHEN NEW.status = 'acknowledged' THEN 'acknowledged'
			WHEN NEW.status = 'resolved' THEN 'resolved'
			WHEN OLD.status = 'resolved' THEN 'reopened'
			ELSE 'escalated'
		END;
	ELSIF NEW.severity <> OLD.severity THEN
		ev := CASE WHEN exception_severity_rank(NEW.severity) > exception_severity_rank(OLD.severity) THEN 'severity_raised' ELSE 'severity_lowered' END;
	ELSE
		RETURN NEW;
	END IF;

	INSERT INTO exception_history (exception_id, event, from_status, to_status, from_severity, to_severity, occurrence, actor_user_id, note)
	VALUES (
		NEW.id, ev, OLD.status, NEW.status, OLD.severity, NEW.severity, NEW.occurrence,
		CASE WHEN ev = 'acknowledged' THEN NEW.acknowledged_by WHEN sweep THEN NULL ELSE app_current_user() END,
		CASE WHEN ev = 'acknowledged' THEN NEW.acknowledgement_note ELSE NULL END
	);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "exception_history_writer"
	AFTER INSERT OR UPDATE ON "exception"
	FOR EACH ROW EXECUTE FUNCTION exception_history_writer();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- One row per run of the detectors.
-- ---------------------------------------------------------------------------
CREATE TABLE "exception_sweep_run" (
	"id" bigserial PRIMARY KEY,
	"business_date" date NOT NULL,
	"trigger" text NOT NULL,
	"triggered_by" uuid REFERENCES "app_user"("id"),
	"started_at" timestamptz NOT NULL,
	"finished_at" timestamptz NOT NULL DEFAULT now(),
	"found" integer NOT NULL DEFAULT 0,
	"created" integer NOT NULL DEFAULT 0,
	"updated" integer NOT NULL DEFAULT 0,
	"reopened" integer NOT NULL DEFAULT 0,
	"resolved" integer NOT NULL DEFAULT 0,
	"notified" integer NOT NULL DEFAULT 0,
	-- Per detector: how many it found, or why it could not run. A detector that failed resolves nothing.
	"detectors" jsonb NOT NULL DEFAULT '[]'::jsonb,
	CONSTRAINT "exception_sweep_run_trigger_known" CHECK ("trigger" IN ('schedule', 'manual')),
	CONSTRAINT "exception_sweep_run_detectors_array" CHECK (jsonb_typeof("detectors") = 'array')
);--> statement-breakpoint
CREATE INDEX "exception_sweep_run_finished_idx" ON "exception_sweep_run" ("finished_at" DESC);--> statement-breakpoint
CREATE TRIGGER "exception_sweep_run_append_only"
	BEFORE UPDATE OR DELETE ON "exception_sweep_run"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE, like the other documents.
-- ---------------------------------------------------------------------------
ALTER TABLE "exception" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exception" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY exception_scope ON "exception"
	USING (
		app_signed_in() AND (
			app_is_super_user()
			OR (
				app_has_grant('exception', 'view')
				AND app_has_grant("permission_object", 'view')
				AND ("branch_code" IS NULL OR app_branch_allowed("branch_code"))
			)
		)
	)
	WITH CHECK (
		app_signed_in() AND (
			app_is_super_user()
			OR (
				app_has_grant('exception', 'execute')
				AND app_has_grant("permission_object", 'view')
				AND ("branch_code" IS NULL OR app_branch_allowed("branch_code"))
			)
		)
	);--> statement-breakpoint

ALTER TABLE "exception_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exception_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY exception_history_scope ON "exception_history"
	USING (EXISTS (SELECT 1 FROM "exception" e WHERE e."id" = "exception_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM "exception" e WHERE e."id" = "exception_id"));--> statement-breakpoint

ALTER TABLE "exception_sweep_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exception_sweep_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY exception_sweep_run_scope ON "exception_sweep_run"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('exception', 'view')))
	WITH CHECK (app_signed_in() AND app_is_super_user());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Never deleted, never rewritten but by the guard: no DELETE for the application.
	GRANT SELECT, INSERT, UPDATE ON "exception" TO erp_app;
	GRANT SELECT, INSERT ON "exception_history" TO erp_app;
	GRANT SELECT, INSERT ON "exception_sweep_run" TO erp_app;
	GRANT USAGE, SELECT ON SEQUENCE exception_history_id_seq TO erp_app;
	GRANT USAGE, SELECT ON SEQUENCE exception_sweep_run_id_seq TO erp_app;
	GRANT EXECUTE ON FUNCTION exception_is_sweep() TO erp_app;
	GRANT EXECUTE ON FUNCTION exception_severity_rank(text) TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('EXCEPTION', 'EXC', '{PREFIX}-{SERIAL}', 4, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('exception', 'Exception', 'home', 'A finding that something is wrong or late and needs a person — found by a detector, resolved only when the cause is gone (Exception Center).')
ON CONFLICT (code) DO NOTHING;
