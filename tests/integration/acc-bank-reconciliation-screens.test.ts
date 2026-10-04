/**
 * Bank Reconciliation — the screens over Phase 07.6/07.7 (REQ-ACC-001 Part D-3).
 *
 * What the screens added to the engines: a statement's lines typed on its
 * record or pasted from the bank's file (the same `appendLine` every line
 * takes, a pasted file twice adds nothing, an unreadable row is kept with its
 * reason); the register and the record's one read (`listForScreen`,
 * `workspace`) with each statement's stage; and the printed copy.
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

import { runExport } from '@/server/print/export';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import * as attachments from '@/server/services/attachments';
import * as recordNotes from '@/server/services/record-notes';

describe('Bank Reconciliation · the statement entered on its record', () => {
  it('takes typed and pasted lines through the one path, keeps what it cannot read, and closes only when it adds up', async () => {
    const opened = await withScope(scope(officer), (tx) =>
      statements.openStatement(tx, officer, {
        bankCashAccountId: bankAccountId,
        branchCode: BAGHDAD,
        periodFrom: '2026-03-01',
        periodTo: '2026-03-31',
        openingBalanceIqd: price('0'),
        closingBalanceIqd: price('900'),
      }),
    );

    const typed = await withScope(scope(officer), (tx) =>
      statements.addLines(tx, officer, opened.id, {
        source: 'typed',
        lines: [{ bookingDate: '2026-03-02', valueDate: '2026-03-02', amountIqd: price('1000'), reference: 'DEP-1', counterparty: null, description: null }],
      }),
    );
    expect(typed).toEqual({ added: 1, duplicates: 0, rejected: 0 });

    const file = [
      'booking_date,amount_iqd,reference,description',
      '2026-03-05,-75,FEE-03,Charges',
      '2026-03-06,-25,FEE-04,"Charges, again"',
      'yesterday,10,BAD,Not a date',
    ].join('\n');
    const read = statements.readPastedLines(file);
    expect(read.lines).toHaveLength(2);
    expect(read.rejected).toEqual([{ rawText: 'yesterday,10,BAD,Not a date', problem: 'booking_date is not a date (YYYY-MM-DD).' }]);

    const pasted = await withScope(scope(officer), (tx) => statements.addLines(tx, officer, opened.id, { source: 'pasted', ...read }));
    expect(pasted).toEqual({ added: 2, duplicates: 0, rejected: 1 });
    // The same file again adds nothing: its rows are recognised by their key.
    const again = await withScope(scope(officer), (tx) =>
      statements.addLines(tx, officer, opened.id, { source: 'pasted', lines: read.lines }),
    );
    expect(again).toEqual({ added: 0, duplicates: 2, rejected: 0 });

    const ctx = { principal: officer.principal, branchCode: BAGHDAD };
    const view = await withScope(scope(officer), (tx) => rec.workspace(tx, ctx, opened.statementNo));
    expect(view.statement.stage).toBe('statement');
    expect(view.lines.map((l) => [l.lineNo, l.amountIqd])).toEqual([
      [1, '1000.0000'],
      [2, '-75.0000'],
      [3, '-25.0000'],
    ]);
    expect(view.rejected.map((r) => r.lineNo)).toEqual([4]);

    // 0 + 1,000 − 75 − 25 = 900: it adds up, so the manager closes it.
    await withScope(scope(manager), (tx) => statements.closeStatement(tx, manager, opened.id));
    const closed = await withScope(scope(officer), (tx) => rec.workspace(tx, ctx, opened.statementNo));
    expect(closed.statement.stage).toBe('ready');

    // A closed statement takes no more lines.
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          statements.addLines(tx, officer, opened.id, {
            source: 'typed',
            lines: [{ bookingDate: '2026-03-07', valueDate: '2026-03-07', amountIqd: price('5'), reference: null, counterparty: null, description: null }],
          }),
        ),
      ),
    ).toMatch(/Lines are added while it is a draft/);
  });
});

describe('Bank Reconciliation · the register and the record', () => {
  it('shows each statement’s stage, its reconciliation’s arithmetic and what is still unmatched', async () => {
    const feb = await february();
    const ctx = { principal: officer.principal, branchCode: BAGHDAD };

    const list = await withScope(scope(officer), (tx) => rec.listForScreen(tx, ctx, {}));
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ reconciliationNo: feb.reconciliationNo, stage: 'reconciling', lineCount: 5, unmatchedCount: 5 });
    expect((await withScope(scope(officer), (tx) => rec.listForScreen(tx, ctx, { view: 'reconciled' }))).total).toBe(0);

    const statementNo = list.rows[0]!.statementNo;
    let view = await withScope(scope(officer), (tx) => rec.workspace(tx, ctx, statementNo));
    // Nothing matched yet: every ledger item reads as a timing difference, so
    // the whole of the bank's closing balance is still to be explained.
    expect(view.reconciliation!.position.differenceIqd).toBe(price('9475'));
    expect(view.reconciliation!.ledger).toHaveLength(7);
    expect(view.glCode).toBeTruthy();

    await withScope(scope(officer), (tx) => rec.suggestMatches(tx, officer, feb.reconciliationId));
    view = await withScope(scope(officer), (tx) => rec.workspace(tx, ctx, statementNo));
    expect(view.reconciliation!.matches.length).toBeGreaterThan(0);
    expect(view.reconciliation!.matches.every((m) => m.state === 'suggested')).toBe(true);
    expect(view.reconciliation!.matches[0]!.journalLines[0]!.entryNo).toMatch(/^JE-/);

    // Printed: the statement's lines, and the matches.
    const copy = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'bank_reconciliation',
        format: 'xlsx',
        locale: 'en',
        at: '2026-03-01T09:00:00.000Z',
        input: { id: statementNo, query: new URLSearchParams() },
      }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) {
      expect(copy.model.tables[0]!.rows).toHaveLength(5);
      expect(copy.model.tables[0]!.totals!.cells.amount).toBe('9475.0000');
      expect(copy.model.tables[1]!.rows.length).toBe(view.reconciliation!.matches.length);
    }
  });

  it('files the bank’s statement on the statement, for whoever reads reconciliations', async () => {
    registerAttachmentRuntime();
    const feb = await february();
    const uploaded = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        objectType: statements.DOCUMENT_TYPE,
        objectId: feb.statementId,
        fileName: 'february.pdf',
        content: Buffer.from('%PDF-1.4\n%%EOF\n'),
      }),
    );
    expect(uploaded.quarantined).toBe(false);

    // The shared Notes door is the statement's — the record from its draft —
    // by whoever enters statements, in the statement's branch.
    await withScope(scope(officer), (tx) =>
      recordNotes.addNote(tx, officer, { object: statements.DOCUMENT_TYPE, recordId: feb.statementId, body: 'Bank fee of 3,000 queried with the branch' }),
    );
    const read = await withScope(scope(officer), (tx) => recordNotes.listNotes(tx, { object: statements.DOCUMENT_TYPE, recordId: feb.statementId }));
    expect(read.map((n) => n.body)).toEqual(['Bank fee of 3,000 queried with the branch']);
  });
});
