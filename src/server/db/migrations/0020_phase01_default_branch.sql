ALTER TABLE "user_branch_scope" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_branch_scope_default_uniq" ON "user_branch_scope" USING btree ("user_id") WHERE "user_branch_scope"."is_default";--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.12.
-- ===========================================================================

-- Existing users get their alphabetically first branch as the default, so that
-- nobody is left with an arbitrary landing branch decided by the query plan.
-- Administrators set the real one on the Data Scopes screen; this only removes
-- the ambiguity for rows that already exist.
UPDATE user_branch_scope s
   SET is_default = true
 WHERE branch_code = (
   SELECT min(branch_code) FROM user_branch_scope x WHERE x.user_id = s.user_id
 )
   AND NOT EXISTS (
     SELECT 1 FROM user_branch_scope d WHERE d.user_id = s.user_id AND d.is_default
   );
