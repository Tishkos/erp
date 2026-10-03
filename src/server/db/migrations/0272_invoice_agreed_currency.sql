-- What the invoice was agreed in, and when its due date became known.
--
-- By direction (2026-10-03): "the purchase invoice orignallay issued in usd
-- please", and — of a date the record was showing because the column cannot be
-- empty — "i said not show due date there isnt due date yet".
--
-- ── The currency ────────────────────────────────────────────────────────
-- The company buys from Shenzhen in dollars and keeps its books in dinars. The
-- invoice is entered in dollars and converted at the rate in force on its own
-- date, and until now only the import application remembered that: the invoice
-- held dinars and nothing else, so a month later nobody could tell from the
-- invoice what was agreed or at what rate the dinars were arrived at.
--
-- Two columns say it: what it was agreed in, and what one unit of that was
-- worth in dinars on the day. They are a record, not a second source of truth —
-- the dinars on the lines are what posts, and these say where they came from.
-- Null is the ordinary case: an invoice agreed in dinars has nothing to say.
--
-- `currency` is left alone. It is the invoice's own ledger currency and the
-- posting reads it; this column would mean something different and sharing one
-- would make both wrong.
--
-- ── The due date ────────────────────────────────────────────────────────
-- `due_date` is NOT NULL and always has been, so an invoice entered on advance
-- terms carries the day it was entered and the screen reads it as a promise
-- that was never made. The stamp says a person set it on purpose —
-- `ap-invoice.setDueDate` writes it — and the record shows a due date only
-- when it is there.

ALTER TABLE "ap_invoice"
  ADD COLUMN IF NOT EXISTS "agreed_currency" text,
  ADD COLUMN IF NOT EXISTS "agreed_rate" numeric(19, 8),
  ADD COLUMN IF NOT EXISTS "due_date_set_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ap_invoice_agreed_currency_fk'
  ) THEN
    ALTER TABLE "ap_invoice"
      ADD CONSTRAINT "ap_invoice_agreed_currency_fk"
      FOREIGN KEY ("agreed_currency") REFERENCES "currency"("code");
  END IF;

  -- A currency without the rate it was converted at says half of a fact.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ap_invoice_agreed_currency_has_a_rate'
  ) THEN
    ALTER TABLE "ap_invoice"
      ADD CONSTRAINT "ap_invoice_agreed_currency_has_a_rate"
      CHECK (("agreed_currency" IS NULL) = ("agreed_rate" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ap_invoice_agreed_rate_positive'
  ) THEN
    ALTER TABLE "ap_invoice"
      ADD CONSTRAINT "ap_invoice_agreed_rate_positive"
      CHECK ("agreed_rate" IS NULL OR "agreed_rate" > 0);
  END IF;
END $$;
