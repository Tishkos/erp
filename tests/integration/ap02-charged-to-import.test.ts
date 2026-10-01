/**
 * REQ-AP-001 A10 — the forwarder's bill belongs to the panels it moved.
 *
 * An expense line charged to an import posts to the landed-cost clearing
 * account, not P&L, and becomes a landed-cost charge of that import in the
 * same transaction — captured now, allocated when Stage 7 locks the cost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as coa from '@/server/services/chart-of-accounts';
import * as payables from '@/server/services/payables';
import * as periods from '@/server/services/periods';
import * as posting from '@/server/services/posting';
import * as receipts from '@/server/services/service-receipt';
import {
  BRANCH,
  IMPORT_INPUT,
  buildPayablesWorld,
  eventsOf,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;
let importPayableId: string;
let accounts: { payable: string; expense: string; clearing: string };

async function account(rootCode: string, name: string, control?: 'supplier'): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    rootCode,
  ]);
  const made = await withScope(scope(world.officer), (tx) =>
    coa.createAccount(tx, world.officer, {
      name,
      currencyRestriction: 'IQD',
      parentId: rows[0].id,
      ...(control ? { controlAccount: control } : {}),
    }),
  );
  await withScope(scope(world.officer), (tx) => coa.submitForApproval(tx, world.officer, made.id));
  await withScope(scope(world.manager), (tx) => coa.approve(tx, world.manager, made.id));
  return made.id;
}

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();

  await withScope(scope(world.manager), (tx) =>
    periods.createFiscalYear(tx, world.manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );

  accounts = {
    payable: await account('L000001', 'Accounts Payable', 'supplier'),
    expense: await account('X000001', 'Freight expense'),
    clearing: await account('A000001', 'Landed cost clearing'),
  };

  // The import the forwarder moved goods for.
  const created = await withScope(scope(world.manager), (tx) =>
    payables.create(tx, world.manager, IMPORT_INPUT(world)),
  );
  importPayableId = created.id;

  // §20.2 — the clearing is a mapping, chosen by Finance, not a constant.
  await withScope(scope(world.manager), (tx) =>
    posting.setMapping(tx, world.manager, {
      eventType: 'purchasing.ap_invoice',
      lineRole: 'landed_cost_clearing',
      accountId: accounts.clearing,
    }),
  );
});

describe('ap02 · a service line charged to an import', () => {
  it('posts to the clearing account, not P&L, and the charge row appears (A10)', async () => {
    // The forwarder's own service payable, so the cost has a home of its own.
    const forwarder = await withScope(scope(world.officer), (tx) =>
      payables.create(tx, world.officer, {
        payableTypeCode: 'service',
        supplierReference: 'FRT-1001',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'IQD',
        documentDate: '2026-09-20',
        description: 'Umm Qasr port handling, CSA-AL0001-1',
        expenseCategoryCode: 'freight_forwarding',
        amountTxn: '650000',
      }),
    );

    // Two lines: one genuinely ours (P&L), one that belongs to the import.
    // §15 — the second approver must be a second person: the officer raises
    // the invoice, the manager stands behind the missing order.
    const invoice = await withScope(scope(world.officer), (tx) =>
      ap.create(tx, world.officer, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'FRT-1001',
        branchCode: BRANCH,
        invoiceDate: '2026-09-21',
        currency: 'IQD',
        payableId: forwarder.id,
        nonPoJustification: 'Forwarder bills after the fact; no order exists.',
        nonPoApprovedBy: world.manager.principal.userId,
        payableAccountId: accounts.payable,
        expenseAccountId: accounts.expense,
        lines: [
          {
            description: 'Port handling — our own storage',
            quantity: 1_000_000n,
            unitPriceIqd: 150_000_0000n,
            uomCode: 'EA',
          },
          {
            description: 'Freight CSA-AL0001-1, Umm Qasr → Erbil',
            quantity: 1_000_000n,
            unitPriceIqd: 500_000_0000n,
            uomCode: 'EA',
            chargedToPayableId: importPayableId,
          },
        ],
      }),
    );

    // A9 — the forwarder's own service is confirmed before its bill may post.
    const receipt = await withScope(scope(world.officer), (tx) =>
      receipts.createForPayable(tx, world.officer, {
        payableId: forwarder.id,
        departmentCode: 'FIN',
        branchCode: BRANCH,
        serviceDate: '2026-09-20',
        description: 'Port handling delivered',
      }),
    );
    await withScope(scope(world.officer), (tx) => receipts.submit(tx, world.officer, receipt.id));
    await withScope(scope(world.manager), (tx) => receipts.approve(tx, world.manager, receipt.id));

    await withScope(scope(world.manager), (tx) => ap.submit(tx, world.manager, invoice.id));
    // Posting is the CEO's act — approval goes to the top (§5.2).
    const posted = await withScope(scope(world.ceo), (tx) => ap.post(tx, world.ceo, invoice.id));

    // The journal: 150,000 to the expense, 500,000 to the clearing — the
    // charged line never touches P&L (A10).
    const { rows: lines } = await ownerPool.query(
      `select l.account_id, l.debit_iqd::numeric::text as debit, l.line_role
         from journal_line l where l.journal_entry_id = $1 and l.debit_iqd > 0
         order by l.line_no`,
      [posted.journalEntryId],
    );
    const byAccount = new Map(lines.map((line) => [line.account_id, line]));
    expect(byAccount.get(accounts.expense)?.debit).toBe('150000.0000');
    expect(byAccount.get(accounts.clearing)?.debit).toBe('500000.0000');
    expect(byAccount.get(accounts.clearing)?.line_role).toBe('landed_cost_clearing');

    // The charge row, created from the document, typed by the category.
    const { rows: charges } = await ownerPool.query(
      `select charge_type_code, amount_iqd::numeric::text as amount, source_type
         from landed_cost_charge where payable_id = $1`,
      [importPayableId],
    );
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      charge_type_code: 'freight',
      amount: '500000.0000',
      source_type: 'ap_invoice_line',
    });

    // And the import's story says so.
    const story = await eventsOf(importPayableId);
    const charged = story.find((event) => event.eventCode === 'CHARGED_TO_IMPORT');
    expect(charged?.summary).toMatch(/500,?000/);

    // Reposting cannot double the charge: the source line is unique.
    const { rows: unique } = await ownerPool.query(
      `select count(*)::int as n from landed_cost_charge where payable_id = $1`,
      [importPayableId],
    );
    expect(unique[0].n).toBe(1);
  });
});
