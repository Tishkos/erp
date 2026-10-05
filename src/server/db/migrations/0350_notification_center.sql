-- ===========================================================================
-- Platform phase · Agent 6 — the notification centre (2026-10-04).
-- HAND-AUTHORED. Additive; no applied migration is touched.
--
-- One `notification` table, one delivery runner, one bell. This migration
-- makes the table the person's own and makes the bell cheap:
--
--   * A notification is read and changed only by its recipient. 0238 let a
--     super user read everybody's, which would hand a chat message's preview
--     (the notification body) to someone outside the conversation (C-60). The
--     scheduled jobs that really do read everyone's mark their transaction as
--     a system sweep (`app.system_sweep`), as before; no web request does.
--   * What a notification *says* never changes after it is raised. Only its
--     read state (and the system's acted/escalated marks) moves: read_at goes
--     both ways, so "mark as unread" is a real state, stored per recipient.
--   * The bell's two questions — how many unread, and the unread list — have
--     partial / composite indexes of their own.
--   * Everybody with a role may open their own notifications screen: `view`
--     on `notification` (until now the accounting roles' alone) is given to
--     every existing role, as `chat` was.
--   * The System Health check "deliveries stuck" counted other people's
--     notifications as a super user; it asks through a definer function now.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The bell
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS notification_unread_idx
  ON notification (recipient_user_id, created_at DESC) WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_kind_idx
  ON notification (recipient_user_id, event_type, created_at DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Whose it is (C-70)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS notification_read ON notification;--> statement-breakpoint
CREATE POLICY notification_read ON notification FOR SELECT
  USING (recipient_user_id = app_current_user()
         OR current_setting('app.system_sweep', true) = 'on');--> statement-breakpoint

DROP POLICY IF EXISTS notification_update ON notification;--> statement-breakpoint
CREATE POLICY notification_update ON notification FOR UPDATE
  USING (recipient_user_id = app_current_user()
         OR current_setting('app.system_sweep', true) = 'on')
  WITH CHECK (recipient_user_id = app_current_user()
              OR current_setting('app.system_sweep', true) = 'on');--> statement-breakpoint

-- What it says never changes (C-70): the recipient, the kind, the subject,
-- the text, the context, the rule and the moment are fixed at raise time. The
-- read mark moves both ways; acted and escalated stay forward-only (0016).
CREATE OR REPLACE FUNCTION notification_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dedupe_key IS DISTINCT FROM NEW.dedupe_key THEN
    RAISE EXCEPTION 'The duplicate-suppression key cannot be changed — it is what makes "once" true (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
  OR OLD.event_type        IS DISTINCT FROM NEW.event_type
  OR OLD.object_type       IS DISTINCT FROM NEW.object_type
  OR OLD.object_id         IS DISTINCT FROM NEW.object_id
  OR OLD.subject           IS DISTINCT FROM NEW.subject
  OR OLD.body              IS DISTINCT FROM NEW.body
  OR OLD.context           IS DISTINCT FROM NEW.context
  OR OLD.rule_code         IS DISTINCT FROM NEW.rule_code
  OR OLD.branch_code       IS DISTINCT FROM NEW.branch_code
  OR OLD.created_at        IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'A notification is not edited: what it says, to whom and when are fixed when it is raised. Only its read mark moves.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.acted_at IS NOT NULL AND NEW.acted_at IS NULL THEN
    RAISE EXCEPTION 'A task that was acted upon cannot become outstanding again.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS NULL THEN
    RAISE EXCEPTION 'An escalation that happened cannot be un-happened (§5.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- System Health: deliveries that waited more than a day, across everybody.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_deliveries_stuck() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int FROM notification_delivery d
   WHERE d.status = 'pending' AND d.last_attempt_at IS NULL
     AND EXISTS (SELECT 1 FROM notification n
                  WHERE n.id = d.notification_id AND n.created_at < now() - interval '1 day');
$$;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app_deliveries_stuck() FROM PUBLIC;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The screen: every role may open its own notifications.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'notification', 'view'
  FROM role r
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;
  GRANT EXECUTE ON FUNCTION app_deliveries_stuck() TO erp_app;
END;
$$;
