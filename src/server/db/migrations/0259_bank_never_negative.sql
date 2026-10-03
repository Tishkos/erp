-- A bank or cash account can never hold less than nothing.
--
-- By direction (2026-10-03), after an account was found at -10,000 IQD:
-- "bank account never goes - in the system it should never ever be negative".
--
-- §15.3's funds check has existed since the payment application was written,
-- and a supplier payment raised directly was made to run it too. But twenty
-- services name a bank or cash account, and checking in each of them is a
-- rule that holds until somebody writes the twenty-first. An overdraft is a
-- loan; a loan is a document somebody agreed; and the place to say so once is
-- the database.
--
-- ── How it reads the balance ────────────────────────────────────────────────
-- An account's balance is its posted journal lines, debits less credits, on
-- the G/L account the bank or cash account names. Only posted entries count:
-- a draft journal has promised nothing.
--
-- ── Why deferred ───────────────────────────────────────────────────────────
-- A transfer between two accounts is one journal: the credit on the account
-- the money leaves and the debit on the one it reaches are two lines of the
-- same entry, and an immediate check would refuse the credit before seeing
-- the debit that pays for it. Deferred to COMMIT, the whole journal is in
-- place and the question is the only one worth asking — when this is done,
-- does any account hold less than nothing?
--
-- A constraint trigger must be FOR EACH ROW, so the same account may be
-- asked about once per line. That is a sum over one account's lines at commit
-- and nothing more; correctness before cleverness, and an index on
-- (account_id) already serves it.
--
-- ── What it does not do ─────────────────────────────────────────────────────
-- It does not repair the account already overdrawn. That balance is a posted
-- fact, and facts are corrected by documents — a deposit, or the reversal of
-- the payment that caused it — never by editing the ledger. Until then this
-- refuses to let it get worse, which is the point.

CREATE OR REPLACE FUNCTION assert_bank_not_negative(p_account_id uuid) RETURNS void AS $$
DECLARE
	v_code text;
	v_name text;
	v_balance numeric;
BEGIN
	-- Only a G/L account that a bank or cash account names is subject to this.
	-- An ordinary asset account may go where the books take it.
	SELECT bca.code, bca.name INTO v_code, v_name
	  FROM bank_cash_account bca
	 WHERE bca.gl_account_id = p_account_id
	 LIMIT 1;
	IF v_code IS NULL THEN
		RETURN;
	END IF;

	SELECT coalesce(sum(l.debit_iqd - l.credit_iqd), 0) INTO v_balance
	  FROM journal_line l
	  JOIN journal_entry e ON e.id = l.journal_entry_id
	 WHERE l.account_id = p_account_id
	   AND e.status = 'posted';

	IF v_balance < 0 THEN
		RAISE EXCEPTION
			'% (%) would hold % IQD, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it.',
			v_name, v_code, trim_scale(v_balance)
			USING ERRCODE = 'check_violation';
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_line_bank_guard() RETURNS trigger AS $$
BEGIN
	PERFORM assert_bank_not_negative(NEW.account_id);
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS journal_line_bank_not_negative ON "journal_line";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_line_bank_not_negative
	AFTER INSERT ON "journal_line"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION journal_line_bank_guard();--> statement-breakpoint

-- Posting an entry written earlier as a draft moves the money just as surely,
-- and its lines were inserted when nothing was posted yet. So the same
-- question is asked again at the moment it becomes posted.
CREATE OR REPLACE FUNCTION journal_entry_bank_guard() RETURNS trigger AS $$
DECLARE
	v_account uuid;
BEGIN
	FOR v_account IN SELECT DISTINCT account_id FROM journal_line WHERE journal_entry_id = NEW.id
	LOOP
		PERFORM assert_bank_not_negative(v_account);
	END LOOP;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS journal_entry_bank_not_negative ON "journal_entry";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entry_bank_not_negative
	AFTER UPDATE ON "journal_entry"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted')
	EXECUTE FUNCTION journal_entry_bank_guard();
