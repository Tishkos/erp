-- ===========================================================================
-- Phase 02 — RETIRE THE STACK VALIDATION SPIKE
--
-- 0000_phase00_spike.sql built a set of spike_ objects to prove, against a real
-- PostgreSQL instance, that the hardest constraints in TECHSTACK.md Part A were
-- achievable before anything was built on them. 0001 recorded that they would
-- be dropped once their replacements existed rather than on a schedule.
--
-- They now exist, and each proof has moved to the table that carries it for
-- real:
--
--   A1  atomic posting          journal_entry + journal_line in one transaction
--                               (02.7 — tests/integration/phase02-posting-engine)
--   A2  append-only             audit_event, workflow_decision, period_override,
--                               doc_number_allocation, posting_log (01.4, 02.2, 02.7)
--   A3  row-level security      audit_event with FORCE RLS (01.4)
--   A4  money and rate precision journal_line on the money_amount domain, and
--                               exchange_rate at numeric(18,8) (02.3, 02.5)
--   A5  idempotent posting      journal_entry_source_uniq (02.7)
--   A6  gapless numbering       doc_sequence + document_number_gaps (01.5)
--
-- The DOMAINS created in 0000 are NOT dropped. money_amount, fx_rate and
-- currency_code were never spike objects: they exist so that no table can
-- quietly declare its own precision, and journal_line now uses them.
-- ===========================================================================

DROP TABLE IF EXISTS spike_ledger_entry;--> statement-breakpoint
DROP TABLE IF EXISTS spike_branch;--> statement-breakpoint
DROP TABLE IF EXISTS spike_sequence;--> statement-breakpoint

DROP FUNCTION IF EXISTS spike_next_document_no(text);--> statement-breakpoint
DROP FUNCTION IF EXISTS spike_current_branch();--> statement-breakpoint
DROP FUNCTION IF EXISTS spike_reject_mutation();
