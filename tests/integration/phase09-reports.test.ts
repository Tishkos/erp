/**
 * Phase 09.11 test gate — reports and reconciliation, §12.7.
 *
 * §12.7's acceptance criterion 1, verbatim: *"Every transfer and refund
 * reconciles to client subledger, bank ledger and General Ledger."*
 *
 * The reconciliation below does not compare one report against another. It reads
 * the module's own figure, the journal's, and the client subledger's, from the
 * rows of each, and asserts the three agree — because three summaries derived
 * from one cache always agree and prove nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as client from '@/server/services/money-transfer-client';
import * as mt from '@/server/services/money-transfer';
import * as imports from '@/server/services/client-import';
import * as batches from '@/server/services/bank-execution';
import * as reports from '@/server/services/money-transfer-reports';
import { parseDecimal } from '@domain/money';
import {
  approveKycFor,
  BRANCH,
  buildWorld,
  createUser,
  OTHER_BRANCH,
  scopeOf,
  type Phase09World,
} from './phase09-fixture';

const iqd = (value: string) => parseDecimal(value, 4n);
const FEB = '2026-02-10';

let world: Phase09World;

beforeEach(async () => {
  await resetTestData();
  world = await buildWorld();
  await approveKycFor(world, world.clientPartnerId);
});

/** A client account funded with three partial deposits, all posted. */
async function fundedAccount() {
  const account = await withScope(scopeOf(world.clerk), (tx) =>
    client.openAccount(tx, world.clerk, {
      partnerId: world.clientPartnerId,
      branchCode: BRANCH,
      openedOn: '2026-02-01',
    }),
  );

  for (const [index, amount] of ['5000000', '7000000', '3000000'].entries()) {
    const deposit = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordDeposit(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        depositDate: `2026-02-0${index + 1}`,
        method: 'bank_transfer',
        companyBankAccountId: world.bankAccountId,
        amountIqd: iqd(amount),
        bankReference: `SLIP-${index + 1}`,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postDeposit(tx, world.manager, deposit.id));
  }

  return account;
}

/** The worked example, sent and charged. */
async function sentTransfer(accountId: string) {
  await withScope(scopeOf(world.manager), (tx) =>
    client.confirmFunding(tx, world.manager, accountId, iqd('13050000')),
  );

  const transfer = await withScope(scopeOf(world.clerk), (tx) =>
    mt.createTransfer(tx, world.clerk, {
      clientAccountId: accountId,
      branchCode: BRANCH,
      transferDate: FEB,
      requestedUsd: iqd('9000'),
      officialRateId: world.rates.officialId,
      clientRateId: world.rates.clientId,
      transferAmountIqd: iqd('13050000'),
      companyBankAccountId: world.bankAccountId,
      beneficiaryName: 'Beneficiary Trading LLC',
      logisticsJobRef: 'LOG-JOB-42',
    }),
  );

  await withScope(scopeOf(world.manager), (tx) => mt.markFunded(tx, world.manager, transfer.id));
  await withScope(scopeOf(world.manager), (tx) =>
    mt.initiateTransfer(tx, world.manager, transfer.id),
  );
  await withScope(scopeOf(world.manager), (tx) =>
    mt.markSent(tx, world.manager, transfer.id, 'SWIFT-12345'),
  );

  const expense = await withScope(scopeOf(world.clerk), (tx) =>
    mt.recordExpense(tx, world.clerk, {
      moneyTransferId: transfer.id,
      expenseDate: FEB,
      expenseType: 'bank_charge',
      amountIqd: iqd('25000'),
      chargedToClient: false,
      companyBankAccountId: world.bankAccountId,
      description: 'Correspondent bank charge',
    }),
  );
  await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

  return { transfer, expense };
}

describe('§12.7 acceptance 1 — every transfer and refund reconciles', () => {
  it('the module, the General Ledger and the client subledger agree on a transfer', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);

    const row = await withScope(scopeOf(world.manager), (tx) =>
      reports.reconciliation(tx, transfer.id),
    );

    expect(row.moduleAmountIqd).toBe('13050000.0000');
    expect(row.generalLedgerIqd).toBe('13050000.0000');
    expect(row.clientSubledgerIqd).toBe('13050000.0000');
    expect(row.reconciles).toBe(true);
    expect(row.clientCode).toBe(world.clientPartnerCode);
  });

  it('the bank ledger nets to the money that actually left', async () => {
    const account = await fundedAccount();
    await sentTransfer(account.id);

    // 15,000,000 in from deposits, 13,050,000 out on the transfer, 25,000 out on
    // the bank charge. The bank G/L account is the arbiter, not this module.
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::numeric(19,4)::text as balance
         from journal_line l where l.account_id = $1`,
      [world.accounts.bank],
    );
    expect(rows[0].balance).toBe('1925000.0000');
  });

  it('a refund reconciles too, and leaves the client subledger at zero', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);

    await withScope(scopeOf(world.manager), (tx) =>
      mt.markReturned(tx, world.manager, transfer.id, {
        returnDate: '2026-02-20',
        reason: 'Beneficiary account closed',
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-21' }),
    );

    // Everything the client put in has come back out. The subledger says so,
    // and so does the G/L account it reconciles to.
    const { rows: sub } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0)::numeric(19,4)::text as balance
         from subledger_entry where subledger_type = 'customer' and party_code = $1`,
      [world.clientPartnerCode],
    );
    expect(sub[0].balance).toBe('0.0000');

    const { rows: gl } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0)::numeric(19,4)::text as balance
         from journal_line where account_id = $1`,
      [world.accounts.client_clearing],
    );
    expect(gl[0].balance).toBe('0.0000');

    // And the bank is down by exactly the charge the company absorbed (§12.6).
    const { rows: bank } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0)::numeric(19,4)::text as balance
         from journal_line where account_id = $1`,
      [world.accounts.bank],
    );
    expect(bank[0].balance).toBe('-25000.0000');
  });
});

describe('09.11 — the §12.7 report set', () => {
  it('Client Deposit Ledger shows each deposit, its usage and what is left', async () => {
    const account = await fundedAccount();
    await sentTransfer(account.id);

    const ledger = await withScope(scopeOf(world.manager), (tx) =>
      reports.clientDepositLedger(tx, { clientAccountId: account.id }),
    );

    expect(ledger).toHaveLength(3);
    expect(ledger.map((r) => r.availableIqd)).toEqual([
      '0.0000',
      '0.0000',
      '1950000.0000',
    ]);
    expect(ledger.every((r) => r.clientCode === world.clientPartnerCode)).toBe(true);
    expect(ledger.every((r) => r.journalEntryId !== null)).toBe(true);
  });

  it('Open Client Balances says whose money the company is holding', async () => {
    const account = await fundedAccount();
    await sentTransfer(account.id);

    const open = await withScope(scopeOf(world.manager), (tx) => reports.openClientBalances(tx));
    const row = open.find((r) => r.accountNo === account.accountNo);

    expect(row).toBeDefined();
    expect(row!.clientCode).toBe(world.clientPartnerCode);
    expect(row!.depositedIqd).toBe('15000000.0000');
    expect(row!.usedIqd).toBe('13050000.0000');
    expect(row!.balanceIqd).toBe('1950000.0000');
  });

  it('Transfer Register carries the Gross Spread, Direct Expenses and Net Margin', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);

    const register = await withScope(scopeOf(world.manager), (tx) => reports.transferRegister(tx));
    const row = register.find((r) => r.transferNo === transfer.transferNo);

    expect(row).toBeDefined();
    expect(row!.stage).toBe('Sent'); // Appendix B's own word for `executed`
    expect(row!.requestedUsd).toBe('9000.0000');
    expect(row!.transferAmountIqd).toBe('13050000.0000');
    expect(row!.grossExchangeSpreadIqd).toBe('450000.0000');
    expect(row!.directExpensesIqd).toBe('25000.0000');
    expect(row!.netServiceMarginIqd).toBe('425000.0000');

    // The register and the margin service are the same arithmetic, so they
    // cannot report different numbers for the same transfer.
    const margin = await withScope(scopeOf(world.manager), (tx) => mt.margin(tx, transfer.id));
    expect(row!.grossExchangeSpreadIqd).toBe(
      (await import('@domain/money')).toDecimalString(margin.grossExchangeSpreadIqd, 4n),
    );
  });

  it('Direct Expenses lists every fee against the transfer it belongs to', async () => {
    const account = await fundedAccount();
    const { transfer, expense } = await sentTransfer(account.id);

    const rows = await withScope(scopeOf(world.manager), (tx) => reports.directExpenses(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expenseNo).toBe(expense.expenseNo);
    expect(rows[0]!.transferNo).toBe(transfer.transferNo);
    expect(rows[0]!.chargedToClient).toBe(false);
    expect(rows[0]!.journalEntryId).not.toBeNull();
  });

  it('Returned Transfers shows the charges the company absorbed beside the return', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markReturned(tx, world.manager, transfer.id, {
        returnDate: '2026-02-20',
        reason: 'Beneficiary account closed',
      }),
    );

    const rows = await withScope(scopeOf(world.manager), (tx) => reports.returnedTransfers(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transferNo).toBe(transfer.transferNo);
    expect(rows[0]!.returnReason).toMatch(/account closed/i);
    // §12.6 — shown, not netted into the refund.
    expect(rows[0]!.bankChargesAbsorbedIqd).toBe('25000.0000');
    expect(rows[0]!.returnJournalEntryId).not.toBeNull();
    expect(rows[0]!.originalJournalEntryId).not.toBeNull();
  });

  it('Refunds shows the full amount returned to the client', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markReturned(tx, world.manager, transfer.id, {
        returnDate: '2026-02-20',
        reason: 'Beneficiary account closed',
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-21' }),
    );

    const rows = await withScope(scopeOf(world.manager), (tx) => reports.refunds(tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refundAmountIqd).toBe('15000000.0000');
    expect(rows[0]!.refundJournalEntryId).not.toBeNull();
  });

  it('Transfer-to-Bank Statement Reconciliation ties a transfer to its statement line', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);

    const batch = await withScope(scopeOf(world.clerk), (tx) =>
      batches.openBatch(tx, world.clerk, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('13050000'),
      }),
    );
    await withScope(scopeOf(world.clerk), (tx) =>
      batches.addLine(tx, world.clerk, {
        batchId: batch.id,
        source: { kind: 'money_transfer', id: transfer.id },
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.reconcileToStatement(tx, world.manager, batch.id, 'STMT-2026-02-0042'),
    );

    const rows = await withScope(scopeOf(world.manager), (tx) =>
      reports.transferToBankStatement(tx),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transferNo).toBe(transfer.transferNo);
    expect(rows[0]!.batchNo).toBe(batch.batchNo);
    expect(rows[0]!.statementLineRef).toBe('STMT-2026-02-0042');
    expect(rows[0]!.reconciledAt).not.toBeNull();
  });

  it('shows a transfer with no batch as the gap it is, rather than hiding it', async () => {
    const account = await fundedAccount();
    const { transfer } = await sentTransfer(account.id);

    const rows = await withScope(scopeOf(world.manager), (tx) =>
      reports.transferToBankStatement(tx),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transferNo).toBe(transfer.transferNo);
    // The report exists to find these, so the row stays and the columns are null.
    expect(rows[0]!.batchNo).toBeNull();
    expect(rows[0]!.statementLineRef).toBeNull();
  });

  it('Client Import Cross-Reference links a transfer to its file and logistics job', async () => {
    const account = await fundedAccount();

    const file = await withScope(scopeOf(world.clerk), (tx) =>
      imports.openFile(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        openedOn: '2026-02-01',
        logisticsJobRef: 'LOG-JOB-42',
      }),
    );

    await withScope(scopeOf(world.manager), (tx) =>
      client.confirmFunding(tx, world.manager, account.id, iqd('13050000')),
    );

    const transfer = await withScope(scopeOf(world.clerk), (tx) =>
      mt.createTransfer(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        transferDate: FEB,
        requestedUsd: iqd('9000'),
        officialRateId: world.rates.officialId,
        clientRateId: world.rates.clientId,
        transferAmountIqd: iqd('13050000'),
        companyBankAccountId: world.bankAccountId,
        beneficiaryName: 'Beneficiary Trading LLC',
        clientImportFileId: file.id,
        logisticsJobRef: 'LOG-JOB-42',
      }),
    );

    const rows = await withScope(scopeOf(world.manager), (tx) =>
      imports.crossReference(tx, { clientAccountId: account.id }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileNo).toBe(file.fileNo);
    expect(rows[0]!.transferNo).toBe(transfer.transferNo);
    // The logistics job is a reference until Phase 10 exists. The link is here;
    // what it points at is Phase 10's to build.
    expect(rows[0]!.logisticsJobRef).toBe('LOG-JOB-42');
  });
});

describe('09.11 — reports respect data scope and mark provisional data (§12.7, §22)', () => {
  it('distinguishes posted from provisional data', async () => {
    const account = await fundedAccount();

    // A draft deposit: recorded, not yet in the bank ledger.
    await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordDeposit(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        depositDate: FEB,
        method: 'cash',
        companyBankAccountId: world.bankAccountId,
        amountIqd: iqd('1000000'),
      }),
    );

    const ledger = await withScope(scopeOf(world.manager), (tx) =>
      reports.clientDepositLedger(tx, { clientAccountId: account.id }),
    );

    const provisional = ledger.filter((r) => !r.isPosted);
    expect(provisional).toHaveLength(1);
    expect(provisional[0]!.amountIqd).toBe('1000000.0000');
    expect(provisional[0]!.journalEntryId).toBeNull();

    // It is shown — a clerk needs to see what they keyed — and it is labelled,
    // which is what §12.7 asks for. It is not silently added to the balance.
    const open = await withScope(scopeOf(world.manager), (tx) => reports.openClientBalances(tx));
    expect(open.find((r) => r.accountNo === account.accountNo)!.depositedIqd).toBe(
      '15000000.0000',
    );
  });

  it('shows a user of another branch nothing of this one’s (§22)', async () => {
    const account = await fundedAccount();
    await sentTransfer(account.id);

    // Same role, same permissions, a different branch. Row-level security is
    // what makes the difference, not a filter the report remembered to apply.
    const outsider = await createUser('accounting_manager', { branches: [OTHER_BRANCH] });
    const outsiderScope = {
      userId: outsider.principal.userId,
      branchCode: OTHER_BRANCH,
      isSuperUser: false,
    };

    const register = await withScope(outsiderScope, (tx) => reports.transferRegister(tx));
    expect(register).toEqual([]);

    const ledger = await withScope(outsiderScope, (tx) => reports.clientDepositLedger(tx));
    expect(ledger).toEqual([]);

    const open = await withScope(outsiderScope, (tx) => reports.openClientBalances(tx));
    expect(open.find((r) => r.accountNo === account.accountNo)).toBeUndefined();

    // And the branch that owns them still sees them, so the assertion above is
    // about scope rather than about an empty database.
    const mine = await withScope(scopeOf(world.manager), (tx) => reports.transferRegister(tx));
    expect(mine).toHaveLength(1);
  });
});
