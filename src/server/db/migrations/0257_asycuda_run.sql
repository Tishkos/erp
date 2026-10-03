-- The ASYCUDA update, kept as a run — REQ-AP-001 §21.8.
--
-- The screen read a pasted list, showed the difference and applied it, and
-- kept nothing: what customs said last Tuesday, and which file it came from,
-- was gone the moment the page was closed. That is thin for a step this
-- important (by direction, 2026-10-02) — the declaration status is what
-- releases a payment, so "when did ASYCUDA say this, and on whose reading?"
-- has to be answerable afterwards.
--
-- So an update is a run, the way a legacy import is: the list exactly as it
-- was read, the file it came from, the difference computed at that moment,
-- who read it and who applied it. The difference is kept as JSON beside the
-- text rather than in a child table, exactly as `legacy_import_run.report`
-- is — it is a record of what was seen, never queried across runs.
--
-- Applying stays what it was: `customs_pd_history` rows with source
-- `asycuda_list`. This table says where that reading came from.

CREATE TABLE IF NOT EXISTS "asycuda_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- 'file' when a report was uploaded, 'paste' when the list was typed in.
	"source" text NOT NULL,
	-- The uploaded files' names, in the order given; an empty array for a paste.
	"file_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- SHA-256 over the lines as read — what "the same list again" means.
	"text_sha256" text NOT NULL,
	-- The lines themselves, so the difference can be recomputed and the run
	-- re-read long after the file has gone.
	"line_text" text NOT NULL,
	-- The difference at the moment it was read: one entry per line.
	"report" jsonb NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"change_count" integer DEFAULT 0 NOT NULL,
	"unreadable_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"read_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_by" uuid REFERENCES "app_user"("id"),
	"applied_at" timestamp with time zone,
	CONSTRAINT "asycuda_run_source_known" CHECK ("source" IN ('file', 'paste')),
	CONSTRAINT "asycuda_run_status_known" CHECK ("status" IN ('previewed', 'applied')),
	-- Applied means both halves of the fact, or neither.
	CONSTRAINT "asycuda_run_applied_whole" CHECK (
		("status" = 'applied' AND "applied_by" IS NOT NULL AND "applied_at" IS NOT NULL)
		OR ("status" = 'previewed' AND "applied_by" IS NULL AND "applied_at" IS NULL)
	)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "asycuda_run_read_idx" ON "asycuda_run" USING btree ("read_at" DESC);--> statement-breakpoint

ALTER TABLE "asycuda_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asycuda_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'asycuda_run' AND policyname = 'asycuda_run_scope') THEN
		CREATE POLICY asycuda_run_scope ON "asycuda_run" USING (app_signed_in()) WITH CHECK (app_signed_in());
	END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
	GRANT SELECT, INSERT, UPDATE ON "asycuda_run" TO erp_app;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
