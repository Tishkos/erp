/**
 * The import world the Logistics suites build on — REQ-LOG-001.
 *
 * The trading world (a supplier, a clerk, a manager, the mapped accounts)
 * plus what an import needs on its way: the In Process transit warehouse,
 * the clearing account the landed-cost lock credits, and the small helpers
 * every suite otherwise retypes — an import posted into transit, a B/L with
 * containers planned to the quantities the test names, a receipt, a charge
 * from a posted journal, a PD moved to a status. Everything goes through the
 * services; nothing is written to a document table by hand.
 *
 * The timeline runs July to September 2026 — in the past, and it must stay
 * there: a landed cost is locked on a day that has come and not before the
 * last container was received (`landed-cost.lockDateFor`), so a receipt or a
 * lock dated after today is refused, not deferred.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool } from './setup';
import { fundBank } from './hr-funds';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as customs from '@/server/services/customs-pd';
import * as landed from '@/server/services/landed-cost';
import * as shipments from '@/server/services/shipments';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

export { BAGHDAD, PANEL, WAREHOUSE, scope };
export const IN_PROCESS = 'WH-LOG-INPROC';
export const SECOND = 'WH-LOG-ERBIL';
export const iqd = (value: string) => parseDecimal(value, 4n);
export const q = (value: string) => parseQuantity(value);

export interface ImportWorld extends TradingWorld {
  /** The journal serial, so two charges never share a number. */
  serial: number;
}

/** The trading world with a transit warehouse and the landed-cost clearing mapped. */
export async function buildImportWorld(): Promise<ImportWorld> {
  const world = await buildTradingWorld();
  // C-20: charges below are paid out of the bank, so it holds money first.
  await fundBank(world, '5000000.0000');
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process'), ($3,'Erbil Store',$2,'branch',false,null)`,
    [IN_PROCESS, BAGHDAD, SECOND],
  );
  const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
  const { rows: clearing } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('A970001','Landed Cost Clearing','asset',$1,false,true,'approved',1,'IQD') returning id`,
    [parent[0].id],
  );
  world.accounts.landed_cost_clearing = clearing[0].id;
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('payables.landed_cost','landed_cost_clearing',$1,true,$2)`,
    [clearing[0].id, world.manager.principal.userId],
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('landed_cost_lock','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement='optional'`,
  );
  return { ...world, serial: 0 };
}

/** An import of `quantity` panels at 10,000 IQD, raised and (unless told not to) posted — its goods land in transit. */
export async function importOf(world: ImportWorld, quantity: string, options: { reference?: string; post?: boolean; price?: string } = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: options.reference ?? `LOG-${randomUUID().slice(0, 6)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-07-01',
      dueDate: '2026-09-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q(quantity),
          unitPriceIqd: iqd(options.price ?? '10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id, invoice_no from ap_invoice where id = $1`, [made.id]);
  if (options.post !== false) {
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
  }
  return { invoiceId: made.id, invoiceNo: rows[0].invoice_no as string, payableId: rows[0].payable_id as string };
}

/** A B/L whose containers each carry the quantity given, in the order given. */
export async function blWith(world: ImportWorld, payableId: string, containers: readonly { no: string; qty: string }[], options: { blNo?: string; eta?: string; portCode?: string | null } = {}) {
  // The B/L's table as the screen sends it: each container and what it carries of the PI's one line.
  const models = await withScope(scope(world.clerk), (tx) => shipments.modelsToShip(tx, payableId));
  const line = models.find((model) => model.itemCode === PANEL) ?? models[0]!;
  const made = await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: options.blNo ?? `MEDU${randomUUID().slice(0, 6).toUpperCase()}`,
      blDate: '2026-07-20',
      eta: options.eta ?? '2026-08-25',
      vessel: 'MSC AURORA',
      shippingLine: 'MSC',
      portOfLoading: 'Shanghai',
      portOfDischargeCode: options.portCode === undefined ? 'PRT-0001' : options.portCode,
      containerRows: containers.map((c) => ({ containerNo: c.no, sizeType: '40HC', quantities: { [line.key]: q(c.qty) } })),
    }),
  );
  const { rows } = await ownerPool.query(`select id, container_no from shipment_container where bl_id = $1 order by container_no`, [made.id]);
  const byNo = new Map((rows as { id: string; container_no: string }[]).map((row) => [row.container_no, row.id]));
  return { blId: made.id, blNo: made.blNo, containerIds: containers.map((c) => byNo.get(c.no)!) };
}

/** Receives a container whole (or `received` of its plan) into the main warehouse. */
export async function receive(world: ImportWorld, containerId: string, options: { received?: string; on?: string; warehouse?: string; reason?: string | null } = {}) {
  const { rows } = await ownerPool.query(
    `select id, planned_qty::text as planned from shipment_container_line where container_id = $1 and superseded_at is null`,
    [containerId],
  );
  const line = rows[0] as { id: string; planned: string };
  return withScope(scope(world.clerk), (tx) =>
    shipments.receive(tx, world.clerk, {
      documentId: randomUUID(),
      containerId,
      warehouseCode: options.warehouse ?? WAREHOUSE,
      receiptDate: options.on ?? '2026-08-28',
      lines: [{ containerLineId: line.id, receivedQty: q(options.received ?? line.planned), damagedQty: 0n, ...(options.received ? {} : { shortQty: 0n }) }],
      varianceReason: options.reason ?? null,
    }),
  );
}

/** A posted journal, as an accountant would post one: Dr `debit` Cr `credit`. */
export async function journal(world: ImportWorld, debit: string, credit: string, amount: string, on = '2026-08-20') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const entryNo = `JV-LOG-${(world.serial += 1)}`;
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Manual journal','draft',$5,$5,$6) returning id`,
      [entryNo, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, debit, amount, credit, BAGHDAD],
    );
    await client.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, world.manager.principal.userId]);
    await client.query('commit');
    return entryNo;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** A charge on the import from a posted journal that parked the cost on the clearing account. */
export async function charge(world: ImportWorld, payableId: string, type: string, amount: string, reason: string | null = null) {
  const entryNo = await journal(world, world.accounts.landed_cost_clearing!, world.accounts.bank!, amount);
  return withScope(scope(world.clerk), (tx) =>
    landed.addCharge(tx, world.clerk, { payableId, chargeTypeCode: type, journalEntryNo: entryNo, amountIqd: iqd(amount), reason }),
  );
}

export async function registerPd(world: ImportWorld, payableId: string, pdNo: string) {
  return withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo, registrationDate: '2026-07-02', expiryDate: '2027-03-01' }),
  );
}

export const pdTo = (world: ImportWorld, pdId: string, statusCode: string, on: string) =>
  withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pdId, { statusCode, effectiveDate: on }));

export const lock = (world: ImportWorld, payableId: string, input: Partial<landed.LockInput> = {}) =>
  withScope(scope(world.manager), (tx) => landed.lock(tx, world.manager, { payableId, lockDate: '2026-08-30', ...input }));

/** The ledger's balance of PANEL in one warehouse — `stock_position.held` (0287), which for a transit warehouse means in transit, never on hand. */
export const ledgerBalance = async (warehouseCode: string) =>
  (await ownerPool.query(`select coalesce(sum(held), 0)::numeric(24,6)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, warehouseCode])).rows[0].n as string;
