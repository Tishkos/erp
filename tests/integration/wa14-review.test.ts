/**
 * What is waiting, and whether a document would go through — 2026-10-05, by
 * direction: "What's stuck? One list of everything waiting: drafts never
 * submitted, approved but not posted" and "Check before posting: warns about
 * duplicates, an unusual price, a due date equal to the invoice date, no
 * stock".
 *
 *   * `stuckDocuments` lists every document resting in a status that is not an
 *     end, with its age and what it is waiting for — as the asker: a family
 *     their role cannot view is named as not shown, and nothing of it is.
 *   * `reviewDocument` says what the document's own service would refuse at
 *     the next step (BLOCKERS), what is legal and odd (WARNINGS), and what was
 *     checked and found in order (FINE) — and the blockers are the service's:
 *     a sale it calls short of stock is refused by `ar.post` for that reason,
 *     and one it calls clear posts.
 *
 * Both run in the question's read-only transaction and write nothing.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import { businessToday } from '@/server/domain/business-date';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as journals from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as wa from '@/server/services/whatsapp';
import { reviewDocument, stuckDocuments } from '@/server/services/whatsapp-review';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let nobody: ActorContext;
const BASE = 'https://erp.test';
const TODAY = businessToday();
const day = (offset: number) => businessToday(new Date(Date.now() + offset * 86_400_000));

async function createUser(roles: string, name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles.split('+')) {
    if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** A question's read context, as `wa.answer` builds it: read-only, as the asker. */
const asking = <T>(ctx: ActorContext, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  wa.withReadOnlyScope({ userId: ctx.principal.userId, branchCode: BAGHDAD, isSuperUser: ctx.principal.isSuperUser }, fn);

const stuck = (ctx: ActorContext, args: Parameters<typeof stuckDocuments>[2] = {}) => asking(ctx, (tx) => stuckDocuments(tx, ctx.principal, args, BASE));
const check = (ctx: ActorContext, no: string) => asking(ctx, (tx) => reviewDocument(tx, ctx.principal, no, BASE));

interface Purchase {
  readonly date?: string;
  readonly due?: string;
  readonly quantity?: string;
  readonly price?: string;
  readonly supplierNo?: string;
  readonly duplicate?: boolean;
}

/** A draft purchase invoice for panels into the main warehouse, raised by the officer. */
async function purchase(input: Purchase = {}): Promise<{ id: string; invoiceNo: string }> {
  const date = input.date ?? TODAY;
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: input.supplierNo ?? `JK-${randomUUID().slice(0, 8)}`,
      branchCode: BAGHDAD,
      invoiceDate: date,
      dueDate: input.due ?? day(30),
      ...(input.duplicate ? { duplicateApprovedBy: world.manager.principal.userId, duplicateApprovalReason: 'A second delivery billed under the same number.' } : {}),
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity(input.quantity ?? '10'),
          unitPriceIqd: parseDecimal(input.price ?? '10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select invoice_no from ap_invoice where id = $1`, [made.id]);
  return { id: made.id, invoiceNo: rows[0].invoice_no as string };
}

/** The same, submitted by the officer and posted by the manager: the stock is in. */
async function postedPurchase(input: Purchase = {}): Promise<{ id: string; invoiceNo: string }> {
  const made = await purchase(input);
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
  return made;
}

/** A draft sales invoice for panels out of the main warehouse, raised by the officer. */
const sale = (input: { readonly quantity?: string; readonly price?: string; readonly date?: string; readonly due?: string } = {}) =>
  withScope(scope(world.clerk), (tx) =>
    ar.createDirect(tx, world.clerk, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: input.date ?? TODAY,
      dueDate: input.due ?? day(30),
      lines: [{ itemCode: PANEL, quantity: parseQuantity(input.quantity ?? '2'), unitPriceIqd: parseDecimal(input.price ?? '15000', 4n), warehouseCode: WAREHOUSE }],
    }),
  );

beforeEach(async () => {
  world = await buildTradingWorld();
  nobody = await createUser('', 'A New Starter');
});

describe('everything waiting, in one list', () => {
  it('names what is resting where, how long, and what it is waiting for', async () => {
    const bought = await purchase({ date: '2026-09-01', due: '2026-11-01' });
    const sold = await sale({ date: '2026-09-12' });
    await withScope(scope(world.manager), (tx) => ar.approve(tx, world.manager, sold.id));
    await ownerPool.query(`insert into business_partner (code, legal_name, is_customer, is_supplier, status, active) values ('SUP-PROSPECT','Basra Freight',false,true,'prospect',true)`);
    // Ten days old, so the age is a figure and not "today".
    await ownerPool.query(`update ap_invoice set created_at = created_at - interval '10 days' where id = $1`, [bought.id]);

    const all = await stuck(world.manager);
    expect(all).toMatch(/^3 documents are waiting, in 3 groups — oldest first in each\. A document in one of these statuses has changed NOTHING in the books yet\./);
    expect(all).toContain('PURCHASE INVOICES — draft, never sent on (1): waiting to be submitted — nothing is owed and no stock has come in.');
    expect(all).toMatch(new RegExp(`• ${bought.invoiceNo} · \\S+ · Jinko Solar · 100,000 IQD · dated 2026-09-01 · raised 10 days ago by Test User`));
    expect(all).toContain(`Register: ${BASE}/payables/invoices`);
    // The case that started this: approved, and nobody posted it.
    expect(all).toContain('SALES INVOICES — approved, never posted (1): waiting to be POSTED — until then the customer’s account and the stock are untouched.');
    expect(all).toMatch(new RegExp(`• ${sold.invoiceNo} · \\S+ · Al Noor Trading · 30,000 IQD · dated 2026-09-12 · raised today by Test User`));
    expect(all).toContain(`Register: ${BASE}/sales/ar-invoices`);
    expect(all).toContain('CUSTOMERS AND SUPPLIERS — prospects (1): waiting to be approved');
    expect(all).toContain('• SUP-PROSPECT · Basra Freight · supplier · entered today');
    expect(all).toMatch(/review_document/);

    // Only what has waited: the ten-day-old draft.
    const old = await stuck(world.manager, { olderThanDays: 5 });
    expect(old).toMatch(/^1 document is waiting, in 1 group \(waiting 5 days or more\)/);
    expect(old).toContain(bought.invoiceNo);
    expect(old).not.toContain(sold.invoiceNo);

    // Only one kind — by its prefix, by its name, by its key.
    for (const kind of ['INV', 'sales invoice', 'ar_invoice', 'sales']) {
      const sales = await stuck(world.manager, { kind });
      expect(sales, kind).toContain(sold.invoiceNo);
      expect(sales, kind).not.toContain(bought.invoiceNo);
      expect(sales, kind).not.toContain('prospects');
    }
    expect(await stuck(world.manager, { kind: 'purchase invoice' })).toContain(bought.invoiceNo);
    expect(await stuck(world.manager, { kind: 'prospects' })).toMatch(/^1 document is waiting[\s\S]*SUP-PROSPECT/);
    expect(await stuck(world.manager, { kind: 'flying carpets' })).toMatch(/I do not know a kind of document called "flying carpets"/);

    // Only what the asker raised: the officer raised both documents, the manager neither.
    const mine = await stuck(world.clerk, { mine: true });
    expect(mine).toMatch(/^2 documents are waiting, in 2 groups \(that you raised\)/);
    expect(await stuck(world.manager, { mine: true })).toMatch(/^Nothing is waiting \(that you raised\)/);
  });

  it('says so in a line when nothing is waiting, and shows nobody a family their role cannot view', async () => {
    expect(await stuck(world.manager)).toMatch(/^Nothing is waiting: every document this person can see is either finished or not begun\./);

    const bought = await purchase();
    const sold = await sale();
    const blind = await stuck(nobody);
    expect(blind).toMatch(/^Nothing is waiting/);
    expect(blind).not.toContain(bought.invoiceNo);
    expect(blind).not.toContain(sold.invoiceNo);
    expect(blind).toMatch(/Not shown, because this person's role does not include them: purchase invoice, sales invoice, purchase order/);
    // The same question, asked by somebody whose role reads the books.
    expect(await stuck(world.clerk)).toMatch(/^2 documents are waiting/);
  });
});

describe('a sales invoice, checked before it is posted', () => {
  it('is blocked while the warehouse holds less than it sells — and clear once the stock is in, as posting agrees', async () => {
    const sold = await sale({ quantity: '2', price: '15000' });
    await withScope(scope(world.manager), (tx) => ar.approve(tx, world.manager, sold.id));

    const short = await check(world.manager, sold.invoiceNo.toLowerCase());
    expect(short).toContain(`${sold.invoiceNo} · sales invoice · status: APPROVED · branch BGW`);
    expect(short).toMatch(/VERDICT: it would be REFUSED as it stands — 1 blocker/);
    expect(short).toMatch(/✗ Line 1 sells 2 of ITM-PANEL and WH-MAIN holds 0 — 2 short\. Negative stock is not allowed/);
    expect(short).toContain(`its page: ${BASE}/sales/ar-invoices/${sold.invoiceNo}`);
    expect(short).toMatch(/NEXT: Post it \(document_step post\)/);
    // The service says the same thing when it is tried.
    expect(await rejection(withScope(scope(world.manager), (tx) => ar.post(tx, world.manager, sold.id)))).toMatch(/sells more ITM-PANEL than WH-MAIN holds/);

    // Ten panels at 10,000 come in.
    await postedPurchase({ quantity: '10', price: '10000' });
    const clear = await check(world.manager, sold.invoiceNo);
    expect(clear).toMatch(/VERDICT: nothing blocks it and nothing looks odd\./);
    expect(clear).toContain('BLOCKERS: none found.');
    expect(clear).toContain('WARNINGS: none.');
    expect(clear).toMatch(/FINE — checked and in order: every line has its stock in its warehouse; no line sells below its FIFO cost; due \d{4}-\d{2}-\d{2}; the period \(October 2026\) is open; the date \(\d{4}-\d{2}-\d{2}\) is a sensible one; the customer \(\S+\) is active, not on hold and within their limit\./);
    await withScope(scope(world.manager), (tx) => ar.post(tx, world.manager, sold.id));
    expect(await check(world.manager, sold.invoiceNo)).toMatch(/It is already posted: there is no step left to check it before/);
  });

  it('warns of a sale below cost, of more than is left after another line, of a due date that is the invoice date, of a customer over their limit', async () => {
    await postedPurchase({ quantity: '10', price: '10000' });
    await ownerPool.query(
      `update business_partner set credit_limit_iqd = 50000, on_credit_hold = true, credit_hold_reason = 'Two cheques returned', credit_hold_by = $2, credit_hold_at = now() where id = $1`,
      [world.customerId, world.manager.principal.userId],
    );

    const cheap = await sale({ quantity: '8', price: '8000', due: TODAY });
    const found = await check(world.clerk, cheap.invoiceNo);
    expect(found).toMatch(/VERDICT: nothing blocks it, and 4 things are worth a second look first\./);
    expect(found).toMatch(/! Line 1 sells ITM-PANEL at 8,000 each, BELOW its cost: the stock it will take cost 10,000 each \(FIFO\)\./);
    expect(found).toMatch(new RegExp(`! The due date is the invoice date \\(${TODAY}\\)`));
    expect(found).toMatch(/! The customer \S+ · Al Noor Trading is on CREDIT HOLD \("Two cheques returned"\)/);
    expect(found).toMatch(/! Over the credit limit: \S+ · Al Noor Trading already owes 0 IQD, this invoice adds 64,000, and their limit is 50,000 IQD\./);
    expect(found).toMatch(/NEXT: Approve it \(document_step approve\)/);

    // Two lines of one item draw on one pool: the second finds what the first left.
    const two = await withScope(scope(world.clerk), (tx) =>
      ar.createDirect(tx, world.clerk, {
        customerId: world.customerId,
        branchCode: BAGHDAD,
        invoiceDate: TODAY,
        dueDate: day(30),
        lines: [
          { itemCode: PANEL, quantity: parseQuantity('7'), unitPriceIqd: parseDecimal('15000', 4n), warehouseCode: WAREHOUSE },
          { itemCode: PANEL, quantity: parseQuantity('5'), unitPriceIqd: parseDecimal('15000', 4n), warehouseCode: WAREHOUSE },
        ],
      }),
    );
    const both = await check(world.clerk, two.invoiceNo);
    expect(both).toMatch(/✗ Line 2 sells 5 of ITM-PANEL and WH-MAIN holds 3 — 2 short\./);
    expect(both).not.toMatch(/✗ Line 1 /);
  });
});

describe('a purchase invoice, checked before it is posted', () => {
  it('a clean one is FINE only', async () => {
    await postedPurchase({ quantity: '10', price: '10000', date: day(-3), supplierNo: 'JK-1000' });
    const clean = await purchase({ quantity: '5', price: '11000', supplierNo: 'JK-1001' });
    const found = await check(world.clerk, clean.invoiceNo);
    expect(found).toContain(`${clean.invoiceNo} · purchase invoice · status: DRAFT · branch BGW`);
    expect(found).toMatch(/VERDICT: nothing blocks it and nothing looks odd\./);
    expect(found).toContain('BLOCKERS: none found.');
    expect(found).toContain('WARNINGS: none.');
    expect(found).toMatch(/FINE — checked and in order: 1 line, total 55,000 IQD; the supplier's number "JK-1001" is on no other invoice of theirs; no price is more than 30% from the last purchase of its item; due \d{4}-\d{2}-\d{2}; no match variance is open; the period \(October 2026\) is open; the date \(\d{4}-\d{2}-\d{2}\) is a sensible one; the supplier \(\S+\) is active\./);
    expect(found).toMatch(/NEXT: Submit it \(document_step submit\)/);
    expect(found).toContain(`its page: ${BASE}/payables/invoices/${clean.invoiceNo}`);
  });

  it('warns of the supplier’s number used twice, the same invoice keyed twice, a due date that is the invoice date, a price far from the last one', async () => {
    const first = await postedPurchase({ quantity: '10', price: '10000', date: day(-3), supplierNo: 'JK-2000' });

    // The supplier's own number again — accepted at entry only with a reason, and still worth saying.
    const again = await purchase({ quantity: '4', price: '10000', supplierNo: 'JK-2000', duplicate: true });
    expect(await check(world.clerk, again.invoiceNo)).toMatch(new RegExp(`! The supplier's invoice number "JK-2000" is already on ${first.invoiceNo} \\(posted\\)\\.`));

    // The same charge under two of our numbers: same supplier, same date, same total.
    const one = await purchase({ quantity: '6', price: '9000', supplierNo: 'JK-2001' });
    const twin = await purchase({ quantity: '6', price: '9000', supplierNo: 'JK-2002' });
    expect(await check(world.clerk, twin.invoiceNo)).toMatch(new RegExp(`! It looks entered twice: ${one.invoiceNo} \\(draft\\) is from the same supplier, on the same date, with the same lines\\.`));

    // Due the day it is dated.
    const dueNow = await purchase({ quantity: '3', price: '10000', due: TODAY });
    expect(await check(world.clerk, dueNow.invoiceNo)).toMatch(new RegExp(`! The due date is the invoice date \\(${TODAY}\\): it will show as due at once\\.`));

    // Twice the last price paid. Its total (2 × 20,000) is the 40,000 of the four at 10,000 above,
    // and that alone does not make it the same invoice: the lines differ.
    const dear = await purchase({ quantity: '2', price: '20000' });
    const found = await check(world.clerk, dear.invoiceNo);
    expect(found).not.toMatch(/It looks entered twice/);
    expect(found).toMatch(new RegExp(`! Line 1 \\(ITM-PANEL\\) is priced at 20,000, and the last purchase was at 10,000 \\(${first.invoiceNo}, ${day(-3)}\\) — more than 30% apart\\.`));
    expect(found).toMatch(/VERDICT: nothing blocks it, and 1 thing is worth a second look first\./);
    // Within 30% is not a warning.
    const near = await purchase({ quantity: '2', price: '12500' });
    expect(await check(world.clerk, near.invoiceNo)).toMatch(/no price is more than 30% from the last purchase of its item/);
  });

  it('is blocked by a closed period and by a date no period covers — and old and future dates are said', async () => {
    const january = await purchase({ date: '2026-01-15', due: '2026-03-15' });
    const beyond = await purchase({ date: '2027-02-10', due: '2027-03-10' });

    // Before the close: January is open, and the date is merely old.
    const before = await check(world.clerk, january.invoiceNo);
    expect(before).toContain('BLOCKERS: none found.');
    expect(before).toMatch(/! It is dated 2026-01-15, \d+ days back\./);
    expect(before).toMatch(/the period \(January 2026\) is open/);

    // Closed, through the service that closes a period (as im10-period-close does).
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('accounting_manager','fiscal_period','configure') on conflict do nothing`);
    const manager: ActorContext = {
      principal: await withScope(scope(world.manager), (tx) => authz.loadPrincipal(tx, world.manager.principal.userId)),
      branchCode: BAGHDAD,
    };
    const { rows } = await ownerPool.query(`select p.id from fiscal_period p join fiscal_year y on y.id = p.fiscal_year_id where y.code = 'FY2026' and p.period_no = 1`);
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, rows[0].id as string, 'closed', 'month end'));

    const closed = await check(world.clerk, january.invoiceNo);
    expect(closed).toMatch(/VERDICT: it would be REFUSED as it stands — 1 blocker, 1 warning\./);
    expect(closed).toMatch(/✗ 2026-01-15 is in January 2026, which is CLOSED\. A closed period is final/);

    // Soft-closed: a document does not post into it either.
    await ownerPool.query(`update fiscal_period set status = 'soft_closed' where period_no = 2 and fiscal_year_id = (select id from fiscal_year where code = 'FY2026')`);
    const february = await purchase({ date: '2026-02-10', due: '2026-04-10' });
    expect(await check(world.clerk, february.invoiceNo)).toMatch(/✗ 2026-02-10 is in February 2026, which is SOFT-CLOSED\. A document does not post into a soft-closed period/);

    const none = await check(world.clerk, beyond.invoiceNo);
    expect(none).toMatch(/✗ No accounting period covers 2027-02-10, so nothing can post on that date\./);
    expect(none).toMatch(/! It is dated 2027-02-10, which is \d+ days in the FUTURE\./);
  });
});

describe('a journal entry, checked before it is submitted', () => {
  const codeOf = async (id: string) => (await ownerPool.query(`select code from chart_of_account where id = $1`, [id])).rows[0].code as string;

  async function journal(lines: readonly { readonly account: string; readonly debit?: string; readonly credit?: string }[], description: string | null = 'Office rent, October') {
    return withScope(scope(world.clerk), async (tx) => {
      const made = await journals.createDraft(tx, world.clerk, { branchCode: BAGHDAD, documentDate: TODAY, postingDate: TODAY, description });
      for (const line of lines) {
        await journals.addLine(tx, world.clerk, made.id, {
          accountId: line.account,
          ...(line.debit ? { debit: line.debit } : {}),
          ...(line.credit ? { credit: line.credit } : {}),
          dimensions: { department: null },
        });
      }
      return made;
    });
  }

  it('a balanced draft on posting accounts is fine; one that does not balance, or sits on a heading, is not', async () => {
    const expense = world.accounts.expense!;
    const bank = world.accounts.bank!;
    const fine = await journal([
      { account: expense, debit: '250000' },
      { account: bank, credit: '250000' },
    ]);
    const found = await check(world.clerk, fine.entryNo);
    expect(found).toContain(`${fine.entryNo} · journal entry · status: DRAFT · branch BGW`);
    expect(found).toMatch(/VERDICT: nothing blocks it and nothing looks odd\./);
    expect(found).toMatch(/FINE — checked and in order: 2 lines, debits 250,000 = credits; every account is approved, active and takes postings; the period \(October 2026\) is open; the date \(\d{4}-\d{2}-\d{2}\) is a sensible one\./);
    expect(found).toMatch(/NEXT: Submit it \(document_step submit\) — somebody in the Finance department/);
    expect(found).toContain(`its page: ${BASE}/finance/journals/${fine.entryNo}`);

    const lopsided = await journal(
      [
        { account: expense, debit: '250000' },
        { account: bank, credit: '200000' },
      ],
      null,
    );
    const out = await check(world.clerk, lopsided.entryNo);
    expect(out).toMatch(/✗ It does not balance: debits 250,000, credits 200,000 — out by 50,000\./);
    expect(out).toMatch(/! It has no description/);
    // What `journal.submit` says when it is tried.
    expect(await rejection(withScope(scope(world.clerk), (tx) => journals.submit(tx, world.clerk, lopsided.id)))).toMatch(/balance/i);

    // An account switched off after the line was keyed, and a control account posted by hand.
    const payable = world.accounts.supplier_payable!;
    const hand = await journal([
      { account: expense, debit: '1000' },
      { account: bank, credit: '1000' },
    ]);
    await ownerPool.query(`update journal_line set account_id = $1 where journal_entry_id = $2 and credit_iqd > 0`, [payable, hand.id]);
    await ownerPool.query(`update chart_of_account set is_active = false where id = $1`, [expense]);
    const bad = await check(world.clerk, hand.entryNo);
    expect(bad).toMatch(new RegExp(`✗ Line \\d+: ${await codeOf(expense)} · Service and Expense Cost is inactive\\.`));
    expect(bad).toMatch(new RegExp(`! Line \\d+ posts by hand to ${await codeOf(payable)} · Trade Payables, the supplier control account\\.`));
  });
});

describe('what it is not asked, it says', () => {
  it('refuses by role, by number and by absence, in words to pass on', async () => {
    const bought = await purchase();
    expect(await check(nobody, bought.invoiceNo)).toMatch(/role does not include "purchase invoice" \(the permission view on ap_invoice\)/);
    expect(await check(world.clerk, 'API-BGW-2026-999999')).toMatch(/There is no purchase invoice API-BGW-2026-999999 that this person can see\./);
    expect(await check(world.clerk, 'XYZ-1')).toMatch(/I cannot tell what kind of document XYZ-1 is from its number/);
    expect(await check(world.clerk, '  ')).toBe('Which document? Give its number.');
  });

  it('reads and changes nothing', async () => {
    const bought = await purchase();
    const sold = await sale();
    const count = async () =>
      (await ownerPool.query(`select (select count(*) from audit_event)::int as audits, (select count(*) from inventory_movement)::int as moves, (select count(*) from journal_entry)::int as journals`)).rows[0];
    const before = await count();
    await stuck(world.manager);
    await check(world.manager, bought.invoiceNo);
    await check(world.manager, sold.invoiceNo);
    expect(await count()).toEqual(before);
    expect((await ownerPool.query(`select status from ap_invoice where id = $1`, [bought.id])).rows[0].status).toBe('draft');
  });
});
