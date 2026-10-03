-- ===========================================================================
-- Hold notifications — REQ-AP-001 §19.4.
--
-- Role-recipient rules through the existing notification service. The reason
-- code's default role is who the sweep's holds wait for (D2); the rule here
-- is the channel that tells them. Escalation past the limit's own days is
-- the sweep's job and lands as its own event type.
-- ===========================================================================

INSERT INTO notification_rule
  (code, description, event_type, recipient_role, channels)
VALUES
  ('payable_hold_opened',
   'A payable was stopped — a hold needs its reason, owner and next action (REQ-AP-001 §19).',
   'payable.hold.opened', 'accounting_officer', ARRAY['in_app']),
  ('payable_hold_escalated',
   'A payable hold has waited past its escalation limit with no owner or no progress (REQ-AP-001 §19.4).',
   'payable.hold.escalated', 'accounting_manager', ARRAY['in_app']);
