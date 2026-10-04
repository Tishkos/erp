-- ===========================================================================
-- Platform phase · Agent 10 — Workflow automation: the rule, its versions, the
-- outbox of events and the log of runs (2026-10-05). HAND-AUTHORED.
-- Everything additive; no applied migration is touched.
--
--   This is the FIRST CONTROLLED automation layer, not a general workflow
--   builder. A rule is an explicit Qimah event, a few typed conditions and a
--   short list of actions from a closed vocabulary (domain/automation.ts). The
--   database holds the same closed lists as the application, so no code path —
--   a service, a script, a hand-run statement — can store a rule that names an
--   event, an action kind, an operator or a key the vocabulary does not have.
--   tests/unit/wf01-automation.test.ts reads this file and fails when they
--   disagree.
--
--   automation_setting       the global switch and the auto-pause threshold.
--   automation_rule          AUT-{SERIAL}: one rule, built from a template. Created
--                            OFF; `enabled_at` is stamped by the database, and a
--                            rule acts only on events that happened after it.
--                            Never deleted.
--   automation_rule_version  append-only. A change is a new row; a run names the
--                            version it used. The conditions and actions are
--                            checked here, whoever inserts them.
--   automation_event         the outbox. A business transaction RECORDS a row here
--                            (automation_record_event, a definer function called in
--                            a savepoint) and nothing more: no rule runs in it, so a
--                            failing rule can never roll back or delay a document.
--                            Unique per (event, record, window): a double dispatch
--                            writes one row. Consumed in order by the runner with
--                            FOR UPDATE SKIP LOCKED.
--   automation_run           append-only. One row per rule per event per attempt:
--                            the rule version, what was planned, what each step did,
--                            the outcome and its reason in plain words.
--
--   The runner acts as the RULE OWNER (the person who last saved or enabled it):
--   whatever an action needs, the owner's own grants and the owning service's own
--   checks decide, so the reach of a run is the intersection of the two.
--
--   Who may see or change any of it: `automation` view / administer (0401).
-- ===========================================================================

CREATE TABLE "automation_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" uuid REFERENCES "app_user"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "automation_setting_known" CHECK (
		("key" = 'enabled' AND "value" IN ('on', 'off'))
		OR ("key" = 'pause_after_failures' AND "value" ~ '^[0-9]{1,2}$' AND "value"::integer BETWEEN 1 AND 20)
	)
);--> statement-breakpoint

INSERT INTO "automation_setting" ("key", "value") VALUES ('enabled', 'on'), ('pause_after_failures', '3');--> statement-breakpoint

CREATE FUNCTION automation_is_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT coalesce((SELECT "value" = 'on' FROM automation_setting WHERE "key" = 'enabled'), true);
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The rule
-- ---------------------------------------------------------------------------
CREATE TABLE "automation_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_no" text NOT NULL,
	"event_key" text NOT NULL,
	"template_code" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer NOT NULL DEFAULT 1,
	-- Whose permissions the rule runs with: the person who last saved or enabled it.
	"owner_user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"enabled" boolean NOT NULL DEFAULT false,
	"enabled_at" timestamptz,
	"enabled_by" uuid REFERENCES "app_user"("id"),
	-- Set when the system stopped the rule (consecutive failures, an owner who may no longer own it); a person's own "off" leaves these empty.
	"paused_at" timestamptz,
	"paused_reason" text,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"last_run_at" timestamptz,
	"last_outcome" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "automation_rule_event_known" CHECK ("event_key" IN ('ap_invoice.submitted', 'ap_invoice.posted', 'task.overdue', 'container.eta_exceeded', 'ar_invoice.overdue')),
	CONSTRAINT "automation_rule_template_shape" CHECK ("template_code" ~ '^[a-z][a-z_]{2,50}$'),
	CONSTRAINT "automation_rule_name_length" CHECK (char_length(btrim("name")) BETWEEN 3 AND 80),
	CONSTRAINT "automation_rule_version_positive" CHECK ("current_version" >= 1),
	CONSTRAINT "automation_rule_failures_nonnegative" CHECK ("consecutive_failures" >= 0),
	CONSTRAINT "automation_rule_enabled_stamped" CHECK (("enabled" AND "enabled_at" IS NOT NULL AND "enabled_by" IS NOT NULL) OR (NOT "enabled" AND "enabled_at" IS NULL)),
	CONSTRAINT "automation_rule_paused_says_why" CHECK (("paused_at" IS NULL AND "paused_reason" IS NULL) OR (NOT "enabled" AND "paused_at" IS NOT NULL AND nullif(btrim("paused_reason"), '') IS NOT NULL)),
	CONSTRAINT "automation_rule_outcome_known" CHECK ("last_outcome" IS NULL OR "last_outcome" IN ('done', 'skipped', 'failed'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_no_uniq" ON "automation_rule" ("rule_no");--> statement-breakpoint
CREATE INDEX "automation_rule_event_idx" ON "automation_rule" ("event_key") WHERE "enabled";--> statement-breakpoint
CREATE INDEX "automation_rule_owner_idx" ON "automation_rule" ("owner_user_id");--> statement-breakpoint
CREATE INDEX "automation_rule_recent_idx" ON "automation_rule" ("created_at" DESC);--> statement-breakpoint

-- Never deleted.
CREATE FUNCTION automation_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is never deleted (%); switch a rule off, and keep its history.', TG_TABLE_NAME, coalesce(to_jsonb(OLD)->>'rule_no', to_jsonb(OLD)->>'id') USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_rule_no_delete"
	BEFORE DELETE ON "automation_rule"
	FOR EACH ROW EXECUTE FUNCTION automation_no_delete();--> statement-breakpoint

-- The guard: what is born off, what never changes, what the database stamps.
CREATE FUNCTION automation_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- A rule is born off, on its first version, with nothing run.
		NEW.enabled := false;
		NEW.enabled_at := NULL;
		NEW.enabled_by := NULL;
		NEW.paused_at := NULL;
		NEW.paused_reason := NULL;
		NEW.consecutive_failures := 0;
		NEW.last_run_at := NULL;
		NEW.last_outcome := NULL;
		NEW.current_version := 1;
		NEW.created_at := now();
		NEW.updated_at := now();
		RETURN NEW;
	END IF;

	IF NEW.id <> OLD.id OR NEW.rule_no <> OLD.rule_no OR NEW.event_key <> OLD.event_key OR NEW.template_code <> OLD.template_code
	   OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION '%: the number, the event, the template, the author and the creation time never change.', OLD.rule_no USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.current_version < OLD.current_version THEN
		RAISE EXCEPTION '%: a rule never goes back to an earlier version; a change is a new version.', OLD.rule_no USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.current_version <> OLD.current_version AND NOT EXISTS (SELECT 1 FROM automation_rule_version v WHERE v.rule_id = NEW.id AND v.version = NEW.current_version) THEN
		RAISE EXCEPTION '%: version % does not exist.', OLD.rule_no, NEW.current_version USING ERRCODE = 'check_violation';
	END IF;

	IF NEW.enabled AND NOT OLD.enabled THEN
		-- The moment is the database's: a rule acts on what happens after it, never on what it was not on for.
		NEW.enabled_at := now();
		NEW.paused_at := NULL;
		NEW.paused_reason := NULL;
		NEW.consecutive_failures := 0;
	ELSIF NEW.enabled THEN
		NEW.enabled_at := OLD.enabled_at;
		NEW.enabled_by := OLD.enabled_by;
	ELSE
		NEW.enabled_at := NULL;
		NEW.enabled_by := NULL;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_rule_guard"
	BEFORE INSERT OR UPDATE ON "automation_rule"
	FOR EACH ROW EXECUTE FUNCTION automation_rule_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The versions: append-only, and the closed vocabulary held at the database.
-- ---------------------------------------------------------------------------
CREATE TABLE "automation_rule_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL REFERENCES "automation_rule"("id"),
	"version" integer NOT NULL,
	"event_key" text NOT NULL,
	"name" text NOT NULL,
	"template_code" text NOT NULL,
	-- What the administrator typed on the template's form, in canonical form; the screen shows it back.
	"params" jsonb NOT NULL,
	-- What the template built from it, validated by domain/automation.ts and again by the guard below.
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"changed_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"change_note" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "automation_rule_version_positive" CHECK ("version" >= 1),
	CONSTRAINT "automation_rule_version_params_object" CHECK (jsonb_typeof("params") = 'object'),
	CONSTRAINT "automation_rule_version_conditions_array" CHECK (jsonb_typeof("conditions") = 'array' AND jsonb_array_length("conditions") <= 8),
	CONSTRAINT "automation_rule_version_actions_array" CHECK (jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") BETWEEN 1 AND 6),
	CONSTRAINT "automation_rule_version_note_length" CHECK ("change_note" IS NULL OR char_length("change_note") <= 1000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_version_uniq" ON "automation_rule_version" ("rule_id", "version");--> statement-breakpoint
CREATE TRIGGER "automation_rule_version_append_only"
	BEFORE UPDATE OR DELETE ON "automation_rule_version"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE FUNCTION automation_rule_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	rule automation_rule%ROWTYPE;
	item jsonb;
	recipient jsonb;
	k text;
BEGIN
	SELECT * INTO rule FROM automation_rule WHERE id = NEW.rule_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'A version belongs to a rule.' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.event_key <> rule.event_key OR NEW.template_code <> rule.template_code THEN
		RAISE EXCEPTION '%: a version is of the rule''s own event and template.', rule.rule_no USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.version <> coalesce((SELECT max(v.version) FROM automation_rule_version v WHERE v.rule_id = NEW.rule_id), 0) + 1 THEN
		RAISE EXCEPTION '%: versions are numbered one after another.', rule.rule_no USING ERRCODE = 'check_violation';
	END IF;

	-- Conditions: a field, an operator from the closed list, a value — and nothing else.
	FOR item IN SELECT * FROM jsonb_array_elements(NEW.conditions) LOOP
		IF jsonb_typeof(item) <> 'object' THEN
			RAISE EXCEPTION '%: a condition is a field, an operator and a value.', rule.rule_no USING ERRCODE = 'check_violation';
		END IF;
		FOR k IN SELECT jsonb_object_keys(item) LOOP
			IF k NOT IN ('field', 'op', 'value') THEN
				RAISE EXCEPTION '%: a condition has no "%".', rule.rule_no, k USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		IF coalesce(item->>'op', '') NOT IN ('gte', 'gt', 'lte', 'lt', 'eq', 'ne', 'in') THEN
			RAISE EXCEPTION '%: "%" is not an operator.', rule.rule_no, item->>'op' USING ERRCODE = 'check_violation';
		END IF;
		IF coalesce(item->>'field', '') !~ '^[A-Za-z][A-Za-z0-9]{1,40}$' THEN
			RAISE EXCEPTION '%: a condition names a field.', rule.rule_no USING ERRCODE = 'check_violation';
		END IF;
	END LOOP;

	-- Actions: one of five kinds. None of them posts, pays, receives or moves stock, and none can be added without a migration.
	FOR item IN SELECT * FROM jsonb_array_elements(NEW.actions) LOOP
		IF jsonb_typeof(item) <> 'object' OR coalesce(item->>'kind', '') NOT IN ('create_notification', 'open_workflow', 'create_task', 'request_approval', 'create_exception') THEN
			RAISE EXCEPTION '%: "%" is not something a rule can do.', rule.rule_no, coalesce(item->>'kind', '?') USING ERRCODE = 'check_violation';
		END IF;
		FOR k IN SELECT jsonb_object_keys(item) LOOP
			IF k NOT IN ('kind', 'recipients', 'assignee', 'departmentCode', 'title', 'priority', 'dueInDays', 'severity', 'note') THEN
				RAISE EXCEPTION '%: an action has no "%".', rule.rule_no, k USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		IF jsonb_typeof(item->'recipients') = 'array' THEN
			FOR recipient IN SELECT * FROM jsonb_array_elements(item->'recipients') LOOP
				IF coalesce(recipient->>'kind', '') NOT IN ('role', 'user', 'rule_owner', 'record_raiser', 'record_assignee', 'assignee_supervisor', 'raiser_supervisor') THEN
					RAISE EXCEPTION '%: "%" is not a kind of recipient.', rule.rule_no, coalesce(recipient->>'kind', '?') USING ERRCODE = 'check_violation';
				END IF;
			END LOOP;
		END IF;
	END LOOP;

	NEW.created_at := now();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_rule_version_guard"
	BEFORE INSERT ON "automation_rule_version"
	FOR EACH ROW EXECUTE FUNCTION automation_rule_version_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------
CREATE TABLE "automation_event" (
	"id" bigserial PRIMARY KEY,
	"event_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_key" text NOT NULL,
	-- When this event happened: a record event's own moment; a sweep's business day.
	"window_key" text NOT NULL,
	-- The stretch of lateness it belongs to (a due date, an ETA); a record event is its own. A rule acts once per stretch.
	"episode_key" text NOT NULL,
	"branch_code" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamptz NOT NULL DEFAULT now(),
	"status" text NOT NULL DEFAULT 'pending',
	"attempts" integer NOT NULL DEFAULT 0,
	"next_attempt_at" timestamptz NOT NULL DEFAULT now(),
	"processed_at" timestamptz,
	"last_error" text,
	"rules_seen" integer NOT NULL DEFAULT 0,
	"rules_matched" integer NOT NULL DEFAULT 0,
	CONSTRAINT "automation_event_key_known" CHECK ("event_key" IN ('ap_invoice.submitted', 'ap_invoice.posted', 'task.overdue', 'container.eta_exceeded', 'ar_invoice.overdue')),
	CONSTRAINT "automation_event_status_known" CHECK ("status" IN ('pending', 'retry', 'done', 'failed')),
	CONSTRAINT "automation_event_subject_key" CHECK ("subject_key" = "subject_type" || ':' || "subject_id"),
	CONSTRAINT "automation_event_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
	CONSTRAINT "automation_event_processed_stamped" CHECK (("status" IN ('done', 'failed')) = ("processed_at" IS NOT NULL))
);--> statement-breakpoint
-- One row per event per record per window: a second dispatch of the same fact writes nothing.
CREATE UNIQUE INDEX "automation_event_once" ON "automation_event" ("event_key", "subject_key", "window_key");--> statement-breakpoint
CREATE INDEX "automation_event_due_idx" ON "automation_event" ("next_attempt_at", "id") WHERE "status" IN ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "automation_event_recent_idx" ON "automation_event" ("occurred_at" DESC);--> statement-breakpoint
CREATE TRIGGER "automation_event_no_delete"
	BEFORE DELETE ON "automation_event"
	FOR EACH ROW EXECUTE FUNCTION automation_no_delete();--> statement-breakpoint

-- What happened is not rewritten: only the runner's own bookkeeping moves.
CREATE FUNCTION automation_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id <> OLD.id OR NEW.event_key <> OLD.event_key OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id
	   OR NEW.window_key <> OLD.window_key OR NEW.episode_key <> OLD.episode_key OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
	   OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.occurred_at <> OLD.occurred_at THEN
		RAISE EXCEPTION 'automation_event %: what happened is never rewritten; only its processing moves.', OLD.id USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.status IN ('done', 'failed') THEN
		RAISE EXCEPTION 'automation_event %: it was processed (%) and is final.', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "automation_event_guard"
	BEFORE UPDATE ON "automation_event"
	FOR EACH ROW EXECUTE FUNCTION automation_event_guard();--> statement-breakpoint

-- Is anybody listening? An event nobody has a rule for is not recorded (the outbox does not fill with facts no rule asked for), and
-- with the global switch off nothing is.
CREATE FUNCTION automation_listening(p_event text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT automation_is_on() AND EXISTS (SELECT 1 FROM automation_rule r WHERE r.event_key = p_event AND r.enabled);
$$;--> statement-breakpoint

-- The one thing a business transaction does: record the fact, in its own savepoint, as a row. It runs as the table's owner so the
-- person doing the work needs no grant on automation, and it runs no rule.
CREATE FUNCTION automation_record_event(
	p_event text, p_subject_type text, p_subject_id text, p_window text, p_episode text, p_branch text, p_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	v_id bigint;
BEGIN
	IF NOT automation_listening(p_event) THEN
		RETURN NULL;
	END IF;
	INSERT INTO automation_event (event_key, subject_type, subject_id, subject_key, window_key, episode_key, branch_code, payload)
	VALUES (p_event, p_subject_type, p_subject_id, p_subject_type || ':' || p_subject_id, p_window, p_episode, p_branch, p_payload)
	ON CONFLICT (event_key, subject_key, window_key) DO NOTHING
	RETURNING id INTO v_id;
	RETURN v_id;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The runs: append-only.
-- ---------------------------------------------------------------------------
CREATE TABLE "automation_run" (
	"id" bigserial PRIMARY KEY,
	"rule_id" uuid NOT NULL REFERENCES "automation_rule"("id"),
	"rule_version" integer NOT NULL,
	"event_id" bigint NOT NULL REFERENCES "automation_event"("id"),
	"event_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"window_key" text NOT NULL,
	"episode_key" text NOT NULL,
	-- rule | event | record | stretch: what makes a run the same run.
	"run_key" text NOT NULL,
	"attempt" integer NOT NULL DEFAULT 1,
	-- Whose permissions it ran with.
	"owner_user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	-- What the rule version planned, and what each step did (status, a plain sentence, what it made).
	"planned" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"results" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"started_at" timestamptz NOT NULL DEFAULT now(),
	"finished_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "automation_run_outcome_known" CHECK ("outcome" IN ('done', 'skipped', 'failed')),
	CONSTRAINT "automation_run_attempt_positive" CHECK ("attempt" >= 1),
	CONSTRAINT "automation_run_reason_present" CHECK (nullif(btrim("reason"), '') IS NOT NULL),
	CONSTRAINT "automation_run_planned_array" CHECK (jsonb_typeof("planned") = 'array'),
	CONSTRAINT "automation_run_results_array" CHECK (jsonb_typeof("results") = 'array')
);--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_attempt_uniq" ON "automation_run" ("event_id", "rule_id", "attempt");--> statement-breakpoint
-- A rule acts once on a record in a stretch of lateness: a second "done" for the same key cannot be written, however it is asked.
CREATE UNIQUE INDEX "automation_run_done_once" ON "automation_run" ("run_key") WHERE "outcome" = 'done';--> statement-breakpoint
CREATE INDEX "automation_run_rule_idx" ON "automation_run" ("rule_id", "id" DESC);--> statement-breakpoint
CREATE INDEX "automation_run_recent_idx" ON "automation_run" ("id" DESC);--> statement-breakpoint
CREATE INDEX "automation_run_outcome_idx" ON "automation_run" ("outcome", "id" DESC);--> statement-breakpoint
CREATE TRIGGER "automation_run_append_only"
	BEFORE UPDATE OR DELETE ON "automation_run"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE, like the other documents. Reading is `view` on
-- `automation`; writing is `administer`. The runner works as the system
-- operator (a super user) and the dispatch function as the table owner.
-- ---------------------------------------------------------------------------
ALTER TABLE "automation_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_setting_scope ON "automation_setting"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'administer')));--> statement-breakpoint

ALTER TABLE "automation_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_rule_scope ON "automation_rule"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'administer')));--> statement-breakpoint

ALTER TABLE "automation_rule_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_rule_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_rule_version_scope ON "automation_rule_version"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'administer')));--> statement-breakpoint

ALTER TABLE "automation_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_event_scope ON "automation_event"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND app_is_super_user());--> statement-breakpoint

ALTER TABLE "automation_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_run_scope ON "automation_run"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND app_is_super_user());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Never deleted: no DELETE for the application.
	GRANT SELECT, INSERT, UPDATE ON "automation_setting" TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "automation_rule" TO erp_app;
	GRANT SELECT, INSERT ON "automation_rule_version" TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "automation_event" TO erp_app;
	GRANT SELECT, INSERT ON "automation_run" TO erp_app;
	GRANT USAGE, SELECT ON SEQUENCE automation_event_id_seq TO erp_app;
	GRANT USAGE, SELECT ON SEQUENCE automation_run_id_seq TO erp_app;
	GRANT EXECUTE ON FUNCTION automation_is_on() TO erp_app;
	GRANT EXECUTE ON FUNCTION automation_listening(text) TO erp_app;
	GRANT EXECUTE ON FUNCTION automation_record_event(text, text, text, text, text, text, jsonb) TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('AUTOMATION_RULE', 'AUT', '{PREFIX}-{SERIAL}', 3, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('automation_rule', 'Automation rule', 'administration', 'An explicit Qimah event, a few typed conditions and a closed list of safe actions, run as its owner (Workflow Automation).')
ON CONFLICT (code) DO NOTHING;
