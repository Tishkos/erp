/**
 * REQ-AP-001 Stage 4 — PD / ASYCUDA (§16).
 *
 *   A11 (PD half)  The PD check on a payment application names the PD and
 *                  what is wrong with it — none registered, not validated,
 *                  expired, another bank — as a warning on the record, and
 *                  refuses nothing (2026-10-07, by direction: shown, never a
 *                  stop); the PD the bank pays against is recorded on the
 *                  application when there is one.
 *   A13 (REQ-APP A10)  A PD moved to an expired status requires a hold with
 *                  reason PD and allows re-registration; the old row is
 *                  unchanged and linked.
 *
 * Plus: one registration per number and year; a terminal status is final;
 * the history is append-only; the ASYCUDA list is read into a difference and
 * applied as history rows; the sweep warns once and expires on the day after.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { eq } from 'drizzle-orm';
import { withScope } from '@/server/db/client';
import { paymentApplication } from '@/server/db/schema';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as payables from '@/server/services/payables';
import * as sweep from '@/server/services/payables-sweep';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let payableId: string;
let payeeId: string;
let serial = 0;
const SWIFT = 'PM-T101';

async function fund(amount: string) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= '2026-09-01' and ends_on >= '2026-09-01' limit 1`,
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,'2026-09-01','2026-09-01',$2,$3,'Owner deposit','draft',$4,$4,$5) returning id`,
      [`FUND-AP04-${(serial += 1)}`, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1,1,$2,$3,0,$3,0,0,0,'IQD',$5), ($1,2,$4,0,$3,0,$3,0,0,'IQD',$5)`,
      [entry[0].id, world.accounts.bank, amount, world.accounts.grni, BAGHDAD],
    );
    await client.query(`update journal_entry set status='posted', approved_by=$2, posted_at=now() where id=$1`, [
      entry[0].id,
      world.manager.principal.userId,
    ]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

const register = (input: Partial<customs.RegisterInput> = {}) =>
  withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, {
      payableId,
      pdNo: '9330',
      registrationDate: '2026-09-02',
      expiryDate: '2027-03-01',
      bankCode: 'BNK-0002',
      ...input,
    }),
  );
const change = (pdId: string, statusCode: string, effectiveDate = '2026-09-05', note: string | null = null) =>
  withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pdId, { statusCode, effectiveDate, note }));
const codes = async () => {
  const { rows } = await ownerPool.query(
    `select event_code from payable_event where payable_id = $1 order by recorded_at, id`,
    [payableId],
  );
  return rows.map((row) => row.event_code as string);
};
const superScope = () => ({ userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true });

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`,
    [SWIFT],
  );
  // The world's bank account is with Arab Bank (BNK-0002, seeded by 0232).
  await ownerPool.query(`update bank_cash_account set bank_code = 'BNK-0002' where id = $1`, [world.bankAccountId]);
  const { rows: payee } = await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, currency, approval_status, is_active)
     values ($1,'Bank of China','CN-1','IQD','approved',true) returning id`,
    [world.supplierId],
  );
  payeeId = payee[0].id;
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'CSA-PD-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity('100'),
          unitPriceIqd: parseDecimal('10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  payableId = rows[0].payable_id;
});

describe('§16.1 · the PD register', () => {
  it('registers a PD with its history, its event and the stage it reaches', async () => {
    const pd = await register();
    const { rows } = await ownerPool.query(
      `select status_code, registration_year, bank_swift, branch_code from customs_pd where id = $1`,
      [pd.id],
    );
    expect(rows[0]).toEqual({
      status_code: 'submitted',
      registration_year: 2026,
      bank_swift: 'ARABIQBAXXX',
      branch_code: BAGHDAD,
    });
    const { rows: history } = await ownerPool.query(
      `select status_code, source from customs_pd_status_history where pd_id = $1`,
      [pd.id],
    );
    expect(history).toEqual([{ status_code: 'submitted', source: 'user' }]);
    expect(await codes()).toContain('PD_SUBMITTED');
    const facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts.livePdCount).toBe(1);
  });

  it('keeps the registration as the bank’s platform shows it: importer code, financier, invoice no., declarant code (0420)', async () => {
    const pd = await register({ importerCode: ' 70002390 ', financier: '32', invoiceNo: 'WMT2S014A', declarantCode: '2509106C' });
    const { rows } = await ownerPool.query(`select importer_code, financier, invoice_no, declarant_code from customs_pd where id = $1`, [pd.id]);
    expect(rows[0]).toEqual({ importer_code: '70002390', financier: '32', invoice_no: 'WMT2S014A', declarant_code: '2509106C' });
    // On the import's PD section and the register, and found by the search.
    const listed = await withScope(scope(world.clerk), (tx) => customs.list(tx, { payableId, view: 'all' }));
    expect(listed[0]).toMatchObject({ importerCode: '70002390', financier: '32', invoiceNo: 'WMT2S014A', declarantCode: '2509106C' });
    const found = await withScope(scope(world.clerk), (tx) => customs.listForScreen(tx, { search: '2509106C', view: 'all' }));
    expect(found.rows.map((row) => row.pdNo)).toEqual(['9330']);
    // Blank is nothing; a code longer than the platform's is refused.
    const bare = await register({ pdNo: '9331', importerCode: '  ' });
    expect((await ownerPool.query(`select importer_code from customs_pd where id = $1`, [bare.id])).rows[0].importer_code).toBeNull();
    expect(await rejection(register({ pdNo: '9332', declarantCode: 'X'.repeat(65) }))).toMatch(/at most 64/);

    // Re-registered: the codes travel with the import unless the form changes them.
    await change(pd.id, 'rejected', '2026-09-04', 'Wrong HS code');
    const fresh = await withScope(scope(world.clerk), (tx) =>
      customs.reRegister(tx, world.clerk, pd.id, { pdNo: '9412', registrationDate: '2026-09-06', expiryDate: '2027-03-06', declarantCode: '2509107D' }),
    );
    const { rows: carried } = await ownerPool.query(`select importer_code, financier, invoice_no, declarant_code from customs_pd where id = $1`, [fresh.id]);
    expect(carried[0]).toEqual({ importer_code: '70002390', financier: '32', invoice_no: 'WMT2S014A', declarant_code: '2509107D' });
  });

  it('one registration per number and year; expiry before registration is refused', async () => {
    await register();
    expect(await rejection(register())).toMatch(/already registered/);
    // The same number in another year is another registration.
    const next = await register({ registrationDate: '2027-01-05', expiryDate: '2027-07-01' });
    expect(next.pdNo).toBe('9330');
    expect(await rejection(register({ pdNo: '9331', expiryDate: '2026-08-01' }))).toMatch(/cannot expire/);
  });

  it('a terminal status is final; a rejected PD is re-registered, the old row untouched and linked', async () => {
    const pd = await register();
    await change(pd.id, 'rejected', '2026-09-04', 'Wrong HS code');
    expect(await rejection(change(pd.id, 'validated'))).toMatch(/final.*Re-register/s);

    const fresh = await withScope(scope(world.clerk), (tx) =>
      customs.reRegister(tx, world.clerk, pd.id, {
        pdNo: '9412',
        registrationDate: '2026-09-06',
        expiryDate: '2027-03-06',
      }),
    );
    const { rows } = await ownerPool.query(
      `select pd_no, status_code, supersedes_pd_id from customs_pd order by created_at`,
    );
    expect(rows).toEqual([
      { pd_no: '9330', status_code: 'rejected', supersedes_pd_id: null },
      { pd_no: '9412', status_code: 'submitted', supersedes_pd_id: pd.id },
    ]);
    expect(fresh.pdNo).toBe('9412');
    expect(await codes()).toEqual(expect.arrayContaining(['PD_REJECTED', 'PD_REREGISTERED']));
    // Once only.
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          customs.reRegister(tx, world.clerk, pd.id, {
            pdNo: '9413',
            registrationDate: '2026-09-07',
            expiryDate: '2027-03-07',
          }),
        ),
      ),
    ).toMatch(/already been re-registered/);
    // And a live PD is not re-registered.
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          customs.reRegister(tx, world.clerk, fresh.id, {
            pdNo: '9414',
            registrationDate: '2026-09-07',
            expiryDate: '2027-03-07',
          }),
        ),
      ),
    ).toMatch(/only a rejected or expired PD/);
  });

  it('the status history is append-only', async () => {
    const pd = await register();
    const refused = await ownerPool
      .query(`delete from customs_pd_status_history where pd_id = $1`, [pd.id])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(refused).not.toBe('allowed');
  });

  it('every standing PD totally written off is the Cleared rule’s PD condition', async () => {
    const first = await register();
    const second = await register({ pdNo: '9500' });
    await change(first.id, 'validated');
    await change(first.id, 'totally_written_off', '2026-09-20');
    let facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts.allPdsWrittenOff).toBe(false);
    await change(second.id, 'validated');
    await change(second.id, 'totally_written_off', '2026-09-21');
    facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts.allPdsWrittenOff).toBe(true);
    expect(await codes()).toContain('PD_TOTALLY_WRITTEN_OFF');
  });
});

describe('A11 · the bank pays only against a validated PD — shown on the application, never a stop (2026-10-07)', () => {
  const draftAndApprove = async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      applications.create(tx, world.clerk, {
        payableId,
        paymentMethodCode: SWIFT,
        bankCashAccountId: world.bankAccountId,
        payeeBankAccountId: payeeId,
        amountTxn: parseDecimal('300000', 4n),
        onDate: '2026-09-10',
      }),
    );
    await withScope(scope(world.manager), async (tx) => { await applications.submit(tx, world.manager, made.id); return applications.approve(tx, world.manager, made.id); });
    return made;
  };
  const send = (id: string, by = world.clerk, overrideReason: string | null = null) =>
    withScope(scope(by), (tx) =>
      applications.send(tx, by, id, { applicationDate: '2026-09-10', overrideReason }),
    );
  const pdCheck = async (id: string) =>
    withScope(scope(world.clerk), async (tx) => {
      const [row] = await tx.select().from(paymentApplication).where(eq(paymentApplication.id, id)).limit(1);
      return (await applications.checksFor(tx, { ...row!, applicationDate: '2026-09-10' })).find((check) => check.code === 'pd_validated')!;
    });

  it('no PD, or one not validated: a warning that names it, and Send still goes; validated: the PD is recorded', async () => {
    await fund('5000000');
    const made = await draftAndApprove();
    expect(await pdCheck(made.id)).toMatchObject({ outcome: 'warning', detail: expect.stringMatching(/No PD is registered/) });

    const pd = await register();
    expect(await pdCheck(made.id)).toMatchObject({ outcome: 'warning', detail: expect.stringMatching(/PD 9330 is Submitted/) });

    await change(pd.id, 'validated', '2026-09-08');
    expect(await pdCheck(made.id)).toMatchObject({ outcome: 'pass' });
    await send(made.id);
    const { rows } = await ownerPool.query(`select status, pd_id, overridden_checks from payment_application where id = $1`, [made.id]);
    expect(rows[0]).toEqual({ status: 'sent', pd_id: pd.id, overridden_checks: [] });
  });

  it('with no PD at all a clerk sends without a reason, nothing is overridden, and no PD is recorded on it', async () => {
    await fund('5000000');
    const made = await draftAndApprove();
    await send(made.id);
    const { rows } = await ownerPool.query(`select status, pd_id, overridden_checks from payment_application where id = $1`, [made.id]);
    expect(rows[0]).toEqual({ status: 'sent', pd_id: null, overridden_checks: [] });
    expect(await codes()).not.toContain('CHECK_OVERRIDDEN');
  });

  it('a PD registered with another bank is a warning; Send goes and names no PD until one of the account’s bank is validated', async () => {
    await fund('5000000');
    const pd = await register({ bankCode: 'BNK-0001' });
    await change(pd.id, 'validated', '2026-09-08');
    const made = await draftAndApprove();
    expect(await pdCheck(made.id)).toMatchObject({ outcome: 'warning', detail: expect.stringMatching(/registered with Mansour Bank .* from Arab Bank/) });
    await send(made.id);
    const { rows } = await ownerPool.query(`select overridden_checks, pd_id from payment_application where id = $1`, [made.id]);
    // The PD the bank would pay against is still the one named: the warning says the banks differ.
    expect(rows[0]).toEqual({ overridden_checks: [], pd_id: pd.id });
    expect(await codes()).not.toContain('CHECK_OVERRIDDEN');
  });

  it('an expired PD is a warning, not a stop', async () => {
    await fund('5000000');
    const pd = await register({ expiryDate: '2026-09-09' });
    await change(pd.id, 'validated', '2026-09-05');
    const made = await draftAndApprove();
    expect(await pdCheck(made.id)).toMatchObject({ outcome: 'warning', detail: expect.stringMatching(/PD 9330 expired on 2026-09-09/) });
    await send(made.id);
    expect((await ownerPool.query(`select status from payment_application where id = $1`, [made.id])).rows[0].status).toBe('sent');
  });
});

describe('§21.8 · the ASYCUDA list', () => {
  it('reads the pasted list into a difference, and applies the changes as history', async () => {
    const a = await register({ pdNo: '9330' });
    const b = await register({ pdNo: '9331' });
    const c = await register({ pdNo: '9332' });
    await change(c.id, 'rejected', '2026-09-04');
    const list = [
      'PD No\tStatus\tDate',
      '9330\tValidated\t08/09/2026',
      '9331  Submited',
      '9332, Validated',
      '7777 Validated',
      '9330 Lost in the post',
    ].join('\n');

    const diff = await withScope(scope(world.clerk), (tx) => customs.asycudaDiff(tx, list));
    expect(diff.rows.map((row) => [row.pdNo, row.outcome])).toEqual([
      ['9330', 'change'],
      ['9331', 'same'],
      ['9332', 'final'],
      ['7777', 'not_found'],
    ]);
    expect(diff.unreadable.map((row) => row.line)).toEqual([1, 6]);

    const applied = await withScope(scope(world.clerk), (tx) => customs.asycudaApply(tx, world.clerk, list));
    expect(applied).toMatchObject({ changed: 1, same: 1, notFound: ['7777'], skipped: ['9332'], unreadable: 2 });
    const { rows } = await ownerPool.query(
      `select d.pd_no, d.status_code, h.source, h.effective_date::text as on
         from customs_pd d join customs_pd_status_history h on h.pd_id = d.id
        where d.id = $1 order by h.recorded_at desc limit 1`,
      [a.id],
    );
    expect(rows[0]).toEqual({ pd_no: '9330', status_code: 'validated', source: 'asycuda_list', on: '2026-09-08' });
    expect(b.pdNo).toBe('9331');
  });
});

describe('§16.2 · the sweep keeps the PD clocks', () => {
  it('warns once inside 45 days, expires the day after, and stops the import until re-registered', async () => {
    const pd = await register({ registrationDate: '2026-04-01', expiryDate: '2026-10-20' });
    await change(pd.id, 'validated', '2026-04-05');

    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-09-10')); // 40 days left
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-09-11'));
    expect((await codes()).filter((code) => code === 'PD_EXPIRING')).toHaveLength(1);

    const run = await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-21'));
    expect(run.pdsExpired).toBe(1);
    const { rows } = await ownerPool.query(`select status_code, status_date::text as on from customs_pd where id = $1`, [pd.id]);
    expect(rows[0]).toEqual({ status_code: 'expired_validated', on: '2026-10-21' });
    expect(await codes()).toContain('PD_EXPIRED');

    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-22'));
    const { rows: holds } = await ownerPool.query(
      `select lane_code, check_code, reason_code from payable_hold where payable_id = $1 and check_code = 'pd_expired'`,
      [payableId],
    );
    expect(holds).toEqual([{ lane_code: 'pd', check_code: 'pd_expired', reason_code: 'PENDING_REASON' }]);
  });

  it('a PD not validated in 7 days opens one hold in the PD lane', async () => {
    await register({ registrationDate: '2026-09-01' });
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-09-07'));
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-09-12'));
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-09-13'));
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from payable_hold where payable_id = $1 and check_code = 'pd_not_validated'`,
      [payableId],
    );
    expect(rows[0].n).toBe(1);
  });
});
