-- Sales Returns — the offset account (Operations build, block 9, 2026-09-14).
--
--   Header   ... Offset Account (Accounts Receivable or Bank — one must be
--            selected) ...
--   Journal  Sales Return Dr. / Accounts Receivable or Bank Cr. /
--            Inventory Dr. / COGS Cr.
--
-- A return can settle two ways, and the difference is real money. If the
-- customer has not paid yet, the credit reduces what they owe: Accounts
-- Receivable. If they have already paid, the company hands the cash back and
-- the credit comes out of a bank or a till. Booking the second as the first
-- leaves a receivable the customer does not owe and a bank balance the company
-- does not have.
--
-- The system chose Accounts Receivable every time. That was right for one of
-- the two cases and silently wrong for the other, which is the worse half:
-- nothing fails, the books just drift.
--
-- ── Why this lives on the return and not on the credit memo ────────────────
-- The memo is the document that posts, so the column could have gone there.
-- It goes on the return because that is where the sponsor put it, and the
-- reason holds: whoever takes the goods back is the one who knows whether the
-- customer was refunded at the counter. By the time a memo is raised that fact
-- is a week old and second-hand.

ALTER TABLE "sales_return"
  ADD COLUMN IF NOT EXISTS "offset_kind" text NOT NULL DEFAULT 'receivable';
--> statement-breakpoint

ALTER TABLE "sales_return"
  ADD COLUMN IF NOT EXISTS "offset_bank_account_id" uuid
    REFERENCES "bank_cash_account"("id");
--> statement-breakpoint

COMMENT ON COLUMN "sales_return"."offset_kind" IS
  'Which side the credit lands on: ''receivable'' reduces what the customer '
  'owes, ''bank'' pays them back out of a bank or cash account.';
--> statement-breakpoint

-- One must be selected, and only one can be. Writing it as an equivalence
-- rather than two CHECKs means neither half can be satisfied alone: a bank
-- offset without an account, and an account named on a receivable offset, are
-- both unrepresentable.
ALTER TABLE "sales_return"
  ADD CONSTRAINT "sales_return_offset_one_of"
  CHECK (
    "offset_kind" IN ('receivable', 'bank')
    AND ("offset_kind" = 'bank') = ("offset_bank_account_id" IS NOT NULL)
  );
--> statement-breakpoint

-- The default above is for the rows already in the table, which were all
-- posted to Accounts Receivable and so are correctly described by it. New rows
-- say which they are; the service requires it.
ALTER TABLE "sales_return" ALTER COLUMN "offset_kind" DROP DEFAULT;
