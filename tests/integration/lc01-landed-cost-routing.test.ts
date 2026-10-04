/**
 * IMPROVEMENT-002 — where every dinar of a landed-cost lock goes (0280).
 *
 * A lock spreads an import's charges over the layers its containers created.
 * What is still on hand is restated into the layer's unit cost (Dr the item's
 * inventory account, per warehouse). What had already left follows the
 * business event that took the units — never "everything that left is cost of
 * sales" (sponsor, 2026-10-04):
 *
 *   a sale on an A/R invoice     cogs, on the invoice journal's COGS account
 *                                and with that line's dimensions
 *   a project material issue     project_material_cost, the issue journal's
 *                                account and dimensions (the project), and a
 *                                project_cost row — no budget stop
 *   a transfer / relocation      no departure: the share follows to the
 *                                destination layer and restates it there
 *   a write-off                  inventory_loss (refused, naming the role,
 *                                while it is unmapped)
 *   a supplier (goods) return    purchase_variance, or return_clearing when the
 *                                supplier reimburses the landed cost
 *   an Item Reconciliation out   inventory_adjustment
 *   anything else                refused, naming the movement kind
 *
 * One `landed_cost_departure` row per lock × layer × departed movement. A
 * sale reversed before the lock departed nothing; units a customer returned
 * before the lock follow to the return layer.
 *
 * Scenarios, one describe each, each building its own import and ending on
 * the balance assertions of `support/landed-cost-balance.ts`:
 *
 *   1  500 received, 200 sold, 300 left (and an amount that does not divide)
 *   2  three locks on the same layer — the unit-cost chain
 *   3  a sale reversed before the lock
 *   4  a sales return before the lock
 *   5  a project material issue (active project)
 *   6  a transfer followed; a transfer still in transit refused
 *   7  a write-off: refused while inventory_loss is unmapped, then posted
 *   8  a goods return: purchase_variance, return_clearing, the flag frozen
 *   9  an Item Reconciliation out
 *  10  the lock date's guards, and an unknown departure kind
 *  11  a reversal is dated the day it is made (stock and journal), the
 *      original movement untouched, across a closed period
 *  12  a purchase invoice whose charge is locked is not reversed
 *
 * Dates: the import arrives in August 2026, everything departs in September,
 * and the locks are dated on or before 30 September — a lock may not be dated
 * in the future, and "today" is the business date the run happens on.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import { registerDepartureRuntime } from '@/server/departures-runtime';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as customs from '@/server/services/customs-pd';
import * as gr from '@/server/services/goods-return';
import * as inventory from '@/server/services/inventory';
import * as landed from '@/server/services/landed-cost';
import * as periods from '@/server/services/periods';
import * as closing from '@/server/services/project-close';
import * as pb from '@/server/services/project-budget';
import * as pe from '@/server/services/project-execution';
import * as ps from '@/server/services/project-system';
import * as shipments from '@/server/services/shipments';
import * as sr from '@/server/services/sales-return';
import * as states from '@/server/services/stock-states';
import * as stock from '@/server/services/stock-operations';
import * as transfers from '@/server/services/transfers';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { addBusinessDays, businessToday } from '@/server/domain/business-date';
import { restate } from '@/server/domain/landed-cost';
import { parseDecimal, toDecimalString } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { fundBank } from './hr-funds';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import {
  assertImportFullyAccounted,
  assertLayersMatchGl,
  assertLockBalanced,
  layersAndGl,
} from './support/landed-cost-balance';

const IN_PROCESS = 'WH-LC01-INPROC';
const SECOND = 'WH-LC01-ERBIL';
const DAMAGED = 'WH-LC01-DAMAGED';
const CUSTOMER = 'CUST-ALNOOR'; // the trading world's customer
const RECEIVED_ON = '2026-08-20';
const PD_WRITTEN_OFF_ON = '2026-09-15';
const LOCK_ON = '2026-09-30';
/** Each scenario builds an import end to end; the per-test default of 30 s is not enough. */
const SLOW = 120_000;

const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);
const money = (value: bigint) => toDecimalString(value, 4n);

let world: TradingWorld;
let releaser: ActorContext;
let serial = 0;

const as = <T>(ctx: ActorContext, fn: (tx: Tx) => Promise<T>) => withScope(scope(ctx), fn);

// ---------------------------------------------------------------------------
// The world: the trading fixture, the warehouses an import passes through,
// and the destination accounts a lock routes to.
// ---------------------------------------------------------------------------

/** A posting rule, as the Posting Mappings screen would write it. */
async function map(event: string, role: string, accountId: string) {
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ($1,$2,$3,true,$4) on conflict do nothing`,
    [event, role, accountId, world.manager.principal.userId],
  );
}

/** A second accounting manager — the four eyes a project's release and budget need. */
async function anotherManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Releaser')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

beforeEach(async () => {
  // The per-module destination handlers; idempotent.
  registerDepartureRuntime();
  world = await buildTradingWorld();
  // C-20 — the charges are paid out of the bank, so it holds money first.
  await fundBank(world, '100000000.0000');

  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values
       ($1,'In Process',$4,'transit',true,'in_process'),
       ($2,'Erbil Store',$4,'branch',false,null),
       ($3,'Damaged Goods',$4,'damaged_goods',false,null)`,
    [IN_PROCESS, SECOND, DAMAGED, BAGHDAD],
  );

  // The accounts the trading world does not have: the clearing the charges
  // park on, and three of the destinations a departed share can go to.
  for (const [role, parent, code, name] of [
    ['landed_cost_clearing', 'A000001', 'A980001', 'Landed Cost Clearing'],
    ['inventory_adjustment', 'X000001', 'X980001', 'Inventory Adjustments'],
    ['inventory_loss', 'X000001', 'X980002', 'Inventory Loss'],
    ['project_material_cost', 'X000001', 'X980003', 'Project Material Cost'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    world.accounts[role] = rows[0].id;
    await as(world.manager, (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
  }

  // The lock's own event: the clearing it empties, and — so that whichever
  // way the engine resolves a destination role, it lands on the account the
  // document's own posting used — each mapped destination role too. The
  // documents' own events where the trading world does not map them.
  // `inventory_loss` is deliberately NOT mapped here: scenario 7 maps it.
  await map('payables.landed_cost', 'landed_cost_clearing', world.accounts.landed_cost_clearing!);
  await map('purchasing.ap_invoice', 'landed_cost_clearing', world.accounts.landed_cost_clearing!);
  await map('payables.landed_cost', 'cogs', world.accounts.cogs!);
  await map('payables.landed_cost', 'purchase_variance', world.accounts.purchase_variance!);
  await map('payables.landed_cost', 'return_clearing', world.accounts.return_clearing!);
  await map('payables.landed_cost', 'inventory_adjustment', world.accounts.inventory_adjustment!);
  await map('inventory.stock_adjustment', 'inventory_adjustment', world.accounts.inventory_adjustment!);
  await map('payables.landed_cost', 'project_material_cost', world.accounts.project_material_cost!);
  await map('projects.material_issue', 'project_material_cost', world.accounts.project_material_cost!);

  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('landed_cost_lock','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
  releaser = await anotherManager();
});

// ---------------------------------------------------------------------------
// The import: 500 panels at 10,000 IQD on one container, received into the
// main warehouse on 20 August — one FIFO layer, 5,000,000 IQD.
// ---------------------------------------------------------------------------

interface Import {
  readonly invoiceId: string;
  readonly invoiceLineId: string;
  readonly payableId: string;
  readonly pdId: string;
  /** The layer the container receipt created in WH-MAIN. */
  readonly layerId: string;
  /** The batch the goods carry, for the movements of a batch-tracked item. */
  readonly batch: string | null;
}

async function receivedImport(): Promise<Import> {
  serial += 1;
  const made = await as(world.clerk, (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `CSA-LC01-${serial}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-08-03',
      dueDate: '2026-11-03',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q('500'),
          unitPriceIqd: iqd('10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows: invoice } = await ownerPool.query(
    `select i.payable_id, l.id as line_id from ap_invoice i join ap_invoice_line l on l.ap_invoice_id = i.id where i.id = $1`,
    [made.id],
  );
  const payableId = invoice[0].payable_id as string;
  await as(world.clerk, (tx) => ap.submit(tx, world.clerk, made.id));
  await as(world.manager, (tx) => ap.post(tx, world.manager, made.id));

  await as(world.clerk, (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: `MEDULC01${String(serial).padStart(4, '0')}`,
      blDate: '2026-08-05',
      eta: '2026-08-18',
      containers: 'MSCU1234566',
      spreadLines: true,
    }),
  );
  const { rows: containers } = await ownerPool.query(`select id from shipment_container where payable_id = $1`, [payableId]);
  for (const container of containers) {
    const { rows: lines } = await ownerPool.query(
      `select id, planned_qty from shipment_container_line where container_id = $1 and superseded_at is null`,
      [container.id],
    );
    await as(world.clerk, (tx) =>
      shipments.receive(tx, world.clerk, {
        documentId: randomUUID(),
        containerId: container.id,
        warehouseCode: WAREHOUSE,
        receiptDate: RECEIVED_ON,
        lines: lines.map((line) => ({ containerLineId: line.id, receivedQty: q(line.planned_qty), damagedQty: 0n, shortQty: 0n })),
        varianceReason: null,
      }),
    );
  }

  const pd = await as(world.clerk, (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo: `77${serial}`, registrationDate: '2026-08-04', expiryDate: '2027-02-01' }),
  );
  await as(world.clerk, (tx) => customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-08-06' }));

  const { rows: layers } = await ownerPool.query(
    `select cl.id, m.batch_number
       from cost_layer cl join inventory_movement m on m.id = cl.created_by_movement_id
      where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt'
        and cl.item_code = $1 and cl.warehouse_code = $2`,
    [PANEL, WAREHOUSE],
  );
  expect(layers).toHaveLength(1);
  return {
    invoiceId: made.id,
    invoiceLineId: invoice[0].line_id,
    payableId,
    pdId: pd.id,
    layerId: layers[0].id,
    batch: layers[0].batch_number,
  };
}

/** §20.1 condition 3 — the lock is offered once every PD is totally written off. */
const writeOffPd = (imp: Import, on = PD_WRITTEN_OFF_ON) =>
  as(world.clerk, (tx) => customs.changeStatus(tx, world.clerk, imp.pdId, { statusCode: 'totally_written_off', effectiveDate: on }));

/** A posted journal, Dr clearing / Cr bank, as an accountant would post one. */
async function clearingJournal(amount: string, on: string): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: period } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const entryNo = `JV-LC01-${(serial += 1)}`;
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Freight paid for the import','draft',$5,$5,$6) returning id`,
      [entryNo, on, period[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, world.accounts.landed_cost_clearing, amount, world.accounts.bank, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, world.manager.principal.userId],
    );
    await client.query('commit');
    return entryNo;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A charge of the import from a posted journal (§20.2). */
async function charge(imp: Import, amount: string, on = '2026-09-16', type = 'freight') {
  const entryNo = await clearingJournal(amount, on);
  return as(world.clerk, (tx) =>
    landed.addCharge(tx, world.clerk, { payableId: imp.payableId, chargeTypeCode: type, journalEntryNo: entryNo, amountIqd: iqd(amount) }),
  );
}

const lockImport = (imp: Import, input: Partial<landed.LockInput> = {}) =>
  as(world.manager, (tx) => landed.lock(tx, world.manager, { payableId: imp.payableId, lockDate: LOCK_ON, ...input }));

// ---------------------------------------------------------------------------
// The documents that take stock away, driven the way their screens drive them
// ---------------------------------------------------------------------------

interface Sale {
  readonly id: string;
  readonly invoiceNo: string;
  readonly lineId: string;
  readonly journalEntryId: string;
}

/** A direct Sales Invoice: raised by the clerk, approved and posted by the manager (who holds the CEO's approval). */
async function sell(
  quantity: string,
  options: { on: string; warehouseCode?: string; departmentCode?: string; businessLineCode?: string },
): Promise<Sale> {
  const made = await as(world.clerk, (tx) =>
    ar.createDirect(tx, world.clerk, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: options.on,
      dueDate: '2026-12-31',
      ...(options.departmentCode ? { departmentCode: options.departmentCode } : {}),
      ...(options.businessLineCode ? { businessLineCode: options.businessLineCode } : {}),
      lines: [{ itemCode: PANEL, quantity: q(quantity), unitPriceIqd: iqd('15000'), warehouseCode: options.warehouseCode ?? WAREHOUSE }],
    }),
  );
  await as(world.manager, (tx) => ar.approve(tx, world.manager, made.id));
  const posted = await as(world.manager, (tx) => ar.post(tx, world.manager, made.id));
  const { rows } = await ownerPool.query(`select id from ar_invoice_line where ar_invoice_id = $1`, [made.id]);
  return { id: made.id, invoiceNo: made.invoiceNo, lineId: rows[0].id, journalEntryId: posted.journalEntryId };
}

/** Block 9 — the customer sends goods back into WH-MAIN, saleable, and is credited. */
async function returnSale(sale: Sale, quantity: string, on: string) {
  const created = await as(world.clerk, (tx) =>
    sr.request(tx, world.clerk, {
      arInvoiceId: sale.id,
      requestedOn: on,
      reason: 'Returned by the customer',
      offsetKind: 'receivable',
      lines: [{ arInvoiceLineId: sale.lineId, quantity: q(quantity) }],
    }),
  );
  const view = await as(world.manager, (tx) => sr.view(tx, created.id));
  await as(world.manager, (tx) =>
    sr.receiveGoods(tx, world.manager, created.id, {
      receivedOn: on,
      lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: q(quantity) }],
    }),
  );
  await as(world.manager, (tx) =>
    sr.inspect(tx, world.manager, created.id, [
      { salesReturnLineId: view.lines[0]!.id, acceptedQuantity: q(quantity), disposition: 'saleable', destinationWarehouseCode: WAREHOUSE },
    ]),
  );
  await as(world.manager, (tx) => sr.acceptAndSettle(tx, world.manager, created.id));
  return created;
}

// ---------------------------------------------------------------------------
// Reading what the lock wrote
// ---------------------------------------------------------------------------

interface DepartureRow {
  readonly id: string;
  readonly kind: string;
  readonly cost_layer_id: string;
  readonly movement_id: string | null;
  readonly movement_kind: string | null;
  readonly source_document_type: string | null;
  readonly source_document_id: string | null;
  readonly source_line_id: string | null;
  readonly quantity: string;
  readonly amount_iqd: string;
  readonly destination_role: string;
  readonly account_id: string;
  readonly dimensions: Record<string, unknown>;
  readonly journal_entry_id: string;
  readonly returns_departure_id: string | null;
  readonly to_layer_id: string | null;
  readonly departed_on: string;
}

async function departuresOf(lockId: string): Promise<DepartureRow[]> {
  const { rows } = await ownerPool.query(
    `select id, kind, cost_layer_id, movement_id, movement_kind, source_document_type, source_document_id,
            source_line_id, quantity::text as quantity, amount_iqd::text as amount_iqd, destination_role,
            account_id, dimensions, journal_entry_id, returns_departure_id, to_layer_id, departed_on::text as departed_on
       from landed_cost_departure where lock_id = $1
      -- The table's columns, not the text aliases above: '80' sorts after '120' as text.
      order by kind, landed_cost_departure.quantity desc, landed_cost_departure.amount_iqd desc, source_document_id`,
    [lockId],
  );
  return rows as DepartureRow[];
}

/** The routing fields of a departure, for an exact comparison. */
const routed = (row: DepartureRow) => ({
  kind: row.kind,
  quantity: row.quantity,
  amount_iqd: row.amount_iqd,
  destination_role: row.destination_role,
  account_id: row.account_id,
  movement_kind: row.movement_kind,
  source_document_type: row.source_document_type,
  source_document_id: row.source_document_id,
  journal_entry_id: row.journal_entry_id,
});

/**
 * One dimension of a departure's `dimensions`. The contract fixes the values,
 * not the spelling of the keys: the posting engine's (`business_line`), the
 * journal column's (`business_line_code`) and camel case are all read.
 */
function dimensionOf(dims: Record<string, unknown>, name: string): unknown {
  const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const key of [name, `${name}_code`, `${camel}Code`, camel]) {
    if (key in dims) return dims[key] ?? null;
  }
  return null;
}
const saleDimensions = (dims: Record<string, unknown>) => ({
  department: dimensionOf(dims, 'department'),
  business_line: dimensionOf(dims, 'business_line'),
  business_partner: dimensionOf(dims, 'business_partner'),
  warehouse: dimensionOf(dims, 'warehouse'),
});

/** The COGS line the sale's own journal posted for its line. */
async function cogsLineOf(sale: Sale) {
  const { rows } = await ownerPool.query(
    `select account_id, department_code, business_line_code, business_partner_code, warehouse_code
       from journal_line where journal_entry_id = $1 and line_role = 'cogs' and source_line_id = $2`,
    [sale.journalEntryId, sale.lineId],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as {
    account_id: string;
    department_code: string | null;
    business_line_code: string | null;
    business_partner_code: string | null;
    warehouse_code: string | null;
  };
}

/** A lock journal's lines on one account, summed per set of dimensions. */
async function lockLinesOn(journalEntryId: string, accountId: string) {
  const { rows } = await ownerPool.query(
    `select department_code, business_line_code, business_partner_code, warehouse_code, project_code,
            sum(debit_iqd - credit_iqd)::text as net
       from journal_line where journal_entry_id = $1 and account_id = $2
      group by 1, 2, 3, 4, 5 order by sum(debit_iqd - credit_iqd) desc`,
    [journalEntryId, accountId],
  );
  return rows;
}

async function adjustmentOf(lockId: string, layerId: string) {
  const { rows } = await ownerPool.query(
    `select via_layer_id, inventory_iqd::text as inventory, unit_cost_before::text as before, unit_cost_after::text as after,
            on_hand_qty::text as on_hand
       from landed_cost_layer_adjustment where lock_id = $1 and cost_layer_id = $2`,
    [lockId, layerId],
  );
  expect(rows, `one adjustment of layer ${layerId} by lock ${lockId}`).toHaveLength(1);
  return rows[0];
}

async function layerOf(layerId: string) {
  const { rows } = await ownerPool.query(
    `select remaining_quantity::text as remaining, unit_cost_iqd::text as unit, origin_layer_id, warehouse_code
       from cost_layer where id = $1`,
    [layerId],
  );
  return rows[0] as { remaining: string; unit: string; origin_layer_id: string | null; warehouse_code: string };
}

/** The layer a movement of this document and kind created. */
async function layerCreatedBy(sourceDocumentType: string, sourceDocumentId: string, kind: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `select cl.id from cost_layer cl join inventory_movement m on m.id = cl.created_by_movement_id
      where m.source_document_type = $1 and m.source_document_id = $2 and m.kind::text = $3`,
    [sourceDocumentType, sourceDocumentId, kind],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

/** What a refused lock must have left behind: no lock, and every charge still waiting. */
async function nothingLocked(imp: Import, charges: number) {
  const { rows } = await ownerPool.query(
    `select (select count(*)::int from landed_cost_lock where payable_id = $1) as locks,
            (select count(*)::int from landed_cost_departure where payable_id = $1) as departures,
            (select count(*)::int from landed_cost_charge where payable_id = $1 and lock_id is null and cancelled_at is null) as waiting`,
    [imp.payableId],
  );
  expect(rows[0]).toEqual({ locks: 0, departures: 0, waiting: charges });
}

// ===========================================================================
describe('1 · sold before the lock: what stayed is restated, what was sold is cost of sales with the sale\'s dimensions', () => {
  it('500 received, 200 sold on two invoices, 300 left: 300/500 into stock, 200/500 to COGS', async () => {
    const imp = await receivedImport();
    // One sale attributed (department, business line), one not.
    const attributed = await sell('120', { on: '2026-09-01', departmentCode: 'FIN', businessLineCode: 'CONTRACTING' });
    const plain = await sell('80', { on: '2026-09-02' });
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp, { basisCode: 'by_value' });
    // 100,000 over 500 is 200 a panel: 300 still here take 60,000, the 200 sold 40,000.
    expect([done.sequence, done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual([
      1,
      '100000.0000',
      '60000.0000',
      '40000.0000',
    ]);
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '300.000000', unit: '10200.0000' });
    expect(await adjustmentOf(done.id, imp.layerId)).toMatchObject({
      via_layer_id: null,
      inventory: '60000.0000',
      before: '10000.0000',
      after: '10200.0000',
      on_hand: '300.000000',
    });

    // One departure per sale, at its own quantity, to cost of sales.
    const rows = await departuresOf(done.id);
    expect(rows.map(routed)).toEqual([
      {
        kind: 'departure',
        quantity: '120.000000',
        amount_iqd: '24000.0000',
        destination_role: 'cogs',
        account_id: world.accounts.cogs,
        movement_kind: 'delivery',
        source_document_type: 'ar_invoice',
        source_document_id: attributed.id,
        journal_entry_id: done.journalEntryId,
      },
      {
        kind: 'departure',
        quantity: '80.000000',
        amount_iqd: '16000.0000',
        destination_role: 'cogs',
        account_id: world.accounts.cogs,
        movement_kind: 'delivery',
        source_document_type: 'ar_invoice',
        source_document_id: plain.id,
        journal_entry_id: done.journalEntryId,
      },
    ]);
    expect(rows.map((row) => [row.source_line_id, row.cost_layer_id])).toEqual([
      [attributed.lineId, imp.layerId],
      [plain.lineId, imp.layerId],
    ]);

    // The account and the dimensions are the ones the sale's own COGS line carried.
    for (const [sale, row] of [
      [attributed, rows[0]!],
      [plain, rows[1]!],
    ] as const) {
      const cogs = await cogsLineOf(sale);
      expect(row.account_id).toBe(cogs.account_id);
      expect(saleDimensions(row.dimensions)).toEqual({
        department: cogs.department_code,
        business_line: cogs.business_line_code,
        business_partner: cogs.business_partner_code,
        warehouse: cogs.warehouse_code,
      });
    }
    expect(saleDimensions(rows[0]!.dimensions)).toEqual({
      department: 'FIN',
      business_line: 'CONTRACTING',
      business_partner: CUSTOMER,
      warehouse: WAREHOUSE,
    });

    // …and the lock's journal posts each share under the sale's dimensions.
    const plainCogs = await cogsLineOf(plain);
    expect(await lockLinesOn(done.journalEntryId, world.accounts.cogs!)).toEqual([
      {
        department_code: 'FIN',
        business_line_code: 'CONTRACTING',
        business_partner_code: CUSTOMER,
        warehouse_code: WAREHOUSE,
        project_code: null,
        net: '24000.0000',
      },
      {
        department_code: plainCogs.department_code,
        business_line_code: plainCogs.business_line_code,
        business_partner_code: CUSTOMER,
        warehouse_code: WAREHOUSE,
        project_code: null,
        net: '16000.0000',
      },
    ]);

    // The service reads the same rows.
    const listed = await as(world.manager, (tx) => landed.departuresFor(tx, imp.payableId));
    expect(listed.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '60000.0000',
      departedIqd: '40000.0000',
    });
    // 5,000,000 bought − 2,000,000 sold + 60,000 restated = 300 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '3060000.0000', glIqd: '3060000.0000' });
  }, SLOW);

  it('an amount that does not divide evenly still lands whole: every fils is in stock, a departure or a rounding row', async () => {
    const imp = await receivedImport();
    const sales = [
      await sell('67', { on: '2026-09-01' }),
      await sell('71', { on: '2026-09-02' }),
      await sell('62', { on: '2026-09-03' }),
    ];
    await writeOffPd(imp);
    await charge(imp, '99999.99');

    const done = await lockImport(imp);
    // The domain's own restatement: 300 of 500 left; the unit cost rounds to
    // 10,200.0000, so stock takes 60,000.0000 and 39,999.9900 left with the sales.
    const expected = restate({ originalQuantity: q('500'), remainingQuantity: q('300'), unitCost: iqd('10000') }, iqd('99999.99'));
    expect([money(expected.inventoryIqd), money(expected.goneIqd)]).toEqual(['60000.0000', '39999.9900']);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['60000.0000', '39999.9900']);

    const rows = await departuresOf(done.id);
    const departures = rows.filter((row) => row.kind === 'departure');
    expect(departures.map((row) => [row.source_document_id, row.quantity]).sort()).toEqual(
      [
        [sales[0]!.id, '67.000000'],
        [sales[1]!.id, '71.000000'],
        [sales[2]!.id, '62.000000'],
      ].sort(),
    );
    expect(rows.every((row) => row.kind === 'departure' || row.kind === 'rounding')).toBe(true);
    // Each share is its pro-rata part of 39,999.99 to within a fils per
    // departure; whatever is left over is a rounding row of fils, not dinars.
    const gone = expected.goneIqd;
    const sold = q('200');
    const tolerance = BigInt(departures.length);
    for (const row of departures) {
      const exact = gone * q(row.quantity); // × sold, to stay in integers
      const given = iqd(row.amount_iqd) * sold;
      const off = given > exact ? given - exact : exact - given;
      expect(off <= tolerance * sold, `${row.source_document_id}: ${row.amount_iqd}`).toBe(true);
      expect(row.destination_role).toBe('cogs');
    }
    for (const row of rows.filter((r) => r.kind === 'rounding')) {
      expect([row.movement_id, row.quantity]).toEqual([null, '0.000000']);
      expect(iqd(row.amount_iqd) <= tolerance).toBe(true);
    }

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '99999.9900',
      inventoryIqd: '60000.0000',
      departedIqd: '39999.9900',
    });
    await assertLayersMatchGl([PANEL]);
  }, SLOW);
});

// ===========================================================================
describe('2 · three locks on the same layer: the unit-cost chain, each lock balanced', () => {
  it('10,000 → 10,200 → 10,300 → 10,350, and every later lock sends the sold share after the same sales', async () => {
    const imp = await receivedImport();
    const first = await sell('200', { on: '2026-09-01' });
    await writeOffPd(imp);

    await charge(imp, '100000', '2026-09-16');
    const one = await lockImport(imp, { basisCode: 'by_value', lockDate: '2026-09-20' });
    await charge(imp, '50000', '2026-09-21');
    const two = await lockImport(imp, { basisCode: 'by_quantity', lockDate: '2026-09-25' });
    // A sale between the second and the third lock goes out at 10,300.
    const second = await sell('100', { on: '2026-09-27' });
    expect((await cogsLineOf(second)).account_id).toBe(world.accounts.cogs);
    const { rows: secondCogs } = await ownerPool.query(
      `select debit_iqd::text as debit from journal_line where journal_entry_id = $1 and line_role = 'cogs'`,
      [second.journalEntryId],
    );
    expect(secondCogs).toEqual([{ debit: '1030000.0000' }]);
    await charge(imp, '25000', '2026-09-28');
    const three = await lockImport(imp, { lockDate: '2026-09-30' });

    expect(
      [one, two, three].map((lock) => [lock.sequence, lock.totalIqd, lock.inventoryIqd, lock.cogsIqd]),
    ).toEqual([
      [1, '100000.0000', '60000.0000', '40000.0000'],
      [2, '50000.0000', '30000.0000', '20000.0000'],
      [3, '25000.0000', '10000.0000', '15000.0000'],
    ]);

    // The chain, kept: each lock records the unit cost it found and left.
    const { rows: chain } = await ownerPool.query(
      `select k.sequence, a.unit_cost_before::text as before, a.unit_cost_after::text as after,
              a.inventory_iqd::text as inventory, a.on_hand_qty::text as on_hand, a.via_layer_id
         from landed_cost_layer_adjustment a join landed_cost_lock k on k.id = a.lock_id
        where a.cost_layer_id = $1 order by k.sequence`,
      [imp.layerId],
    );
    expect(chain).toEqual([
      { sequence: 1, before: '10000.0000', after: '10200.0000', inventory: '60000.0000', on_hand: '300.000000', via_layer_id: null },
      { sequence: 2, before: '10200.0000', after: '10300.0000', inventory: '30000.0000', on_hand: '300.000000', via_layer_id: null },
      { sequence: 3, before: '10300.0000', after: '10350.0000', inventory: '10000.0000', on_hand: '200.000000', via_layer_id: null },
    ]);
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '200.000000', unit: '10350.0000' });

    // The first sale gets a share from every lock; the second only from the third.
    const shares = async (lockId: string) =>
      (await departuresOf(lockId)).map((row) => [row.kind, row.source_document_id, row.quantity, row.amount_iqd, row.destination_role]);
    expect(await shares(one.id)).toEqual([['departure', first.id, '200.000000', '40000.0000', 'cogs']]);
    expect(await shares(two.id)).toEqual([['departure', first.id, '200.000000', '20000.0000', 'cogs']]);
    expect(await shares(three.id)).toEqual([
      ['departure', first.id, '200.000000', '10000.0000', 'cogs'],
      ['departure', second.id, '100.000000', '5000.0000', 'cogs'],
    ]);

    for (const lock of [one, two, three]) await assertLockBalanced(lock.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '175000.0000',
      inventoryIqd: '100000.0000',
      departedIqd: '75000.0000',
    });
    // 5,000,000 − 2,000,000 + 60,000 + 30,000 − 1,030,000 + 10,000 = 200 × 10,350.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '2070000.0000', glIqd: '2070000.0000' });
  }, SLOW);
});

// ===========================================================================
describe('3 · a sale reversed before the lock departed nothing', () => {
  it('the reversed sale gets no share; the other sale gets its own', async () => {
    const imp = await receivedImport();
    const reversed = await sell('200', { on: '2026-09-01' });
    const kept = await sell('100', { on: '2026-09-02' });
    // A reversal is dated the day it is made, so the lock that follows it is too.
    await as(world.manager, (tx) => ar.reverse(tx, world.manager, reversed.id, { reason: 'Raised against the wrong customer.' }));
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp, { lockDate: businessToday() });
    // 400 back on the layer: 80,000 into stock; the 100 kept sold, 20,000.
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['80000.0000', '20000.0000']);
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '400.000000', unit: '10200.0000' });

    const rows = await departuresOf(done.id);
    expect(rows.map((row) => [row.kind, row.source_document_id, row.quantity, row.amount_iqd, row.destination_role])).toEqual([
      ['departure', kept.id, '100.000000', '20000.0000', 'cogs'],
    ]);
    const { rows: reversedMovements } = await ownerPool.query(
      `select id from inventory_movement where source_document_type = 'ar_invoice' and source_document_id = $1`,
      [reversed.id],
    );
    expect(reversedMovements.length).toBeGreaterThanOrEqual(2); // the delivery and its reversal
    expect(rows.filter((row) => reversedMovements.some((m) => m.id === row.movement_id))).toEqual([]);

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '80000.0000',
      departedIqd: '20000.0000',
    });
    // 5,000,000 − 2,000,000 − 1,000,000 + 2,000,000 back + 80,000 = 400 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4080000.0000', glIqd: '4080000.0000' });
  }, SLOW);
});

// ===========================================================================
describe('4 · a sales return before the lock: the returned units carry their share back into stock', () => {
  it('200 sold, 50 returned: 150 to COGS, the 50 restated on the return layer', async () => {
    const imp = await receivedImport();
    const sale = await sell('200', { on: '2026-09-01', departmentCode: 'FIN' });
    const back = await returnSale(sale, '50', '2026-09-05');
    const returnLayer = await layerCreatedBy('sales_return', back.id, 'sales_return');
    expect(await layerOf(returnLayer)).toMatchObject({ remaining: '50.000000', unit: '10000.0000' });
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp);
    // 300 on the receipt layer take 60,000, the 50 back on the shelf 10,000;
    // the 150 the customer kept 30,000.
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['70000.0000', '30000.0000']);

    const rows = await departuresOf(done.id);
    expect(rows.map((row) => [row.kind, row.source_document_id, row.quantity, row.amount_iqd, row.destination_role])).toEqual([
      ['departure', sale.id, '150.000000', '30000.0000', 'cogs'],
    ]);
    expect(dimensionOf(rows[0]!.dimensions, 'department')).toBe('FIN');

    expect(await adjustmentOf(done.id, returnLayer)).toMatchObject({
      via_layer_id: imp.layerId,
      inventory: '10000.0000',
      before: '10000.0000',
      after: '10200.0000',
    });
    expect(await layerOf(returnLayer)).toMatchObject({ remaining: '50.000000', unit: '10200.0000' });
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '300.000000', unit: '10200.0000' });

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '70000.0000',
      departedIqd: '30000.0000',
    });
    // 5,000,000 − 2,000,000 + 500,000 back + 70,000 = 350 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '3570000.0000', glIqd: '3570000.0000' });
  }, SLOW);
});

// ===========================================================================
describe('5 · a project material issue: the share is the project\'s cost, not cost of sales', () => {
  /** An active project, one element, a Materials budget of 1,010,000. */
  async function activeProject(typeCode: 'INTERNAL' | 'INVESTMENT' = 'INTERNAL') {
    const { projectCode } = await as(world.manager, (tx) =>
      ps.createDefinition(tx, world.manager, {
        name: 'Solar farm site works',
        typeCode,
        code: typeCode === 'INTERNAL' ? 'SITE-26' : 'FARM-26',
        branchCode: BAGHDAD,
        managerUserId: world.manager.principal.userId,
        baselineStartsOn: '2026-08-01',
        baselineEndsOn: '2027-03-31',
      }),
    );
    const civil = (await as(world.manager, (tx) => ps.addElement(tx, world.manager, projectCode, { parentCode: `${projectCode}-1`, name: 'Panel installation' }))).code;
    await as(releaser, (tx) => ps.release(tx, releaser, projectCode));
    const doc = await as(world.manager, (tx) =>
      pb.createBudgetDocument(tx, world.manager, projectCode, {
        kind: 'original',
        description: 'Tender',
        lines: [{ wbsCode: civil, costCode: 'MAT', amountIqd: '1010000' }],
      }),
    );
    await as(world.manager, (tx) => pb.submitBudgetDocument(tx, world.manager, doc.documentNo));
    await as(releaser, (tx) => pb.approveBudgetDocument(tx, releaser, doc.documentNo));
    return { projectCode, civil };
  }
  const elementOf = async (projectCode: string, code: string) =>
    (await as(world.manager, (tx) => ps.tree(tx, projectCode))).find((element) => element.code === code)!;

  /** 100 panels of the import to the element on 10 September, posted. */
  async function issuePanels(imp: Import, projectCode: string, civil: string, quantity = '100') {
    const issue = await as(world.clerk, (tx) =>
      pe.createIssue(tx, world.clerk, {
        projectCode,
        wbsCode: civil,
        costCode: 'MAT',
        warehouseCode: WAREHOUSE,
        movementDate: '2026-09-10',
        description: 'Panels to site',
        lines: [{ itemCode: PANEL, quantity, batchNumber: imp.batch }],
        documentId: randomUUID(),
      }),
    );
    await as(world.manager, (tx) => pe.postIssue(tx, world.manager, issue.documentNo));
    const { rows } = await ownerPool.query(
      `select l.id, l.movement_id from project_material_issue_line l join project_material_issue d on d.id = l.issue_id where d.document_no = $1`,
      [issue.documentNo],
    );
    return { documentNo: issue.documentNo, lineId: rows[0].id as string, movementId: rows[0].movement_id as string };
  }

  const projectBalance = async (accountId: string, projectCode: string) =>
    (
      await ownerPool.query(
        `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as net from journal_line l join journal_entry e on e.id = l.journal_entry_id
          where e.status in ('posted', 'reversed') and l.account_id = $1 and l.project_code = $2`,
        [accountId, projectCode],
      )
    ).rows[0].net as string;

  it('100 issued: 20,000 to project_material_cost with the project dimension, and a project cost row past the budget', async () => {
    const imp = await receivedImport();
    const { projectCode, civil } = await activeProject();
    const issue = await as(world.clerk, (tx) =>
      pe.createIssue(tx, world.clerk, {
        projectCode,
        wbsCode: civil,
        costCode: 'MAT',
        warehouseCode: WAREHOUSE,
        movementDate: '2026-09-10',
        description: 'Panels to site',
        lines: [{ itemCode: PANEL, quantity: '100', batchNumber: imp.batch }],
        documentId: randomUUID(),
      }),
    );
    await as(world.manager, (tx) => pe.postIssue(tx, world.manager, issue.documentNo));
    // 1,000,000 of a 1,010,000 budget: under the stop line.
    expect((await elementOf(projectCode, civil)).actualIqd).toBe('1000000.0000');
    const { rows: issueCost } = await ownerPool.query(
      `select l.account_id, l.project_code from journal_line l
         join project_material_issue d on d.journal_entry_id = l.journal_entry_id
        where d.document_no = $1 and l.line_role = 'project_material_cost'`,
      [issue.documentNo],
    );
    expect(issueCost).toEqual([{ account_id: world.accounts.project_material_cost, project_code: projectCode }]);
    const { rows: costsBefore } = await ownerPool.query(`select id from project_cost where project_code = $1`, [projectCode]);

    await writeOffPd(imp);
    await charge(imp, '100000');
    const done = await lockImport(imp);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['80000.0000', '20000.0000']);

    const rows = await departuresOf(done.id);
    expect(rows.map(routed)).toEqual([
      {
        kind: 'departure',
        quantity: '100.000000',
        amount_iqd: '20000.0000',
        destination_role: 'project_material_cost',
        account_id: issueCost[0].account_id,
        movement_kind: 'project_issue',
        source_document_type: expect.any(String),
        source_document_id: expect.any(String),
        journal_entry_id: done.journalEntryId,
      },
    ]);
    expect(dimensionOf(rows[0]!.dimensions, 'project')).toBe(projectCode);
    const onCost = await lockLinesOn(done.journalEntryId, world.accounts.project_material_cost!);
    expect(onCost.map((line) => [line.project_code, line.net])).toEqual([[projectCode, '20000.0000']]);

    // The project's analysis hears of it: one new cost row on the element,
    // and the element's actual rises past its budget — no stop for cost that
    // was already spent.
    const { rows: costsAfter } = await ownerPool.query(
      `select project_code, wbs_code, cost_code, amount_iqd::text as amount from project_cost
        where project_code = $1 and not (id = any($2::uuid[]))`,
      [projectCode, costsBefore.map((row) => row.id)],
    );
    expect(costsAfter).toEqual([{ project_code: projectCode, wbs_code: civil, cost_code: 'MAT', amount: '20000.0000' }]);
    expect((await elementOf(projectCode, civil)).actualIqd).toBe('1020000.0000');

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '80000.0000',
      departedIqd: '20000.0000',
    });
    // 5,000,000 − 1,000,000 issued + 80,000 = 400 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4080000.0000', glIqd: '4080000.0000' });
  }, SLOW);

  it('a settled investment project: the share reaches the same receiver, flagged post-settlement, and a supplement carries it to the asset — the project is not reopened', async () => {
    const imp = await receivedImport();
    const { projectCode, civil } = await activeProject('INVESTMENT');
    // The asset under construction the settlement capitalises to.
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'A000001'`);
    const { rows: auc } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ('A980004','Assets Under Construction',$1,$2,false,true,'approved',1,'IQD') returning id`,
      [parents[0].account_type, parents[0].id],
    );
    await as(world.manager, (tx) => coa.setRequiredDimensions(tx, world.manager, auc[0].id, []));
    await map('projects.settlement', 'project_auc', auc[0].id);

    const issue = await issuePanels(imp, projectCode, civil);
    // Technically complete, settled on 20 September by two people, closed.
    await as(world.manager, (tx) => ps.technicalComplete(tx, world.manager, projectCode));
    const { settlementNo } = await as(releaser, (tx) => closing.createSettlement(tx, releaser, projectCode, { settledOn: '2026-09-20' }));
    await as(world.manager, (tx) => closing.postSettlement(tx, world.manager, settlementNo));
    await as(world.manager, (tx) => ps.close(tx, world.manager, projectCode, 'capitalised'));
    expect(await projectBalance(auc[0].id, projectCode)).toBe('1000000.0000');
    expect(await projectBalance(world.accounts.project_material_cost!, projectCode)).toBe('0.0000');
    const { rows: settlement } = await ownerPool.query(`select id from project_settlement where settlement_no = $1`, [settlementNo]);

    await writeOffPd(imp);
    await charge(imp, '100000');
    const done = await lockImport(imp);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['80000.0000', '20000.0000']);

    // The departure: the issue's receiver, flagged post-settlement.
    const { rows } = await ownerPool.query(
      `select id, destination_role, amount_iqd::text as amount, post_settlement, dimensions from landed_cost_departure where lock_id = $1 and kind = 'departure'`,
      [done.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ destination_role: 'project_material_cost', amount: '20000.0000', post_settlement: true });
    expect(dimensionOf(rows[0].dimensions, 'project')).toBe(projectCode);

    // The supplement: linked to the settlement, the issue line and the departure;
    // its own journal to the asset. The project's cost rows stay as the
    // settlement left them (the database refuses a row on a closed project).
    const { rows: supplements } = await ownerPool.query(
      `select s.settlement_id, s.lock_id, s.departure_id, s.material_issue_line_id, s.cost_id, s.amount_iqd::text as amount,
              s.posted_on::text as on, s.journal_entry_id
         from project_settlement_supplement s where s.project_code = $1`,
      [projectCode],
    );
    expect(supplements).toHaveLength(1);
    expect(supplements[0]).toMatchObject({
      settlement_id: settlement[0].id,
      lock_id: done.id,
      departure_id: rows[0].id,
      material_issue_line_id: issue.lineId,
      cost_id: null,
      amount: '20000.0000',
      on: LOCK_ON,
    });
    const { rows: landedCosts } = await ownerPool.query(`select count(*)::int as n from project_cost where project_code = $1 and kind = 'landed_cost_adjustment'`, [projectCode]);
    expect(landedCosts[0].n).toBe(0);
    expect(supplements[0].journal_entry_id).not.toBeNull();
    const { rows: supplementJournal } = await ownerPool.query(
      `select e.posting_date::text as on, e.status::text as status, l.line_role, l.debit_iqd::text as dr, l.credit_iqd::text as cr, l.project_code
         from journal_entry e join journal_line l on l.journal_entry_id = e.id where e.id = $1 order by l.line_no`,
      [supplements[0].journal_entry_id],
    );
    expect(supplementJournal).toEqual([
      { on: LOCK_ON, status: 'posted', line_role: 'project_auc', dr: '20000.0000', cr: '0.0000', project_code: projectCode },
      { on: LOCK_ON, status: 'posted', line_role: 'project_cost', dr: '0.0000', cr: '20000.0000', project_code: projectCode },
    ]);
    // The asset carries the landed cost; the cost account nets to nothing; the project stays closed and wholly settled.
    expect(await projectBalance(auc[0].id, projectCode)).toBe('1020000.0000');
    expect(await projectBalance(world.accounts.project_material_cost!, projectCode)).toBe('0.0000');
    const { rows: state } = await ownerPool.query(
      `select p.status::text as status, (select count(*)::int from project_cost where project_code = p.code and settlement_id is null) as unsettled,
              (select count(*)::int from project_settlement where project_code = p.code and status = 'posted') as settlements
         from project p where p.code = $1`,
      [projectCode],
    );
    expect(state[0]).toEqual({ status: 'closed', unsettled: 0, settlements: 1 });

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({ chargesIqd: '100000.0000', inventoryIqd: '80000.0000', departedIqd: '20000.0000' });
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4080000.0000', glIqd: '4080000.0000' });
  }, SLOW);

  it('material returned after the lock, naming the issue line: the return layer at the restated cost, the share back from the project, never more than issued', async () => {
    const imp = await receivedImport();
    const { projectCode, civil } = await activeProject();
    const issue = await issuePanels(imp, projectCode, civil);
    await writeOffPd(imp);
    await charge(imp, '100000');
    const done = await lockImport(imp);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['80000.0000', '20000.0000']);
    expect((await elementOf(projectCode, civil)).actualIqd).toBe('1020000.0000');
    const departure = (await departuresOf(done.id)).find((row) => row.kind === 'departure')!;

    // 40 of the 100 come back, naming the issue line; the unit cost defaults to what they went out at.
    const today = businessToday();
    const back = await as(world.clerk, (tx) =>
      pe.createIssue(tx, world.clerk, {
        projectCode,
        wbsCode: civil,
        costCode: 'MAT',
        warehouseCode: WAREHOUSE,
        kind: 'return',
        movementDate: today,
        lines: [{ itemCode: PANEL, quantity: '40', batchNumber: imp.batch, returnsLineId: issue.lineId }],
        documentId: randomUUID(),
      }),
    );
    await as(world.manager, (tx) => pe.postIssue(tx, world.manager, back.documentNo));
    const { rows: returnLine } = await ownerPool.query(
      `select l.unit_cost_iqd::text as unit, l.returns_issue_line_id, l.movement_id from project_material_issue_line l
         join project_material_issue d on d.id = l.issue_id where d.document_no = $1`,
      [back.documentNo],
    );
    expect(returnLine[0]).toMatchObject({ unit: '10000.0000', returns_issue_line_id: issue.lineId });
    const returnLayer = await layerCreatedBy('project', projectCode, 'project_return');
    expect(await layerOf(returnLayer)).toMatchObject({ remaining: '40.000000', unit: '10200.0000' });

    const returned = (await departuresOf(done.id)).filter((row) => row.kind === 'return');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({
      quantity: '-40.000000',
      amount_iqd: '-8000.0000',
      destination_role: 'project_material_cost',
      account_id: departure.account_id,
      returns_departure_id: departure.id,
      to_layer_id: returnLayer,
      movement_id: returnLine[0].movement_id,
      movement_kind: 'project_return',
      departed_on: today,
    });
    // Its journal credits the project; the project's own analysis hears of it.
    expect(await lockLinesOn(returned[0]!.journal_entry_id, world.accounts.project_material_cost!)).toEqual([
      expect.objectContaining({ project_code: projectCode, net: '-8000.0000' }),
    ]);
    const { rows: costs } = await ownerPool.query(
      `select kind, amount_iqd::text as amount, source_type from project_cost where project_code = $1 and kind = 'landed_cost_adjustment' order by created_at`,
      [projectCode],
    );
    expect(costs).toEqual([
      { kind: 'landed_cost_adjustment', amount: '20000.0000', source_type: 'landed_cost_lock' },
      { kind: 'landed_cost_adjustment', amount: '-8000.0000', source_type: 'landed_cost_return' },
    ]);
    // 1,020,000 − 400,000 returned − 8,000 of its landed cost.
    expect((await elementOf(projectCode, civil)).actualIqd).toBe('612000.0000');

    // 60 are left on the issue line; 61 is refused before anything is written.
    expect(
      await rejection(
        as(world.clerk, (tx) =>
          pe.createIssue(tx, world.clerk, {
            projectCode,
            wbsCode: civil,
            costCode: 'MAT',
            warehouseCode: WAREHOUSE,
            kind: 'return',
            movementDate: today,
            lines: [{ itemCode: PANEL, quantity: '61', batchNumber: imp.batch, returnsLineId: issue.lineId }],
          }),
        ),
      ),
    ).toMatch(/has 60 of/);

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({ chargesIqd: '100000.0000', inventoryIqd: '80000.0000', departedIqd: '20000.0000' });
    // 400 × 10,200 + 40 × 10,200 = 4,488,000.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4488000.0000', glIqd: '4488000.0000' });
  }, SLOW);
});

// ===========================================================================
describe('6 · a transfer: the share follows the stock; a transfer still in transit stops the lock', () => {
  it('100 moved to Erbil, 30 of them sold there: 80,000 here, 14,000 there, 6,000 to COGS from Erbil', async () => {
    const imp = await receivedImport();
    const moved = await as(world.clerk, (tx) =>
      stock.transfer(tx, world.clerk, {
        itemCode: PANEL,
        fromWarehouseCode: WAREHOUSE,
        toWarehouseCode: SECOND,
        quantity: q('100'),
        transferDate: '2026-09-05',
      }),
    );
    const there = await layerCreatedBy('stock_transfer', moved.id, 'transfer_receipt');
    // The relocation names the layer its stock came from.
    expect(await layerOf(there)).toMatchObject({ origin_layer_id: imp.layerId, remaining: '100.000000', unit: '10000.0000' });
    const sale = await sell('30', { on: '2026-09-08', warehouseCode: SECOND, departmentCode: 'FIN', businessLineCode: 'CONTRACTING' });
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp, { basisCode: 'by_quantity' });
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['94000.0000', '6000.0000']);

    // The transfer departed nothing: only the sale out of Erbil has a row.
    const rows = await departuresOf(done.id);
    expect(rows.map(routed)).toEqual([
      {
        kind: 'departure',
        quantity: '30.000000',
        amount_iqd: '6000.0000',
        destination_role: 'cogs',
        account_id: world.accounts.cogs,
        movement_kind: 'delivery',
        source_document_type: 'ar_invoice',
        source_document_id: sale.id,
        journal_entry_id: done.journalEntryId,
      },
    ]);
    expect(saleDimensions(rows[0]!.dimensions)).toEqual({
      department: 'FIN',
      business_line: 'CONTRACTING',
      business_partner: CUSTOMER,
      warehouse: SECOND,
    });

    // 20,000 went with the hundred; 14,000 of it stays on the seventy left in Erbil.
    expect(await adjustmentOf(done.id, imp.layerId)).toMatchObject({ via_layer_id: null, inventory: '80000.0000', after: '10200.0000' });
    expect(await adjustmentOf(done.id, there)).toMatchObject({
      via_layer_id: imp.layerId,
      inventory: '14000.0000',
      before: '10000.0000',
      after: '10200.0000',
      on_hand: '70.000000',
    });
    expect(await layerOf(there)).toMatchObject({ remaining: '70.000000', unit: '10200.0000' });

    // Dr inventory in each warehouse it stands in.
    const { rows: stockLines } = await ownerPool.query(
      `select warehouse_code, sum(debit_iqd - credit_iqd)::text as net from journal_line
        where journal_entry_id = $1 and line_role = 'inventory' group by 1 order by 1`,
      [done.journalEntryId],
    );
    expect(stockLines).toEqual(
      [
        { warehouse_code: WAREHOUSE, net: '80000.0000' },
        { warehouse_code: SECOND, net: '14000.0000' },
      ].sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code)),
    );

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '94000.0000',
      departedIqd: '6000.0000',
    });
    // 5,000,000 − 300,000 sold in Erbil + 94,000 = 470 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4794000.0000', glIqd: '4794000.0000' });
  }, SLOW);

  it('a warehouse transfer issued and not yet received: the lock is refused, naming the transfer', async () => {
    const imp = await receivedImport();
    const requested = await as(world.clerk, (tx) =>
      transfers.request(tx, world.clerk, {
        sourceWarehouseCode: WAREHOUSE,
        destinationWarehouseCode: SECOND,
        branchCode: BAGHDAD,
        requestedOn: '2026-09-05',
        lines: [{ itemCode: PANEL, quantity: q('40'), batchNumber: imp.batch }],
      }),
    );
    await as(world.manager, (tx) => transfers.approve(tx, world.manager, requested.id));
    await as(world.manager, (tx) => transfers.issue(tx, world.manager, requested.id, { issuedOn: '2026-09-06' }));
    await writeOffPd(imp);
    await charge(imp, '100000');
    const before = await layersAndGl([PANEL]);

    const message = await rejection(lockImport(imp));
    expect(message).toContain(requested.transferNo);
    await nothingLocked(imp, 1);
    // Nothing moved in the layers or the ledger.
    await assertLayersMatchGl([PANEL], before);
  }, SLOW);

  it('…and once received, the two-step transfer is followed like any other', async () => {
    const imp = await receivedImport();
    const requested = await as(world.clerk, (tx) =>
      transfers.request(tx, world.clerk, {
        sourceWarehouseCode: WAREHOUSE,
        destinationWarehouseCode: SECOND,
        branchCode: BAGHDAD,
        requestedOn: '2026-09-05',
        lines: [{ itemCode: PANEL, quantity: q('40'), batchNumber: imp.batch }],
      }),
    );
    await as(world.manager, (tx) => transfers.approve(tx, world.manager, requested.id));
    await as(world.manager, (tx) => transfers.issue(tx, world.manager, requested.id, { issuedOn: '2026-09-06' }));
    await as(world.manager, (tx) => transfers.receive(tx, world.manager, requested.id, { receivedOn: '2026-09-07', quantities: { 1: q('40') } }));
    const there = await layerCreatedBy('warehouse_transfer', requested.id, 'transfer_receipt');
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['100000.0000', '0.0000']);
    expect(await departuresOf(done.id)).toEqual([]);
    expect(await adjustmentOf(done.id, there)).toMatchObject({ via_layer_id: imp.layerId, inventory: '8000.0000', after: '10200.0000' });
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '460.000000', unit: '10200.0000' });

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '100000.0000',
      departedIqd: '0.0000',
    });
    await assertLayersMatchGl([PANEL]);
  }, SLOW);
});

// ===========================================================================
describe('7 · a write-off: inventory loss, and refused while nobody has said which account that is', () => {
  it('refused naming inventory_loss while it is unmapped; posted there once it is', async () => {
    const imp = await receivedImport();
    // §9.8 — damaged, moved to the damaged store at cost, then written off.
    await as(world.manager, (tx) =>
      states.approveDamage(tx, world.manager, {
        itemCode: PANEL,
        fromWarehouseCode: WAREHOUSE,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: q('20'),
        movementDate: '2026-09-06',
        reason: 'Crushed by a forklift in the yard',
        batchNumber: imp.batch,
      }),
    );
    const written = await as(world.manager, (tx) =>
      states.writeOff(tx, world.manager, {
        itemCode: PANEL,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: q('20'),
        movementDate: '2026-09-07',
        reason: 'Beyond repair',
        batchNumber: imp.batch,
      }),
    );
    await writeOffPd(imp);
    await charge(imp, '100000');
    // The write-off itself posts nothing here (no `post`), so the layers and
    // the ledger already differ by its 200,000; the lock is judged on what it
    // changes.
    const before = await layersAndGl([PANEL]);

    expect(await rejection(lockImport(imp))).toMatch(/inventory_loss/);
    await nothingLocked(imp, 1);

    await map('payables.landed_cost', 'inventory_loss', world.accounts.inventory_loss!);
    await map('inventory.write_off', 'inventory_loss', world.accounts.inventory_loss!);
    const done = await lockImport(imp);
    // 480 still here take 96,000; the 20 written off 4,000 — to the loss.
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['96000.0000', '4000.0000']);

    // The write-off names no document of its own; the row names its movement
    // (and copies whatever source the movement has — `assertLockBalanced`).
    const rows = await departuresOf(done.id);
    expect(rows).toHaveLength(1);
    expect(routed(rows[0]!)).toMatchObject({
      kind: 'departure',
      quantity: '20.000000',
      amount_iqd: '4000.0000',
      destination_role: 'inventory_loss',
      account_id: world.accounts.inventory_loss,
      movement_kind: 'write_off',
      journal_entry_id: done.journalEntryId,
    });
    expect(rows[0]!.movement_id).toBe(written.movementId);
    expect((await lockLinesOn(done.journalEntryId, world.accounts.inventory_loss!)).map((line) => line.net)).toEqual(['4000.0000']);

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '96000.0000',
      departedIqd: '4000.0000',
    });
    const after = await assertLayersMatchGl([PANEL], before);
    expect(iqd(after.layersIqd) - iqd(before.layersIqd)).toBe(iqd('96000'));
  }, SLOW);
});

// ===========================================================================
describe('8 · a goods return to the supplier: purchase variance, or return clearing when the supplier pays it back', () => {
  async function returnToSupplier(imp: Import, reimburses: boolean) {
    const made = await as(world.clerk, (tx) =>
      gr.createFromInvoice(tx, world.clerk, {
        apInvoiceId: imp.invoiceId,
        returnDate: '2026-09-08',
        reason: 'Cracked glass on arrival',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: imp.invoiceLineId, quantity: q('50'), warehouseCode: WAREHOUSE }],
      }),
    );
    // Decided on the draft; frozen once the return posts.
    if (reimburses) await ownerPool.query(`update goods_return set reimburses_landed_cost = true where id = $1`, [made.id]);
    await as(world.manager, (tx) => gr.approve(tx, world.manager, made.id));
    await as(world.manager, (tx) => gr.post(tx, world.manager, made.id));
    return made;
  }

  for (const [reimburses, role] of [
    [false, 'purchase_variance'],
    [true, 'return_clearing'],
  ] as const) {
    it(`reimburses_landed_cost ${reimburses ? 'yes' : 'no'}: the 50 sent back take 10,000 to ${role}; the flag is frozen once posted`, async () => {
      const imp = await receivedImport();
      const sent = await returnToSupplier(imp, reimburses);
      const { rows: flag } = await ownerPool.query(`select status, reimburses_landed_cost from goods_return where id = $1`, [sent.id]);
      expect(flag[0]).toEqual({ status: 'posted', reimburses_landed_cost: reimburses });
      expect(
        await rejection(ownerPool.query(`update goods_return set reimburses_landed_cost = $2 where id = $1`, [sent.id, !reimburses])),
      ).toMatch(/shipped and posted|Reverse it/);

      await writeOffPd(imp);
      await charge(imp, '100000');
      const done = await lockImport(imp);
      expect([done.inventoryIqd, done.cogsIqd]).toEqual(['90000.0000', '10000.0000']);

      const rows = await departuresOf(done.id);
      expect(rows.map(routed)).toEqual([
        {
          kind: 'departure',
          quantity: '50.000000',
          amount_iqd: '10000.0000',
          destination_role: role,
          account_id: world.accounts[role],
          movement_kind: 'goods_return',
          source_document_type: 'goods_return',
          source_document_id: sent.id,
          journal_entry_id: done.journalEntryId,
        },
      ]);
      expect((await lockLinesOn(done.journalEntryId, world.accounts[role]!)).map((line) => line.net)).toEqual(['10000.0000']);

      await assertLockBalanced(done.id);
      expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
        chargesIqd: '100000.0000',
        inventoryIqd: '90000.0000',
        departedIqd: '10000.0000',
      });
      // 5,000,000 − 500,000 sent back + 90,000 = 450 × 10,200.
      expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4590000.0000', glIqd: '4590000.0000' });
    }, SLOW);
  }
});

// ===========================================================================
describe('9 · an Item Reconciliation that takes stock out: inventory adjustment', () => {
  it('25 found missing: 5,000 to inventory_adjustment, the account the reconciliation posted to', async () => {
    const imp = await receivedImport();
    const counted = await as(world.manager, (tx) =>
      stock.adjust(tx, world.manager, {
        itemCode: PANEL,
        warehouseCode: WAREHOUSE,
        direction: 'out',
        quantity: q('25'),
        adjustmentDate: '2026-09-12',
      }),
    );
    const { rows: own } = await ownerPool.query(
      `select l.account_id from journal_line l join stock_adjustment a on a.journal_entry_id = l.journal_entry_id
        where a.id = $1 and l.line_role = 'inventory_adjustment'`,
      [counted.id],
    );
    expect(own).toEqual([{ account_id: world.accounts.inventory_adjustment }]);
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp);
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['95000.0000', '5000.0000']);
    expect((await departuresOf(done.id)).map(routed)).toEqual([
      {
        kind: 'departure',
        quantity: '25.000000',
        amount_iqd: '5000.0000',
        destination_role: 'inventory_adjustment',
        account_id: world.accounts.inventory_adjustment,
        movement_kind: 'count_adjustment',
        source_document_type: 'stock_adjustment',
        source_document_id: counted.id,
        journal_entry_id: done.journalEntryId,
      },
    ]);

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '95000.0000',
      departedIqd: '5000.0000',
    });
    // 5,000,000 − 250,000 counted out + 95,000 = 475 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4845000.0000', glIqd: '4845000.0000' });
  }, SLOW);
});

// ===========================================================================
describe('10 · the lock date, and a departure no business event claims', () => {
  it('refused in the future, before the previous lock, and before the last container arrived', async () => {
    const imp = await receivedImport();
    await writeOffPd(imp);
    await charge(imp, '100000', '2026-09-16');

    const tomorrow = addBusinessDays(businessToday(), 1);
    expect(await rejection(lockImport(imp, { lockDate: tomorrow }))).toMatch(
      new RegExp(`future|after today|later than today|ahead of today|${tomorrow}`, 'i'),
    );
    // The container came in on 20 August: a lock dated the 19th spreads cost over goods not yet here.
    expect(await rejection(lockImport(imp, { lockDate: '2026-08-19' }))).toMatch(/receiv|receipt|container|arriv|2026-08-20/i);
    await nothingLocked(imp, 1);

    const first = await lockImport(imp, { lockDate: '2026-09-25' });
    await charge(imp, '50000', '2026-09-26');
    expect(await rejection(lockImport(imp, { lockDate: '2026-09-20' }))).toMatch(/2026-09-25|previous|earlier lock|last lock|prior/i);
    const { rows: locks } = await ownerPool.query(`select count(*)::int as n from landed_cost_lock where payable_id = $1`, [imp.payableId]);
    expect(locks[0].n).toBe(1);

    const second = await lockImport(imp, { lockDate: '2026-09-28' });
    expect([first.sequence, second.sequence, second.totalIqd, second.inventoryIqd]).toEqual([1, 2, '50000.0000', '50000.0000']);

    for (const lock of [first, second]) await assertLockBalanced(lock.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '150000.0000',
      inventoryIqd: '150000.0000',
      departedIqd: '0.0000',
    });
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '5150000.0000', glIqd: '5150000.0000' });
  }, SLOW);

  it('an issue of a kind no destination handler claims is refused, naming the kind', async () => {
    const imp = await receivedImport();
    // A receipt kind used as an issue: nothing in the system routes it.
    await as(world.manager, (tx) =>
      inventory.issue(tx, world.manager, {
        itemCode: PANEL,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: q('5'),
        movementDate: '2026-09-09',
        kind: 'opening_stock',
        batchNumber: imp.batch,
        sourceDocumentType: 'test',
        sourceDocumentId: 'LC01-ODD-1',
      }),
    );
    await writeOffPd(imp);
    await charge(imp, '100000');

    expect(await rejection(lockImport(imp))).toMatch(/opening_stock/);
    await nothingLocked(imp, 1);
  }, SLOW);
});

// ===========================================================================
describe('11 · a reversal is dated the day it is made, and the original keeps its own', () => {
  it('inventory.reverseMovement dates the reversal on the day asked, never before the original', async () => {
    const received = (batch: string) =>
      as(world.manager, (tx) =>
        inventory.receive(tx, world.manager, {
          itemCode: PANEL,
          warehouseCode: WAREHOUSE,
          branchCode: BAGHDAD,
          quantity: q('5'),
          unitCostIqd: iqd('1000'),
          movementDate: '2026-09-10',
          kind: 'goods_receipt',
          batchNumber: batch,
        }),
      );
    const movement = async (id: string) =>
      (
        await ownerPool.query(
          `select movement_date::text as date, kind::text as kind, quantity::text as quantity, reverses_movement_id
             from inventory_movement where id = $1`,
          [id],
        )
      ).rows[0];

    const later = await received('B-RV-1');
    const undone = await as(world.manager, (tx) =>
      inventory.reverseMovement(tx, world.manager, later.movementId, 'Entered twice.', { reversalDate: '2026-09-15' }),
    );
    expect(await movement(undone.movementId)).toEqual({ date: '2026-09-15', kind: 'reversal', quantity: '-5.000000', reverses_movement_id: later.movementId });
    expect(await movement(later.movementId)).toMatchObject({ date: '2026-09-10', kind: 'goods_receipt', quantity: '5.000000' });

    const early = await received('B-RV-2');
    const clamped = await as(world.manager, (tx) =>
      inventory.reverseMovement(tx, world.manager, early.movementId, 'Wrong item.', { reversalDate: '2026-09-01' }),
    );
    expect((await movement(clamped.movementId)).date).toBe('2026-09-10');

    const plain = await received('B-RV-3');
    const today = businessToday();
    const unasked = await as(world.manager, (tx) => inventory.reverseMovement(tx, world.manager, plain.movementId, 'Wrong warehouse.'));
    expect([today, businessToday()]).toContain((await movement(unasked.movementId)).date);
  }, SLOW);

  it('a sale in a closed month is reversed in the open one: stock and journal on the reversal day, the original row untouched', async () => {
    // Ten panels bought directly in February, four sold in February.
    const bought = await as(world.clerk, (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'SI-LC01-FEB',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-02',
        dueDate: '2026-03-02',
        lines: [
          { itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('10'), unitPriceIqd: iqd('100000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE },
        ],
      }),
    );
    await as(world.clerk, (tx) => ap.submit(tx, world.clerk, bought.id));
    await as(world.manager, (tx) => ap.post(tx, world.manager, bought.id));
    const sale = await sell('4', { on: '2026-02-10' });
    const { rows: originals } = await ownerPool.query(
      `select * from inventory_movement where source_document_type = 'ar_invoice' and source_document_id = $1 order by id`,
      [sale.id],
    );
    expect(originals.length).toBeGreaterThan(0);

    // January and February closed, in sequence, through the checklist.
    const { rows: months } = await ownerPool.query(
      `select id from fiscal_period where ends_on <= '2026-02-28' and status <> 'closed' order by starts_on`,
    );
    for (const month of months) {
      await as(world.manager, (tx) => periods.setPeriodStatus(tx, world.manager, month.id, 'closed', 'Month end'));
    }
    const { rows: closed } = await ownerPool.query(
      `select count(*)::int as n from fiscal_period where ends_on <= '2026-02-28' and status = 'closed'`,
    );
    expect(closed[0].n).toBe(2);

    const today = businessToday();
    await as(world.manager, (tx) => ar.reverse(tx, world.manager, sale.id, { reason: 'Sold to the wrong customer.' }));
    const days = [today, businessToday()];

    // The stock came back on the day it was put back…
    const { rows: reversals } = await ownerPool.query(
      `select movement_date::text as date from inventory_movement where reverses_movement_id = any($1::uuid[])`,
      [originals.map((row) => row.id)],
    );
    expect(reversals).toHaveLength(originals.length);
    for (const row of reversals) expect(days).toContain(row.date);
    // …the journal was mirrored on the same day…
    const { rows: mirrored } = await ownerPool.query(
      `select posting_date::text as date from journal_entry where reverses_id = $1`,
      [sale.journalEntryId],
    );
    expect(mirrored).toHaveLength(1);
    expect(reversals.every((row) => row.date === mirrored[0].date)).toBe(true);
    // …and February still says what happened in February.
    const { rows: after } = await ownerPool.query(
      `select * from inventory_movement where id = any($1::uuid[]) order by id`,
      [originals.map((row) => row.id)],
    );
    expect(after).toEqual(originals);
    const { rows: invoice } = await ownerPool.query(`select status from ar_invoice where id = $1`, [sale.id]);
    expect(invoice[0].status).toBe('reversed');
    const position = await as(world.manager, (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD));
    expect(position.onHand).toBe(q('10'));
    await assertLayersMatchGl([PANEL]);
  }, SLOW);
});

// ===========================================================================
describe('12 · a purchase invoice whose charge is already locked is not reversed', () => {
  it('the forwarder\'s invoice is refused with a sentence, not a constraint, and nothing changes', async () => {
    const imp = await receivedImport();
    // The forwarder's bill: its one line belongs to the import (A10).
    const forwarder = await as(world.clerk, (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'FWD-LC01-1',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-12',
        dueDate: '2026-10-12',
        nonPoJustification: 'The forwarder bills after the fact; no order exists.',
        nonPoApprovedBy: world.manager.principal.userId,
        lines: [
          {
            description: 'Ocean freight MSCU1234566',
            quantity: q('1'),
            unitPriceIqd: iqd('100000'),
            uomCode: 'EA',
            isInventory: false,
            chargedToPayableId: imp.payableId,
          },
        ],
      }),
    );
    await as(world.clerk, (tx) => ap.submit(tx, world.clerk, forwarder.id));
    const posted = await as(world.manager, (tx) => ap.post(tx, world.manager, forwarder.id));
    const { rows: charges } = await ownerPool.query(
      `select id, amount_iqd::text as amount, source_type from landed_cost_charge where payable_id = $1`,
      [imp.payableId],
    );
    expect(charges).toEqual([{ id: expect.any(String), amount: '100000.0000', source_type: 'ap_invoice_line' }]);

    await writeOffPd(imp);
    const done = await lockImport(imp);
    expect([done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual(['100000.0000', '100000.0000', '0.0000']);

    const message = await rejection(
      as(world.manager, (tx) => ap.reverse(tx, world.manager, forwarder.id, { reason: 'Billed twice.' })),
    );
    expect(message).toMatch(/lock|landed cost/i);
    expect(message).not.toMatch(/violates|constraint|duplicate key|permission denied for|syntax error/i);

    // The invoice, its journal and its locked charge stand as they were.
    const { rows: state } = await ownerPool.query(
      `select i.status, e.reversed_by_id, c.lock_id, c.cancelled_at
         from ap_invoice i join journal_entry e on e.id = i.journal_entry_id
         join landed_cost_charge c on c.id = $2
        where i.id = $1`,
      [forwarder.id, charges[0].id],
    );
    expect(state[0]).toEqual({ status: 'posted', reversed_by_id: null, lock_id: done.id, cancelled_at: null });
    expect(posted.journalEntryId).toBeTruthy();

    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({
      chargesIqd: '100000.0000',
      inventoryIqd: '100000.0000',
      departedIqd: '0.0000',
    });
    await assertLayersMatchGl([PANEL]);
  }, SLOW);
});

// ===========================================================================
describe('13 · stock that comes back after a lock brings its landed share back', () => {
  /** The journal a return of landed cost posted with a movement, and its lines on one account. */
  async function returnJournalOf(returnMovementId: string) {
    const { rows } = await ownerPool.query(
      `select e.id, e.posting_date::text as posting_date, e.status::text as status
         from journal_entry e
        where e.source_module = 'inventory' and e.source_doc_id = $1 and e.source_event = 'landed_cost_returned'`,
      [returnMovementId],
    );
    expect(rows, `one landed-cost return journal for movement ${returnMovementId}`).toHaveLength(1);
    return rows[0] as { id: string; posting_date: string; status: string };
  }

  it('a sale reversed after the lock: the share comes back from cost of sales onto the restored layer, a return row against the departure, dated the reversal', async () => {
    const imp = await receivedImport();
    const undone = await sell('200', { on: '2026-09-01', departmentCode: 'FIN', businessLineCode: 'CONTRACTING' });
    const kept = await sell('100', { on: '2026-09-02' });
    await writeOffPd(imp);
    await charge(imp, '100000');

    const done = await lockImport(imp);
    // 200 here take 40,000; the 300 sold 60,000 — 40,000 after the first sale, 20,000 after the second.
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['40000.0000', '60000.0000']);
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '200.000000', unit: '10200.0000' });
    await assertLayersMatchGl([PANEL]);

    const today = businessToday();
    await as(world.manager, (tx) => ar.reverse(tx, world.manager, undone.id, { reason: 'Raised against the wrong customer.' }));

    // The 200 are back on their layer, which carries the restated cost.
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '400.000000', unit: '10200.0000' });

    const rows = await departuresOf(done.id);
    const departure = rows.find((row) => row.kind === 'departure' && row.source_document_id === undone.id)!;
    const back = rows.filter((row) => row.kind === 'return');
    expect(back).toHaveLength(1);
    const { rows: reversal } = await ownerPool.query(
      `select r.id from inventory_movement r where r.reverses_movement_id = $1`,
      [departure.movement_id],
    );
    expect(back[0]).toMatchObject({
      quantity: '-200.000000',
      amount_iqd: '-40000.0000',
      destination_role: 'cogs',
      account_id: departure.account_id,
      dimensions: departure.dimensions,
      movement_id: reversal[0].id,
      movement_kind: 'reversal',
      source_document_type: 'ar_invoice',
      source_document_id: undone.id,
      returns_departure_id: departure.id,
      to_layer_id: imp.layerId,
      cost_layer_id: imp.layerId,
    });
    expect([today, businessToday()]).toContain(back[0]!.departed_on);
    // The one the customer kept is untouched.
    expect(rows.find((row) => row.kind === 'departure' && row.source_document_id === kept.id)).toMatchObject({ amount_iqd: '20000.0000' });

    // Its journal: Dr inventory / Cr the sale's COGS line, dated the reversal, 40,000.
    const journal = await returnJournalOf(reversal[0].id);
    expect(journal.id).toBe(back[0]!.journal_entry_id);
    expect(journal.status).toBe('posted');
    expect([today, businessToday()]).toContain(journal.posting_date);
    expect(await lockLinesOn(journal.id, world.accounts.inventory!)).toEqual([
      { department_code: null, business_line_code: null, business_partner_code: null, warehouse_code: WAREHOUSE, project_code: null, net: '40000.0000' },
    ]);
    expect(await lockLinesOn(journal.id, world.accounts.cogs!)).toEqual([
      { department_code: 'FIN', business_line_code: 'CONTRACTING', business_partner_code: CUSTOMER, warehouse_code: WAREHOUSE, project_code: null, net: '-40000.0000' },
    ]);
    // The journal reversal of the sale and the return of the share are dated the same day.
    const { rows: mirrored } = await ownerPool.query(`select posting_date::text as date from journal_entry where reverses_id = $1`, [undone.journalEntryId]);
    expect(mirrored[0].date).toBe(journal.posting_date);

    // The lock's own account is unchanged; the import still explains every dinar it locked.
    await assertLockBalanced(done.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({ chargesIqd: '100000.0000', inventoryIqd: '40000.0000', departedIqd: '60000.0000' });
    // 5,000,000 − 3,000,000 + 40,000 + 2,000,000 back + 40,000 back = 400 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '4080000.0000', glIqd: '4080000.0000' });
    // Cost of sales holds exactly the share of what stayed sold: 20,000.
    const { rows: cogs } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as net from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status in ('posted', 'reversed') and e.id in ($2, $3)`,
      [world.accounts.cogs, done.journalEntryId, journal.id],
    );
    expect(cogs[0].net).toBe('20000.0000');
  }, SLOW);

  it('a sales return after the lock: the return layer costs the restated price, the share comes back from COGS; a later lock reaches the returned units; never more than departed', async () => {
    const imp = await receivedImport();
    const sale = await sell('200', { on: '2026-09-01', departmentCode: 'FIN' });
    await writeOffPd(imp);
    await charge(imp, '100000');
    const first = await lockImport(imp);
    expect([first.inventoryIqd, first.cogsIqd]).toEqual(['60000.0000', '40000.0000']);
    const departure = (await departuresOf(first.id)).find((row) => row.kind === 'departure')!;

    // 50 of the 200 come back, after the lock.
    const today = businessToday();
    const back = await returnSale(sale, '50', today);
    const returnLayer = await layerCreatedBy('sales_return', back.id, 'sales_return');
    // The return layer holds them at the restated cost: 10,000 the sale left at + 200 the lock added.
    expect(await layerOf(returnLayer)).toMatchObject({ remaining: '50.000000', unit: '10200.0000' });
    const { rows: returnMovement } = await ownerPool.query(
      `select inventory_movement_id as id from sales_return_line where sales_return_id = $1`,
      [back.id],
    );
    const rows = await departuresOf(first.id);
    const returned = rows.filter((row) => row.kind === 'return');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({
      quantity: '-50.000000',
      amount_iqd: '-10000.0000',
      destination_role: 'cogs',
      account_id: departure.account_id,
      returns_departure_id: departure.id,
      to_layer_id: returnLayer,
      cost_layer_id: imp.layerId,
      movement_id: returnMovement[0].id,
      movement_kind: 'sales_return',
      source_document_type: 'sales_return',
      source_document_id: back.id,
      departed_on: today,
    });
    const journal = await returnJournalOf(returnMovement[0].id);
    // Credited with the dimensions the departure was posted with — the sale's.
    expect(await lockLinesOn(journal.id, world.accounts.cogs!)).toEqual([
      {
        department_code: 'FIN',
        business_line_code: dimensionOf(departure.dimensions, 'business_line'),
        business_partner_code: CUSTOMER,
        warehouse_code: WAREHOUSE,
        project_code: null,
        net: '-10000.0000',
      },
    ]);
    await assertLockBalanced(first.id);
    // 5,000,000 − 2,000,000 + 60,000 + 500,000 back + 10,000 back = 350 × 10,200.
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '3570000.0000', glIqd: '3570000.0000' });

    // The rest come back too: the departure is wholly returned, and it refuses a fils more.
    const rest = await returnSale(sale, '150', today);
    const restLayer = await layerCreatedBy('sales_return', rest.id, 'sales_return');
    expect(await layerOf(restLayer)).toMatchObject({ remaining: '150.000000', unit: '10200.0000' });
    const all = (await departuresOf(first.id)).filter((row) => row.kind === 'return');
    expect(all.map((row) => [row.quantity, row.amount_iqd]).sort()).toEqual([
      ['-150.000000', '-30000.0000'],
      ['-50.000000', '-10000.0000'],
    ]);
    await expect(
      ownerPool.query(
        `insert into landed_cost_departure
           (lock_id, payable_id, kind, cost_layer_id, movement_id, quantity, amount_iqd, destination_role, account_id,
            journal_entry_id, returns_departure_id, to_layer_id, departed_on, created_by)
         values ($1, $2, 'return', $3, $4, -1, -0.0001, 'cogs', $5, $6, $7, $8, $9, $10)`,
        [
          first.id, imp.payableId, imp.layerId, returnMovement[0].id, departure.account_id, journal.id, departure.id,
          returnLayer, today, world.manager.principal.userId,
        ],
      ),
    ).rejects.toThrow(/More of this landed cost would come back than left/);
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '5100000.0000', glIqd: '5100000.0000' });

    // A later lock (owner 4.8): the units already back are reached where they
    // stand — the two return layers — and nothing of them departs.
    await charge(imp, '50000', today);
    const second = await lockImport(imp, { lockDate: today });
    // 50,000 over 500: 300 here 30,000; the 200 returned, 5,000 and 15,000 on their layers.
    expect([second.inventoryIqd, second.cogsIqd]).toEqual(['50000.0000', '0.0000']);
    expect(await adjustmentOf(second.id, returnLayer)).toMatchObject({ via_layer_id: imp.layerId, inventory: '5000.0000', before: '10200.0000', after: '10300.0000' });
    expect(await adjustmentOf(second.id, restLayer)).toMatchObject({ via_layer_id: imp.layerId, inventory: '15000.0000', before: '10200.0000', after: '10300.0000' });
    expect(await layerOf(imp.layerId)).toMatchObject({ remaining: '300.000000', unit: '10300.0000' });
    expect((await departuresOf(second.id)).filter((row) => row.kind !== 'return')).toEqual([]);
    await assertLockBalanced(second.id);
    expect(await assertImportFullyAccounted(imp.payableId)).toEqual({ chargesIqd: '150000.0000', inventoryIqd: '110000.0000', departedIqd: '40000.0000' });
    expect(await assertLayersMatchGl([PANEL])).toMatchObject({ layersIqd: '5150000.0000', glIqd: '5150000.0000' });
  }, SLOW);
});

