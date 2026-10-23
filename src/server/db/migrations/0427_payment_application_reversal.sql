-- ===========================================================================
-- Reversing a paid payment application (2026-10-24, by direction: "in payment
-- application please even settled have to [be] reversed").
-- HAND-AUTHORED.
--
-- Until now a payment application ended at Paid (`confirmed`) or `debited`:
-- once the supplier payment or deposit it posted was on the books, nothing
-- on the application could take it back. Now a Paid or debited application
-- is **Reversed**, with a reason, by whoever may reverse on it
-- (`reverse_cancel`): `payment-applications.reverse` undoes what confirming
-- did, each part through its owner's service —
--
--   * the supplier payment it posted (or the deposit, a supplier advance),
--     its journal mirrored and its allocations undone, so the invoices owe
--     again;
--   * the import's exchange difference, when the payment had made the import
--     fully paid: its journal mirrored and what it closed owing again (this
--     migration lets its rows take that stamp, once);
--   * a sheet application confirmed before the cut-over: its settlement of
--     the opening balance (this migration lets that row be undone, once, for
--     an application that is reversed);
--   * the loan's draw.
--
-- `reversed` is final, like rejected and cancelled: it holds no money, frees
-- its instalment and its loan draw, and does not tie the import to its bank.
--
-- Found on the way: 0036's guard refused an invoice going back to `posted`
-- when its payment is undone, reading it as a posting (so no payment of an
-- invoice whose match was an exception could be reversed). Narrowed at the end.
-- ===========================================================================

ALTER TABLE "payment_application" DROP CONSTRAINT "payment_application_status";
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_status" CHECK (
	"status" IN ('draft', 'submitted', 'approved', 'sent', 'confirmed', 'debited', 'rejected', 'cancelled', 'reversed')
);
--> statement-breakpoint

ALTER TABLE "payment_application" ADD COLUMN "reversed_by" uuid REFERENCES "app_user"("id");
--> statement-breakpoint
ALTER TABLE "payment_application" ADD COLUMN "reversed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "payment_application" ADD COLUMN "reversal_reason" text;
--> statement-breakpoint
-- Reversed means who, when and why — and nothing else carries them.
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_reversal_complete" CHECK (
	("status" = 'reversed'
		AND "reversed_by" IS NOT NULL AND "reversed_at" IS NOT NULL
		AND coalesce(btrim("reversal_reason"), '') <> '')
	OR ("status" <> 'reversed' AND "reversed_by" IS NULL AND "reversed_at" IS NULL AND "reversal_reason" IS NULL)
);
--> statement-breakpoint
-- A reversed application was paid: it keeps the proof and the document it posted.
ALTER TABLE "payment_application" DROP CONSTRAINT "payment_application_confirmed_has_proof";
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_confirmed_has_proof" CHECK (
	"status" NOT IN ('confirmed', 'debited', 'reversed')
	OR ("confirmed_on" IS NOT NULL
		AND coalesce(btrim("confirmation_reference"), '') <> ''
		AND ("supplier_payment_id" IS NOT NULL OR "supplier_advance_id" IS NOT NULL OR "source" <> 'erp'))
);
--> statement-breakpoint
ALTER TABLE "payment_application" DROP CONSTRAINT "payment_application_sent_has_date";
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_sent_has_date" CHECK (
	"status" NOT IN ('sent', 'confirmed', 'debited', 'reversed') OR "application_date" IS NOT NULL
);
--> statement-breakpoint

INSERT INTO "payment_application_transition" ("from_status", "to_status") VALUES
	('confirmed', 'reversed'),
	('debited',   'reversed')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PAYMENT_REVERSED', 'payment', 'Payment reversed'),
	('EXCHANGE_DIFFERENCE_UNDONE', 'payment', 'Exchange difference undone — the import is no longer fully paid'),
	('OPENING_SETTLEMENT_UNDONE', 'payment', 'Payment before the cut-over reversed; the opening balance owes it again')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The import's exchange difference: undone once, when a payment of the
-- import is reversed. Nothing else about a row ever changes, and it is never
-- deleted (it was append-only by grant; it is by trigger now).
-- ---------------------------------------------------------------------------
ALTER TABLE "payable_exchange_difference" ADD COLUMN "reversed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "payable_exchange_difference" ADD COLUMN "reversed_by" uuid REFERENCES "app_user"("id");
--> statement-breakpoint
ALTER TABLE "payable_exchange_difference" ADD COLUMN "reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id");
--> statement-breakpoint
ALTER TABLE "payable_exchange_difference" ADD CONSTRAINT "payable_exchange_difference_reversal_complete" CHECK (
	("reversed_at" IS NULL AND "reversed_by" IS NULL AND "reversal_journal_entry_id" IS NULL)
	OR ("reversed_at" IS NOT NULL AND "reversed_by" IS NOT NULL AND "reversal_journal_entry_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payable_exchange_difference_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE'
	   AND OLD.reversed_at IS NULL
	   AND NEW.reversed_at IS NOT NULL
	   AND NEW.id = OLD.id AND NEW.payable_id = OLD.payable_id
	   AND NEW.kind = OLD.kind AND NEW.source_type = OLD.source_type
	   AND NEW.source_id = OLD.source_id AND NEW.source_no = OLD.source_no
	   AND NEW.amount_iqd = OLD.amount_iqd AND NEW.journal_entry_id = OLD.journal_entry_id
	   AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'An import''s exchange difference is final; it is only undone, once, when a payment of the import is reversed.'
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payable_exchange_difference_frozen"
	BEFORE UPDATE OR DELETE ON "payable_exchange_difference"
	FOR EACH ROW EXECUTE FUNCTION payable_exchange_difference_frozen();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The opening balance's settlement by a payment made before the cut-over:
-- undone once, when that payment application is reversed — as an invoice's
-- absorption is undone when the invoice is (0422).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION import_opening_settlement_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE'
	   AND OLD.reversed_at IS NULL
	   AND NEW.reversed_at IS NOT NULL
	   AND (OLD.kind = 'absorbed_by_invoice'
	        OR (OLD.kind = 'paid_before_cut_over'
	            AND EXISTS (SELECT 1 FROM payment_application a
	                         WHERE a.id = OLD.payment_application_id AND a.status = 'reversed')))
	   AND NEW.id = OLD.id AND NEW.ap_invoice_id = OLD.ap_invoice_id AND NEW.kind = OLD.kind
	   AND NEW.payment_application_id IS NOT DISTINCT FROM OLD.payment_application_id
	   AND NEW.absorbed_invoice_id IS NOT DISTINCT FROM OLD.absorbed_invoice_id
	   AND NEW.amount_txn = OLD.amount_txn AND NEW.amount_iqd = OLD.amount_iqd
	   AND NEW.journal_entry_id = OLD.journal_entry_id
	   AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'An opening balance''s settlement is final; it is undone, once, only when the invoice that it absorbed or the payment application that made it is reversed.'
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT UPDATE ON "payable_exchange_difference" TO erp_app;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An invoice whose payment is undone goes back to `posted` from `settled` or
-- `partially_executed`. That is not posting it: it posted long ago, its
-- variance was decided then. 0036's guard read any move into `posted` as a
-- posting, so reversing the payment of an invoice whose match was an accepted-
-- at-posting exception (an import's, an opening balance) was refused.
-- The guard now looks only at a move into `posted` from before posting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ap_invoice_exception_blocks_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open integer;
BEGIN
  IF NEW.status <> 'posted' OR OLD.status IN ('posted', 'partially_executed', 'settled') THEN
    RETURN NEW;
  END IF;

  IF NEW.match_status = 'exception' AND NEW.variance_approved_by IS NULL THEN
    RAISE EXCEPTION
      'Invoice % is in exception and no manager has accepted the variance (blueprint 8.4). Resolve the exception or record the approval, then post.',
      NEW.invoice_no USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_open
    FROM ap_match_exception
   WHERE ap_invoice_id = NEW.id AND resolved_at IS NULL;

  IF v_open > 0 THEN
    RAISE EXCEPTION
      'Invoice % has % unresolved match exception(s) (blueprint 8.4). Each one is a decision somebody has to record before the invoice posts.',
      NEW.invoice_no, v_open USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
