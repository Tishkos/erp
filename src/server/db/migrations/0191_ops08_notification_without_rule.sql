-- A notification can be sent to somebody who asked for it — Operations block 8
-- (2026-09-12).
--
-- Every notification so far has come from a rule: an event happens, §21's
-- rules say which role hears about it, and the people in that role are told.
-- `rule_code` was NOT NULL because there was no other way for one to exist.
--
-- Block 8 has another. "Every status change sends a notification to the
-- selected system users" — selected, by name, not by role. There is no rule
-- behind those messages and recording one would claim a configuration
-- decision nobody made, which is the same reason a posting line that names its
-- own account records no posting rule.
ALTER TABLE "notification" ALTER COLUMN "rule_code" DROP NOT NULL;

COMMENT ON COLUMN "notification"."rule_code" IS
  'The §21 rule that raised this, or null when it was sent to somebody who asked '
  'to be told rather than to a role the rules name.';
