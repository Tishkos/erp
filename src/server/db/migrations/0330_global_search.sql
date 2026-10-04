-- Global search / command palette (platform phase, Agent 5).
--
-- The palette finds a record by what a person types: a document number
-- ("API-HQ-2026-000012", or just "AP-12"), a code, a name, a reference they
-- were handed (a B/L, a container, a supplier's invoice number), a file name.
-- Every query runs as the asker, so the branch rule is the table's own row
-- policy; what this migration adds is only the means to answer quickly.
--
--   * search_fold(text) — the one folding both sides of a comparison go
--     through. Lower case; Arabic diacritics and the tatweel removed; the alef
--     family (أ إ آ ٱ) read as ا, ى as ي, ة as ه, ؤ as و, ئ as ي; Arabic-Indic and
--     Extended Arabic-Indic digits read as 0–9. People type أحمد and احمد, شركة
--     and شركه, ١٢٣ and 123 for the same thing; the stored text is left exactly
--     as written and only the comparison is relaxed. It is IMMUTABLE so an index
--     can be built over it, and a plain SQL function so the planner inlines it —
--     the expression in the query is then the expression in the index.
--     `src/server/domain/search.ts` › `foldText` is the same function in
--     TypeScript; tests/integration/gs-global-search.test.ts holds them equal.
--
--   * What an index can do depends on the table's row policy. A table under
--     row-level security (almost every document) has its policy applied before
--     the query's own conditions, and PostgreSQL lets only LEAKPROOF operators
--     run ahead of it: `=`, `<`, `>=` are; LIKE, lower(), search_fold() and the
--     trigram operators are not. On such a table a trigram index is therefore
--     never used — the person's query becomes a filter over every row they may
--     see — and a plain btree is, but only for comparisons. So:
--
--       - tables WITHOUT a row policy (business partners, items, warehouses,
--         accounts, bank/cash accounts): trigram GIN indexes over
--         search_fold(column) — one index serves equality, prefix and
--         substring matches of three characters or more;
--       - tables WITH one: plain btrees on the columns people look a record up
--         by (the references they were handed, the B/L and container numbers),
--         read as equal-or-begins-with ranges; and a btree on the date the
--         newest-first window of a name search is read in (the 10,000 newest
--         rows the asker may see — src/server/search/table-query.ts).
--         `DESC NULLS LAST` is the order the query asks for.
--
--   * doc_number_allocation(serial): the numbering series records every number
--     it hands out with its serial. "AP-1024" is read as prefix AP, serial 1024;
--     the lookup is "which documents of these series carry serial 1024", which
--     the table's unique index (sequence_key, scope_key, serial) cannot answer
--     without knowing the scope.
--
-- Nothing here changes a row or a policy; dropping the indexes only makes
-- search slower.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

CREATE OR REPLACE FUNCTION search_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $fn$
  SELECT translate(
    regexp_replace(lower(value), '[ً-ٰٟـ]', '', 'g'),
    'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    'اااايهوي01234567890123456789'
  )
$fn$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION search_fold(text) TO erp_app;--> statement-breakpoint

-- Tables with no row policy: trigram over the folded text.
CREATE INDEX IF NOT EXISTS business_partner_legal_name_fold_idx
  ON business_partner USING gin (search_fold(legal_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_partner_trade_name_fold_idx
  ON business_partner USING gin (search_fold(trade_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_name_fold_idx
  ON item USING gin (search_fold(name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS item_supplier_code_fold_idx
  ON item USING gin (search_fold(supplier_item_code) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS warehouse_name_fold_idx
  ON warehouse USING gin (search_fold(name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chart_of_account_name_fold_idx
  ON chart_of_account USING gin (search_fold(name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_cash_account_name_fold_idx
  ON bank_cash_account USING gin (search_fold(name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_cash_account_number_fold_idx
  ON bank_cash_account USING gin (search_fold(account_number) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_cash_account_iban_fold_idx
  ON bank_cash_account USING gin (search_fold(iban) gin_trgm_ops);--> statement-breakpoint

-- Tables under a row policy: the references people are handed with the paper, as stored.
CREATE INDEX IF NOT EXISTS ap_invoice_supplier_invoice_no_idx ON ap_invoice (supplier_invoice_no);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payment_reference_idx ON supplier_payment (reference);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_receipt_bank_reference_idx ON customer_receipt (bank_reference);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_bank_reference_idx ON payment_application (bank_reference);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS purchase_order_reference_idx ON purchase_order (reference);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goods_receipt_supplier_delivery_note_idx ON goods_receipt (supplier_delivery_note);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_facility_reference_idx ON bank_loan (facility_reference);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payable_supplier_reference_idx ON payable (supplier_reference);--> statement-breakpoint

-- …and the shipping numbers, whose existing unique indexes are partial (live rows only).
CREATE INDEX IF NOT EXISTS bill_of_lading_bl_no_idx ON bill_of_lading (bl_no);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shipment_container_container_no_idx ON shipment_container (container_no);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shipment_container_seal_no_idx ON shipment_container (seal_no);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_declaration_customs_ref_idx ON customs_declaration (customs_ref);--> statement-breakpoint

-- The newest-first window a name is matched inside.
CREATE INDEX IF NOT EXISTS ap_invoice_recent_idx ON ap_invoice (invoice_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ar_invoice_recent_idx ON ar_invoice (invoice_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payment_recent_idx ON supplier_payment (payment_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_receipt_recent_idx ON customer_receipt (receipt_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_recent_idx ON payment_application (application_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS purchase_order_recent_idx ON purchase_order (order_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goods_receipt_recent_idx ON goods_receipt (receipt_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sales_return_recent_idx ON sales_return (requested_on DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journal_entry_recent_idx ON journal_entry (posting_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_recent_idx ON bank_loan (created_at DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payable_recent_idx ON payable (document_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bill_of_lading_recent_idx ON bill_of_lading (bl_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shipment_container_recent_idx ON shipment_container (eta DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_pd_recent_idx ON customs_pd (registration_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_declaration_recent_idx ON customs_declaration (declaration_date DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_recent_idx ON project (created_at DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS employee_recent_idx ON employee (hire_date DESC NULLS LAST);--> statement-breakpoint

-- Files: the current, clean, undisposed ones — the only ones a document lists —
-- by name as stored, and newest first.
CREATE INDEX IF NOT EXISTS attachment_file_name_idx
  ON attachment (file_name)
  WHERE scan_status = 'clean' AND superseded_by_id IS NULL AND disposed_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachment_recent_idx
  ON attachment (created_at DESC NULLS LAST)
  WHERE scan_status = 'clean' AND superseded_by_id IS NULL AND disposed_at IS NULL;--> statement-breakpoint

-- "AP-1024": the documents of a series that carry serial 1024.
CREATE INDEX IF NOT EXISTS doc_number_allocation_serial_idx
  ON doc_number_allocation (serial);
