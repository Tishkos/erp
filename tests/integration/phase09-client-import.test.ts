/**
 * Phase 09.10 test gate — Client-funded import and Client Inventory,
 * §12.4 and §11.3.
 *
 * §11.3, in terms:
 *   - *"Goods imported for a client do not enter company warehouses"*
 *   - *"Goods remain in a financial intermediary account, Client Inventory,
 *      until delivery to the client"*
 *   - *"No Sales Invoice is issued for the goods because the company is
 *      providing a service rather than selling the goods"*
 *
 * The first is the one this file spends most of its effort on, because it is the
 * one a later change could quietly break: a client's goods appearing in a
 * company stock valuation would be wrong in a way nobody notices until a
 * stocktake.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asApp, ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as client from '@/server/services/money-transfer-client';
import * as imports from '@/server/services/client-import';
import * as inventory from '@/server/services/inventory';
import { AVAILABILITY_BUCKETS, availableQuantity } from '@domain/inventory';
import { parseDecimal, toDecimalString } from '@domain/money';
import { BRANCH, buildWorld, scopeOf, type Phase09World } from './phase09-fixture';

const iqd = (value: string) => parseDecimal(value, 4n);
const show = (value: bigint) => toDecimalString(value, 4n);

const FEB = '2026-02-10';
const ITEM = 'ITM-CLIENT-GOODS';
const WAREHOUSE = `WH-${BRANCH}`;

let world: Phase09World;
let clientAccountId: string;

beforeEach(async () => {
  await resetTestData();
  world = await buildWorld();

  // An item and a warehouse that *could* hold stock, so "zero company inventory"
  // is a measured result rather than the absence of anything to measure.
  // One transaction: an item declares a base unit and must carry it, and the
  // constraint saying so is DEFERRED, so the two rows arrive together.
  const connection = await ownerPool.connect();
  try {
    await connection.query('begin');
    const { rows } = await connection.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Client consignment goods',true,'EA','batch') returning id`,
      [ITEM],
    );
    await connection.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1,'EA',1,1)`,
      [rows[0].id],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }

  const account = await withScope(scopeOf(world.clerk), (tx) =>
    client.openAccount(tx, world.clerk, {
      partnerId: world.clientPartnerId,
      branchCode: BRANCH,
      openedOn: '2026-02-01',
    }),
  );
  clientAccountId = account.id;
});

/** Opens a file, pays for the client's goods and posts it. */
async function paidImport(amountIqd = '4000000') {
  const file = await withScope(scopeOf(world.clerk), (tx) =>
    imports.openFile(tx, world.clerk, {
      clientAccountId,
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

describe('09.10 — client goods never enter company inventory (§11.3, §12.4)', () => {
  it('a client-funded import creates zero company inventory quantity in every Phase 04 bucket', async () => {
    await paidImport();

    const position = await withScope(scopeOf(world.manager), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BRANCH),
    );

    // §9.5's nine buckets, every one of them.
    expect(AVAILABILITY_BUCKETS).toHaveLength(9);
    expect(position.onHand).toBe(0n);
    expect(availableQuantity(position)).toBe(0n);
    expect(position.reserved).toBe(0n);
    expect(position.inTransit).toBe(0n);
    expect(position.inQuarantine).toBe(0n);
    expect(position.damaged).toBe(0n);
    expect(position.returnsStock).toBe(0n);
    expect(position.orderedFromSuppliers).toBe(0n);
    expect(position.committedToCustomers).toBe(0n);
  });

  it('touches the Phase 04 ledger not at all — no movement, no layer', async () => {
    await paidImport();

    const { rows } = await ownerPool.query(`
      select (select count(*) from inventory_movement)     as movements,
             (select count(*) from cost_layer)             as layers,
             (select count(*) from cost_layer_consumption) as consumptions,
             (select count(*) from stock_reservation)      as reservations
    `);

    // Not "nets to zero" — never written at all. A movement and its reversal
    // would still put the client's goods through the company's stock ledger.
    expect(rows[0]).toEqual({
      movements: '0',
      layers: '0',
      consumptions: '0',
      reservations: '0',
    });
  });

  it('Client Inventory is a financial balance only, with no quantity ledger', async () => {
    // The strongest form of the rule: there is no column anywhere in this module
    // that could hold a quantity, an item or a warehouse. A rule expressed as an
    // absent column cannot be forgotten by the next person adding a feature.
    const { rows } = await ownerPool.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and table_name in ('client_import_file','client_import_payment','client_goods_delivery')
          and (column_name ~ '(^|_)(quantity|qty)($|_)'
            or column_name in ('item_code','item_id','warehouse_code','warehouse_id'))`,
    );
    expect(rows).toEqual([]);
  });

  it('refuses at the database if anyone ever adds one', async () => {
    // The event trigger is the guard on the guard: the absence above is only a
    // guarantee for as long as nobody adds a column, and this is what makes
    // adding one fail loudly rather than silently.
    const message = await rejection(
      ownerPool.query(`alter table client_import_payment add column quantity numeric(24,6)`),
    );
    expect(message).toMatch(/company inventory quantity/i);
    expect(message).toMatch(/11\.3|12\.4/);
  });

  it('posts Dr Client Inventory / Cr Company Bank Account (§12.4)', async () => {
    const { payment } = await paidImport();

    const { rows } = await ownerPool.query(
      `select l.line_role, l.debit_iqd, l.credit_iqd, l.account_id
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.source_doc_id = $1 order by l.line_no`,
      [payment.id],
    );

    expect(rows[0].line_role).toBe('client_inventory');
    expect(rows[0].debit_iqd).toBe('4000000.0000');
    expect(rows[0].account_id).toBe(world.accounts.client_inventory);
    expect(rows[1].line_role).toBe('bank');
    expect(rows[1].credit_iqd).toBe('4000000.0000');
  });

  it('posts Dr Client Account / Cr Client Inventory on delivery, with no Sales Invoice', async () => {
    const { file } = await paidImport();

    const delivery = await withScope(scopeOf(world.clerk), (tx) =>
      imports.recordDelivery(tx, world.clerk, {
        clientImportFileId: file.id,
        deliveryDate: '2026-02-15',
        amountIqd: iqd('4000000'),
        goodsDescription: 'One container, consignment 42',
        receivedBy: 'Client driver',
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      imports.postDelivery(tx, world.manager, delivery.id),
    );

    const { rows } = await ownerPool.query(
      `select l.line_role, l.debit_iqd, l.credit_iqd
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.source_doc_id = $1 order by l.line_no`,
      [delivery.id],
    );
    expect(rows[0].line_role).toBe('client_account');
    expect(rows[0].debit_iqd).toBe('4000000.0000');
    expect(rows[1].line_role).toBe('client_inventory');
    expect(rows[1].credit_iqd).toBe('4000000.0000');

    // §11.3 — "No Sales Invoice is issued for the goods." Nothing here
    // recognises revenue: the settlement clears an intermediary account and
    // charges the client for what was bought on their behalf.
    const { rows: revenue } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd), 0)::numeric(19,4)::text as total
         from journal_line l where l.account_id = $1`,
      [world.accounts.service_revenue],
    );
    expect(revenue[0].total).toBe('0.0000');
  });

  it('Client Inventory reconciles to its G/L account and clears to zero on delivery settlement', async () => {
    const { file } = await paidImport();

    const beforeDelivery = await withScope(scopeOf(world.manager), (tx) =>
      imports.clientInventoryBalance(tx, file.id),
    );
    expect(show(beforeDelivery)).toBe('4000000.0000');

    // The module's figure and the ledger's agree, because the module's is
    // derived from the same postings.
    const { rows: gl } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0)::text as balance
         from journal_line where account_id = $1`,
      [world.accounts.client_inventory],
    );
    expect(gl[0].balance).toBe('4000000.0000');

    const delivery = await withScope(scopeOf(world.clerk), (tx) =>
      imports.recordDelivery(tx, world.clerk, {
        clientImportFileId: file.id,
        deliveryDate: '2026-02-15',
        amountIqd: iqd('4000000'),
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      imports.postDelivery(tx, world.manager, delivery.id),
    );

    const afterDelivery = await withScope(scopeOf(world.manager), (tx) =>
      imports.clientInventoryBalance(tx, file.id),
    );
    expect(show(afterDelivery)).toBe('0.0000');

    const { rows: glAfter } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0)::text as balance
         from journal_line where account_id = $1`,
      [world.accounts.client_inventory],
    );
    expect(glAfter[0].balance).toBe('0.0000');

    await withScope(scopeOf(world.manager), (tx) =>
      imports.settleFile(tx, world.manager, file.id),
    );
    const { rows: fileRow } = await ownerPool.query(
      `select status from client_import_file where id = $1`,
      [file.id],
    );
    expect(fileRow[0].status).toBe('settled');
  });

  it('a file with an unsettled Client Inventory balance cannot be settled', async () => {
    const { file } = await paidImport();

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) => imports.settleFile(tx, world.manager, file.id)),
    );
    expect(message).toMatch(/still carries a Client Inventory balance of 4000000/i);
  });

  it('refuses the premature settlement at the database too, bypassing the service', async () => {
    const { file } = await paidImport();

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update client_import_file set status = 'settled' where id = $1`, [file.id]),
      ),
    );
    expect(message).toMatch(/still carries a Client Inventory balance/i);
  });

  it('the client-funded import is visibly separate from the standard transfer model', async () => {
    const { file } = await paidImport();

    const rows = await withScope(scopeOf(world.manager), (tx) =>
      imports.crossReference(tx, { clientAccountId }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileNo).toBe(file.fileNo);
    expect(rows[0]!.clientCode).toBe(world.clientPartnerCode);
    expect(rows[0]!.paidIqd).toBe('4000000.0000');
    expect(rows[0]!.deliveredIqd).toBe('0.0000');

    // §11.3 and §12.4 both insist the two services keep separate results. The
    // cross-reference links the cases; it reports no combined figure, and there
    // is no transfer on this file at all.
    expect(rows[0]!.transferNo).toBeNull();
    // Since D16 the job names the file rather than the file naming a text
    // reference, so an import file with no logistics job reports none. That the
    // link resolves when a job *does* exist is asserted in phase10-logistics,
    // where there is a job to resolve to.
    expect(rows[0]!.logisticsJobNo).toBeNull();
  });

  it('a posted client-import document is corrected by reversal, never by editing', async () => {
    const { payment } = await paidImport();

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update client_import_payment set amount_iqd = 1 where id = $1`, [payment.id]),
      ),
    );
    expect(message).toMatch(/has posted|Reverse it/i);

    // And there is no DELETE grant to route around it with (§1.1).
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'erp_app'
          and table_name in ('client_import_file','client_import_payment','client_goods_delivery')`,
    );
    expect(rows.map((r) => r.privilege_type)).not.toContain('DELETE');
  });
});
