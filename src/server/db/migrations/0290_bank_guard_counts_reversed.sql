-- C-20 counts a reversed journal as well as a posted one (REQ-ACC-001 E-3).
--
-- 0259's `assert_bank_not_negative` summed the lines of journals whose status
-- is `posted`. Reversing a journal (`journal.reverse`) posts a mirror entry and
-- turns the original `reversed` — its lines still stand in the ledger, and
-- every balance the application reads (`treasury.balances`, the trial balance,
-- the G/L inquiry) counts `('posted','reversed')`. The guard alone did not, so
-- at commit it saw the mirror without the original it mirrors: reversing a
-- transfer that had filled an account read as emptying it twice, and the
-- reversal was refused with "would hold -N IQD".
--
-- That hit every reversal touching a bank or cash account — an internal
-- transfer, a customer receipt, a supplier payment. The fix is the one word:
-- the guard reads the balance the way the ledger does.
--
-- Nothing else changes: the same triggers, deferred to commit, call it. A
-- journal that would truly leave an account below nothing is still refused,
-- reversed or not, because the original and its mirror sum to nothing.

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

	-- A reversed journal's lines stand beside its reversal's; both count, as
	-- they do in `treasury.balances` and the trial balance.
	SELECT coalesce(sum(l.debit_iqd - l.credit_iqd), 0) INTO v_balance
	  FROM journal_line l
	  JOIN journal_entry e ON e.id = l.journal_entry_id
	 WHERE l.account_id = p_account_id
	   AND e.status IN ('posted', 'reversed');

	IF v_balance < 0 THEN
		RAISE EXCEPTION
			'% (%) would hold % IQD, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it.',
			v_name, v_code, trim_scale(v_balance)
			USING ERRCODE = 'check_violation';
	END IF;
END;
$$ LANGUAGE plpgsql;
