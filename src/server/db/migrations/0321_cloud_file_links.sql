-- ===========================================================================
-- Platform phase, Agent 4 — links between a cloud file and an ERP record.
-- HAND-AUTHORED. Everything additive.
--
-- A link is a fact about two things that live elsewhere: a file (or folder) in
-- QS Cloud Files, known by Nextcloud's numeric file id, and an ERP record,
-- known by its object type and the id its paperclip files under. There are no
-- bytes here and no copy of the cloud's tree — only the name the linker saw,
-- kept so a link can be told apart from another and found again when the file
-- has been moved.
--
-- Document -> record and record -> documents are the two ways to read this
-- one table. A link is ended, never deleted: `unlinked_*` say who and why, and
-- the row stays as the evidence that the file once belonged to the record.
-- Whether a person may MAKE or SEE a link is the registry's question (the
-- record's own access check, in the application) and, here, the grant and the
-- record's branch.
-- ===========================================================================

CREATE TABLE "cloud_file_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- Which installation the file id belongs to.
	"server_url" text NOT NULL,
	"file_id" text NOT NULL,
	"name" text NOT NULL,
	"is_folder" boolean NOT NULL DEFAULT false,
	-- Where the linker saw it. Other people may see the same file elsewhere (a share lands in their root).
	"path" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	-- The record's number, for display; the record is the authority.
	"record_label" text NOT NULL,
	"branch_code" text REFERENCES "branch"("code"),
	"linked_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"linked_at" timestamptz NOT NULL DEFAULT now(),
	"unlinked_by" uuid REFERENCES "app_user"("id"),
	"unlinked_at" timestamptz,
	"unlink_reason" text,
	CONSTRAINT "cloud_file_link_type_shape" CHECK ("object_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "cloud_file_link_file_id_shape" CHECK ("file_id" ~ '^[A-Za-z0-9:_.-]{1,64}$'),
	CONSTRAINT "cloud_file_link_end_is_whole" CHECK (
		("unlinked_at" IS NULL AND "unlinked_by" IS NULL AND "unlink_reason" IS NULL)
		OR ("unlinked_at" IS NOT NULL AND "unlinked_by" IS NOT NULL)
	)
);
--> statement-breakpoint

-- A file is linked to a record once at a time.
CREATE UNIQUE INDEX "cloud_file_link_live_uniq" ON "cloud_file_link" ("server_url", "file_id", "object_type", "object_id")
	WHERE "unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cloud_file_link_record_idx" ON "cloud_file_link" ("object_type", "object_id") WHERE "unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cloud_file_link_file_idx" ON "cloud_file_link" ("server_url", "file_id") WHERE "unlinked_at" IS NULL;--> statement-breakpoint

-- No row is deleted; what was linked is frozen; the name and path follow the
-- file when it moves; an ended link stays ended.
CREATE FUNCTION cloud_file_link_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'cloud_file_link is never deleted: end the link instead.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.server_url IS DISTINCT FROM OLD.server_url
	   OR NEW.file_id IS DISTINCT FROM OLD.file_id
	   OR NEW.object_type IS DISTINCT FROM OLD.object_type
	   OR NEW.object_id IS DISTINCT FROM OLD.object_id
	   OR NEW.record_label IS DISTINCT FROM OLD.record_label
	   OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
	   OR NEW.linked_by IS DISTINCT FROM OLD.linked_by
	   OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
		RAISE EXCEPTION 'cloud_file_link: what a file was linked to cannot be changed.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.unlinked_at IS NOT NULL AND (
		NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at OR NEW.unlinked_by IS DISTINCT FROM OLD.unlinked_by
		OR NEW.unlink_reason IS DISTINCT FROM OLD.unlink_reason OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.path IS DISTINCT FROM OLD.path) THEN
		RAISE EXCEPTION 'cloud_file_link: an ended link stays as it ended.' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "cloud_file_link_guard" BEFORE UPDATE OR DELETE ON "cloud_file_link"
	FOR EACH ROW EXECUTE FUNCTION cloud_file_link_guard();--> statement-breakpoint

ALTER TABLE "cloud_file_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_file_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Read: the Document Center's grant, inside the record's branch (a link with no branch is company-wide).
CREATE POLICY "cloud_file_link_read" ON "cloud_file_link" FOR SELECT
	USING (app_has_grant('cloud_files', 'view')
	       AND (app_is_super_user() OR "branch_code" IS NULL OR app_branch_allowed("branch_code")));--> statement-breakpoint
CREATE POLICY "cloud_file_link_insert" ON "cloud_file_link" FOR INSERT
	WITH CHECK (app_has_grant('cloud_files', 'create')
	            AND "linked_by" = app_current_user()
	            AND (app_is_super_user() OR "branch_code" IS NULL OR app_branch_allowed("branch_code")));--> statement-breakpoint
CREATE POLICY "cloud_file_link_update" ON "cloud_file_link" FOR UPDATE
	USING (app_has_grant('cloud_files', 'create')
	       AND (app_is_super_user() OR "branch_code" IS NULL OR app_branch_allowed("branch_code")))
	WITH CHECK (app_has_grant('cloud_files', 'create')
	            AND (app_is_super_user() OR "branch_code" IS NULL OR app_branch_allowed("branch_code")));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON cloud_file_link TO erp_app;
END;
$$;
