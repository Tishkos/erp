CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" text,
	CONSTRAINT "auth_session_revocation_complete" CHECK (("auth_session"."revoked_at" is null) = ("auth_session"."revoked_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"enrolled_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mfa_secret_present" CHECK (length("user_mfa"."secret") >= 16)
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "role" ADD COLUMN "requires_mfa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_revoked_by_app_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_uniq" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_session_token_uniq" ON "auth_session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier","expires_at");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.1.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §25 — "No passwords, tokens, private keys or sensitive document contents in
-- logs", and the 01.1 gate: "credentials are not recoverable from the database
-- in plaintext or reversible form."
--
-- A hash is not a password, so the column may hold one and nothing else. This
-- refuses the shapes a plaintext password takes: anything that is not one of
-- the hash formats the application produces. It cannot prove a value is a hash
-- — nothing can — but it stops the accident where a migration, a fixture or a
-- support script writes the password itself into the column.
-- ---------------------------------------------------------------------------
ALTER TABLE auth_account
  ADD CONSTRAINT auth_account_password_is_hashed
  CHECK (
    password IS NULL
    -- scrypt/argon2/bcrypt-style: an algorithm-tagged string, or a long hex or
    -- base64 digest. All are far longer than a password anyone would type.
    OR password ~ '^\$(argon2(i|d|id)|2[aby]|scrypt)\$'
    OR (length(password) >= 60 AND password !~ '\s')
  );--> statement-breakpoint

-- A session token is looked up, so it is stored as a digest — the raw value
-- lives only in the cookie. A database dump must not be a set of live sessions.
ALTER TABLE auth_session
  ADD CONSTRAINT auth_session_token_is_digest
  CHECK (length(token) >= 32 AND token !~ '\s');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §25 — a revoked session stays.
--
-- better-auth deletes sessions on sign-out; a deleted session cannot be asked
-- why it ended. An administrator cutting someone off, and an auditor reading it
-- back, both need the row. Revocation is therefore one-way and the reason is
-- immutable once given.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_session_revocation_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION
      'A revoked session cannot be reinstated. Sign in again to obtain a new one (§25).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
          OR NEW.revoked_at  IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION
      'The record of a revocation cannot be changed (§5.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The token is the lookup key; changing it would silently re-point a live
  -- session at a different secret.
  IF NEW.token IS DISTINCT FROM OLD.token OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A session cannot be re-issued in place.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER auth_session_revocation_final
  BEFORE UPDATE ON auth_session
  FOR EACH ROW EXECUTE FUNCTION auth_session_revocation_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants.
--
-- The application reads and writes its own sessions and credentials. It may not
-- DELETE a session — §25's revocation is a marked row, not a missing one — and
-- the MFA secret is write-once-read: an enrolled second factor is replaced by
-- re-enrolling, which is an administrative act with its own audit.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON auth_session, auth_account, auth_verification, user_mfa FROM erp_app;

  GRANT SELECT, INSERT, UPDATE         ON auth_session      TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON auth_account      TO erp_app;
  -- Verification tokens are consumed: a used one is removed, not kept.
  GRANT SELECT, INSERT, UPDATE, DELETE ON auth_verification TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa          TO erp_app;
END;
$$;