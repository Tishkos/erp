-- An import application says when it moves.
--
-- By direction (2026-10-03): "also mention import aplicaiton stages he should
-- let us know everything".
--
-- The stage was already recorded — `recomputeStage` writes a STAGE_CHANGED
-- event on the document's own log, which anybody looking at the document can
-- read. Nobody was told. An import takes weeks and the stage is the one fact
-- that says where it has got to, so the person who asked for the import hears
-- it when it changes rather than by opening the screen to check.
--
-- Once per stage, not once per move: the event's occurrence is the stage
-- reached, so a recompute that lands on the same stage again says nothing, and
-- every stage the document actually reaches is announced exactly once.
--
-- To the CEO, by the means their contact allows. The accounting manager works
-- the document and watches it on the screen; it is the person waiting on the
-- goods who needs telling.

INSERT INTO notification_rule (code, description, event_type, recipient_role, channels, escalate_after_seconds, escalate_to_role, active) VALUES
	('ceo_payable_stage_changed',
	 'An import application reached a new stage — the CEO hears of it (REQ-AP-001 §17).',
	 'payable.stage.changed', 'ceo', ARRAY['in_app','whatsapp']::notification_channel[], NULL, NULL, true)
ON CONFLICT (code) DO NOTHING;
