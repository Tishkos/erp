# Full integration suite — 3 October 2026

**Branch** `whatsapp-configuration` at `1a22a5a` (the revision now live on erp.qs-groups.com).
**Database** `erp_test_fullrun`, created for this run so no other job could reset it mid-flight.
**Scope** all 142 integration files.

| | Files | Tests |
|---|---|---|
| Passed | 124 | 2,313 |
| **Failed** | **18** | **45** |
| Skipped | — | 26 |

Every failing file is listed below with its cause. **Nothing has been fixed, committed or pushed** — the repository is exactly as it was before the run.

---

## The short version

**One change explains 41 of the 45 failing tests**, and one of the two files that fail before collecting any. Yesterday, at your direction — *"bank account never goes - in the system it should never ever be negative"* — a bank or cash account became unable to hold less than nothing. That is two pieces of work from today: a funds check in the payment services (`c19fccd`) and a database constraint that no service can bypass (`c3980e7`, migration `0259`).

It works. It is refusing exactly what you asked it to refuse. But forty-one tests pay a supplier, refund a customer or repay a loan **from an account the test never put money into**, and those tests were written when that was allowed. They encode the old permissive behaviour, and nobody had run the suite since the control went in.

So the great majority of this list is not a defect in the product. It is the bill for a rule you were right to ask for, and it has to be paid test by test — each one needs a funding step added.

**Two things in the list are not that**, and one of them matters:

1. **A loan can no longer pay for anything.** Real, and it needs your decision. See Finding 2.
2. **A script still stamps the UTC date**, which reads yesterday for the first three hours of every Baghdad day. Real, small, one line. See Finding 3.

---

## Finding 1 — Forty-one tests pay from empty accounts

**Status** Expected fallout. The product is correct; the tests are stale.

The refusals say exactly what is wrong, in both forms:

```
InsufficientFundsError: BANK-000001 has 0.0000 IQD available against 1500000.0000 IQD
  — deposit or draw the money first, or pay from an account that holds it.

error: Rafidain Current Account (BANK-000001) would hold -30000 IQD, and a bank or cash
  account cannot hold less than nothing. Deposit or draw the money first, or pay from an
  account that holds it.
```

The shortfalls the suite ran into: `BANK-000001` short by 600 / 5,000 / 20,000 / 30,000 / 100,000 / 500,000 IQD; `CASH-BGW` short by 2,050,000 and 4,000,000 IQD; `CASH-000001` holding 400,000 against 600,000 asked.

| File | Failing | What it was proving |
|---|---|---|
| `money-transfer-bank-execution-batch.test.ts` | 15 | §12.5 batch execution and statement reconciliation |
| `money-transfer-client-import.test.ts` | 9 | §12.4 client goods never enter company inventory |
| `purchasing-supplier-payment.test.ts` | 5 | §15 the ageing ties to the control account |
| `ap07-landed-cost.test.ts` | 3 | A18 landed cost allocation |
| `ops09-sales-returns.test.ts` | 2 | the refund credits the bank |
| `ap02-expenses-and-import-invoice.test.ts` | 1 | D12 expense marked paid |
| `ap03-payments.test.ts` | 1 | A12 cheque and cash each with their own proof |
| `ap06-loans.test.ts` | 1 | §15.6 Dr liability Cr bank on repayment |
| `im10-period-close.test.ts` | 1 | IM10 an unposted journal blocks the close |
| `ops12-trading-cycle.test.ts` | 1 | a whole cycle agreeing end to end |
| `ops13-final-audit.test.ts` | 1 | block 9 a sales return settles the customer |
| `purchasing-exit-gate.test.ts` | 1 | the §26 scenario end to end |
| `ops14-print-export.test.ts` | file | the fixture itself fails before any test runs |

**The fix** is in the tests, not the product: each fixture funds its account before it spends. The existing pattern is in `tests/integration/treasury-bank-balance.test.ts`, which was written alongside the control and funds the account first on purpose. Roughly a day's work across thirteen files, and worth doing properly — a suite that cannot pay for anything cannot prove that payment works.

**What this means for the live system.** Nothing is broken on the server by this. But it is worth knowing that any real workflow which pays before the money is recorded as received will now be refused — and `CASH-BGW` and `BANK-000001` on the live database are the accounts to watch. `BANK-000001` is still at **−10,000 IQD** from before the control existed; that is a posted fact and needs either a deposit or the reversal of the payment that caused it.

---

## Finding 2 — A loan-funded payment application cannot be confirmed

**Status** Real. Needs your decision. This is the one I would act on first.

`hd09-double-submit.test.ts` › *two concurrent confirms of one payment application post one supplier payment and draw the loan once*

Both attempts failed where exactly one should have succeeded:

```
AssertionError: expected [] to have a length of 1 but got +0
```

The application in that test is funded by a **loan** (`fundingSourceCode: 'loan'`), which is the §15.7 arrangement: a bank lends, and the loan pays the supplier for an import. Reading the code:

- `payment-applications.ts:534` draws the loan at **approval** — `if (row.loanId) await loans.allocate(...)`;
- `loans.allocate` (`loans.ts:902`) writes a `bank_loan_allocation` row and **posts no journal**;
- so no money reaches the bank account;
- and `supplier-payment.post` then refuses the payment, because the account holds nothing.

A loan reserves loan *capacity* in this system; it never puts cash in the account. Before today that did not matter, because the payment went out regardless. Now it does.

**Two ways to resolve it, and the choice is yours:**

**(a) Make the loan's money real — my recommendation.** When a loan is drawn, post `Dr Bank / Cr Loan liability` for the drawn amount. This is what a bank actually does: it lends by crediting your account. The books then show the money that is about to be spent, the funds control stays absolutely intact, and the loan liability appears the moment you owe it rather than at the first repayment. It is also the only version of this that gives a true balance sheet mid-import.

**(b) Let an approved loan allocation count as available funds.** Smaller change — the funds check adds open allocations to the available figure. But the bank account then shows money it does not hold, which is the thing you asked never to happen, and the loan liability still appears late.

There is a second cost to this failure worth naming: `hd09` exists to prove that **two simultaneous confirms post only one payment**. It now fails before it ever tests that, so the double-submit guarantee is currently unproven. Whichever option you choose, that test needs to pass again for its own sake.

---

## Finding 3 — A script still stamps the UTC date

**Status** Real. One line.

`hd07-business-today.test.ts` › *no service stamps UTC today any more* — the guard that greps the tree for UTC dates, and it found one:

```
scripts/ops/prepare-legacy-import.ts:36
const cutOver = (process.argv[2] ?? '').trim() || new Date().toISOString().slice(0, 10);
```

`new Date().toISOString().slice(0, 10)` is the UTC day, which reads **yesterday for the first three hours of every Baghdad day**. The house rule is `businessToday()` from `src/server/domain/business-date.ts`, and this guard exists precisely to stop this pattern coming back.

Here it decides the **cut-over date of the legacy books import** when none is given on the command line. Run between midnight and 3am Baghdad time, the opening balances would be dated a day early — and opening balances are not something you want to re-date afterwards.

**The fix** is `businessToday()` instead, with the import added to the file's guard list. The line was last touched on 2 October (`3836015`), so this is recent rather than ancient.

---

## Finding 4 — The "no exchange mechanism" gate is matching the wrong word

**Status** Real but harmless. The gate has gone wrong, not the product.

`sales-return.test.ts` › *has no exchange document type and no exchange status*

§7.5 says the ERP has no goods-**exchange** document — you return goods and sell again, you do not swap them. The gate asserts nothing in the system is called "exchange", and it now finds:

```
{ "code": "payable_exchange_difference", ... }
```

That is the FIX-3 import work: an exchange-**rate** difference on a foreign-currency payable, which has nothing whatever to do with exchanging goods. The gate is matching the word, not the meaning.

**The fix** is to narrow the gate's query so a currency term does not trip a goods rule — and to say so in the test, since the next person will hit this too.

---

## Finding 5 — A byte-for-byte PDF comparison is off by 113 bytes

**Status** Unexplained. Needs a look, not urgent.

`wa02-intents.test.ts` › *the PDF statement is byte-identical to the ERP's export of the same sheet at the same instant*

```
AssertionError: expected 96984 to be 97097
```

The WhatsApp attachment and the export route are meant to produce the identical file — that is the W6 guarantee, and the point of it is that nobody can be sent a different set of figures from the one on screen. A 113-byte difference is small enough to be a timestamp, a date rendering, or one figure formatted differently, and large enough to mean the two paths are not actually the same call.

I did not trace this one — it is the only failure I am leaving without a cause, and I would rather say so than guess. Note that today's `money.say` change touched notification and event text, **not** the print renderers, so it is unlikely to be the cause, but it has not been ruled out either.

---

## Finding 6 — `pg_dump` is not installed here

**Status** Environment, not product. No action needed.

`im01-backup-restore.test.ts` — `Error: spawnSync pg_dump ENOENT`. The file collected zero tests. The PostgreSQL client tools are not on this Windows machine's PATH; the database itself runs in Docker, which is why everything else works. The backup and restore drill is exercised on the server by the weekly cron (`restore-drill.sh`), so this is a gap in local coverage only. Installing the PostgreSQL client tools would close it.

---

## How the run was done, and one thing to know about it

The suite runs its files **serially** by its own configuration (`fileParallelism: false`) because they share one PostgreSQL instance — so this takes hours, not minutes.

It was run in two parts:

- **Files 1–54** in one pass. All 54 passed, 1,477 tests. The pass was then killed: I had a log monitor watching for failures and stopping it took the suite's shell with it, because both were in the same process group. My mistake.
- **Files 55–142** in ten slices short enough to complete inside a single call, after a second background attempt was also killed after 54 seconds. 836 passed, 45 failed, 26 skipped.

The split changes nothing about what was tested. Each file resets the database for itself and they never run concurrently, so a slice is the same experiment as a whole run — but you should know the result is a sum of two sessions rather than one green or red line, because the 54 files in the first part have no JSON report behind them, only their log.

**Suggested order of work:** Finding 2 (decide, then implement), Finding 3 (one line), Finding 1 (the long slog), Finding 5 (investigate), Finding 4 (tidy the gate). Finding 6 needs nothing.

---

*Raw output, should you want it — these live in the session's temporary directory and will go when the job is deleted:*
`full-integration.log` (files 1–54), `chunks.log` (files 55–142), `chunk-*.json` (machine-readable per slice).
