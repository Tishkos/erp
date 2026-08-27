-- Phase 1 — Business Line is not a dimension anybody can supply yet.
--
-- §4.2 makes Business Line mandatory on revenue and expense accounts, and that
-- rule is right: a Profit or Loss that cannot be cut by business line is worth
-- less than one that can. But the Business Line master is detailed accounting
-- Master Data, which Phase 1 explicitly excludes.
--
-- Left as it stands, the two facts collide: every journal touching a revenue or
-- an expense account is refused for a dimension the system offers no way to
-- fill in. That is not a control — a control that cannot be satisfied is a
-- broken screen — and the phase cannot produce a Statement of Profit or Loss
-- at all, which is requirement 5.
--
-- So the requirement is relaxed for manual journals, using the per-document
-- override that exists for exactly this: `document_type_dimension` beats the
-- account-type default. Two things are worth being clear about:
--
--   * It is relaxed to `optional`, not removed. A journal *may* carry a
--     business line the day the master arrives, and the ones entered before
--     then are simply unclassified rather than wrong.
--   * It is relaxed for `journal_entry` only. Every other document type still
--     inherits the account-type default, so nothing else quietly loosens.
--
-- Tighten this to `mandatory` when the Business Line master ships.

INSERT INTO document_type_dimension (document_type_code, dimension, requirement)
VALUES ('journal_entry', 'business_line', 'optional')
ON CONFLICT (document_type_code, dimension) DO UPDATE SET requirement = 'optional';--> statement-breakpoint
