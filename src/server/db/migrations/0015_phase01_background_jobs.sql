CREATE TYPE "public"."job_outbox_status" AS ENUM('pending', 'dispatched', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."job_run_status" AS ENUM('queued', 'active', 'completed', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TABLE "job_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"queue_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"status" "job_outbox_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"abandoned_reason" text,
	"created_by" uuid,
	"branch_code" text,
	CONSTRAINT "job_outbox_dispatched_at_matches" CHECK (("job_outbox"."status" = 'dispatched') = ("job_outbox"."dispatched_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text,
	"owner_role" text NOT NULL,
	"retry_limit" integer DEFAULT 3 NOT NULL,
	"retry_delay_seconds" integer DEFAULT 30 NOT NULL,
	"retry_backoff" boolean DEFAULT true NOT NULL,
	"target_seconds" integer DEFAULT 300 NOT NULL,
	"retryable_by_support" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "job_queue_retry_limit_range" CHECK ("job_queue"."retry_limit" between 0 and 20),
	CONSTRAINT "job_queue_target_positive" CHECK ("job_queue"."target_seconds" > 0),
	CONSTRAINT "job_queue_owner_present" CHECK (btrim("job_queue"."owner_role") <> '')
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_run_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"queue_name" text NOT NULL,
	"outbox_id" bigint,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"status" "job_run_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"replayed_from" bigint,
	"replayed_by" uuid,
	CONSTRAINT "job_run_attempt_non_negative" CHECK ("job_run"."attempt" >= 0),
	CONSTRAINT "job_run_completed_at_matches" CHECK (("job_run"."status" in ('completed','dead_letter')) = ("job_run"."completed_at" is not null)),
	CONSTRAINT "job_run_error_matches_status" CHECK (case
            when "job_run"."status" in ('failed','dead_letter') then "job_run"."error_message" is not null
            when "job_run"."status" = 'queued'                  then "job_run"."error_message" is null
            else true
          end)
);
--> statement-breakpoint
ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_queue_name_job_queue_name_fk" FOREIGN KEY ("queue_name") REFERENCES "public"."job_queue"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_queue_name_job_queue_name_fk" FOREIGN KEY ("queue_name") REFERENCES "public"."job_queue"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_outbox_id_job_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."job_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_replayed_by_app_user_id_fk" FOREIGN KEY ("replayed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_outbox_pending_idx" ON "job_outbox" USING btree ("created_at") WHERE "job_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "job_outbox_key_idx" ON "job_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_run_queue_status_idx" ON "job_run" USING btree ("queue_name","status","created_at");--> statement-breakpoint
CREATE INDEX "job_run_open_idx" ON "job_run" USING btree ("created_at") WHERE "job_run"."status" <> 'completed';--> statement-breakpoint
CREATE INDEX "job_run_key_idx" ON "job_run" USING btree ("idempotency_key");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.10.
-- ===========================================================================

-- A replay points at the run it replaces, so a dead letter and its retry are
-- one story rather than two unrelated rows.
ALTER TABLE job_run
  ADD CONSTRAINT job_run_replayed_from_fk
  FOREIGN KEY (replayed_from) REFERENCES job_run(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §25 — "Support tools may inspect status … but may not edit posted financial
-- data."
--
-- The job history is the thing support reads. A run that could be edited would
-- let a failure be tidied away, which is the one thing the record exists to
-- prevent. Terminal runs are frozen; a live one may only move forward.
-- ---------------------------------------------------------------------------
CREATE FUNCTION job_run_history_preserved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'dead_letter') THEN
    IF NEW.status        IS DISTINCT FROM OLD.status
    OR NEW.payload       IS DISTINCT FROM OLD.payload
    OR NEW.error_message IS DISTINCT FROM OLD.error_message
    OR NEW.attempt       IS DISTINCT FROM OLD.attempt THEN
      RAISE EXCEPTION
        'A finished job run cannot be rewritten. Replay it if it should run again — the failure stays on the record (§25).'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.queue_name IS DISTINCT FROM OLD.queue_name THEN
    RAISE EXCEPTION 'A job cannot be moved between queues.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER job_run_history_preserved
  BEFORE UPDATE ON job_run
  FOR EACH ROW EXECUTE FUNCTION job_run_history_preserved();--> statement-breakpoint

CREATE TRIGGER job_run_no_delete
  BEFORE DELETE ON job_run
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- An outbox row is the record that an event was owed. Once dispatched it is
-- evidence that it was handed over, and it is not deleted.
CREATE FUNCTION job_outbox_dispatch_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'dispatched' AND NEW.status <> 'dispatched' THEN
    RAISE EXCEPTION
      'A dispatched event cannot be returned to the outbox. Enqueue a new one if it must happen again.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.queue_name IS DISTINCT FROM OLD.queue_name THEN
    RAISE EXCEPTION 'An outbox event cannot be rewritten after the fact.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER job_outbox_dispatch_final
  BEFORE UPDATE ON job_outbox
  FOR EACH ROW EXECUTE FUNCTION job_outbox_dispatch_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The queues this release needs.
--
-- `posting.posted` is the one §24 names: the posting engine's after-commit
-- event. It is **not** replayable by support — delivery is at-least-once and a
-- replay may be a second delivery, which on a financial event is a second
-- effect. Notifications are replayable, because a duplicate notification is an
-- annoyance rather than a misstatement.
-- ---------------------------------------------------------------------------
INSERT INTO job_queue
  (name, description, owner_role, retry_limit, retry_delay_seconds, retry_backoff,
   target_seconds, retryable_by_support) VALUES
  ('posting.posted',
   'Emitted after a journal commits. Downstream subscribers react to it (§24).',
   'accounting_manager', 5, 30, true, 300, false),
  ('notification.deliver',
   'Delivers an in-app or e-mail notification (§21).',
   'accounting_manager', 5, 60, true, 900, true),
  ('document.expiry_reminder',
   'Reminds a document owner that an attachment or licence is expiring (§21).',
   'accounting_manager', 3, 3600, true, 86400, true);--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'job', 'view'),
  ('accounting_manager', 'job', 'execute'),
  ('accounting_officer', 'job', 'view');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON job_queue, job_outbox, job_run FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON job_queue  TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON job_outbox TO erp_app;
  -- No DELETE: a job run is the record support reads.
  GRANT SELECT, INSERT, UPDATE ON job_run    TO erp_app;
END;
$$;