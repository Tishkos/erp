-- ===========================================================================
-- The status log keeps its order inside one transaction — REQ-AP-001 §7.3.
--
-- `now()` is transaction-stable: the four events one creation writes all
-- carried the same recorded_at, and uuid tie-breaks shuffled the story.
-- `clock_timestamp()` is the server clock §7.1 actually means — the moment
-- each row was written, microsecond resolution, strictly useful for ordering.
-- ===========================================================================

ALTER TABLE payable_event ALTER COLUMN recorded_at SET DEFAULT clock_timestamp();
