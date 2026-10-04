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
--   * Trigram (pg_trgm, already installed by 0212 — a trusted extension, so the
--     database owner may create it) GIN indexes over search_fold(column) for the
--     text people search by. One index serves equality, prefix and substring
--     matches of three characters or more.
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

-- Master records.
CREATE INDEX IF NOT EXISTS business_partner_legal_name_fold_idx
  ON business_partner USING gin (search_fold(legal_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_partner_trade_name_fold_idx
  ON business_partner USING gin (search_fold(trade_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS employee_name_en_fold_idx
  ON employee USING gin (search_fold(full_name_en) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS employee_name_ar_fold_idx
  ON employee USING gin (search_fold(full_name_ar) gin_trgm_ops);--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS project_name_fold_idx
  ON project USING gin (search_fold(name) gin_trgm_ops);--> statement-breakpoint

-- Documents: the references a person was handed with the paper.
CREATE INDEX IF NOT EXISTS ap_invoice_supplier_invoice_no_fold_idx
  ON ap_invoice USING gin (search_fold(supplier_invoice_no) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payment_reference_fold_idx
  ON supplier_payment USING gin (search_fold(reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_receipt_bank_reference_fold_idx
  ON customer_receipt USING gin (search_fold(bank_reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_bank_reference_fold_idx
  ON payment_application USING gin (search_fold(bank_reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS purchase_order_reference_fold_idx
  ON purchase_order USING gin (search_fold(reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goods_receipt_delivery_note_fold_idx
  ON goods_receipt USING gin (search_fold(supplier_delivery_note) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sales_order_customer_reference_fold_idx
  ON sales_order USING gin (search_fold(customer_reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journal_entry_description_fold_idx
  ON journal_entry USING gin (search_fold(description) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_facility_reference_fold_idx
  ON bank_loan USING gin (search_fold(facility_reference) gin_trgm_ops);--> statement-breakpoint

-- Imports and shipping: numbers typed by people, in whatever case they were given.
CREATE INDEX IF NOT EXISTS payable_supplier_reference_fold_idx
  ON payable USING gin (search_fold(supplier_reference) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payable_description_fold_idx
  ON payable USING gin (search_fold(description) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bill_of_lading_bl_no_fold_idx
  ON bill_of_lading USING gin (search_fold(bl_no) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bill_of_lading_vessel_fold_idx
  ON bill_of_lading USING gin (search_fold(vessel) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shipment_container_no_fold_idx
  ON shipment_container USING gin (search_fold(container_no) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shipment_container_seal_fold_idx
  ON shipment_container USING gin (search_fold(seal_no) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_pd_no_fold_idx
  ON customs_pd USING gin (search_fold(pd_no) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_declaration_ref_fold_idx
  ON customs_declaration USING gin (search_fold(customs_ref) gin_trgm_ops);--> statement-breakpoint

-- Files: the current, clean, undisposed ones — the only ones a document lists.
CREATE INDEX IF NOT EXISTS attachment_file_name_fold_idx
  ON attachment USING gin (search_fold(file_name) gin_trgm_ops)
  WHERE scan_status = 'clean' AND superseded_by_id IS NULL AND disposed_at IS NULL;--> statement-breakpoint

-- "AP-1024": the documents of a series that carry serial 1024.
CREATE INDEX IF NOT EXISTS doc_number_allocation_serial_idx
  ON doc_number_allocation (serial);
