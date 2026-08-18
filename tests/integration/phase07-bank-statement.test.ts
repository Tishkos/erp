/**
 * Phase 07.6 test gate — bank statement import. §17, §23, Appendix B.
 *
 *   - Importing the same statement twice does not duplicate lines
 *   - Statement lines carry date, value date, amount, reference and counterparty
 *   - An unparseable line is reported rather than silently dropped
 *   - The import runs through the Phase 01 import framework with preview, error
 *     file and batch ID
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as statements from '@/server/services/bank-statement';
import * as imports from '@/server/services/import';
import '@/server/services/import-definitions';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let officer: ActorContext;
let manager: ActorContext;
let bankAccountId: string;
let cashAccountId: string | null;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
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

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  const { rows: bank } = await ownerPool.query(
    `select id from bank_cash_account
      where branch_code = $1 and account_type = 'bank' limit 1`,
    [BAGHDAD],
  );
  bankAccountId = bank[0].id;

  const { rows: cash } = await ownerPool.query(
    `select id from bank_cash_account
      where branch_code = $1 and account_type = 'cash' limit 1`,
    [BAGHDAD],
  );
  cashAccountId = cash[0]?.id ?? null;
});

/** The statement the tests import, as a bank would send it. */
const LINES = [
  {
    lineNo: 1,
    bookingDate: '2026-02-03',
    valueDate: '2026-02-03',
    amountIqd: price('-1500'),
    reference: 'TRF-9001',
    counterparty: 'Supplier One',
    description: 'Outgoing transfer',
  },
  {
    lineNo: 2,
    bookingDate: '2026-02-11',
    valueDate: '2026-02-13',
    amountIqd: price('4000'),
    reference: 'DEP-4412',
    counterparty: 'Al Rasheed Trading',
    description: 'Customer deposit',
  },
  {
    lineNo: 3,
    bookingDate: '2026-02-25',
    valueDate: '2026-02-25',
    amountIqd: price('-25'),
    reference: 'FEE-02',
    counterparty: null,
    description: 'Account maintenance fee',
  },
] as const;

const HEADER = {
  branchCode: BAGHDAD,
  periodFrom: '2026-02-01',
  periodTo: '2026-02-28',
  openingBalanceIqd: price('10000'),
  // 10,000 − 1,500 + 4,000 − 25
  closingBalanceIqd: price('12475'),
};

/**
 * The one-shot path: header, lines and close in a single call.
 *
 * Run as the manager, because closing a statement is *agreeing* the bank's
 * figures — an approval, and not the same act as typing the lines in.
 */
async function importOnce(overrides: Partial<statements.ImportStatementInput> = {}) {
  return withScope(scope(manager), (tx) =>
    statements.importStatement(tx, manager, {
      ...HEADER,
      bankCashAccountId: bankAccountId,
      lines: [...LINES],
      ...overrides,
    }),
  );
}

/** A line identical to LINES[2] on every visible field — and a real second fee. */
const TWIN = {
  lineNo: 4,
  bookingDate: '2026-02-25',
  valueDate: '2026-02-25',
  amountIqd: price('-25'),
  reference: 'FEE-02',
  counterparty: null,
  description: 'Account maintenance fee',
} as const;

/** The header alone, as a person opens it before the file arrives. */
async function openHeader() {
  return withScope(scope(officer), (tx) =>
    statements.openStatement(tx, officer, { ...HEADER, bankCashAccountId: bankAccountId }),
  );
}

/** Every line through the one function a screen and a file both call. */
async function appendAll(
  statementId: string,
  lines: readonly {
    lineNo: number;
    bookingDate: string;
    valueDate: string;
    amountIqd: bigint;
    reference: string | null;
    counterparty: string | null;
    description: string | null;
  }[],
) {
  const results = [];
  for (const line of lines) {
    results.push(
      await withScope(scope(officer), (tx) =>
        statements.appendLine(tx, officer, statementId, line),
      ),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------

describe('07.6 gate · importing the same statement twice does not duplicate lines', () => {
  it('takes every line the first time', async () => {
    const result = await importOnce();
    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
  });

  it('refuses a second statement for the same account and period', async () => {
    await importOnce();

    // The commonest way the same statement arrives twice is somebody importing
    // the file again. Two statements for one period would double-count in the
    // reconciliation, so this is caught before a line is read.
    expect(await rejection(importOnce())).toMatch(/bank_statement_period_uniq/);
  });

  it('takes none of the lines a second time when the same file is re-imported', async () => {
    const header = await openHeader();

    const first = await appendAll(header.id, LINES);
    const second = await appendAll(header.id, LINES);

    expect(first.filter((row) => !row.duplicate)).toHaveLength(3);
    expect(second.every((row) => row.duplicate)).toBe(true);

    const { rows } = await ownerPool.query(`select count(*)::int as n from bank_statement_line`);
    expect(rows[0].n).toBe(3);
  });

  it('is immune to renumbering when the bank gives its own transaction id', async () => {
    const header = await openHeader();
    const withIds = LINES.map((line) => ({ ...line, bankReference: `TXN-${line.lineNo}` }));

    await appendAll(header.id, withIds);

    // The same three transactions, re-exported in a different order so every
    // row number moved. The bank's own identifier does not move with them.
    const renumbered = await appendAll(
      header.id,
      withIds.map((line, index) => ({ ...line, lineNo: index + 40 })),
    );

    expect(renumbered.every((row) => row.duplicate)).toBe(true);
  });

  it('keeps two genuinely identical transactions apart', async () => {
    const header = await openHeader();
    const results = await appendAll(header.id, [...LINES, TWIN]);

    expect(results.filter((row) => !row.duplicate)).toHaveLength(4);
  });

  it('and still recognises both of them on a re-import', async () => {
    const header = await openHeader();
    await appendAll(header.id, [...LINES, TWIN]);
    const again = await appendAll(header.id, [...LINES, TWIN]);

    expect(again.every((row) => row.duplicate)).toBe(true);

    const { rows } = await ownerPool.query(`select count(*)::int as n from bank_statement_line`);
    expect(rows[0].n).toBe(4);
  });

  it('prefers the bank’s own transaction id where it gives one', async () => {
    await importOnce({
      lines: LINES.map((line) => ({ ...line, bankReference: `TXN-${line.lineNo}` })),
    });

    const { rows } = await ownerPool.query(
      `select import_key from bank_statement_line order by line_no`,
    );
    expect(rows.map((row) => row.import_key)).toEqual([
      expect.stringMatching(/^bank:.*:TXN-1$/),
      expect.stringMatching(/^bank:.*:TXN-2$/),
      expect.stringMatching(/^bank:.*:TXN-3$/),
    ]);
  });

  it('will not let a duplicate key in by any route', async () => {
    await importOnce();
    const { rows } = await ownerPool.query(
      `select statement_id, import_key from bank_statement_line limit 1`,
    );

    await expect(
      ownerPool.query(
        `insert into bank_statement_line
           (statement_id, line_no, import_key, booking_date, value_date, amount_iqd)
         values ($1, 99, $2, '2026-02-03', '2026-02-03', -1)`,
        [rows[0].statement_id, rows[0].import_key],
      ),
    ).rejects.toThrow(/bank_statement_line_import_key_uniq/);
  });
});

describe('07.6 gate · lines carry date, value date, amount, reference and counterparty', () => {
  it('keeps all five, exactly as the bank sent them', async () => {
    const result = await importOnce();
    const view = await withScope(scope(officer), (tx) => statements.view(tx, result.id));

    expect(view.lines[1]).toMatchObject({
      bookingDate: '2026-02-11',
      valueDate: '2026-02-13',
      amountIqd: '4000.0000',
      reference: 'DEP-4412',
      counterparty: 'Al Rasheed Trading',
    });
  });

  it('keeps the sign rather than splitting into debit and credit columns', async () => {
    const result = await importOnce();
    const view = await withScope(scope(officer), (tx) => statements.view(tx, result.id));

    expect(view.lines.map((line) => line.amountIqd)).toEqual([
      '-1500.0000',
      '4000.0000',
      '-25.0000',
    ]);
  });

  it('refuses a value date before the booking date', async () => {
    expect(
      await rejection(
        importOnce({
          lines: [{ ...LINES[0], valueDate: '2026-02-01' }],
          closingBalanceIqd: price('8500'),
        }),
      ),
    ).toMatch(/value date .* is before the booking date/);
  });

  it('refuses a line of nothing', async () => {
    expect(
      await rejection(
        importOnce({
          lines: [{ ...LINES[0], amountIqd: 0n }],
          closingBalanceIqd: price('10000'),
        }),
      ),
    ).toMatch(/A movement of nothing is not a movement/);
  });

  it('refuses a line dated outside the statement’s own period', async () => {
    expect(
      await rejection(
        importOnce({
          lines: [{ ...LINES[0], bookingDate: '2026-03-05', valueDate: '2026-03-05' }],
          closingBalanceIqd: price('8500'),
        }),
      ),
    ).toMatch(/outside statement/);
  });
});

describe('§17 · the statement has to add up before it is agreed', () => {
  it('refuses a truncated download', async () => {
    expect(
      await rejection(importOnce({ lines: [LINES[0], LINES[1]] })),
    ).toMatch(/does not add up|is a statement with a line missing/);
  });

  it('says by how much it is out', async () => {
    expect(await rejection(importOnce({ lines: [LINES[0], LINES[1]] }))).toMatch(/-25\.0000 out/);
  });

  it('leaves nothing behind when it refuses', async () => {
    await rejection(importOnce({ lines: [LINES[0], LINES[1]] }));

    const { rows } = await ownerPool.query(
      `select (select count(*) from bank_statement)::int as headers,
              (select count(*) from bank_statement_line)::int as lines`,
    );
    expect(rows[0]).toMatchObject({ headers: 0, lines: 0 });
  });

  it('takes the balances from the bank rather than computing them', async () => {
    const result = await importOnce();
    const view = await withScope(scope(officer), (tx) => statements.view(tx, result.id));

    // The movement is derived; the two balances are not. They agree because the
    // statement was checked, not because one was calculated from the other.
    expect(view.statement.openingBalanceIqd).toBe('10000.0000');
    expect(view.statement.closingBalanceIqd).toBe('12475.0000');
    expect(view.movementIqd).toBe(price('2475'));
  });
});

describe('07.6 gate · an unparseable line is reported, not dropped', () => {
  it('keeps the raw text and the reason', async () => {
    const result = await importOnce({
      rejected: [
        { lineNo: 4, rawText: '25/02/2026;;;garbled;;', problem: 'No amount column could be read.' },
      ],
    });

    expect(result.rejected).toBe(1);

    const view = await withScope(scope(officer), (tx) => statements.view(tx, result.id));
    expect(view.rejected[0]).toMatchObject({
      lineNo: 4,
      rawText: '25/02/2026;;;garbled;;',
      problem: 'No amount column could be read.',
    });
  });

  it('reports them across statements', async () => {
    await importOnce({
      rejected: [{ lineNo: 4, rawText: 'garbled', problem: 'No amount column could be read.' }],
    });

    const report = await withScope(scope(officer), (tx) =>
      statements.rejectedReport(tx, BAGHDAD),
    );
    expect(report).toHaveLength(1);
    expect(report[0]!.problem).toMatch(/No amount column/);
  });

  it('refuses a rejection with no reason — that is a dropped line with extra steps', async () => {
    const result = await importOnce();

    await expect(
      ownerPool.query(
        `insert into bank_statement_rejected_line (statement_id, line_no, raw_text, problem)
         values ($1, 9, 'garbled', '  ')`,
        [result.id],
      ),
    ).rejects.toThrow(/bank_statement_rejected_problem_present/);
  });
});

describe('07.6 gate · the import runs through the Phase 01 framework', () => {
  const FILE = [
    'statement_no,booking_date,value_date,amount_iqd,reference,counterparty,description',
    'STMT,2026-02-03,2026-02-03,-1500,TRF-9001,Supplier One,Outgoing transfer',
    'STMT,2026-02-11,2026-02-13,4000,DEP-4412,Al Rasheed Trading,Customer deposit',
    'STMT,2026-02-25,2026-02-25,-25,FEE-02,,Account maintenance fee',
  ];

  it('previews without writing, then commits with a batch id', async () => {
    const header = await openHeader();
    const content = FILE.map((row) => row.replace(/^STMT/, header.statementNo)).join('\n');

    const uploaded = await withScope(scope(officer), (tx) =>
      imports.upload(tx, officer, 'bank_statement_line', content, 'feb-2026.csv'),
    );

    expect(uploaded.preview.validRows).toBe(3);
    expect(uploaded.errorFile).toBe('');

    const { rows: beforeCommit } = await ownerPool.query(
      `select count(*)::int as n from bank_statement_line`,
    );
    expect(beforeCommit[0].n).toBe(0);

    const committed = await withScope(scope(officer), (tx) =>
      imports.commit(tx, officer, uploaded.batchId),
    );
    expect(committed.committedRows).toBe(3);
    expect(committed.batchId).toBe(uploaded.batchId);

    const view = await withScope(scope(officer), (tx) => statements.view(tx, header.id));
    expect(view.lines).toHaveLength(3);
  });

  it('produces an error file for a row it cannot read', async () => {
    const header = await openHeader();
    const content = [
      ...FILE.map((row) => row.replace(/^STMT/, header.statementNo)),
      `${header.statementNo},2026-02-26,2026-02-26,0,ZERO,,A heading, not a movement`,
    ].join('\n');

    const uploaded = await withScope(scope(officer), (tx) =>
      imports.upload(tx, officer, 'bank_statement_line', content, 'feb-2026.csv'),
    );

    expect(uploaded.preview.invalidRows).toBeGreaterThan(0);
    expect(uploaded.errorFile).not.toBe('');
  });

  it('closes only once the lines agree with the bank’s closing balance', async () => {
    const header = await openHeader();
    const content = FILE.map((row) => row.replace(/^STMT/, header.statementNo)).join('\n');

    const uploaded = await withScope(scope(officer), (tx) =>
      imports.upload(tx, officer, 'bank_statement_line', content, 'feb-2026.csv'),
    );
    await withScope(scope(officer), (tx) => imports.commit(tx, officer, uploaded.batchId));

    const closed = await withScope(scope(manager), (tx) =>
      statements.closeStatement(tx, manager, header.id),
    );
    expect(closed.movementIqd).toBe(price('2475'));
  });

  it('will not close a statement whose lines do not reach the closing balance', async () => {
    const header = await openHeader();
    const partial = FILE.slice(0, 3).map((row) => row.replace(/^STMT/, header.statementNo)).join('\n');

    const uploaded = await withScope(scope(officer), (tx) =>
      imports.upload(tx, officer, 'bank_statement_line', partial, 'feb-2026.csv'),
    );
    await withScope(scope(officer), (tx) => imports.commit(tx, officer, uploaded.batchId));

    expect(
      await rejection(
        withScope(scope(manager), (tx) => statements.closeStatement(tx, manager, header.id)),
      ),
    ).toMatch(/statement with a line missing/);
  });

  it('will not add lines to a statement that has been closed', async () => {
    const result = await importOnce();

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          statements.appendLine(tx, officer, result.id, {
            lineNo: 9,
            bookingDate: '2026-02-27',
            valueDate: '2026-02-27',
            amountIqd: price('-10'),
            reference: 'LATE',
            counterparty: null,
            description: null,
          }),
        ),
      ),
    ).toMatch(/adding to it would change what was agreed/);
  });
});

describe('§17 · a statement is of a bank account', () => {
  it('refuses a cash float — a float is agreed by counting it', async () => {
    if (!cashAccountId) return;

    expect(
      await rejection(importOnce({ bankCashAccountId: cashAccountId })),
    ).toMatch(/A statement comes from a bank|agreed by counting/);
  });
});

describe('§17 · unmatched lines are reported and aged', () => {
  it('lists every line until the reconciliation says otherwise', async () => {
    await importOnce();

    const unmatched = await withScope(scope(officer), (tx) =>
      statements.unmatchedLines(tx, { bankCashAccountId: bankAccountId }),
    );

    expect(unmatched).toHaveLength(3);
    expect(unmatched.every((row) => row.matchStatus === 'unmatched')).toBe(true);
    // Oldest first — the order somebody works them in.
    expect(unmatched.map((row) => row.bookingDate)).toEqual([
      '2026-02-03',
      '2026-02-11',
      '2026-02-25',
    ]);
  });

  it('honours an as-of date, because ageing is asked as at a date', async () => {
    await importOnce();

    const unmatched = await withScope(scope(officer), (tx) =>
      statements.unmatchedLines(tx, { bankCashAccountId: bankAccountId, asOf: '2026-02-12' }),
    );
    expect(unmatched).toHaveLength(2);
  });
});
