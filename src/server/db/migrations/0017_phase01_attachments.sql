CREATE TYPE "public"."attachment_scan_status" AS ENUM('pending', 'clean', 'infected', 'failed');--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"scan_status" "attachment_scan_status" DEFAULT 'pending' NOT NULL,
	"scan_detail" text,
	"scanned_at" timestamp with time zone,
	"retention_until" date,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"disposed_at" timestamp with time zone,
	"disposed_by" uuid,
	"uploaded_by" uuid NOT NULL,
	"branch_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_size_positive" CHECK ("attachment"."size_bytes" > 0),
	CONSTRAINT "attachment_version_positive" CHECK ("attachment"."version" >= 1),
	CONSTRAINT "attachment_hash_shape" CHECK ("attachment"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachment_scan_result_complete" CHECK (("attachment"."scan_status" = 'pending') = ("attachment"."scanned_at" is null)),
	CONSTRAINT "attachment_disposal_complete" CHECK (("attachment"."disposed_at" is null) = ("attachment"."disposed_by" is null)),
	CONSTRAINT "attachment_hold_blocks_disposal" CHECK (not ("attachment"."legal_hold" and "attachment"."disposed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "attachment_access" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attachment_access_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"attachment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"denied" boolean DEFAULT false NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_access_denial_has_reason" CHECK ((not "attachment_access"."denied") or "attachment_access"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_disposed_by_app_user_id_fk" FOREIGN KEY ("disposed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_app_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_access" ADD CONSTRAINT "attachment_access_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_access" ADD CONSTRAINT "attachment_access_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_parent_idx" ON "attachment" USING btree ("object_type","object_id","version");--> statement-breakpoint
CREATE INDEX "attachment_hash_idx" ON "attachment" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_storage_key_uniq" ON "attachment" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_supersedes_uniq" ON "attachment" USING btree ("supersedes_id") WHERE "attachment"."supersedes_id" is not null;--> statement-breakpoint
CREATE INDEX "attachment_access_attachment_idx" ON "attachment_access" USING btree ("attachment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "attachment_access_user_idx" ON "attachment_access" USING btree ("user_id","occurred_at");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.8.
-- ===========================================================================

-- The version chain, in both directions. Added after the table because both
-- keys point back at it.
ALTER TABLE attachment
  ADD CONSTRAINT attachment_supersedes_fk
  FOREIGN KEY (supersedes_id) REFERENCES attachment(id);--> statement-breakpoint

ALTER TABLE attachment
  ADD CONSTRAINT attachment_superseded_by_fk
  FOREIGN KEY (superseded_by_id) REFERENCES attachment(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §21 — "later versions do not overwrite prior versions", and "financial
-- evidence attached to a posted transaction is immutable."
--
-- Everything that identifies the file is frozen the moment it is written. What
-- may change afterwards is the scan result, the version links, the retention
-- metadata and the disposal record — the things that happen *to* a document
-- rather than the document itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION attachment_content_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.object_type  IS DISTINCT FROM OLD.object_type
  OR NEW.object_id    IS DISTINCT FROM OLD.object_id
  OR NEW.file_name    IS DISTINCT FROM OLD.file_name
  OR NEW.content_type IS DISTINCT FROM OLD.content_type
  OR NEW.size_bytes   IS DISTINCT FROM OLD.size_bytes
  OR NEW.sha256       IS DISTINCT FROM OLD.sha256
  OR NEW.storage_key  IS DISTINCT FROM OLD.storage_key
  OR NEW.version      IS DISTINCT FROM OLD.version
  OR NEW.uploaded_by  IS DISTINCT FROM OLD.uploaded_by THEN
    RAISE EXCEPTION
      'An attachment cannot be altered. Upload a new version — the previous one stays retrievable (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A version chain is written once. Re-pointing it would let a later upload
  -- quietly take the place of an earlier one, which is the overwrite §21 forbids.
  IF OLD.superseded_by_id IS NOT NULL AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id THEN
    RAISE EXCEPTION 'The version this attachment was replaced by cannot be changed (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- §21 — a hold is lifted deliberately and is audited; it is not cleared by a
  -- retention date passing, and disposal cannot race it.
  IF OLD.disposed_at IS NOT NULL AND NEW.disposed_at IS NULL THEN
    RAISE EXCEPTION 'A disposal cannot be undone (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER attachment_content_immutable
  BEFORE UPDATE ON attachment
  FOR EACH ROW EXECUTE FUNCTION attachment_content_immutable();--> statement-breakpoint

-- §1.1 — nothing saved is deleted. An attachment is disposed of, which is a
-- recorded administrative act, not a DELETE.
CREATE TRIGGER attachment_no_delete
  BEFORE DELETE ON attachment
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Every read is evidence of a read. §21 wants downloads in the audit trail, and
-- an access log that can be edited records nothing.
CREATE TRIGGER attachment_access_append_only
  BEFORE UPDATE OR DELETE ON attachment_access
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'attachment', 'view'),
  ('accounting_officer', 'attachment', 'create'),
  ('accounting_manager', 'attachment', 'view'),
  ('accounting_manager', 'attachment', 'create'),
  ('accounting_manager', 'attachment', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON attachment, attachment_access FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON attachment        TO erp_app;
  GRANT SELECT, INSERT         ON attachment_access TO erp_app;
END;
$$;
