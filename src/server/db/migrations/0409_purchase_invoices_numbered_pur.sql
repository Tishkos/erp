-- 0409 — purchase invoices are numbered PUR-, not API- (2026-10-06, by
-- direction: "make pur not api").
--
-- The series `AP_INVOICE` (0036) gives the next purchase invoice — the debit
-- note too, which is one — PUR-{BRANCH}-{YYYY}-{SERIAL}. The serial runs on
-- from where API- stopped. Numbers already issued never change: they are on
-- journals, audit rows, the import's log and paper. Everything that reads a
-- purchase invoice by its prefix reads both (`domain/whatsapp-do.ts`,
-- `domain/search.ts` › `RETIRED_PREFIXES`).
--
-- PUR- was the local-goods payable's prefix (0225), in the same pattern; two
-- series writing the same number would collide on the one numbering register
-- (`doc_number_allocation_document_no_uniq`), and a PUR- number would name two
-- kinds of record. So the local-goods payable takes LOC- from now on. What it
-- issued as PUR- keeps its number, and the allocator steps over a number any
-- series already holds (`numbering.allocateDocumentNumber`).
--
-- Only a series still on its seeded prefix is changed: one somebody renamed on
-- the Numbering screen is theirs. Each change is an audit row, as the screen's
-- own would be, with no actor (the release made it).
SELECT set_config('app.is_super_user', 'true', true);
--> statement-breakpoint
WITH changed AS (
	UPDATE "doc_sequence" s
	   SET "prefix" = CASE s.key WHEN 'AP_INVOICE' THEN 'PUR' ELSE 'LOC' END
	 WHERE (s.key = 'AP_INVOICE' AND s.prefix = 'API')
	    OR (s.key = 'PAYABLE_LOCAL_GOODS' AND s.prefix = 'PUR')
	RETURNING s.key, s.prefix
)
INSERT INTO "audit_event" ("action", "object_type", "object_id", "before_value", "after_value", "reason", "outcome")
SELECT 'number_series.updated',
       'number_series',
       c.key,
       jsonb_build_object('prefix', CASE c.key WHEN 'AP_INVOICE' THEN 'API' ELSE 'PUR' END),
       jsonb_build_object('prefix', c.prefix),
       CASE c.key
         WHEN 'AP_INVOICE' THEN 'Migration 0409: purchase invoices are numbered PUR- (by direction, 2026-10-06); numbers already issued keep API-.'
         ELSE 'Migration 0409: PUR- now numbers purchase invoices, so local-goods payables take LOC-; numbers already issued keep PUR-.'
       END,
       'success'
  FROM changed c;
--> statement-breakpoint
SELECT set_config('app.is_super_user', '', true);
