/**
 * The Warehouses Report's "Goods on the way" (2026-10-21, by direction: "In
 * Process and On Process only show the items that arrived … On Board doesn't
 * have anything").
 *
 * An import's goods are stock only through its invoice and a container's
 * receipt; no import moves stock through On Board or At Port, and the sheet's
 * imports have no stock at all. `payables.goodsOnTheWay` is the other half:
 * every live container not received, at the place the import workbench's Goods
 * filter puts it, and an import with no container whose goods no invoice has
 * booked — read-only, never stock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { containerNo } from '../support/container-number';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import * as payables from '@/server/services/payables';
import { BAGHDAD, PANEL, blWith, buildImportWorld, importOf, receive, scope, type ImportWorld } from './logistics-fixture';

let world: ImportWorld;
let payableNo: string;
let boxes: string[];
const BOX_A = containerNo('TGHU', 710001);
const BOX_B = containerNo('TGHU', 710002);

const read = (filter: Parameters<typeof payables.goodsOnTheWay>[1] = {}) =>
  withScope(scope(world.manager), (tx) => payables.goodsOnTheWay(tx, filter));

beforeEach(async () => {
  world = await buildImportWorld();
  const made = await importOf(world, '400', { reference: 'WAY-1' });
  payableNo = (await ownerPool.query(`select payable_no from payable where id = $1`, [made.payableId])).rows[0].payable_no;
  ({ containerIds: boxes } = await blWith(world, made.payableId, [
    { no: BOX_A, qty: '250' },
    { no: BOX_B, qty: '150' },
  ], { eta: '2026-08-10' }));
});

describe('WH1 · goods on the way, by where they are', () => {
  it('follows each container: in process, on board, at port, and gone once received', async () => {
    let found = await read();
    expect(found.rows.filter((row) => row.payableNo === payableNo).map((row) => [row.containerNo, row.place, row.itemCode, row.quantity])).toEqual([
      [BOX_A, 'in_process', PANEL, '250.000000'],
      [BOX_B, 'in_process', PANEL, '150.000000'],
    ]);

    await ownerPool.query(`update shipment_container set status_code = 'on_sea' where id = $1`, [boxes[0]]);
    await ownerPool.query(`update shipment_container set status_code = 'at_port', arrived_port_on = '2026-08-12' where id = $1`, [boxes[1]]);
    found = await read({ place: 'on_board' });
    expect(found.rows.map((row) => [row.containerNo, row.quantity])).toEqual([[BOX_A, '250.000000']]);
    expect((await read({ place: 'at_port' })).rows.map((row) => row.containerNo)).toEqual([BOX_B]);
    expect((await read({ place: 'in_process' })).rows.filter((row) => row.payableNo === payableNo)).toEqual([]);

    // A late container is on board, and says so.
    await ownerPool.query(`update shipment_container set status_code = 'late' where id = $1`, [boxes[0]]);
    expect((await read({ place: 'on_board' })).rows.map((row) => [row.containerNo, row.late])).toEqual([[BOX_A, true]]);

    // Received: in the warehouse's stock now, so no longer on the way.
    await receive(world, boxes[1]!);
    expect((await read()).rows.map((row) => row.containerNo)).toEqual([BOX_A]);
  });

  it('is searched by the item, its description, the container or the import', async () => {
    expect((await read({ search: 'solar panel' })).rows).toHaveLength(2);
    expect((await read({ search: PANEL.toLowerCase() })).rows).toHaveLength(2);
    expect((await read({ search: BOX_B })).rows.map((row) => row.containerNo)).toEqual([BOX_B]);
    expect((await read({ search: payableNo })).rows).toHaveLength(2);
    expect((await read({ search: 'no such goods' })).rows).toEqual([]);
    // A wildcard typed is a character searched for.
    expect((await read({ search: '%' })).rows).toEqual([]);
  });

  it('shows an import with no container and no booked invoice as the import describes it; a booked one is stock already', async () => {
    // A sheet import: no invoice, a draft application waiting for its first SWIFT — On Process (Without SWIFT).
    const { rows: made } = await ownerPool.query(
      `insert into payable (payable_no, payable_type_code, supplier_reference, supplier_reference_key, supplier_id, branch_code,
                            currency, amount_txn, amount_iqd, quantity, document_date, description, stage_code, source, created_by)
       select 'IMP-WAY-SHEET', 'import', 'SHEET-WAY', 'SHEETWAY', $1, $2, 'IQD', 1000000, 1000000, 1339, '2026-07-01', 'panel',
              (select code from payable_stage where payable_type_code = 'import' order by sequence limit 1), 'sheet_import', $3
       returning id`,
      [world.supplierId, BAGHDAD, world.manager.principal.userId],
    );
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ('WAY-SWIFT','SWIFT transfer','bank','swift') on conflict do nothing`);
    await ownerPool.query(
      `insert into payment_application (application_no, payable_id, branch_code, supplier_id, payment_method_code, bank_cash_account_id,
                                        currency, amount_txn, amount_iqd, status, source, created_by)
       values ('PAYAPP-WAY-1', $1, $2, $3, 'WAY-SWIFT', $4, 'IQD', 200000, 200000, 'draft', 'sheet_import', $5)`,
      [made[0].id, BAGHDAD, world.supplierId, world.bankAccountId, world.manager.principal.userId],
    );
    const sheet = (await read({ place: 'on_process' })).rows;
    expect(sheet.map((row) => [row.payableNo, row.containerNo, row.description, row.quantity])).toEqual([['IMP-WAY-SHEET', null, 'panel', '1339.000000']]);
    expect((await read({ search: 'panel' })).rows.map((row) => row.payableNo)).toContain('IMP-WAY-SHEET');

    // An import whose invoice booked its goods, with no container yet: its goods are the In Process warehouse's stock, not listed here.
    const booked = await importOf(world, '30', { reference: 'WAY-2' });
    const bookedNo = (await ownerPool.query(`select payable_no from payable where id = $1`, [booked.payableId])).rows[0].payable_no;
    expect((await read()).rows.map((row) => row.payableNo)).not.toContain(bookedNo);
  });

  it('counts what a stage holds: containers, imports without one, units', async () => {
    await ownerPool.query(`update shipment_container set status_code = 'on_sea' where id = $1`, [boxes[0]]);
    const { rows } = await read();
    expect(payables.goodsOnTheWayAt(rows, 'on_board')).toEqual({ containers: 1, imports: 0, units: 250_000000n });
    expect(payables.goodsOnTheWayAt(rows.filter((row) => row.payableNo === payableNo), 'in_process')).toEqual({ containers: 1, imports: 0, units: 150_000000n });
    expect(payables.goodsOnTheWayAt(rows, 'at_port')).toEqual({ containers: 0, imports: 0, units: 0n });
  });

  it('maps each stage warehouse to its place', () => {
    expect(['without_swift', 'in_process', 'on_board', 'on_port', null].map(payables.goodsPlaceOfStage)).toEqual([
      'on_process',
      'in_process',
      'on_board',
      'at_port',
      null,
    ]);
  });
});
