-- ===========================================================================
-- C-20, narrowed (2026-10-21, by direction: "we can always add that even if
-- we don't have money, but we should know in its page that the money is going
-- to be minus"; "no one should see the values if he doesn't have the rights").
-- HAND-AUTHORED.
--
-- Until now a bank or cash account could never hold less than nothing: any
-- journal that left it below zero was refused at commit, and once an account
-- *was* below zero (opening balances not yet entered, a rate typed wrong) it
-- refused everything that touched it — a deposit that brought it back up
-- included.
--
-- Now:
--   * a journal is refused only when it takes money OUT of the account
--     (its own net on the account is a credit) and leaves it below zero —
--     a deposit into an account that is below zero goes through;
--   * a payment application's own payment goes through even so: the supplier
--     payment or supplier advance that confirming an application posts
--     (`payment_application.supplier_payment_id` / `supplier_advance_id`,
--     written in the same transaction, before this deferred check runs). The
--     application's page says beforehand that the account will go below zero;
--   * the refusal no longer says what the account holds — the balance is for
--     whoever may open the Bank/Cash Accounts screen, and an error is read by
--     whoever pressed the button.
-- ===========================================================================

CREATE OR REPLACE FUNCTION assert_bank_not_negative(p_account_id uuid, p_entry_id uuid) RETURNS void AS $$
DECLARE
	v_code text;
	v_name text;
	v_status text;
	v_net numeric;
	v_balance numeric;
BEGIN
	-- Only a G/L account that a bank or cash account names is subject to this.
	SELECT bca.code, bca.name INTO v_code, v_name
	  FROM bank_cash_account bca
	 WHERE bca.gl_account_id = p_account_id
	 LIMIT 1;
	IF v_code IS NULL THEN
		RETURN;
	END IF;

	-- A draft moves no money; it is asked again when it is posted.
	SELECT e.status INTO v_status FROM journal_entry e WHERE e.id = p_entry_id;
	IF v_status IS NULL OR v_status NOT IN ('posted', 'reversed') THEN
		RETURN;
	END IF;

	-- Money coming in (or nothing moving) never makes it worse.
	SELECT coalesce(sum(l.debit_iqd - l.credit_iqd), 0) INTO v_net
	  FROM journal_line l
	 WHERE l.journal_entry_id = p_entry_id AND l.account_id = p_account_id;
	IF v_net >= 0 THEN
		RETURN;
	END IF;

	-- A payment application's own payment may take the account below zero.
	IF EXISTS (
		SELECT 1
		  FROM journal_entry e
		  JOIN payment_application pa
		    ON pa.supplier_payment_id::text = e.source_doc_id
		    OR pa.supplier_advance_id::text = e.source_doc_id
		 WHERE e.id = p_entry_id AND e.source_module = 'purchasing'
	) THEN
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
			'% (%) does not hold enough money for this, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it.',
			v_name, v_code
			USING ERRCODE = 'check_violation';
	END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_line_bank_guard() RETURNS trigger AS $$
BEGIN
	PERFORM assert_bank_not_negative(NEW.account_id, NEW.journal_entry_id);
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_entry_bank_guard() RETURNS trigger AS $$
DECLARE
	v_account uuid;
BEGIN
	FOR v_account IN SELECT DISTINCT account_id FROM journal_line WHERE journal_entry_id = NEW.id
	LOOP
		PERFORM assert_bank_not_negative(v_account, NEW.id);
	END LOOP;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The one-argument form (0259, 0290) is called by nothing now.
DROP FUNCTION IF EXISTS assert_bank_not_negative(uuid);
