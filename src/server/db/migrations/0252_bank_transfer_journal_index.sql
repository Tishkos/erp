-- REQ-FIX-001 FIX-1 — Bank and Cash Reporting tells a transfer between the
-- company's own accounts by the journal a bank_transfer posted
-- (bank_transfer.journal_entry_id), once per journal line it reads. Additive.
CREATE INDEX IF NOT EXISTS "bank_transfer_journal_entry_idx" ON "bank_transfer" USING btree ("journal_entry_id") WHERE "journal_entry_id" IS NOT NULL;
