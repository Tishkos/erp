/**
 * Phase 07.7 test gate — the bank reconciliation workspace. §17.
 *
 *   - Automatic matching proposes correct matches and never auto-commits
 *     without confirmation
 *   - Reconciliation cannot be finalised while an unexplained difference remains
 *   - An authorised adjustment posts through the Phase 02 engine to a clearing
 *     account
 *   - Reconciled statement lines are immutable; a correction requires the reopen
 *     workflow and is audited
 *   - Reconciled bank balance equals the G/L balance for the same date, proven
 *     for a full test period
 *   - Unmatched and unidentified items are reported and aged
 *
 * And the §12.5 case Phase 09 depends on: one statement line against a batch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as statements from '@/server/services/bank-statement';
import * as rec from '@/server/services/bank-reconciliation';
import * as treasury from '@/server/services/treasury';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let officer: ActorContext;
let manager: ActorContext;
let bankAccountId: string;
let bankGlId: string;
let suspenseId: string;
let chargesId: string;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    `${role}-${(seq += 1)}`,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

/**
 * A posted movement on the bank's G/L account, with the other leg in suspense.
 *
 * Written by hand rather than through a document, because what the
 * reconciliation cares about is the shape of the ledger entry — its date, its
 * amount and what it says about itself — not which module produced it.
 */
async function ledgerMovement(input: {
  date: string;
  amountIqd: string;
  reference: string;
  counterparty?: string | null;
}): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [input.date],
    );
    const magnitude = input.amountIqd.replace('-', '');
    const intoBank = !input.amountIqd.startsWith('-');

    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,$5,'draft',$6,$6,$7) returning id`,
      [
        `JE-${(seq += 1)}`,
        input.date,
        periods[0].id,
        BAGHDAD,
        input.reference,
        magnitude,
        manager.principal.userId,
      ],
    );

    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code,
          line_description, business_partner_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $4, $5, $6),
              ($1, 2, $7, 0, $3, 0, $3, 0, 0, 'IQD', $4, $5, null)`,
      intoBank
        ? [
            entry[0].id,
            bankGlId,
            magnitude,
            BAGHDAD,
            input.reference,
            input.counterparty ?? null,
            suspenseId,
          ]
        : [
            entry[0].id,
            suspenseId,
            magnitude,
            BAGHDAD,
            input.reference,
            null,
            bankGlId,
          ],
    );

    // The bank leg carries the counterparty whichever side it is on.
    await client.query(
      `update journal_line set business_partner_code = $2
        where journal_entry_id = $1 and account_id = $3`,
      [entry[0].id, input.counterparty ?? null, bankGlId],
    );

    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, manager.principal.userId],
    );
    await client.query('commit');
    return entry[0].id;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The bank's G/L line of one entry — the thing a match points at. */
async function bankLineOf(entryId: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `select id from journal_line where journal_entry_id = $1 and account_id = $2`,
    [entryId, bankGlId],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31'),
            ($1,2,'February 2026','2026-02-01','2026-02-28'),
            ($1,3,'March 2026','2026-03-01','2026-03-31')
     on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: bank } = await ownerPool.query(
    `select b.id, b.gl_account_id from bank_cash_account b
      where b.account_type = 'bank' limit 1`,
  );
  bankAccountId = bank[0].id;
  bankGlId = bank[0].gl_account_id;

  for (const [code, name, parent] of [
    ['L9SUSPEN', 'Funding Suspense', 'L000001'],
    ['X9BANKCH', 'Bank Charges', 'X000001'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    if (code === 'L9SUSPEN') suspenseId = rows[0].id;
    else chargesId = rows[0].id;
  }

  // §4.2 — a bank charge is an expense with no department anybody chose (D15).
  await withScope(scope(manager), (tx) =>
    coa.setRequiredDimensions(tx, manager, chargesId, []),
  );
});

/**
 * February, as both records saw it.
 *
 * | Date | The books | The bank |
 * |---|---|---|
 * | 31 Jan | +10,000 opening | opening balance 10,000 |
 * | 3 Feb | −1,500 TRF-9001 | −1,500 TRF-9001 |
 * | 11 Feb | +4,000 DEP-4412 | +4,000 DEP-4412 |
 * | 20 Feb | −1,000 × 3, one instruction | −3,000 BATCH-7 |
 * | 25 Feb | *nothing* | −25 FEE-02 |
 * | 27 Feb | −700 CHQ-77 | *nothing — not presented* |
 *
 * Ledger at 28 Feb: 8,800. Statement closing: 9,475.
 * 9,475 − 700 unpresented = 8,775, which is 25 short of the books — the fee
 * nobody recorded, and the only unexplained difference in the month.
 */
async function february() {
  await ledgerMovement({ date: '2026-02-01', amountIqd: '10000', reference: 'OPENING' });
  const paid = await ledgerMovement({
    date: '2026-02-03',
    amountIqd: '-1500',
    reference: 'TRF-9001',
    counterparty: 'SUP-001',
  });
  const received = await ledgerMovement({
    date: '2026-02-11',
    amountIqd: '4000',
    reference: 'DEP-4412',
    counterparty: 'CUST-001',
  });
  const batch = [
    await ledgerMovement({ date: '2026-02-20', amountIqd: '-1000', reference: 'BATCH-7 leg 1' }),
    await ledgerMovement({ date: '2026-02-20', amountIqd: '-1000', reference: 'BATCH-7 leg 2' }),
    await ledgerMovement({ date: '2026-02-20', amountIqd: '-1000', reference: 'BATCH-7 leg 3' }),
  ];
  const cheque = await ledgerMovement({
    date: '2026-02-27',
    amountIqd: '-700',
    reference: 'CHQ-77',
  });

  const statement = await withScope(scope(manager), (tx) =>
    statements.importStatement(tx, manager, {
      bankCashAccountId: bankAccountId,
      branchCode: BAGHDAD,
      periodFrom: '2026-02-01',
      periodTo: '2026-02-28',
      openingBalanceIqd: price('0'),
      closingBalanceIqd: price('9475'),
      lines: [
        {
          lineNo: 1,
          bookingDate: '2026-02-01',
          valueDate: '2026-02-01',
          amountIqd: price('10000'),
          reference: 'OPENING',
          counterparty: null,
          description: 'Balance brought forward',
        },
        {
          lineNo: 2,
          bookingDate: '2026-02-03',
          valueDate: '2026-02-03',
          amountIqd: price('-1500'),
          reference: 'TRF-9001',
          counterparty: 'SUP-001',
          description: 'Outgoing transfer',
        },
        {
          lineNo: 3,
          bookingDate: '2026-02-11',
          valueDate: '2026-02-11',
          amountIqd: price('4000'),
          reference: 'DEP-4412',
          counterparty: 'CUST-001',
          description: 'Customer deposit',
        },
        {
          lineNo: 4,
          bookingDate: '2026-02-20',
          valueDate: '2026-02-20',
          amountIqd: price('-3000'),
          reference: 'BATCH-7',
          counterparty: null,
          description: 'Payment instruction BATCH-7',
        },
        {
          lineNo: 5,
          bookingDate: '2026-02-25',
          valueDate: '2026-02-25',
          amountIqd: price('-25'),
          reference: 'FEE-02',
          counterparty: null,
          description: 'Account maintenance fee',
        },
      ],
    }),
  );

  const opened = await withScope(scope(officer), (tx) =>
    rec.open(tx, officer, statement.id),
  );

  return {
    statementId: statement.id,
    reconciliationId: opened.id,
    reconciliationNo: opened.reconciliationNo,
    bankLines: {
      paid: await bankLineOf(paid),
      received: await bankLineOf(received),
      batch: await Promise.all(batch.map(bankLineOf)),
      cheque: await bankLineOf(cheque),
    },
  };
}

async function statementLine(statementId: string, lineNo: number): Promise<string> {
  const { rows } = await ownerPool.query(
    `select id from bank_statement_line where statement_id = $1 and line_no = $2`,
    [statementId, lineNo],
  );
  return rows[0].id;
}

/** February worked through to the point where only the fee is unexplained. */
async function februaryMatched() {
  const feb = await february();

  await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));

  const { rows: suggested } = await ownerPool.query(
    `select id from bank_reconciliation_match where reconciliation_id = $1 and state = 'suggested'`,
    [feb.reconciliationId],
  );
  for (const match of suggested) {
    await withScope(scope(officer), (tx) => rec.confirmMatch(tx, officer, match.id));
  }

  // §12.5 — the batch: one statement line, three ledger entries.
  await withScope(scope(officer), async (tx) =>
    rec.matchManually(tx, officer, feb.reconciliationId, {
      statementLineIds: [await statementLine(feb.statementId, 4)],
      journalLineIds: feb.bankLines.batch,
    }),
  );

  return feb;
}

// ---------------------------------------------------------------------------

describe('07.7 gate · matching proposes, and never commits on its own (§17)', () => {
  it('finds the entries that are obviously the same movement', async () => {
    const feb = await february();

    const { proposals } = await withScope(scope(officer), (tx) =>
      rec.suggestMatches(tx, officer, feb.reconciliationId),
    );

    // The opening, TRF-9001 and DEP-4412 match one-to-one. The batch does not —
    // no single ledger entry is 3,000 — and neither does the fee or the
    // unpresented cheque.
    expect(proposals).toHaveLength(3);

    // The two with a counterparty on both sides score full marks; the opening
    // has none, so it scores on amount, reference and date alone. A lower score
    // is not a weaker match, it is less corroboration — which is exactly what a
    // person confirming it should be told.
    expect(proposals.filter((p) => p.confidence === 100)).toHaveLength(2);
    expect(proposals.every((p) => p.confidence >= 70)).toBe(true);
  });

  it('writes every proposal as a suggestion, never as agreed', async () => {
    const feb = await february();
    await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));

    const { rows } = await ownerPool.query(
      `select state, confirmed_by, confirmed_at from bank_reconciliation_match
        where reconciliation_id = $1`,
      [feb.reconciliationId],
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.state).toBe('suggested');
      expect(row.confirmed_by).toBeNull();
      expect(row.confirmed_at).toBeNull();
    }
  });

  it('says why it proposed each one', async () => {
    const feb = await february();
    await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));

    const { rows } = await ownerPool.query(
      `select why from bank_reconciliation_match where reconciliation_id = $1 order by match_no`,
      [feb.reconciliationId],
    );
    expect(rows[0].why).toMatch(/amount/);
    expect(rows[0].why).toMatch(/reference/);
  });

  it('puts a person’s name on a confirmation', async () => {
    const feb = await february();
    await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));

    const { rows: before } = await ownerPool.query(
      `select id from bank_reconciliation_match where reconciliation_id = $1 order by match_no limit 1`,
      [feb.reconciliationId],
    );
    await withScope(scope(officer), (tx) => rec.confirmMatch(tx, officer, before[0].id));

    const { rows: after } = await ownerPool.query(
      `select state, confirmed_by from bank_reconciliation_match where id = $1`,
      [before[0].id],
    );
    expect(after[0].state).toBe('confirmed');
    expect(after[0].confirmed_by).toBe(officer.principal.userId);
  });

  it('refuses to finalise while a suggestion is unconfirmed', async () => {
    const feb = await february();
    await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));

    expect(
      await rejection(withScope(scope(manager), (tx) => rec.finalise(tx, manager, feb.reconciliationId))),
    ).toMatch(/statement line|unconfirmed|nobody has confirmed/);
  });

  it('never proposes two entries of different amounts', async () => {
    const feb = await february();
    const { proposals } = await withScope(scope(officer), (tx) =>
      rec.suggestMatches(tx, officer, feb.reconciliationId),
    );

    // The −25 fee and the −700 cheque are the only near-misses in the month,
    // and neither appears in any proposal.
    const feeLine = await statementLine(feb.statementId, 5);
    expect(proposals.flatMap((p) => p.statementLineIds)).not.toContain(feeLine);
  });
});

describe('§12.5 · one statement line against a batch (the Phase 09 case)', () => {
  it('matches three ledger entries to one bank debit', async () => {
    const feb = await february();

    const { matchId } = await withScope(scope(officer), async (tx) =>
      rec.matchManually(tx, officer, feb.reconciliationId, {
        statementLineIds: [await statementLine(feb.statementId, 4)],
        journalLineIds: feb.bankLines.batch,
      }),
    );

    const { rows } = await ownerPool.query(
      `select count(*) filter (where statement_line_id is not null)::int as statement_side,
              count(*) filter (where journal_line_id is not null)::int as ledger_side
         from bank_reconciliation_match_line where match_id = $1`,
      [matchId],
    );
    expect(rows[0]).toMatchObject({ statement_side: 1, ledger_side: 3 });
  });

  it('refuses a batch whose legs do not total the statement line', async () => {
    const feb = await february();

    expect(
      await rejection(
        withScope(scope(officer), async (tx) =>
          rec.matchManually(tx, officer, feb.reconciliationId, {
            statementLineIds: [await statementLine(feb.statementId, 4)],
            journalLineIds: feb.bankLines.batch.slice(0, 2),
          }),
        ),
      ),
    ).toMatch(/not the same money/);
  });

  it('will not let the same journal line be matched twice', async () => {
    const feb = await february();
    await withScope(scope(officer), async (tx) =>
      rec.matchManually(tx, officer, feb.reconciliationId, {
        statementLineIds: [await statementLine(feb.statementId, 4)],
        journalLineIds: feb.bankLines.batch,
      }),
    );

    const { rows: match } = await ownerPool.query(
      `select id from bank_reconciliation_match where reconciliation_id = $1 limit 1`,
      [feb.reconciliationId],
    );

    await expect(
      ownerPool.query(
        `insert into bank_reconciliation_match_line (match_id, journal_line_id, amount_iqd)
         values ($1, $2, -1000)`,
        [match[0].id, feb.bankLines.batch[0]],
      ),
    ).rejects.toThrow(/bank_reconciliation_match_line_journal_uniq/);
  });
});

describe('07.7 gate · it cannot be finalised while a difference is unexplained (§17)', () => {
  it('is 25 short — the fee nobody recorded', async () => {
    const feb = await februaryMatched();

    const position = await withScope(scope(officer), (tx) =>
      rec.position(tx, officer, feb.reconciliationId),
    );

    expect(position.ledgerBalanceIqd).toBe(price('8800'));
    expect(position.statementClosingIqd).toBe(price('9475'));
    expect(position.unpresentedPaymentsIqd).toBe(price('700'));
    expect(position.reconciledBalanceIqd).toBe(price('8775'));
    expect(position.differenceIqd).toBe(price('-25'));
    expect(position.balanced).toBe(false);
  });

  it('refuses to finalise over it', async () => {
    const feb = await februaryMatched();

    expect(
      await rejection(withScope(scope(manager), (tx) => rec.finalise(tx, manager, feb.reconciliationId))),
    ).toMatch(/neither matched nor adjusted|will not let it be finalised/);
  });

  it('has no override to reach for', async () => {
    // finalise(tx, ctx, id) — three arguments and no flag. The only way past a
    // difference is to explain it.
    expect(rec.finalise.length).toBe(3);
  });

  it('will not let the database hold a signed reconciliation that did not balance', async () => {
    const feb = await februaryMatched();

    await expect(
      ownerPool.query(
        `update bank_reconciliation set approved_by = $2, approved_at = now(), difference_iqd = -25
          where id = $1`,
        [feb.reconciliationId, manager.principal.userId],
      ),
    ).rejects.toThrow(/bank_reconciliation_approved_means_balanced/);
  });
});

describe('07.7 gate · an adjustment posts through the Phase 02 engine (§17)', () => {
  it('records the fee, and matches the statement line to what it posted', async () => {
    const feb = await februaryMatched();

    const result = await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Account maintenance fee, February',
      }),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [result.journalEntryId],
    );

    // Money out of the bank: Cr Bank / Dr Bank Charges.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.code === 'X9BANKCH')!.debit_iqd).toBe('25.0000');
    const { rows: bankCode } = await ownerPool.query(
      `select code from chart_of_account where id = $1`,
      [bankGlId],
    );
    expect(rows.find((r) => r.code === bankCode[0].code)!.credit_iqd).toBe('25.0000');
  });

  it('balances the reconciliation, without anybody waiving anything', async () => {
    const feb = await februaryMatched();

    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Account maintenance fee, February',
      }),
    );

    const position = await withScope(scope(officer), (tx) =>
      rec.position(tx, officer, feb.reconciliationId),
    );
    expect(position.differenceIqd).toBe(0n);
    expect(position.balanced).toBe(true);
  });

  it('refuses an adjustment with no description', async () => {
    const feb = await februaryMatched();

    expect(
      await rejection(
        withScope(scope(manager), async (tx) =>
          rec.postAdjustment(tx, manager, feb.reconciliationId, {
            statementLineId: await statementLine(feb.statementId, 5),
            accountId: chargesId,
            description: '   ',
          }),
        ),
      ),
    ).toMatch(/needs a description/);
  });

  it('is a manager’s act — an officer cannot post one', async () => {
    const feb = await februaryMatched();

    expect(
      await rejection(
        withScope(scope(officer), async (tx) =>
          rec.postAdjustment(tx, officer, feb.reconciliationId, {
            statementLineId: await statementLine(feb.statementId, 5),
            accountId: chargesId,
            description: 'Fee',
          }),
        ),
      ),
    ).toMatch(/Permission denied/);
  });
});

describe('07.7 gate · the reconciled balance equals the G/L for the same date (§17)', () => {
  it('agrees a whole month, end to end', async () => {
    const feb = await februaryMatched();
    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Account maintenance fee, February',
      }),
    );

    const finalised = await withScope(scope(manager), (tx) =>
      rec.finalise(tx, manager, feb.reconciliationId),
    );

    expect(finalised.differenceIqd).toBe(0n);
    expect(finalised.reconciledBalanceIqd).toBe(finalised.ledgerBalanceIqd);

    // …and the G/L agrees independently of the reconciliation's own arithmetic.
    const [position] = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28', { branchCode: BAGHDAD }),
    );
    expect(parseDecimal(position!.balanceIqd, 4n)).toBe(finalised.ledgerBalanceIqd);
  });

  it('closes the statement when the reconciliation is signed', async () => {
    const feb = await februaryMatched();
    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Fee',
      }),
    );
    await withScope(scope(manager), (tx) => rec.finalise(tx, manager, feb.reconciliationId));

    const { rows } = await ownerPool.query(`select status from bank_statement where id = $1`, [
      feb.statementId,
    ]);
    expect(rows[0].status).toBe('closed');
  });

  it('records who agreed it and when', async () => {
    const feb = await februaryMatched();
    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Fee',
      }),
    );
    await withScope(scope(manager), (tx) => rec.finalise(tx, manager, feb.reconciliationId));

    const { rows } = await ownerPool.query(
      `select status, approved_by, approved_at, difference_iqd, unpresented_payments_iqd
         from bank_reconciliation where id = $1`,
      [feb.reconciliationId],
    );
    expect(rows[0].status).toBe('approved');
    expect(rows[0].approved_by).toBe(manager.principal.userId);
    expect(rows[0].approved_at).toBeInstanceOf(Date);
    expect(Number(rows[0].difference_iqd)).toBe(0);
    expect(Number(rows[0].unpresented_payments_iqd)).toBe(700);
  });
});

describe('07.7 gate · reconciled lines are immutable; corrections go through reopen (§17)', () => {
  async function finalisedFebruary() {
    const feb = await februaryMatched();
    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Fee',
      }),
    );
    await withScope(scope(manager), (tx) => rec.finalise(tx, manager, feb.reconciliationId));
    return feb;
  }

  it('refuses to change a matched line’s amount', async () => {
    const feb = await finalisedFebruary();

    await expect(
      ownerPool.query(`update bank_statement_line set amount_iqd = -1600 where id = $1`, [
        await statementLine(feb.statementId, 1),
      ]),
    ).rejects.toThrow(/has been reconciled and cannot be changed/);
  });

  it('refuses to change its date or reference either', async () => {
    const feb = await finalisedFebruary();
    const line = await statementLine(feb.statementId, 1);

    await expect(
      ownerPool.query(`update bank_statement_line set booking_date = '2026-02-04' where id = $1`, [
        line,
      ]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      ownerPool.query(`update bank_statement_line set reference = 'OTHER' where id = $1`, [line]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('refuses to delete one', async () => {
    const feb = await finalisedFebruary();

    await expect(
      ownerPool.query(`delete from bank_statement_line where id = $1`, [
        await statementLine(feb.statementId, 1),
      ]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('reopens with a reason, and lets the lines move again', async () => {
    const feb = await finalisedFebruary();

    await withScope(scope(manager), (tx) =>
      rec.reopen(tx, manager, feb.reconciliationId, 'The 20 February batch matched the wrong legs.'),
    );

    const { rows } = await ownerPool.query(
      `select status, reopen_count, reopen_reason, approved_by from bank_reconciliation where id = $1`,
      [feb.reconciliationId],
    );
    expect(rows[0]).toMatchObject({ status: 'draft', reopen_count: 1, approved_by: null });
    expect(rows[0].reopen_reason).toMatch(/wrong legs/);

    // The line is editable again — the correction route works.
    await ownerPool.query(`update bank_statement_line set counterparty = 'SUP-002' where id = $1`, [
      await statementLine(feb.statementId, 1),
    ]);
  });

  it('refuses a reopen with no reason', async () => {
    const feb = await finalisedFebruary();

    expect(
      await rejection(
        withScope(scope(manager), (tx) => rec.reopen(tx, manager, feb.reconciliationId, '  ')),
      ),
    ).toMatch(/needs a reason/);
  });

  it('audits the reopen with the actor, the time and the reason', async () => {
    const feb = await finalisedFebruary();
    await withScope(scope(manager), (tx) =>
      rec.reopen(tx, manager, feb.reconciliationId, 'Wrong legs matched.'),
    );

    const { rows } = await ownerPool.query(
      `select actor_user_id, occurred_at, reason from audit_event
        where action = 'bank_reconciliation.reopened' and object_id = $1`,
      [feb.reconciliationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(manager.principal.userId);
    expect(rows[0].occurred_at).toBeInstanceOf(Date);
    expect(rows[0].reason).toMatch(/Wrong legs/);
  });

  it('makes the matches suggestions again, so they must be agreed a second time', async () => {
    const feb = await finalisedFebruary();
    await withScope(scope(manager), (tx) =>
      rec.reopen(tx, manager, feb.reconciliationId, 'Wrong legs matched.'),
    );

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from bank_reconciliation_match
        where reconciliation_id = $1 and state = 'confirmed'`,
      [feb.reconciliationId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('will not reopen one that was never finalised', async () => {
    const feb = await februaryMatched();

    expect(
      await rejection(withScope(scope(manager), (tx) => rec.reopen(tx, manager, feb.reconciliationId, 'x'))),
    ).toMatch(/only a finalised reconciliation can be reopened/);
  });
});

describe('07.7 gate · unmatched and unidentified items are reported and aged (§17)', () => {
  it('reports both sides, and says what each one means', async () => {
    const feb = await februaryMatched();

    const report = await withScope(scope(officer), (tx) =>
      rec.unmatchedReport(tx, officer, feb.reconciliationId),
    );

    // The bank fee nobody recorded, and the cheque nobody presented.
    expect(report.statement).toHaveLength(1);
    expect(report.statement[0]!.reference).toBe('FEE-02');
    expect(report.ledger).toHaveLength(1);
    expect(report.ledger[0]!.reference).toBe('CHQ-77');
    expect(report.ledger[0]!.kind).toBe('unpresented');
  });

  it('ages each item to the reconciliation date', async () => {
    const feb = await februaryMatched();

    const report = await withScope(scope(officer), (tx) =>
      rec.unmatchedReport(tx, officer, feb.reconciliationId),
    );

    expect(report.statement[0]!.ageDays).toBe(3); // 25 Feb → 28 Feb
    expect(report.ledger[0]!.ageDays).toBe(1); // 27 Feb → 28 Feb
  });

  it('empties once everything is explained', async () => {
    const feb = await februaryMatched();
    await withScope(scope(manager), async (tx) =>
      rec.postAdjustment(tx, manager, feb.reconciliationId, {
        statementLineId: await statementLine(feb.statementId, 5),
        accountId: chargesId,
        description: 'Fee',
      }),
    );

    const report = await withScope(scope(officer), (tx) =>
      rec.unmatchedReport(tx, officer, feb.reconciliationId),
    );

    // The statement side is empty; the cheque stays, because it is a timing
    // difference and not a mistake.
    expect(report.statement).toHaveLength(0);
    expect(report.ledger).toHaveLength(1);
  });
});

describe('§17 · a reconciliation is of one statement, for one account', () => {
  it('refuses a second reconciliation of the same statement', async () => {
    const feb = await february();

    expect(await rejection(withScope(scope(officer), (tx) => rec.open(tx, officer, feb.statementId)))).toMatch(
      /bank_reconciliation_statement_uniq/,
    );
  });

  it('refuses to reconcile a statement that has not been closed', async () => {
    const opened = await withScope(scope(officer), (tx) =>
      statements.openStatement(tx, officer, {
        bankCashAccountId: bankAccountId,
        branchCode: BAGHDAD,
        periodFrom: '2026-03-01',
        periodTo: '2026-03-31',
        openingBalanceIqd: price('0'),
        closingBalanceIqd: price('0'),
      }),
    );

    expect(await rejection(withScope(scope(officer), (tx) => rec.open(tx, officer, opened.id)))).toMatch(
      /has not been closed/,
    );
  });
});
