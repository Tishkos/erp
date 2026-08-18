CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_key" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_view_name_present" CHECK (btrim("saved_view"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_name_uniq" ON "saved_view" USING btree ("owner_user_id","list_key","name");--> statement-breakpoint
CREATE INDEX "saved_view_list_idx" ON "saved_view" USING btree ("list_key","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_default_uniq" ON "saved_view" USING btree ("owner_user_id","list_key") WHERE "saved_view"."is_default";--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.12.
-- ===========================================================================

-- A saved view is the user's own working state, not a controlled document, so
-- it is the one thing in the system that may be deleted outright. §3.2's
-- no-deletion rule governs saved and posted *records*; a discarded filter set
-- has no audit meaning and keeping it forever would only clutter the picker.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON saved_view FROM erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON saved_view TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE saved_view ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE saved_view FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- You see your own views, and the ones others chose to share. Sharing widens
-- who may ask the question; the query still runs as the reader, so it can never
-- widen what they are allowed to see.
CREATE POLICY saved_view_read ON saved_view
  FOR SELECT
  USING (is_shared OR owner_user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint

-- Writes are yours alone. A shared view is readable by everyone and editable by
-- its author, so nobody can silently redefine a view someone else relies on.
CREATE POLICY saved_view_write ON saved_view
  FOR INSERT
  WITH CHECK (owner_user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint

CREATE POLICY saved_view_modify ON saved_view
  FOR UPDATE
  USING (owner_user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (owner_user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint

CREATE POLICY saved_view_remove ON saved_view
  FOR DELETE
  USING (owner_user_id = current_setting('app.user_id', true)::uuid);
