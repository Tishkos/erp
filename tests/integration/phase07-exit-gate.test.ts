/**
 * Phase 07 exit gate — §17's five minimum acceptance criteria, end to end.
 *
 * | # | Criterion |
 * |---|---|
 * | 1 | Payment batches enforce maker-checker controls and source approval |
 * | 2 | Bank statement matching supports automatic suggestions and manual confirmation |
 * | 3 | Reconciled bank balance agrees to the G/L for the same date |
 * | 4 | Unmatched and unidentified items are reported and aged |
 * | 5 | Treasury dashboard provides current and forecast liquidity by currency |
 *
 * The sub-phase tests prove each control on its own. This one proves they
 * **compose**: one month in which money is proposed, approved by a second
 * person, sent by a third, shown on a bank statement, matched back to the
 * ledger, agreed, and then read off the dashboard. That is where a treasury
 * system either holds together or does not, and it is the thing no single
 * sub-phase test can say.
 *
 * It also completes the Phase 05 chain the phase plan names:
 * … → A/P Invoice → payment → **bank reconciliation** → G/L.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as run from '@/server/services/payment-run';
import * as statements from '@/server/services/bank-statement';
import * as rec from '@/server/services/bank-reconciliation';
import * as cash from '@/server/services/cash-forecast';
import * as treasury from '@/server/services/treasury';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

/** §17's three hands. */
let maker: ActorContext;
let checker: ActorContext;
let executor: ActorContext;

let bankAccountId: string;
let bankGlId: string;
let bankGlCode: string;
let supplierId: string;
let suspenseId: string;
let chargesId: string;
let accounts: Record<string, string>;
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

/** Opening money in the bank's G/L account. */
async function fund(amountIqd: string, on: string) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'OPENING','draft',$5,$5,$6) returning id`,
      [`JE-OPEN-${(seq += 1)}`, on, periods[0].id, BAGHDAD, amountIqd, checker.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code, line_description)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5, 'OPENING'),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5, 'OPENING')`,
      [entry[0].id, bankGlId, amountIqd, suspenseId, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, checker.principal.userId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** An approved, posted A/P invoice — the debt the run will pay. */
async function payable(dueDate: string, totalIqd: string) {
  const { rows } = await ownerPool.query(
    `insert into ap_invoice
       (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date,
        currency, total_iqd, settled_amount_iqd, status, created_by,
        non_po_justification, non_po_approved_by, non_po_approved_at)
     values ($1,$2,$3,$4,'2026-02-01',$5,'IQD',$6,0,'posted',$7,
             'Exit-gate fixture invoice', $7, now()) returning id`,
    [
      `API-${(seq += 1)}`,
      `SUP-INV-${seq}`,
      supplierId,
      BAGHDAD,
      dueDate,
      totalIqd,
      maker.principal.userId,
    ],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  maker = await createUser('accounting_officer');
  checker = await createUser('accounting_manager');
  executor = await createUser('accounting_manager');

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
    [checker.principal.userId],
  );

  const { rows: bank } = await ownerPool.query(
    `select b.id, b.gl_account_id, a.code from bank_cash_account b
       join chart_of_account a on a.id = b.gl_account_id
      where b.branch_code = $1 and b.account_type = 'bank' limit 1`,
    [BAGHDAD],
  );
  bankAccountId = bank[0].id;
  bankGlId = bank[0].gl_account_id;
  bankGlCode = bank[0].code;

  accounts = {};
  for (const [role, parent, code, name, control] of [
    ['supplier_payable', 'L000001', 'L9PAY', 'Trade Payables', 'supplier'],
    ['suspense', 'L000001', 'L9SUSPEN', 'Funding Suspense', null],
    ['bank_charges', 'X000001', 'X9BANKCH', 'Bank Charges', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [code, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
  }
  suspenseId = accounts.suspense!;
  chargesId = accounts.bank_charges!;

  // §4.2 — a bank charge is an expense nobody chose a department for (D15).
  await withScope(scope(checker), (tx) =>
    coa.setRequiredDimensions(tx, checker, chargesId, []),
  );

  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('purchasing.supplier_payment','supplier_payable',$1,true,$2)
     on conflict do nothing`,
    [accounts.supplier_payable, checker.principal.userId],
  );

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','Supplier One', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  await ownerPool.query(
    `insert into partner_bank_account
       (partner_id, bank_name, account_number, currency, approval_status, is_active,
        created_by, approved_by, approved_at)
     values ($1,'Rafidain Bank','IQ00-1111','IQD','approved',true,$2,$3,now())`,
    [supplierId, maker.principal.userId, checker.principal.userId],
  );
});

// ---------------------------------------------------------------------------

describe('Phase 07 exit gate · §17, end to end', () => {
  it('proposes, approves, sends, banks and agrees one month of treasury', async () => {
    // ── 1 · The month opens with money in the bank ────────────────────────
    await fund('20000', '2026-02-01');
    await payable('2026-02-10', '1500');
    await payable('2026-02-12', '3000');

    const opening = await withScope(scope(maker), (tx) =>
      cash.dailyPosition(tx, maker, '2026-02-01', { branchCode: BAGHDAD }),
    );
    expect(Number(opening.totalIqd)).toBe(20000);

    // ── 2 · The forecast sees what is coming (criterion 5) ────────────────
    const forecast = await withScope(scope(maker), (tx) =>
      cash.forecast(tx, maker, { from: '2026-02-02', to: '2026-02-28', branchCode: BAGHDAD }),
    );
    expect(Number(forecast.openingIqd)).toBe(20000);
    expect(Number(forecast.closingIqd)).toBe(15500); // 20,000 − 4,500 due
    // §17 names five sources; Phase 13 added `investment_calls` as a sixth,
    // because §13.8 requires the investment cash-flow forecast to feed this one
    // rather than stand beside it as a second forecast nobody reconciles.
    // The closing balance above is unchanged: there are no capital calls here.
    expect(forecast.sources).toHaveLength(6);

    // ── 3 · A payment run: proposed by one, approved by another ───────────
    const proposal = await withScope(scope(maker), (tx) =>
      run.buildProposal(tx, maker, {
        branchCode: BAGHDAD,
        bankCashAccountId: bankAccountId,
        proposalDate: '2026-02-15',
        payDate: '2026-02-15',
      }),
    );
    expect(proposal.selection.selected).toHaveLength(2);

    await withScope(scope(checker), (tx) => run.approveProposal(tx, checker, proposal.id));

    const batch = await withScope(scope(maker), (tx) =>
      run.createBatch(tx, maker, { proposalId: proposal.id, paymentDate: '2026-02-15' }),
    );

    // Criterion 1 — maker-checker. The person who raised it cannot approve it.
    expect(batch.highRisk).toBe(true);
    expect(
      await rejection(withScope(scope(maker), (tx) => run.approveBatch(tx, maker, batch.id))),
    ).toBeTruthy();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    // …and the approver cannot send it either.
    expect(
      await rejection(
        withScope(scope(checker), (tx) =>
          run.executeBatch(tx, checker, { batchId: batch.id, bankInstructionRef: 'TRF-FEB' }),
        ),
      ),
    ).toMatch(/cannot have approved and executed/);

    const executed = await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-FEB' }),
    );
    expect(executed.paymentIds).toHaveLength(2);

    // Both debts are settled, and the bank is 4,500 lighter.
    const { rows: invoices } = await ownerPool.query(
      `select status from ap_invoice order by invoice_no`,
    );
    expect(invoices.map((r) => r.status)).toEqual(['settled', 'settled']);

    const afterPaying = await withScope(scope(maker), (tx) =>
      treasury.balances(tx, maker, '2026-02-28', { accountCode: null }),
    );
    const bankPosition = afterPaying.find((a) => a.glAccountCode === bankGlCode)!;
    expect(Number(bankPosition.balanceIqd)).toBe(15500);

    // ── 4 · The bank's own account of the month ───────────────────────────
    const statement = await withScope(scope(checker), (tx) =>
      statements.importStatement(tx, checker, {
        bankCashAccountId: bankAccountId,
        branchCode: BAGHDAD,
        periodFrom: '2026-02-01',
        periodTo: '2026-02-28',
        openingBalanceIqd: price('0'),
        // 20,000 in, two payments out, and a fee nobody recorded.
        closingBalanceIqd: price('15470'),
        lines: [
          {
            lineNo: 1,
            bookingDate: '2026-02-01',
            valueDate: '2026-02-01',
            amountIqd: price('20000'),
            reference: 'OPENING',
            counterparty: null,
            description: 'Balance brought forward',
          },
          {
            lineNo: 2,
            bookingDate: '2026-02-15',
            valueDate: '2026-02-15',
            amountIqd: price('-1500'),
            reference: 'TRF-FEB',
            counterparty: 'SUP-001',
            description: 'Payment instruction TRF-FEB',
          },
          {
            lineNo: 3,
            bookingDate: '2026-02-15',
            valueDate: '2026-02-15',
            amountIqd: price('-3000'),
            reference: 'TRF-FEB',
            counterparty: 'SUP-001',
            description: 'Payment instruction TRF-FEB',
          },
          {
            lineNo: 4,
            bookingDate: '2026-02-26',
            valueDate: '2026-02-26',
            amountIqd: price('-30'),
            reference: 'FEE-FEB',
            counterparty: null,
            description: 'Account maintenance fee',
          },
        ],
      }),
    );
    expect(statement.imported).toBe(4);

    // ── 5 · The reconciliation (criteria 2, 3 and 4) ──────────────────────
    const reconciliation = await withScope(scope(maker), (tx) =>
      rec.open(tx, maker, statement.id),
    );

    // Criterion 2 — automatic suggestions…
    const { proposals } = await withScope(scope(maker), (tx) =>
      rec.suggestMatches(tx, maker, reconciliation.id),
    );
    expect(proposals.length).toBeGreaterThanOrEqual(3);

    // …and manual confirmation. Nothing is agreed until somebody agrees it.
    const { rows: unconfirmed } = await ownerPool.query(
      `select count(*)::int as n from bank_reconciliation_match
        where reconciliation_id = $1 and state = 'confirmed'`,
      [reconciliation.id],
    );
    expect(unconfirmed[0].n).toBe(0);

    const { rows: suggested } = await ownerPool.query(
      `select id from bank_reconciliation_match where reconciliation_id = $1`,
      [reconciliation.id],
    );
    for (const match of suggested) {
      await withScope(scope(maker), (tx) => rec.confirmMatch(tx, maker, match.id));
    }

    // Criterion 4 — what is left is reported and aged: the fee nobody booked.
    const unmatched = await withScope(scope(maker), (tx) =>
      rec.unmatchedReport(tx, maker, reconciliation.id),
    );
    expect(unmatched.statement).toHaveLength(1);
    expect(unmatched.statement[0]!.reference).toBe('FEE-FEB');
    expect(unmatched.statement[0]!.ageDays).toBe(2);

    // It cannot be signed while that difference is unexplained.
    expect(
      await rejection(withScope(scope(checker), (tx) => rec.finalise(tx, checker, reconciliation.id))),
    ).toBeTruthy();

    const feeLineId = unmatched.statement[0]!.id;
    await withScope(scope(checker), async (tx) =>
      rec.postAdjustment(tx, checker, reconciliation.id, {
        statementLineId: feeLineId,
        accountId: chargesId,
        description: 'Account maintenance fee, February',
      }),
    );

    // Criterion 3 — and now the two balances agree for the same date.
    const finalised = await withScope(scope(checker), (tx) =>
      rec.finalise(tx, checker, reconciliation.id),
    );
    expect(finalised.differenceIqd).toBe(0n);
    expect(finalised.reconciledBalanceIqd).toBe(finalised.ledgerBalanceIqd);
    expect(finalised.statementClosingIqd).toBe(price('15470'));

    // ── 6 · The dashboard, after all of it (criterion 5) ──────────────────
    const closing = await withScope(scope(maker), (tx) =>
      cash.dailyPosition(tx, maker, '2026-02-28', { branchCode: BAGHDAD }),
    );
    expect(Number(closing.totalIqd)).toBe(15470);
    expect(closing.byCurrency.map((row) => row.currency)).toEqual(['IQD']);

    const exposure = await withScope(scope(maker), (tx) =>
      cash.currencyExposure(tx, maker, '2026-02-28', BAGHDAD),
    );
    expect(exposure.find((row) => row.currency === 'IQD')).toBeDefined();

    // …and the forecast has nothing left to expect, because it was all paid.
    const after = await withScope(scope(maker), (tx) =>
      cash.forecast(tx, maker, { from: '2026-03-01', to: '2026-03-31', branchCode: BAGHDAD }),
    );
    expect(after.lines).toHaveLength(0);
    expect(Number(after.closingIqd)).toBe(15470);
  });

  it('leaves an audit trail that names every hand the money passed through', async () => {
    await fund('20000', '2026-02-01');
    await payable('2026-02-10', '1500');

    const proposal = await withScope(scope(maker), (tx) =>
      run.buildProposal(tx, maker, {
        branchCode: BAGHDAD,
        bankCashAccountId: bankAccountId,
        proposalDate: '2026-02-15',
        payDate: '2026-02-15',
      }),
    );
    await withScope(scope(checker), (tx) => run.approveProposal(tx, checker, proposal.id));
    const batch = await withScope(scope(maker), (tx) =>
      run.createBatch(tx, maker, { proposalId: proposal.id, paymentDate: '2026-02-15' }),
    );
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-FEB' }),
    );

    const { rows } = await ownerPool.query(
      `select action, actor_user_id from audit_event
        where object_id in ($1, $2) order by occurred_at`,
      [proposal.id, batch.id],
    );

    const by = new Map(rows.map((row) => [row.action, row.actor_user_id]));
    expect(by.get('payment_proposal.built')).toBe(maker.principal.userId);
    expect(by.get('payment_proposal.approved')).toBe(checker.principal.userId);
    expect(by.get('payment_batch.created')).toBe(maker.principal.userId);
    expect(by.get('payment_batch.approved')).toBe(checker.principal.userId);
    expect(by.get('payment_batch.executed')).toBe(executor.principal.userId);

    // Three different people, which is what §17 asks for and what an auditor
    // reading this trail can see without being told.
    expect(new Set([...by.values()]).size).toBe(3);
  });
});
