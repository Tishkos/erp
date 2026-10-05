-- ===========================================================================
-- Platform phase, Agent 4 — QS Cloud Files (the Document Center's connection).
-- HAND-AUTHORED. Everything additive.
--
-- Nextcloud (files.qs-groups.com) keeps the files and decides who may see
-- them. Qimah keeps only what it needs to ask the cloud on a person's behalf:
--
--   cloud_setting        the one row: on/off, the address, where the Document
--                        Center starts and where record folders are made
--   cloud_group_mapping  ERP role -> Nextcloud group, with read / write / share
--                        (REQ-FIX-001 FIX-6: the mapping on a settings screen)
--   cloud_account        one person's linked cloud account: the app password
--                        from Login Flow v2, SEALED with the server key
--                        (ERP_SECRET_KEY, AES-256-GCM) — never shown again
--   cloud_link_attempt   a Login Flow v2 that has started and not yet finished
--
-- No file bytes and no copy of the cloud's tree live here. A person's account
-- row is theirs alone; an administrator who deactivates them may read it only
-- to revoke the app password at the cloud (the value is useless without the
-- server key).
-- ===========================================================================

CREATE TABLE "cloud_setting" (
	"id" smallint PRIMARY KEY DEFAULT 1,
	"enabled" boolean NOT NULL DEFAULT false,
	"base_url" text,
	-- Where the Document Center starts, as a path in each person's cloud. '/' is their whole cloud.
	"root_path" text NOT NULL DEFAULT '/',
	-- Where a folder made from an ERP record is created: <record_root>/<kind>/<number>.
	"record_root" text NOT NULL DEFAULT '/Qimah',
	"updated_by" uuid REFERENCES "app_user"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "cloud_setting_singleton" CHECK ("id" = 1),
	CONSTRAINT "cloud_setting_on_needs_address" CHECK (NOT "enabled" OR coalesce(btrim("base_url"), '') <> ''),
	CONSTRAINT "cloud_setting_paths_absolute" CHECK ("root_path" LIKE '/%' AND "record_root" LIKE '/%')
);
--> statement-breakpoint

-- The address the company named; off until somebody switches it on.
INSERT INTO "cloud_setting" ("id", "enabled", "base_url") VALUES (1, false, 'https://files.qs-groups.com');
--> statement-breakpoint

CREATE TABLE "cloud_group_mapping" (
	"role_code" text PRIMARY KEY REFERENCES "role"("code"),
	"group_name" text NOT NULL,
	-- Read is always given; these two widen it.
	"can_write" boolean NOT NULL DEFAULT false,
	"can_share" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"deactivated_reason" text,
	"updated_by" uuid REFERENCES "app_user"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "cloud_group_mapping_group_named" CHECK (btrim("group_name") <> ''),
	-- Deactivated with a reason, never deleted.
	CONSTRAINT "cloud_group_mapping_off_has_reason" CHECK ("active" OR coalesce(btrim("deactivated_reason"), '') <> '')
);
--> statement-breakpoint

CREATE TABLE "cloud_account" (
	"user_id" uuid PRIMARY KEY REFERENCES "app_user"("id"),
	-- The installation the app password belongs to; a different address in the settings means link again.
	"server_url" text NOT NULL,
	-- The cloud's own id for the person: the segment of every WebDAV address that is theirs.
	"cloud_user" text NOT NULL,
	"display_name" text,
	-- The app password, sealed (v1.<iv>.<tag>.<ciphertext>). Never the password itself.
	"secret" text NOT NULL,
	"linked_at" timestamptz NOT NULL DEFAULT now(),
	"last_ok_at" timestamptz,
	-- 'unauthorised' once the cloud has refused the password (revoked there): the person links again.
	"last_error" text,
	CONSTRAINT "cloud_account_secret_is_sealed" CHECK ("secret" LIKE 'v1.%.%.%')
);
--> statement-breakpoint

CREATE TABLE "cloud_link_attempt" (
	"user_id" uuid PRIMARY KEY REFERENCES "app_user"("id"),
	"server_url" text NOT NULL,
	"poll_endpoint" text NOT NULL,
	-- Sealed, like the password it will produce.
	"poll_token" text NOT NULL,
	"login_url" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"expires_at" timestamptz NOT NULL,
	CONSTRAINT "cloud_link_attempt_token_is_sealed" CHECK ("poll_token" LIKE 'v1.%.%.%')
);
--> statement-breakpoint

-- Row security. The settings and the mapping are read by everybody signed in
-- (the Document Center must know whether it is on); changing them is the
-- settings screen's grant. An account and an attempt are the person's own;
-- an administrator who may administer users can also see and remove an
-- account, which is what deactivating the person needs.
ALTER TABLE "cloud_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cloud_setting_read" ON "cloud_setting" FOR SELECT USING (app_signed_in());--> statement-breakpoint
CREATE POLICY "cloud_setting_write" ON "cloud_setting" FOR UPDATE
	USING (app_has_grant('cloud_setting', 'configure'))
	WITH CHECK (app_has_grant('cloud_setting', 'configure'));--> statement-breakpoint

ALTER TABLE "cloud_group_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_group_mapping" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cloud_group_mapping_read" ON "cloud_group_mapping" FOR SELECT USING (app_signed_in());--> statement-breakpoint
CREATE POLICY "cloud_group_mapping_insert" ON "cloud_group_mapping" FOR INSERT
	WITH CHECK (app_has_grant('cloud_setting', 'configure'));--> statement-breakpoint
CREATE POLICY "cloud_group_mapping_update" ON "cloud_group_mapping" FOR UPDATE
	USING (app_has_grant('cloud_setting', 'configure'))
	WITH CHECK (app_has_grant('cloud_setting', 'configure'));--> statement-breakpoint

ALTER TABLE "cloud_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cloud_account_read" ON "cloud_account" FOR SELECT
	USING ("user_id" = app_current_user() OR app_has_grant('app_user', 'administer'));--> statement-breakpoint
CREATE POLICY "cloud_account_insert" ON "cloud_account" FOR INSERT
	WITH CHECK ("user_id" = app_current_user());--> statement-breakpoint
CREATE POLICY "cloud_account_update" ON "cloud_account" FOR UPDATE
	USING ("user_id" = app_current_user())
	WITH CHECK ("user_id" = app_current_user());--> statement-breakpoint
CREATE POLICY "cloud_account_delete" ON "cloud_account" FOR DELETE
	USING ("user_id" = app_current_user() OR app_has_grant('app_user', 'administer'));--> statement-breakpoint

ALTER TABLE "cloud_link_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_link_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cloud_link_attempt_own" ON "cloud_link_attempt"
	USING ("user_id" = app_current_user())
	WITH CHECK ("user_id" = app_current_user());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, UPDATE                 ON cloud_setting       TO erp_app;
	GRANT SELECT, INSERT, UPDATE         ON cloud_group_mapping TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_account       TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_link_attempt  TO erp_app;
END;
$$;
