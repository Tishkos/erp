-- ===========================================================================
-- D10, second part — the audit trail's branch policy is not shaped like the
-- others, and 0041 flattened it. This restores the shape and restates it in
-- terms of permitted branches.
--
-- Every other branch policy is symmetric: the rows you may read are the rows
-- you may write. `audit_event` is deliberately not, for two reasons that pull
-- in opposite directions.
--
--   **Read is narrower than the branch rule.** An event with no branch is
--   administration-wide — a failed sign-in, a permission change, a
--   configuration edit — and 0001 made those readable by a Super User only.
--   0041 restated the policy as `branch_code IS NULL OR app_branch_allowed(…)`
--   in both directions, which handed every unbranched security event to every
--   user, and — because a NULL test needs no session at all — to a connection
--   with no `app.user_id` set. That is the opposite of deny-by-default.
--
--   **Write is wider than the branch rule.** §25 requires authorisation
--   failures to be logged, and the most important one to keep is a user
--   reaching for a branch they do not hold. That record names the refused
--   branch, so under D10 it is by definition a branch the actor is not
--   permitted. A policy that refuses it is a policy under which the one event
--   most worth having is the one event that cannot be written.
--
--   Until now that row got in by accident: 0001 checked the row's branch
--   against the *session* branch, and `authorize()` records the refusal on a
--   connection scoped to the branch being refused. D10 removed the session
--   branch's authority, so the accident stopped working — which is the right
--   time to make the exception explicit and bound it.
--
-- The exception is bounded two ways, so it widens the record and nothing else:
--   * `outcome = 'denied'` — only the record of a refusal. A *successful*
--     action still cannot be written into a branch the actor does not hold.
--   * `actor_user_id = app_current_user()` — you may record your own refusal,
--     never one attributed to somebody else.
--
-- Writing is not reading. None of this lets an actor read back the row they
-- just wrote: the USING clause is unchanged by the exception, so a denial
-- recorded against BSR is visible to BSR and to a Super User, and not to its
-- own author. That asymmetry is the point — the subject of an audit record is
-- not its audience.
-- ===========================================================================

DROP POLICY audit_event_branch_scope ON audit_event;--> statement-breakpoint

CREATE POLICY audit_event_branch_scope ON audit_event
  USING (
    app_is_super_user()
    OR (branch_code IS NOT NULL AND app_branch_allowed(branch_code))
  )
  WITH CHECK (
    app_is_super_user()
    OR branch_code IS NULL
    OR app_branch_allowed(branch_code)
    OR (outcome = 'denied' AND actor_user_id = app_current_user())
  );--> statement-breakpoint

COMMENT ON POLICY audit_event_branch_scope ON audit_event IS
  'D10 (2026-08-17). Read: your permitted branches; unbranched administration-wide '
  'events are Super User only. Write: your permitted branches, no branch, or your own '
  'refusal — a scope denial names the branch it was refused, so it can never be in one.';
