/**
 * Transfers & Applications, 2026-10-15 — by direction:
 *
 *   TA1  One import, one bank: once an application of the import went through
 *        a bank, a later one from another bank is refused and the sheet offers
 *        only that bank's accounts; another account at the same bank passes; a
 *        rejected or cancelled first application lets the bank go.
 *   TA2  Rejected / cancelled needs its reason, not a paper; every other paper
 *        still needs its file.
 *   TA3  The Import Applications search finds an import by part of its
 *        supplier's name ("jink" for Jinko), by words in any order, and by the
 *        number of something raised for it; the count is the rows'.
 *   TA4  The register's new filters: payment state, where the goods are,
 *        state, supplier — and the Payment Applications register's search,
 *        supplier, bank and status groups.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as payables from '@/server/services/payables';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { statusesOf } from '@/server/domain/payment-applications';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const SWIFT = 'TA-SWIFT';
let world: TradingWorld;
let approver: ActorContext;
let serial = 0;
/** Another account at the fixture's bank (Rafidain Bank), and one at another bank. */
let sameBankId: string;
let otherBankId: string;

const iqd = (value: string) => parseDecimal(value, 4n);
const paper = Buffer.from('%PDF-1.4\n% a bank paper\n');

async function glAccount(name: string) {
  const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'A000001'`);
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
    [`A8${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id],
  );
  return rows[0].id as string;
}

async function bankAccount(code: string, bankName: string) {
  const gl = await glAccount(`${bankName} ${code}`);
  const { rows } = await ownerPool.query(
    `insert into bank_cash_account (code, name, account_type, bank_name, account_number, currency, gl_account_id)
     values ($1,$2,'bank',$3,$4,'IQD',$5) returning id`,
    [code, `${bankName} ${code}`, bankName, `ACC-${randomUUID().slice(0, 8)}`, gl],
  );
  return rows[0].id as string;
}

async function superUser(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,'Super user',true)`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD, isSuperUser: true }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** A posted import of 100 panels at IQD 10,000 — IQD 1,000,000 to pay. */
async function postedImport(reference: string) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: parseQuantity('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    } as ap.CreateApInvoiceInput),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
  const { rows } = await ownerPool.query(`select p.id, p.payable_no from ap_invoice i join payable p on p.id = i.payable_id where i.id = $1`, [made.id]);
  return { payableId: rows[0].id as string, payableNo: rows[0].payable_no as string };
}

const apply = (payableId: string, bankCashAccountId: string, amount = '100000') =>
  withScope(scope(world.clerk), (tx) =>
    applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId, amountTxn: iqd(amount) }),
  );
const statusOf = async (id: string) => (await ownerPool.query(`select status::text from payment_application where id = $1`, [id])).rows[0].status as string;

beforeEach(async () => {
  registerAllRecords();
  world = await buildTradingWorld();
  approver = await superUser();
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
  await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active, is_default)
     values ($1,'Bank of China',$2,'BKCHCNBJ','IQD','approved',true,true)`,
    [world.supplierId, `CN-${randomUUID().slice(0, 8)}`],
  );
  sameBankId = await bankAccount('BCA-TA-RAF2', 'Rafidain Bank');
  otherBankId = await bankAccount('BCA-TA-MNS', 'Mansour Bank');
});

describe('TA1 · one import, one bank', () => {
  it('the first application names the bank; another bank is refused and not offered; the same bank passes', async () => {
    const { payableId, payableNo } = await postedImport('TA1-0001');

    // Before any application, every account in the currency is offered.
    const before = await withScope(scope(world.clerk), (tx) => applications.pickersFor(tx, payableId));
    expect(before.bankLock).toBeNull();
    expect(before.accounts.map((account) => account.id)).toEqual(expect.arrayContaining([world.bankAccountId, sameBankId, otherBankId]));

    const first = await apply(payableId, world.bankAccountId);
    const after = await withScope(scope(world.clerk), (tx) => applications.pickersFor(tx, payableId));
    expect(after.bankLock).toMatchObject({ applicationNo: first.applicationNo, bankName: 'Rafidain Bank' });
    const offered = after.accounts.map((account) => account.id);
    expect(offered).toEqual(expect.arrayContaining([world.bankAccountId, sameBankId]));
    expect(offered).not.toContain(otherBankId);

    await expect(apply(payableId, otherBankId)).rejects.toThrow(
      new RegExp(`${payableNo} is paid through Rafidain Bank: its first application, ${first.applicationNo}`),
    );
    // Another account at the same bank is the same bank.
    const second = await apply(payableId, sameBankId);
    expect(second.applicationNo).toBeTruthy();
  });

  it('a first application rejected or cancelled lets the bank go', async () => {
    const { payableId } = await postedImport('TA1-0002');
    const first = await apply(payableId, world.bankAccountId);
    await withScope(scope(world.clerk), (tx) => applications.cancel(tx, world.clerk, first.id, 'Raised at the wrong bank'));
    const picked = await withScope(scope(world.clerk), (tx) => applications.pickersFor(tx, payableId));
    expect(picked.bankLock).toBeNull();
    const elsewhere = await apply(payableId, otherBankId);
    // …and now the other bank holds.
    const locked = await withScope(scope(world.clerk), (tx) => applications.bankLockOf(tx, payableId));
    expect(locked).toMatchObject({ applicationNo: elsewhere.applicationNo, bankName: 'Mansour Bank' });
    await expect(apply(payableId, world.bankAccountId)).rejects.toThrow(/is paid through Mansour Bank/);
  });
});

describe('TA2 · rejected / cancelled needs the reason, not a paper', () => {
  it('cancels an approved application with only its reason; other papers still need their file', async () => {
    const { payableId } = await postedImport('TA2-0001');
    const made = await apply(payableId, world.bankAccountId);
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, made.id));
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, made.id));

    await expect(
      withScope(scope(world.manager), (tx) => applications.addPaper(tx, world.manager, made.id, { kind: 'sent_to_bank', date: '2026-09-10' })),
    ).rejects.toThrow(/Attach the paper/);
    await expect(
      withScope(scope(world.manager), (tx) => applications.addPaper(tx, world.manager, made.id, { kind: 'rejected_cancelled' })),
    ).rejects.toThrow(/Say why/);
    expect(await statusOf(made.id)).toBe('approved');

    const done = await withScope(scope(world.manager), (tx) =>
      applications.addPaper(tx, world.manager, made.id, { kind: 'rejected_cancelled', reason: 'The bank refused the beneficiary' }),
    );
    expect(done).toEqual({ attachmentId: null, kind: 'rejected_cancelled' });
    expect(await statusOf(made.id)).toBe('cancelled');
    const { rows } = await ownerPool.query(`select closed_reason from payment_application where id = $1`, [made.id]);
    expect(rows[0].closed_reason).toBe('The bank refused the beneficiary');
    const papers = await ownerPool.query(`select count(*)::int as n from payment_application_paper where payment_application_id = $1`, [made.id]);
    expect(papers.rows[0].n).toBe(0);
  });

  it('a paper given with the reason is still kept', async () => {
    const { payableId } = await postedImport('TA2-0002');
    const made = await apply(payableId, world.bankAccountId);
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, made.id));
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, made.id));
    const done = await withScope(scope(world.manager), (tx) =>
      applications.addPaper(tx, world.manager, made.id, { kind: 'rejected_cancelled', reason: 'Cancelled', fileName: 'letter.pdf', content: paper }),
    );
    expect(done.attachmentId).toBeTruthy();
  });
});

describe('TA3 · the Import Applications search', () => {
  const search = (term: string, extra: payables.WorkbenchFilter = {}) =>
    withScope(scope(world.clerk), (tx) => payables.workbench(tx, { typeCode: 'import', search: term, pageSize: 100, ...extra }));

  it('finds by part of the supplier’s name, words in any order, and the numbers raised for it', async () => {
    const { payableNo, payableId } = await postedImport('TA3-0001');
    const made = await apply(payableId, world.bankAccountId);

    for (const term of ['jink', 'JINKO', 'solar jink', 'SUP-JIN', payableNo.toLowerCase(), made.applicationNo, 'TA3 0001']) {
      const found = await search(term);
      expect(found.rows.map((row) => row.payableNo), term).toContain(payableNo);
      expect(found.total, term).toBe(found.rows.length);
    }
    for (const term of ['hama', 'jink zzz']) {
      const found = await search(term);
      expect(found.rows, term).toEqual([]);
      expect(found.total, term).toBe(0);
    }
  });
});

describe('TA4 · the registers’ filters', () => {
  it('Import Applications: payment state, goods, state and supplier', async () => {
    const { payableNo, payableId } = await postedImport('TA4-0001');
    const shows = async (filter: payables.WorkbenchFilter) => {
      const found = await withScope(scope(world.clerk), (tx) => payables.workbench(tx, { typeCode: 'import', pageSize: 100, ...filter }));
      expect(found.total).toBe(found.rows.length);
      return found.rows.some((row) => row.payableNo === payableNo);
    };

    expect(await shows({ payment: 'none' })).toBe(true);
    expect(await shows({ payment: 'pending' })).toBe(false);
    await apply(payableId, world.bankAccountId);
    expect(await shows({ payment: 'none' })).toBe(false);
    expect(await shows({ payment: 'pending' })).toBe(true);
    expect(await shows({ payment: 'at_bank' })).toBe(false);
    expect(await shows({ payment: 'paid' })).toBe(false);

    // Posted, nothing held for an advance and no container: In Process.
    expect(await shows({ goods: 'in_process' })).toBe(true);
    expect(await shows({ goods: 'on_process' })).toBe(false);
    expect(await shows({ goods: 'on_board' })).toBe(false);

    expect(await shows({ state: 'open' })).toBe(true);
    expect(await shows({ state: 'cancelled' })).toBe(false);
    expect(await shows({ supplierId: world.supplierId })).toBe(true);
    expect(await shows({ supplierId: world.customerId })).toBe(false);

    const suppliers = await withScope(scope(world.clerk), (tx) => payables.workbenchSuppliers(tx, 'import'));
    expect(suppliers.map((one) => one.id)).toContain(world.supplierId);
  });

  it('Payment Applications: search by supplier name, supplier, bank and the status groups', async () => {
    const { payableId } = await postedImport('TA4-0002');
    const made = await apply(payableId, world.bankAccountId);
    const list = (filter: applications.RegisterFilter) => withScope(scope(world.clerk), (tx) => applications.listForScreen(tx, filter));
    const has = async (filter: applications.RegisterFilter) => {
      const found = await list(filter);
      return found.rows.some((row) => row.applicationNo === made.applicationNo);
    };

    expect(await has({ search: 'jink' })).toBe(true);
    expect(await has({ search: 'rafidain jinko' })).toBe(true);
    expect(await has({ search: 'hama' })).toBe(false);
    expect(await has({ supplierId: world.supplierId })).toBe(true);
    expect(await has({ statuses: statusesOf('pending') })).toBe(true);
    expect(await has({ statuses: statusesOf('not_with_bank') })).toBe(true);
    expect(await has({ statuses: statusesOf('paid') })).toBe(false);
    expect(await has({ currency: 'USD' })).toBe(false);

    const choices = await withScope(scope(world.clerk), (tx) => applications.registerChoices(tx));
    expect(choices.suppliers.map((one) => one.id)).toContain(world.supplierId);
    expect(choices.currencies).toContain('IQD');
  });
});
