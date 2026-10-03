-- ===========================================================================
-- REQ-HARDEN-001 HARDEN-4 G4 / HD13 — the foreign keys the hot paths join
-- on, indexed (2026-10-02).
--
-- PostgreSQL does not index a referencing column by itself. These are the
-- links the registers, the statements, the workbench and the stock reports
-- follow — document to document, document to journal, line to layer — read
-- from the plans the audit took. Additive only: nothing is dropped or
-- rewritten, and IF NOT EXISTS keeps a hand-made index on a live host.
--
-- Not here, deliberately: the `created_by` / `approved_by` user references
-- (hundreds, never joined in a hot path) and the small code tables.
-- ===========================================================================

-- Documents ↔ their journals (the statements' document links, the reversals).
CREATE INDEX IF NOT EXISTS ap_invoice_journal_idx ON ap_invoice (journal_entry_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ar_invoice_journal_idx ON ar_invoice (journal_entry_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payment_journal_idx ON supplier_payment (journal_entry_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_receipt_journal_idx ON customer_receipt (journal_entry_id);--> statement-breakpoint

-- Money documents ↔ their bank or cash account (the bank/cash statements).
CREATE INDEX IF NOT EXISTS supplier_payment_account_idx ON supplier_payment (bank_cash_account_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_receipt_account_idx ON customer_receipt (bank_cash_account_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_batch_line_payment_idx ON payment_batch_line (supplier_payment_id);--> statement-breakpoint

-- Payables (REQ-AP-001 stages 1–8): the links the page and the workbench follow.
CREATE INDEX IF NOT EXISTS payable_charged_to_idx ON payable (charged_to_payable_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payable_purchase_order_idx ON payable (purchase_order_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_supplier_idx ON payment_application (supplier_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_pd_idx ON payment_application (pd_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_loan_idx ON payment_application (loan_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS payment_application_statement_line_idx ON payment_application (statement_line_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customs_pd_bank_idx ON customs_pd (bank_code);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS container_receipt_payable_idx ON container_receipt (payable_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS container_receipt_line_container_line_idx ON container_receipt_line (container_line_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_bank_idx ON bank_loan (bank_code);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_disbursement_journal_idx ON bank_loan (disbursement_journal_entry_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_commission_journal_idx ON bank_loan (commission_journal_entry_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS bank_loan_allocation_charge_idx ON bank_loan_allocation (landed_cost_charge_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS landed_cost_layer_adjustment_payable_idx ON landed_cost_layer_adjustment (payable_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS landed_cost_layer_adjustment_layer_idx ON landed_cost_layer_adjustment (via_layer_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS landed_cost_layer_adjustment_position_idx ON landed_cost_layer_adjustment (item_code, warehouse_code);--> statement-breakpoint

-- Stock: the layer back to the movement that made it (the valuation's join).
CREATE INDEX IF NOT EXISTS cost_layer_created_by_movement_idx ON cost_layer (created_by_movement_id);
