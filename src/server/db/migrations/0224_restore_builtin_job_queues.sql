-- Built-in job queue policies are operational configuration, not test data.
-- The live-database formatter used to truncate job_queue, which removed the
-- notification.deliver policy and made receipt posting fail when a rule
-- raised a notification. Restore missing built-ins without overwriting any
-- existing operator policy.
INSERT INTO job_queue
  (name, description, owner_role, retry_limit, retry_delay_seconds, retry_backoff,
   target_seconds, retryable_by_support)
VALUES
  ('posting.posted',
   'Emitted after a journal commits. Downstream subscribers react to it (§24).',
   'accounting_manager', 5, 30, true, 300, false),
  ('notification.deliver',
   'Delivers an in-app or e-mail notification (§21).',
   'accounting_manager', 5, 60, true, 900, true),
  ('document.expiry_reminder',
   'Reminds a document owner that an attachment or licence is expiring (§21).',
   'accounting_manager', 3, 3600, true, 86400, true)
ON CONFLICT (name) DO NOTHING;
