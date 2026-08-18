CREATE TABLE "posting_failure" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "posting_failure_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"source_module" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"source_event" text NOT NULL,
	"request" jsonb NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"attempted_by" uuid,
	"branch_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_journal_id" uuid
);
--> statement-breakpoint
CREATE TABLE "posting_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "posting_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_type" text NOT NULL,
	"source_module" text NOT NULL,
	"source_doc_id" text NOT NULL,
	"source_event" text NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"was_duplicate" boolean DEFAULT false NOT NULL,
	"posted_by" uuid,
	"branch_code" text,
	"duration_ms" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_log_duration_non_negative" CHECK ("posting_log"."duration_ms" is null or "posting_log"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "posting_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"line_role" text NOT NULL,
	"item_group" text,
	"partner_group" text,
	"warehouse_code" text,
	"project_code" text,
	"branch_code" text,
	"account_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_line" ADD COLUMN "source_line_id" text;--> statement-breakpoint
ALTER TABLE "journal_line" ADD COLUMN "posting_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_line" ADD COLUMN "line_role" text;--> statement-breakpoint
ALTER TABLE "posting_failure" ADD CONSTRAINT "posting_failure_attempted_by_app_user_id_fk" FOREIGN KEY ("attempted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_log" ADD CONSTRAINT "posting_log_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule" ADD CONSTRAINT "posting_rule_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rule" ADD CONSTRAINT "posting_rule_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posting_failure_source_idx" ON "posting_failure" USING btree ("source_module","source_doc_id","source_event");--> statement-breakpoint
CREATE INDEX "posting_failure_open_idx" ON "posting_failure" USING btree ("occurred_at") WHERE "posting_failure"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "posting_log_source_idx" ON "posting_log" USING btree ("source_module","source_doc_id","source_event");--> statement-breakpoint
CREATE INDEX "posting_log_event_idx" ON "posting_log" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rule_criteria_uniq" ON "posting_rule" USING btree ("event_type","line_role",coalesce("item_group", ''),coalesce("partner_group", ''),coalesce("warehouse_code", ''),coalesce("project_code", ''),coalesce("branch_code", ''));--> statement-breakpoint
CREATE INDEX "posting_rule_lookup_idx" ON "posting_rule" USING btree ("event_type","line_role");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.7.
-- ===========================================================================

-- Traceability, as foreign keys rather than as loose text. 02.7's gate:
-- "every journal line resolves to source document, source line, posting rule
-- and actor."
ALTER TABLE journal_line
  ADD CONSTRAINT journal_line_posting_rule_fk
  FOREIGN KEY (posting_rule_id) REFERENCES posting_rule(id);--> statement-breakpoint

ALTER TABLE posting_failure
  ADD CONSTRAINT posting_failure_resolved_journal_fk
  FOREIGN KEY (resolved_journal_id) REFERENCES journal_entry(id);--> statement-breakpoint

ALTER TABLE posting_log
  ADD CONSTRAINT posting_log_journal_fk
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entry(id);--> statement-breakpoint

-- The log and the failure queue are evidence. §24 expects them to answer
-- "what posted, what did not, and why" long after the fact.
CREATE TRIGGER posting_log_append_only
  BEFORE UPDATE OR DELETE ON posting_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- The failure queue is append-only except for the two columns that record a
-- replay succeeding: a failure is never edited away, it is closed out.
CREATE FUNCTION posting_failure_resolution_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type     IS DISTINCT FROM OLD.event_type
  OR NEW.source_module  IS DISTINCT FROM OLD.source_module
  OR NEW.source_doc_id  IS DISTINCT FROM OLD.source_doc_id
  OR NEW.source_event   IS DISTINCT FROM OLD.source_event
  OR NEW.request        IS DISTINCT FROM OLD.request
  OR NEW.error_code     IS DISTINCT FROM OLD.error_code
  OR NEW.error_message  IS DISTINCT FROM OLD.error_message
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION
      'A recorded posting failure cannot be edited. It is closed out by a successful replay, not rewritten (§24).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER posting_failure_resolution_only
  BEFORE UPDATE ON posting_failure
  FOR EACH ROW EXECUTE FUNCTION posting_failure_resolution_only();--> statement-breakpoint

CREATE TRIGGER posting_failure_no_delete
  BEFORE DELETE ON posting_failure
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A mapping may only point at an account that can actually take a posting.
--
-- Otherwise the configuration looks complete and every posting through it fails
-- at run time — which is the worst place to discover it, because by then a
-- business document is waiting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION posting_rule_account_postable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account chart_of_account%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM chart_of_account WHERE id = NEW.account_id;

  IF v_account.is_group THEN
    RAISE EXCEPTION
      'Account % is a group and cannot be mapped: nothing posts to a group (§02.1).',
      v_account.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_account.approval_status <> 'approved' OR NOT v_account.is_active THEN
    RAISE EXCEPTION
      'Account % is not approved and active, so it cannot be mapped for posting (§3.3).',
      v_account.code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER posting_rule_account_postable
  BEFORE INSERT OR UPDATE ON posting_rule
  FOR EACH ROW EXECUTE FUNCTION posting_rule_account_postable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The posting engine's own permission object.
--
-- `configure` maintains the accounting mappings — the most consequential
-- configuration in the system, since it decides what every future document
-- posts to. `execute` replays a failed posting.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'posting_rule', 'view'),
  ('accounting_manager', 'posting_rule', 'view'),
  ('accounting_manager', 'posting_rule', 'create'),
  ('accounting_manager', 'posting_rule', 'configure'),
  ('accounting_manager', 'posting_rule', 'execute');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON posting_rule, posting_failure, posting_log FROM erp_app;

  GRANT SELECT, INSERT, UPDATE, DELETE ON posting_rule TO erp_app;

  -- Append-only, except that a failure may be marked resolved.
  GRANT SELECT, INSERT, UPDATE ON posting_failure TO erp_app;
  GRANT SELECT, INSERT         ON posting_log     TO erp_app;
END;
$$;