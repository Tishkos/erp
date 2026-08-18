CREATE TYPE "public"."import_batch_status" AS ENUM('draft', 'validated', 'committed', 'rolled_back', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('pending', 'valid', 'invalid', 'committed');--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_key" text NOT NULL,
	"file_name" text,
	"status" "import_batch_status" DEFAULT 'draft' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"branch_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"committed_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rollback_reason" text,
	CONSTRAINT "import_batch_counts_consistent" CHECK ("import_batch"."valid_rows" + "import_batch"."invalid_rows" <= "import_batch"."total_rows"),
	CONSTRAINT "import_batch_committed_at_matches" CHECK (("import_batch"."status" = 'committed') = ("import_batch"."committed_at" is not null)
          or "import_batch"."status" = 'rolled_back')
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_row_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"source_id" text,
	"raw_values" jsonb NOT NULL,
	"status" "import_row_status" DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"error_message" text,
	"target_id" text,
	CONSTRAINT "import_row_error_matches_status" CHECK (("import_row"."status" = 'invalid') = ("import_row"."error_message" is not null))
);
--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_status_idx" ON "import_batch" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_no_uniq" ON "import_row" USING btree ("batch_id","row_no");--> statement-breakpoint
CREATE INDEX "import_row_status_idx" ON "import_row" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_row_source_idx" ON "import_row" USING btree ("source_id");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.11.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §4.4 — "rollback before final posting."
--
-- A committed batch is evidence: it says which rows became which records. It
-- may be rolled back — which sets a status and a reason — but it may not be
-- edited or deleted, because a migration nobody can audit is not a migration.
-- ---------------------------------------------------------------------------
CREATE FUNCTION import_batch_history_preserved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('committed', 'rolled_back') THEN
    RETURN NEW;
  END IF;

  IF NEW.definition_key IS DISTINCT FROM OLD.definition_key
  OR NEW.total_rows     IS DISTINCT FROM OLD.total_rows
  OR NEW.created_by     IS DISTINCT FROM OLD.created_by
  OR NEW.committed_at   IS DISTINCT FROM OLD.committed_at THEN
    RAISE EXCEPTION
      'A committed import batch cannot be edited. Roll it back if it was wrong — the record of what was imported stays (§4.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER import_batch_history_preserved
  BEFORE UPDATE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION import_batch_history_preserved();--> statement-breakpoint

CREATE FUNCTION import_batch_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('committed', 'rolled_back') THEN
    RAISE EXCEPTION
      'Import batch % has been committed and cannot be deleted. It is the record of where those rows came from (§26).',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER import_batch_no_delete
  BEFORE DELETE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION import_batch_no_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §5.3 — `import` is its own verb.
--
-- Granting someone the right to create a record one at a time is not the same
-- as granting them the right to create ten thousand at once, and §5.3 keeps the
-- two separate. The Manager holds it; the Officer does not.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'business_partner', 'import'),
  ('accounting_manager', 'item',             'import'),
  ('accounting_manager', 'chart_of_account', 'import');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON import_batch, import_row FROM erp_app;

  -- A draft batch is deleted when abandoned; a committed one never is.
  GRANT SELECT, INSERT, UPDATE, DELETE ON import_batch TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON import_row   TO erp_app;
END;
$$;