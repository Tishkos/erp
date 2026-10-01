/**
 * REQ-AP-001 D12 / D13 — expenses are purchase invoices; an import is born at
 * the purchase invoice.
 *
 *   D13  The accountant enters the supplier's PDF as a purchase invoice and
 *        ticks Import: the import application is created behind it in the
 *        same transaction, keyed by the supplier's number, with the invoice's
 *        lines, its purchase order created silently and submitted.
 *   D12  "Add expense" raises a non-PO purchase invoice with one expense line;
 *        its §15 evidence is the type of fee, and its second person is the
 *        one who posts it. "Mark paid" turns what is owed into a posted,
 *        allocated supplier payment. Unpaid / Paid / Overdue is read from the
 *        invoice; a note is dated, signed and never edited.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as expenses from '@/server/services/expenses';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import {
  BAGHDAD,
  PANEL,
  WAREHOUSE,
  buildTradingWorld,
  scope,
  type TradingWorld,
} from './trading-fixture';

let world: TradingWorld;

beforeEach(async () => {
  world = await buildTradingWorld();
  // The type of fee posts to the world's expense account by default.
  await ownerPool.query(`update expense_category set default_expense_account_id = $1 where code = 'rent'`, [
    world.accounts.expense,
  ]);
});

// The seeded category is migration data: put it back as the migration left it,
// so the next suite does not inherit an account this suite's reset removes.
afterEach(async () => {
  await ownerPool.query(`update expense_category set default_expense_account_id = null where code = 'rent'`);
});

async function rentBill(amount = '1500000') {
  return withScope(scope(world.clerk), (tx) =>
    expenses.addExpense(tx, world.clerk, {
      expenseCategoryCode: 'rent',
      name: 'Erbil office rent — October',
      supplierId: world.supplierId,
      branchCode: BAGHDAD,
      amountIqd: parseDecimal(amount, 4n),
      invoiceDate: '2026-10-01',
      dueDate: '2026-10-05',
    }),
  );
}

describe('D13 · an import is born at the purchase invoice', () => {
  it('ticking Import opens the application behind the invoice, with its lines and a submitted PO', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'CSA-AL0001-1',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-01',
        dueDate: '2026-11-01',
        isImport: true,
        paymentTermsText: '40% deposit, balance before delivery',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('5040'),
            unitPriceIqd: parseDecimal('131000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );

    expect(made.importPayableNo).toMatch(/^IMP-/);

    const { rows } = await ownerPool.query(
      `select i.is_import, p.payable_no, p.payable_type_code, p.supplier_reference,
              p.payment_terms_text, p.purchase_order_id, po.status::text as po_status,
              (select count(*)::int from payable_order_line l where l.payable_id = p.id) as lines
         from ap_invoice i
         join payable p on p.id = i.payable_id
         left join purchase_order po on po.id = p.purchase_order_id
        where i.id = $1`,
      [made.id],
    );
    expect(rows[0]).toMatchObject({
      is_import: true,
      payable_no: made.importPayableNo,
      payable_type_code: 'import',
      supplier_reference: 'CSA-AL0001-1',
      payment_terms_text: '40% deposit, balance before delivery',
      po_status: 'submitted',
      lines: 1,
    });

    // The status log opens with the application and records the PO and the
    // invoice, in the same transaction.
    const { rows: events } = await ownerPool.query(
      `select event_code from payable_event e join payable p on p.id = e.payable_id
        where p.payable_no = $1 order by e.recorded_at, e.id`,
      [made.importPayableNo],
    );
    const codes = events.map((row) => row.event_code);
    expect(codes[0]).toBe('PAYABLE_OPENED');
    expect(codes).toContain('PO_LINKED');
    expect(codes).toContain('TERMS_SET');
  });

  it('an invoice without the tick opens nothing', async () => {
    const made = await rentBill();
    expect(made.importPayableNo).toBeNull();
    const { rows } = await ownerPool.query(`select count(*)::int as n from payable`);
    expect(rows[0].n).toBe(0);
  });

  it('the database holds the pairing: an import invoice always has its application', async () => {
    const made = await rentBill();
    const refused = await ownerPool
      .query(`update ap_invoice set is_import = true where id = $1`, [made.id])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(refused).toMatch(/ap_invoice_import_has_application/);
  });
});

describe('D12 · expenses are purchase invoices', () => {
  it('Add expense raises a non-PO invoice whose evidence is the type of fee', async () => {
    const made = await rentBill();
    const { rows } = await ownerPool.query(
      `select i.status::text as status, i.expense_category_code, i.non_po_justification,
              i.non_po_approved_by, i.expense_account_id, i.purchase_order_id, l.is_inventory,
              l.description
         from ap_invoice i join ap_invoice_line l on l.ap_invoice_id = i.id where i.id = $1`,
      [made.id],
    );
    expect(rows[0]).toMatchObject({
      status: 'draft',
      expense_category_code: 'rent',
      non_po_approved_by: null,
      expense_account_id: world.accounts.expense,
      purchase_order_id: null,
      is_inventory: false,
      description: 'Erbil office rent — October',
    });
    expect(rows[0].non_po_justification).toMatch(/Expense/);
  });

  it('the §15 control still holds for a non-PO invoice that names no type of fee', async () => {
    const refusal = await rejection(
      withScope(scope(world.clerk), (tx) =>
        ap.create(tx, world.clerk, {
          supplierId: world.supplierId,
          supplierInvoiceNo: 'NO-CATEGORY',
          branchCode: BAGHDAD,
          invoiceDate: '2026-10-01',
          dueDate: '2026-10-05',
          lines: [
            {
              description: 'Something',
              quantity: 1_000_000n,
              unitPriceIqd: parseDecimal('1000', 4n),
              isInventory: false,
            },
          ],
        }),
      ),
    );
    expect(refusal).toMatch(/justif|evidence|approv/i);
  });

  it('the raiser cannot post it; the CEO posts; Mark paid settles it; the register says Paid', async () => {
    const made = await rentBill();
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));

    // The second person is the one who posts (approve + post).
    const notTheClerk = await rejection(
      withScope(scope(world.clerk), (tx) => ap.post(tx, world.clerk, made.id)),
    );
    expect(notTheClerk).not.toBe('');
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));

    const state = async (today: string) => {
      const { rows } = await ownerPool.query(
        `select status::text as status, due_date::text as due, total_iqd::text as total,
                settled_amount_iqd::text as settled from ap_invoice where id = $1`,
        [made.id],
      );
      return expenses.paymentState(
        { status: rows[0].status, dueDate: rows[0].due, totalIqd: rows[0].total, settledAmountIqd: rows[0].settled },
        today,
      );
    };
    expect(await state('2026-10-02')).toBe('unpaid');
    expect(await state('2026-10-09')).toBe('overdue');

    // An officer does not hold `post` on supplier payments: no Mark paid.
    const officer = await rejection(
      withScope(scope(world.clerk), (tx) =>
        expenses.markPaid(tx, world.clerk, {
          apInvoiceId: made.id,
          bankCashAccountId: world.bankAccountId,
          paymentDate: '2026-10-06',
          reference: 'TRF-1',
        }),
      ),
    );
    expect(officer).not.toBe('');

    const paid = await withScope(scope(world.manager), (tx) =>
      expenses.markPaid(tx, world.manager, {
        apInvoiceId: made.id,
        bankCashAccountId: world.bankAccountId,
        paymentDate: '2026-10-06',
        reference: 'TRF-1',
      }),
    );
    expect(paid.paymentNo).toBeTruthy();
    expect(await state('2026-10-09')).toBe('paid');

    const { rows: payment } = await ownerPool.query(
      `select status::text as status, reference from supplier_payment where id = $1`,
      [paid.id],
    );
    expect(payment[0]).toMatchObject({ status: 'posted', reference: 'TRF-1' });

    // Paying twice is refused, with the reason.
    const twice = await rejection(
      withScope(scope(world.manager), (tx) =>
        expenses.markPaid(tx, world.manager, {
          apInvoiceId: made.id,
          bankCashAccountId: world.bankAccountId,
          paymentDate: '2026-10-07',
        }),
      ),
    );
    expect(twice).toMatch(/already paid|settled/i);
  });

  it('a note is dated, signed and never edited', async () => {
    const made = await rentBill();
    await withScope(scope(world.clerk), (tx) =>
      expenses.addNote(tx, world.clerk, made.id, 'Landlord travelling, pays Monday'),
    );
    const notes = await withScope(scope(world.clerk), (tx) => expenses.notesOf(tx, made.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toBe('Landlord travelling, pays Monday');

    const blank = await rejection(
      withScope(scope(world.clerk), (tx) => expenses.addNote(tx, world.clerk, made.id, '   ')),
    );
    expect(blank).toMatch(/note says something/);

    const rewritten = await ownerPool
      .query(`delete from ap_invoice_note`)
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(rewritten).not.toBe('allowed');
  });
});
