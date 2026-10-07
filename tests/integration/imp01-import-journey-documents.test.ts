/**
 * The import application's page — the goods' journey and every file of its
 * chain back on its own block (2026-10-07, by direction):
 *
 *   "after the payment application for a payable amount … automatically makes
 *    the payment, it should write somewhere that [the goods went] from On
 *    Process to In Process, [and] others are pending" — and — "every attachment
 *    related to an import application comes back … their attachment should
 *    come back to their blocks".
 *
 *   IMP1  files put on a payment application (a paper), the supplier payment
 *         its confirmation posted, a B/L, a container, a PD, an ASYCUDA reading
 *         of that PD, the journal a landed-cost charge names and the purchase
 *         invoice come back to the import — each in its block (Payments, PD /
 *         ASYCUDA, Shipment & containers, Landed cost, the header), with its
 *         source's kind and number, the paper's kind, and nothing copied: a
 *         block's own file stays its own and is not listed twice.
 *   IMP2  a viewer without the grant on a parent does not see that parent's
 *         files (payment applications, supplier payments) while the others
 *         still come back.
 *   IMP3  the journey: held → released after the application is confirmed,
 *         with the application's number and the paid paper's date; an import
 *         without an advance starts at In Process.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as asycuda from '@/server/services/asycuda-runs';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import * as customs from '@/server/services/customs-pd';
import * as importFiles from '@/server/services/import-attachments';
import * as journey from '@/server/services/import-goods-journey';
import * as landed from '@/server/services/landed-cost';
import * as shipments from '@/server/services/shipments';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { readAttachments } from '@/components/admin/attachments';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-IMP-INPROC';
const HOLD = 'WH-IMP-NOSWIFT';
const SWIFT = 'IMP-SWIFT';
const PDF = Buffer.from('%PDF-1.4\n% a paper of the import\n');
let world: TradingWorld;
let approver: ActorContext;
let serial = 0;

const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);

/** A posted journal, as the owner — what a deposit or a charge names. */
async function postedJournal(debitAccountId: string, amount: string, on = '2026-09-01'): Promise<{ id: string; entryNo: string }> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const entryNo = `JE-IMP-${(serial += 1)}`;
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Import test journal','draft',$5,$5,$6) returning id`,
      [entryNo, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5), ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, debitAccountId, amount, world.accounts.grni, BAGHDAD],
    );
    await client.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, world.manager.principal.userId]);
    await client.query('commit');
    return { id: entry[0].id as string, entryNo };
  } finally {
    client.release();
  }
}

async function userWith(roles: readonly string[], name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** A role that reads the import and its shipping, customs and landed cost — but not its payments. */
async function noPaymentsViewer(): Promise<ActorContext> {
  const code = 'imp_no_payments';
  await ownerPool.query(`insert into role (code, name) values ($1,$1) on conflict do nothing`, [code]);
  for (const object of ['payable', 'ap_invoice', 'bill_of_lading', 'shipment_container', 'customs_pd', 'customs_declaration', 'landed_cost', 'journal_entry', 'attachment']) {
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,'view') on conflict do nothing`, [code, object]);
  }
  return userWith([code], 'Shipping clerk');
}

async function importInvoice(reference: string, extra: Partial<ap.CreateApInvoiceInput> = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      ...extra,
    } as ap.CreateApInvoiceInput),
  );
  const { rows } = await ownerPool.query(`select payable_id, invoice_no from ap_invoice where id = $1`, [made.id]);
  return { invoiceId: made.id, invoiceNo: rows[0].invoice_no as string, payableId: rows[0].payable_id as string };
}

async function post(invoiceId: string) {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
}

const upload = (actor: ActorContext, objectType: string, objectId: string, fileName: string) =>
  withScope(scope(actor), (tx) => attachments.upload(tx, actor, { objectType, objectId, fileName, content: PDF }));

const addPaper = (actor: ActorContext, id: string, input: Omit<applications.PaperInput, 'fileName' | 'content'> & { fileName?: string }) =>
  withScope(scope(actor), (tx) => applications.addPaper(tx, actor, id, { ...input, fileName: input.fileName ?? `${input.kind}.pdf`, content: PDF }));

const gatherAs = (actor: ActorContext, payableId: string) => withScope(scope(actor), (tx) => importFiles.gather(tx, actor.principal, payableId));
const journeyAs = (actor: ActorContext, payableId: string) => withScope(scope(actor), (tx) => journey.journeyFor(tx, actor.principal, payableId));

/** Each block's files as "kind number: file (paper kind)". */
const shape = (gathered: importFiles.GatheredFiles) =>
  Object.fromEntries(
    importFiles.IMPORT_FILE_SECTIONS.map((section) => [
      section,
      gathered[section].flatMap((source) => source.files.map((file) => `${source.kind} ${source.no}: ${file.fileName}${file.paperKind ? ` (${file.paperKind})` : ''}`)).sort(),
    ]),
  );

beforeEach(async () => {
  // Who may read which record's files, registered as the screens' actions do — and the files kept in memory.
  registerAllRecords();
  const kept = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void kept.set(key, content), get: async (key) => kept.get(key) ?? null });
  world = await buildTradingWorld();
  approver = await userWith(['accounting_manager'], 'Second approver');
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values
       ($1,'In Process',$3,'transit',true,'in_process'),
       ($2,'On Process (Without SWIFT)',$3,'transit',true,'without_swift')`,
    [IN_PROCESS, HOLD, BAGHDAD],
  );
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
  await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active, is_default)
     values ($1,'Bank of China',$2,'BKCHCNBJ','IQD','approved',true,true)`,
    [world.supplierId, `CN-${randomUUID().slice(0, 8)}`],
  );
  await postedJournal(world.accounts.bank!, '9000000');
});

/** An import bought with a 20% advance, posted: the goods held, the application a draft. */
async function heldImport(reference: string) {
  const made = await importInvoice(reference, { advanceBasis: 'percent', advancePercent: '20', advancePaymentMethodCode: SWIFT, advancePaidFromAccountId: world.bankAccountId });
  await post(made.invoiceId);
  const { rows } = await ownerPool.query(
    `select a.id, a.application_no from ap_invoice i join payment_application a on a.id = i.advance_application_id where i.id = $1`,
    [made.invoiceId],
  );
  return { ...made, applicationId: rows[0].id as string, applicationNo: rows[0].application_no as string };
}

/** Sent for approval, approved by another person, the PD standing, sent to the bank and paid. */
async function payAdvance(payableId: string, applicationId: string, pdNo: string) {
  await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, applicationId));
  await withScope(scope(approver), (tx) => applications.approve(tx, approver, applicationId));
  const pd = await withScope(scope(world.clerk), (tx) => customs.register(tx, world.clerk, { payableId, pdNo, registrationDate: '2026-09-02', expiryDate: '2027-03-01' }));
  await withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-09-05' }));
  await addPaper(world.manager, applicationId, { kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-1', fileName: 'bank-letter.pdf' });
  await addPaper(world.manager, applicationId, { kind: 'paid', date: '2026-09-12', reference: 'MT103-0001', fileName: 'swift-mt103.pdf' });
  return pd.id;
}

describe('IMP1 · every file of the chain comes back to its own block', () => {
  it('payments, PD / ASYCUDA, shipment, landed cost and the header each gather their records’ files', async () => {
    const made = await heldImport('IMP1-0001');
    const pdId = await payAdvance(made.payableId, made.applicationId, '7301');

    // The block's own file, put through its paperclip: it stays the block's own, not listed twice.
    await upload(world.manager, 'payable_payments', made.payableId, 'payments-own.pdf');
    // The supplier payment the confirmation posted.
    const { rows: paid } = await ownerPool.query(`select p.id, p.payment_no from payment_application a join supplier_payment p on p.id = a.supplier_payment_id where a.id = $1`, [made.applicationId]);
    expect(paid).toHaveLength(1);
    await upload(world.manager, 'supplier_payment', paid[0].id, 'remittance.pdf');

    // Shipment: a B/L with a container, a file on each.
    await withScope(scope(world.clerk), (tx) =>
      shipments.createBl(tx, world.clerk, {
        payableId: made.payableId,
        blNo: 'MEDU7301001',
        blDate: '2026-09-20',
        eta: '2026-10-25',
        portOfDischargeCode: 'PRT-0001',
        containers: 'MSCU1234566',
        spreadLines: true,
      }),
    );
    const { rows: shipped } = await ownerPool.query(`select b.id as bl_id, c.id as container_id from bill_of_lading b join shipment_container c on c.bl_id = b.id where b.payable_id = $1`, [made.payableId]);
    await upload(world.clerk, 'bill_of_lading', shipped[0].bl_id, 'bill-of-lading.pdf');
    await upload(world.clerk, 'shipment_container', shipped[0].container_id, 'packing-list.pdf');

    // Customs: a file on the PD, and an ASYCUDA reading of it (its export filed on the reading).
    await upload(world.clerk, 'customs_pd', pdId, 'pd-printout.pdf');
    const file = { fileName: 'asycuda-export.csv', content: Buffer.from('7301,Validated,08/09/2026\n') };
    const run = await withScope(scope(world.clerk), (tx) =>
      asycuda.startRun(tx, world.clerk, { source: 'file', fileNames: [file.fileName], text: asycuda.readFiles([file]).text, files: [file] }),
    );

    // Landed cost: a freight charge from a posted journal whose file is the forwarder's bill.
    const journal = await postedJournal(world.accounts.inventory!, '150000');
    await upload(world.manager, 'journal_entry', journal.id, 'freight-bill.pdf');
    await withScope(scope(world.manager), (tx) =>
      landed.addCharge(tx, world.manager, { payableId: made.payableId, chargeTypeCode: 'freight', journalEntryNo: journal.entryNo, amountIqd: iqd('150000') }),
    );
    await upload(world.manager, 'payable_landed_cost', made.payableId, 'landed-own.pdf');

    // The header: the purchase invoice's file.
    await upload(world.clerk, 'ap_invoice', made.invoiceId, 'supplier-invoice.pdf');

    const gathered = await gatherAs(world.manager, made.payableId);
    expect(shape(gathered)).toEqual({
      header: [`purchase_invoice ${made.invoiceNo}: supplier-invoice.pdf`],
      payments: [
        `payment_application ${made.applicationNo}: bank-letter.pdf (sent_to_bank)`,
        `payment_application ${made.applicationNo}: swift-mt103.pdf (paid)`,
        `supplier_payment ${paid[0].payment_no}: remittance.pdf`,
      ].sort(),
      customs: [`asycuda_run ${run.runNo}: asycuda-export.csv`, 'customs_pd 7301: pd-printout.pdf'].sort(),
      shipment: ['bill_of_lading MEDU7301001: bill-of-lading.pdf', 'shipment_container MSCU1234566: packing-list.pdf'].sort(),
      landed_cost: [`charge_journal ${journal.entryNo}: freight-bill.pdf`],
    });
    // Each source carries the way to its own page and the counts add up.
    const application = gathered.payments.find((source) => source.kind === 'payment_application')!;
    expect(application.link).toEqual({ profile: 'payment_application', key: made.applicationNo });
    expect(application.files.every((one) => one.uploadedBy !== null && one.sizeBytes === PDF.length)).toBe(true);
    expect(gathered.customs.find((source) => source.kind === 'customs_pd')!.link).toMatchObject({ profile: 'pd', key: '7301' });
    expect(importFiles.countOf(gathered.payments)).toBe(3);

    // The blocks' own files are the paperclips' own reads, not repeated in what comes back.
    const own = await withScope(scope(world.manager), async (tx) => ({
      payments: (await readAttachments(tx, 'payable_payments', made.payableId)).rows.map((row) => row.fileName),
      landed: (await readAttachments(tx, 'payable_landed_cost', made.payableId)).rows.map((row) => row.fileName),
    }));
    expect(own).toEqual({ payments: ['payments-own.pdf'], landed: ['landed-own.pdf'] });

    // Dynamic: a file put on the application now is on the import at once — nothing was copied.
    await upload(world.manager, 'payment_application', made.applicationId, 'note-from-bank.pdf');
    const again = await gatherAs(world.manager, made.payableId);
    expect(shape(again).payments).toContain(`payment_application ${made.applicationNo}: note-from-bank.pdf`);
    const { rows: copies } = await ownerPool.query(`select count(*)::int as n from attachment where file_name = 'note-from-bank.pdf'`);
    expect(copies[0].n).toBe(1);
  });

  it('IMP2 · a viewer without the grant on a parent does not see that parent’s files', async () => {
    const made = await heldImport('IMP2-0001');
    await payAdvance(made.payableId, made.applicationId, '7302');
    const { rows: paid } = await ownerPool.query(`select supplier_payment_id as id from payment_application where id = $1`, [made.applicationId]);
    await upload(world.manager, 'supplier_payment', paid[0].id, 'remittance.pdf');
    await withScope(scope(world.clerk), (tx) =>
      shipments.createBl(tx, world.clerk, { payableId: made.payableId, blNo: 'MEDU7302001', blDate: '2026-09-20', eta: '2026-10-25', portOfDischargeCode: 'PRT-0001', containers: 'MSCU1234566', spreadLines: true }),
    );
    const { rows: bl } = await ownerPool.query(`select id from bill_of_lading where payable_id = $1`, [made.payableId]);
    await upload(world.clerk, 'bill_of_lading', bl[0].id, 'bill-of-lading.pdf');

    const viewer = await noPaymentsViewer();
    const seen = shape(await gatherAs(viewer, made.payableId));
    expect(seen.payments).toEqual([]);
    expect(seen.shipment).toEqual(['bill_of_lading MEDU7302001: bill-of-lading.pdf']);
    // The manager, who holds both, sees the payments too.
    expect(shape(await gatherAs(world.manager, made.payableId)).payments).toHaveLength(3);
  });
});

describe('IMP3 · the goods’ journey', () => {
  it('held → released after the application is confirmed, with its number; no advance starts at In Process', async () => {
    const made = await heldImport('IMP3-0001');
    const before = await journeyAs(world.manager, made.payableId);
    expect(before.advance).toEqual({ kind: 'percent', value: '20', currency: 'IQD' });
    const [held, inProcess] = before.steps;
    expect(held).toMatchObject({ step: 'on_process', state: 'partial', current: true, document: { kind: 'purchase_invoice', no: made.invoiceNo } });
    expect(held!.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(held!.note).toMatchObject({ key: 'journey_held_note', document: { kind: 'payment_application', no: made.applicationNo } });
    expect(inProcess).toMatchObject({ step: 'in_process', state: 'pending', current: false });
    expect(before.steps.map((step) => step.step)).toEqual(['on_process', 'in_process', 'bl', 'containers', 'customs', 'clearance', 'landed_cost', 'received']);

    await payAdvance(made.payableId, made.applicationId, '7303');
    const after = await journeyAs(world.manager, made.payableId);
    expect(after.steps[0]).toMatchObject({ step: 'on_process', state: 'done', note: null });
    expect(after.steps[1]).toMatchObject({
      step: 'in_process',
      state: 'done',
      on: '2026-09-12',
      document: { kind: 'payment_application', no: made.applicationNo },
      detail: { key: 'journey_released' },
    });
    // The PD stood for the payment: customs is done; the B/L is now the current step.
    expect(after.steps.find((step) => step.step === 'customs')).toMatchObject({ state: 'done', on: '2026-09-05', document: { kind: 'pd', no: '7303' } });
    expect(after.steps.find((step) => step.current)?.step).toBe('bl');

    // An import with no advance: In Process is the first step, done when its invoice posted.
    const plain = await importInvoice('IMP3-0002');
    await post(plain.invoiceId);
    const straight = await journeyAs(world.manager, plain.payableId);
    expect(straight.advance).toBeNull();
    expect(straight.steps[0]).toMatchObject({ step: 'in_process', state: 'done', document: { kind: 'purchase_invoice', no: plain.invoiceNo }, detail: { key: 'journey_invoice_posted' } });
    expect(straight.steps.some((step) => step.step === 'on_process')).toBe(false);
  });
});
