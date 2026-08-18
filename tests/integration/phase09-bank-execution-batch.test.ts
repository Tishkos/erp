/**
 * Phase 09.6 test gate — Bank Execution Batch, §12.5 and §12.7 acceptance 3.
 *
 * > *"One bank debit can combine several internally separate transactions, such
 * > as a client transfer and a company import payment. Bank Execution Batch shall
 * > contain separate source lines that retain their own document, client/vendor,
 * > branch, cost centre, accounting and margin. The batch total shall reconcile
 * > to the single bank-statement amount."*
 *
 * The phase notes call this the single most bespoke mechanism in the blueprint,
 * so the tests below are about the word *separate*: what the batch groups, and
 * what it must never merge.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asApp, ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as client from '@/server/services/money-transfer-client';
import * as mt from '@/server/services/money-transfer';
import * as imports from '@/server/services/client-import';
import * as batches from '@/server/services/bank-execution';
import { parseDecimal } from '@domain/money';
import {
  approveKycFor,
  BRANCH,
  buildWorld,
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

/** A client transfer, initiated, ready to be paid through a batch. */
async function clientTransfer(amountIqd = '13050000') {
  const account = await withScope(scopeOf(world.clerk), (tx) =>
    client.openAccount(tx, world.clerk, {
      partnerId: world.clientPartnerId,
      branchCode: BRANCH,
      openedOn: '2026-02-01',
    }),
  );

  const deposit = await withScope(scopeOf(world.clerk), (tx) =>
    mt.recordDeposit(tx, world.clerk, {
      clientAccountId: account.id,
      branchCode: BRANCH,
      depositDate: '2026-02-02',
      method: 'bank_transfer',
      companyBankAccountId: world.bankAccountId,
      amountIqd: iqd('15000000'),
    }),
  );
  await withScope(scopeOf(world.manager), (tx) => mt.postDeposit(tx, world.manager, deposit.id));

  await withScope(scopeOf(world.manager), (tx) =>
    client.confirmFunding(tx, world.manager, account.id, iqd(amountIqd)),
  );

  const transfer = await withScope(scopeOf(world.clerk), (tx) =>
    mt.createTransfer(tx, world.clerk, {
      clientAccountId: account.id,
      branchCode: BRANCH,
      transferDate: FEB,
      requestedUsd: iqd('9000'),
      officialRateId: world.rates.officialId,
      clientRateId: world.rates.clientId,
      transferAmountIqd: iqd(amountIqd),
      companyBankAccountId: world.bankAccountId,
      beneficiaryName: 'Beneficiary Trading LLC',
    }),
  );

  await withScope(scopeOf(world.manager), (tx) => mt.markFunded(tx, world.manager, transfer.id));
  await withScope(scopeOf(world.manager), (tx) =>
    mt.initiateTransfer(tx, world.manager, transfer.id),
  );

  return { account, transfer };
}

/** A company import payment made for the same client, on the same bank debit. */
async function importPayment(accountId: string, amountIqd = '4000000') {
  const file = await withScope(scopeOf(world.clerk), (tx) =>
    imports.openFile(tx, world.clerk, {
      clientAccountId: accountId,
      branchCode: BRANCH,
      openedOn: '2026-02-01',
      description: 'Consignment 42',
    }),
  );

  const payment = await withScope(scopeOf(world.clerk), (tx) =>
    imports.recordPayment(tx, world.clerk, {
      clientImportFileId: file.id,
      paymentDate: FEB,
      amountIqd: iqd(amountIqd),
      companyBankAccountId: world.bankAccountId,
      supplierPartnerId: world.vendorPartnerId,
      supplierReference: 'PI-2026-42',
    }),
  );

  await withScope(scopeOf(world.manager), (tx) =>
    imports.postPayment(tx, world.manager, payment.id),
  );

  return { file, payment };
}

/** A batch holding both, totalling exactly what the bank debited. */
async function composedBatch(total = '17050000') {
  const { account, transfer } = await clientTransfer();
  const { payment } = await importPayment(account.id);

  const batch = await withScope(scopeOf(world.clerk), (tx) =>
    batches.openBatch(tx, world.clerk, {
      branchCode: BRANCH,
      bankCashAccountId: world.bankAccountId,
      executionDate: FEB,
      totalIqd: iqd(total),
      bankReference: 'DEBIT-778899',
    }),
  );

  await withScope(scopeOf(world.clerk), (tx) =>
    batches.addLine(tx, world.clerk, {
      batchId: batch.id,
      source: { kind: 'money_transfer', id: transfer.id },
      costCentreCode: world.costCentreCode,
    }),
  );
  await withScope(scopeOf(world.clerk), (tx) =>
    batches.addLine(tx, world.clerk, {
      batchId: batch.id,
      source: { kind: 'client_import_payment', id: payment.id },
    }),
  );

  return { batch, transfer, payment, account };
}

describe('09.6 — one bank debit, several internally separate transactions (§12.5)', () => {
  it('a batch containing a client transfer and a company import payment keeps both lines’ accounting fully separate', async () => {
    const { batch, transfer, payment } = await composedBatch();

    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const view = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );

    expect(view.lines).toHaveLength(2);

    // Two journals, not one. The batch never merged them, because it never
    // posted anything of its own.
    const journalIds = view.lines.map((line) => line.journalEntryId);
    expect(new Set(journalIds).size).toBe(2);
    expect(journalIds.every(Boolean)).toBe(true);

    // And each journal is the one its own document produced.
    const { rows } = await ownerPool.query(
      `select id, source_doc_id, source_event from journal_entry where id = any($1)`,
      [journalIds],
    );
    const bySource = new Map(rows.map((r) => [r.source_doc_id, r.source_event]));
    expect(bySource.get(transfer.id)).toBe('initiated');
    expect(bySource.get(payment.id)).toBe('posted');

    // The two lines hit different accounts: the transfer relieved Client
    // Clearing, the import payment created Client Inventory. A merged posting
    // could not have said both.
    const { rows: roles } = await ownerPool.query(
      `select distinct l.line_role from journal_line l where l.journal_entry_id = any($1)
        order by l.line_role`,
      [journalIds],
    );
    expect(roles.map((r) => r.line_role)).toEqual(['bank', 'client_clearing', 'client_inventory']);
  });

  it('each line retains its own client/vendor, branch, cost centre and margin', async () => {
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const view = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );
    const [transferLine, paymentLine] = view.lines;

    // client/vendor — the client on one, the overseas vendor on the other.
    expect(transferLine!.counterpartyCode).toBe(world.clientPartnerCode);
    expect(paymentLine!.counterpartyCode).toBe('SUP-900');

    // branch — each line carries its own, on the line rather than the header.
    expect(transferLine!.branchCode).toBe(BRANCH);
    expect(paymentLine!.branchCode).toBe(BRANCH);

    // cost centre — set on the transfer line only, and not inherited.
    expect(transferLine!.costCentreCode).toBe(world.costCentreCode);
    expect(paymentLine!.costCentreCode).toBeNull();

    // margin — the transfer earned one; the import payment earns none of its
    // own, because §11.3 keeps the logistics result separate. No bank charge has
    // been recorded on this transfer, so its net margin is the whole spread:
    // 9,000 × (1,500 − 1,450).
    expect(transferLine!.marginIqd).toBe('450000.0000');
    expect(paymentLine!.marginIqd).toBeNull();
  });

  it('a line cannot claim a branch, counterparty or amount its document does not have', async () => {
    const { batch } = await composedBatch();

    const { rows } = await ownerPool.query(
      `select id from bank_execution_batch_line where batch_id = $1 order by line_no`,
      [batch.id],
    );

    for (const [column, value, pattern] of [
      ['amount_iqd', '999', /is for 999/i],
      ['counterparty_partner_id', 'null', /different client\/vendor/i],
    ] as const) {
      const message = await asApp(scopeOf(world.manager), (query) =>
        rejection(
          query(`update bank_execution_batch_line set ${column} = ${value} where id = $1`, [
            rows[0].id,
          ]),
        ),
      );
      expect(message).toMatch(pattern);
    }
  });

  it('batch total equals the sum of lines exactly, to the last unit of currency', async () => {
    const { batch } = await composedBatch();

    const view = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );
    expect(view.totalIqd).toBe('17050000.0000');
    expect(view.lineSumIqd).toBe('17050000.0000');
    expect(view.differenceIqd).toBe('0.0000');
  });

  it('a batch cannot be executed while its total does not equal the sum of its lines', async () => {
    // One ten-thousandth of a dinar out. §12.7's word is "exactly", and there is
    // no tolerance to widen.
    const { batch } = await composedBatch('17050000.0001');

    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) => batches.executeBatch(tx, world.manager, batch.id)),
    );
    expect(message).toMatch(/lines sum to/i);
    expect(message).toMatch(/0\.0001/);
  });

  it('refuses the unbalanced execution at the database too, bypassing the service', async () => {
    const { batch } = await composedBatch('17050000.0001');
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update bank_execution_batch set status = 'executed' where id = $1`, [batch.id]),
      ),
    );
    expect(message).toMatch(/its lines sum to/i);
  });

  it('an empty batch cannot be executed — a bank debit for nothing', async () => {
    const batch = await withScope(scopeOf(world.clerk), (tx) =>
      batches.openBatch(tx, world.clerk, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('1000000'),
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) => batches.executeBatch(tx, world.manager, batch.id)),
    );
    expect(message).toMatch(/lines sum to 0|has no lines/i);
  });

  it('reversing one line does not corrupt the others', async () => {
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const before = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );

    const { rows } = await ownerPool.query(
      `select id from bank_execution_batch_line where batch_id = $1 order by line_no`,
      [batch.id],
    );

    await withScope(scopeOf(world.manager), (tx) =>
      batches.reverseLine(tx, world.manager, rows[0].id, {
        reason: 'Transfer returned by the beneficiary bank',
      }),
    );

    const after = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );

    // The surviving line is byte-for-byte what it was: same journal, same
    // counterparty, same amount, same margin. There was never anything shared
    // between them to disturb.
    const survivorBefore = before.lines[1]!;
    const survivorAfter = after.lines[1]!;
    expect(survivorAfter).toEqual(survivorBefore);

    // And its journal still stands.
    const { rows: journal } = await ownerPool.query(
      `select status from journal_entry where id = $1`,
      [survivorAfter.journalEntryId],
    );
    expect(journal[0].status).toBe('posted');

    // The reversed line keeps its row and its reason — reversed, never removed.
    expect(after.lines[0]!.reversedAt).not.toBeNull();
    expect(after.lines[0]!.reversalReason).toMatch(/returned by the beneficiary bank/i);
  });

  it('the bank total stays as the bank recorded it after a line is reversed', async () => {
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const { rows } = await ownerPool.query(
      `select id from bank_execution_batch_line where batch_id = $1 order by line_no`,
      [batch.id],
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.reverseLine(tx, world.manager, rows[0].id, { reason: 'Returned' }),
    );

    const view = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );

    // The bank did debit 17,050,000, and no reversal on this side changes that.
    // What changed is what one of the lines turned out to be for, and the
    // difference column is what makes that visible rather than hidden.
    expect(view.totalIqd).toBe('17050000.0000');
    expect(view.lineSumIqd).toBe('4000000.0000');
    expect(view.differenceIqd).toBe('13050000.0000');
  });

  it('the composition is frozen once the bank has paid', async () => {
    const { batch, account } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const { payment: another } = await importPayment(account.id, '1000000');

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        batches.addLine(tx, world.clerk, {
          batchId: batch.id,
          source: { kind: 'client_import_payment', id: another.id },
        }),
      ),
    );
    expect(message).toMatch(/already debited it/i);

    // And a line cannot be deleted out of an executed batch to make room.
    const { rows } = await ownerPool.query(
      `select id from bank_execution_batch_line where batch_id = $1 order by line_no`,
      [batch.id],
    );
    const deleted = await asApp(scopeOf(world.manager), (query) =>
      rejection(query(`delete from bank_execution_batch_line where id = $1`, [rows[0].id])),
    );
    expect(deleted).toMatch(/what the bank debit was for/i);
  });

  it('the same document cannot sit in two live batches', async () => {
    const { account, transfer } = await clientTransfer();

    const first = await withScope(scopeOf(world.clerk), (tx) =>
      batches.openBatch(tx, world.clerk, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('13050000'),
      }),
    );
    await withScope(scopeOf(world.clerk), (tx) =>
      batches.addLine(tx, world.clerk, {
        batchId: first.id,
        source: { kind: 'money_transfer', id: transfer.id },
      }),
    );

    const second = await withScope(scopeOf(world.clerk), (tx) =>
      batches.openBatch(tx, world.clerk, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('13050000'),
      }),
    );

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        batches.addLine(tx, world.clerk, {
          batchId: second.id,
          source: { kind: 'money_transfer', id: transfer.id },
        }),
      ),
    );
    expect(message).toMatch(/bank_execution_batch_line_transfer_once|duplicate key/i);
    expect(account.id).toBeTruthy();
  });

  it('the person who composed a bank debit cannot approve it (§5.2)', async () => {
    // Composed by someone who *does* hold the approve grant, so the refusal is
    // the separation-of-duties rule rather than a missing permission. A clerk is
    // stopped one step earlier, by not being allowed to approve at all.
    const batch = await withScope(scopeOf(world.manager), (tx) =>
      batches.openBatch(tx, world.manager, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('1000000'),
      }),
    );

    const selfApproval = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        batches.approveBatch(tx, world.manager, batch.id),
      ),
    );
    expect(selfApproval).toMatch(/cannot approve it/i);

    const notPermitted = await rejection(
      withScope(scopeOf(world.clerk), (tx) => batches.approveBatch(tx, world.clerk, batch.id)),
    );
    expect(notPermitted).toMatch(/Permission denied/i);

    // A different manager can.
    await withScope(scopeOf(world.compliance), (tx) =>
      batches.approveBatch(tx, world.compliance, batch.id),
    );
    const { rows } = await ownerPool.query(
      `select status from bank_execution_batch where id = $1`,
      [batch.id],
    );
    expect(rows[0].status).toBe('approved');
  });

  it('the batch itself posts nothing — that is what keeps the lines separate', async () => {
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_doc_id = $1`,
      [batch.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('09.6 — reconciliation to one bank statement line (§12.5)', () => {
  it('the batch matches to one statement reference, and the reference is unique per account', async () => {
    // The Phase 07.7 reconciliation workspace does not exist yet, so this is the
    // half of the gate that can be tested now: one batch, one statement line,
    // and the database refusing a second batch that claims the same one.
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.reconcileToStatement(tx, world.manager, batch.id, 'STMT-2026-02-0042'),
    );

    const view = await withScope(scopeOf(world.manager), (tx) =>
      batches.reconciliationFor(tx, batch.id),
    );
    expect(view.status).toBe('settled'); // Appendix B — Reconciled
    expect(view.statementLineRef).toBe('STMT-2026-02-0042');

    const second = await withScope(scopeOf(world.clerk), (tx) =>
      batches.openBatch(tx, world.clerk, {
        branchCode: BRANCH,
        bankCashAccountId: world.bankAccountId,
        executionDate: FEB,
        totalIqd: iqd('500000'),
      }),
    );

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(
          `update bank_execution_batch set statement_line_ref = 'STMT-2026-02-0042',
             reconciled_at = now(), reconciled_by = $2 where id = $1`,
          [second.id, world.manager.principal.userId],
        ),
      ),
    );
    expect(message).toMatch(/bank_execution_batch_statement_uniq|duplicate key/i);
  });

  it('a reconciliation with nothing on the other side is refused', async () => {
    const { batch } = await composedBatch();
    await withScope(scopeOf(world.manager), (tx) =>
      batches.approveBatch(tx, world.manager, batch.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      batches.executeBatch(tx, world.manager, batch.id),
    );

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        batches.reconcileToStatement(tx, world.manager, batch.id, '   '),
      ),
    );
    expect(message).toMatch(/naming the statement line/i);
  });
});
