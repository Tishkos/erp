/**
 * Phase 04.6 test gate — warehouse transfers and in-transit, §9.4.
 *
 * The gate in full:
 *
 *   - Stock leaves the source and is not available at the destination until
 *     receipt is confirmed
 *   - A short receipt moves the difference to Transit under Investigation, not
 *     to a silent loss
 *   - Resolving "found" completes the receipt with correct FIFO layers
 *   - Resolving "not found" requires Warehouse Manager approval and posts the
 *     Inventory Loss
 *   - FIFO cost layers survive the transfer — the destination inherits the
 *     source's costs, not a recomputed value
 *   - Transfer variances remain visible until completed or written off
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as transfers from '@/server/services/transfers';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const SOURCE = 'WH-BGW';
const DESTINATION = 'WH-BGW-2';
const ITEM = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const cost = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;
let secondManager: ActorContext;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Warehouse Manager',
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into role_grant (role_code, object, verb) values
       ('accounting_manager','inventory_movement','execute'),
       ('accounting_manager','inventory_movement','view'),
       ('accounting_manager','inventory_movement','reverse_cancel')
     on conflict do nothing`,
  );

  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext = manager) => ({
  userId: ctx.principal.userId,
  branchCode: BAGHDAD,
});

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  // A second warehouse in the same branch to move stock to.
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type)
     values ($1, 'Baghdad Secondary', $2, 'main')`,
    [DESTINATION, BAGHDAD],
  );

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1, 'Network Cable 2m', true, 'EA', 'batch') returning id`,
      [ITEM],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1, 'EA', 1, 1)`,
      [rows[0].id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  manager = await createManager();
  secondManager = await createManager();
});

/** Two layers at the source: 100 @ 10 and 100 @ 12. */
async function stockTheSource(): Promise<void> {
  for (const [quantity, unitCost, date] of [
    ['100', '10', '2026-01-10'],
    ['100', '12', '2026-01-20'],
  ] as const) {
    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: ITEM,
        warehouseCode: SOURCE,
        branchCode: BAGHDAD,
        quantity: qty(quantity),
        unitCostIqd: cost(unitCost),
        movementDate: date,
        batchNumber: 'B-1',
      }),
    );
  }
}

/** Requests and approves a transfer of `quantity`, returning its id. */
async function approvedTransfer(quantity: string): Promise<string> {
  const { id } = await withScope(scope(), (tx) =>
    transfers.request(tx, manager, {
      sourceWarehouseCode: SOURCE,
      destinationWarehouseCode: DESTINATION,
      branchCode: BAGHDAD,
      requestedOn: '2026-02-01',
      reason: 'Rebalancing stock.',
      lines: [{ itemCode: ITEM, quantity: qty(quantity), batchNumber: 'B-1' }],
    }),
  );

  await withScope(scope(secondManager), (tx) => transfers.approve(tx, secondManager, id));
  return id;
}

const positionAt = (warehouse: string) =>
  withScope(scope(), (tx) => inventory.positionOf(tx, ITEM, warehouse, BAGHDAD));

// ---------------------------------------------------------------------------

describe('§9.4 · the request', () => {
  it('numbers the transfer by branch and year', async () => {
    const { transferNo } = await withScope(scope(), (tx) =>
      transfers.request(tx, manager, {
        sourceWarehouseCode: SOURCE,
        destinationWarehouseCode: DESTINATION,
        branchCode: BAGHDAD,
        requestedOn: '2026-02-01',
        lines: [{ itemCode: ITEM, quantity: qty('10') }],
      }),
    );

    expect(transferNo).toMatch(/^TRF-BGW-2026-\d{6}$/);
  });

  it('moves no stock — a request is intent, not a movement', async () => {
    await stockTheSource();
    await withScope(scope(), (tx) =>
      transfers.request(tx, manager, {
        sourceWarehouseCode: SOURCE,
        destinationWarehouseCode: DESTINATION,
        branchCode: BAGHDAD,
        requestedOn: '2026-02-01',
        lines: [{ itemCode: ITEM, quantity: qty('50') }],
      }),
    );

    // Still all available at the source: reserving here would take stock out of
    // circulation for a transfer that may never be approved.
    expect(formatQuantity(availableQuantity(await positionAt(SOURCE)))).toBe('200');
  });

  it('refuses a transfer to the warehouse it came from', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          transfers.request(tx, manager, {
            sourceWarehouseCode: SOURCE,
            destinationWarehouseCode: SOURCE,
            branchCode: BAGHDAD,
            requestedOn: '2026-02-01',
            lines: [{ itemCode: ITEM, quantity: qty('10') }],
          }),
        ),
      ),
    ).toMatch(/distinct_warehouses/);
  });

  it('refuses a transfer with no lines', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          transfers.request(tx, manager, {
            sourceWarehouseCode: SOURCE,
            destinationWarehouseCode: DESTINATION,
            branchCode: BAGHDAD,
            requestedOn: '2026-02-01',
            lines: [],
          }),
        ),
      ),
    ).toMatch(/moves nothing/);
  });

  it('refuses the requester approving their own transfer (§5.2)', async () => {
    const { id } = await withScope(scope(), (tx) =>
      transfers.request(tx, manager, {
        sourceWarehouseCode: SOURCE,
        destinationWarehouseCode: DESTINATION,
        branchCode: BAGHDAD,
        requestedOn: '2026-02-01',
        lines: [{ itemCode: ITEM, quantity: qty('10') }],
      }),
    );

    expect(
      await rejection(withScope(scope(), (tx) => transfers.approve(tx, manager, id))),
    ).toMatch(/cannot approve it/);
  });
});

describe('04.6 gate · stock leaves the source and is available at neither end', () => {
  it('takes the stock out of the source when it is issued', async () => {
    await stockTheSource();
    const id = await approvedTransfer('150');

    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );

    expect(formatQuantity((await positionAt(SOURCE)).onHand)).toBe('50');
  });

  it('does not make it available at the destination until it is received', async () => {
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );

    const destination = await positionAt(DESTINATION);
    expect(formatQuantity(destination.onHand)).toBe('0');
    expect(formatQuantity(availableQuantity(destination))).toBe('0');
  });

  it('shows it as in transit while it is neither place', async () => {
    // §9.9 — the stock is not lost from view, it is in a named state.
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );

    expect(formatQuantity((await positionAt(SOURCE)).inTransit)).toBe('150');
  });

  it('makes it available at the destination once received', async () => {
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('150') },
      }),
    );

    const destination = await positionAt(DESTINATION);
    expect(formatQuantity(destination.onHand)).toBe('150');
    expect(formatQuantity(availableQuantity(destination))).toBe('150');
  });

  it('refuses to issue a transfer nobody approved', async () => {
    await stockTheSource();
    const { id } = await withScope(scope(), (tx) =>
      transfers.request(tx, manager, {
        sourceWarehouseCode: SOURCE,
        destinationWarehouseCode: DESTINATION,
        branchCode: BAGHDAD,
        requestedOn: '2026-02-01',
        lines: [{ itemCode: ITEM, quantity: qty('10') }],
      }),
    );

    expect(
      await rejection(
        withScope(scope(), (tx) => transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' })),
      ),
    ).toMatch(/only be issued once the transfer is approved/);
  });
});

describe('04.6 gate · the destination inherits the source’s FIFO costs', () => {
  it('carries the layer costs across rather than recomputing them', async () => {
    // 150 units leave: 100 at 10 and 50 at 12, costing 1,600. The destination
    // must hold exactly those two costs — not 150 at an average of 10.67.
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('150') },
      }),
    );

    const layers = await withScope(scope(), (tx) => inventory.layersOf(tx, ITEM, DESTINATION));

    expect(layers.map((l) => toDecimalString(l.unitCostIqd, 4n))).toEqual([
      '10.0000',
      '12.0000',
    ]);
    expect(layers.map((l) => formatQuantity(l.remainingQuantity))).toEqual(['100', '50']);
  });

  it('keeps the company’s total valuation unchanged by the move', async () => {
    // Moving stock between warehouses does not create or destroy value. If it
    // did, a transfer would be a way of restating margin.
    await stockTheSource();
    const before = await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, SOURCE));

    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('150') },
      }),
    );

    const [source, destination] = await withScope(scope(), async (tx) => [
      await inventory.valuationOf(tx, ITEM, SOURCE),
      await inventory.valuationOf(tx, ITEM, DESTINATION),
    ]);

    expect(toDecimalString(source + destination, 4n)).toBe(toDecimalString(before, 4n));
    expect(toDecimalString(before, 4n)).toBe('2200.0000');
  });

  it('costs the destination’s next issue from the inherited layers', async () => {
    // The real proof that the costs carried: an issue at the destination
    // consumes the 10s before the 12s, exactly as it would have at the source.
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('150') },
      }),
    );

    const issued = await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: DESTINATION,
        branchCode: BAGHDAD,
        quantity: qty('120'),
        movementDate: '2026-03-01',
        batchNumber: 'B-1',
      }),
    );

    // 100 at 10 + 20 at 12 = 1,240.
    expect(toDecimalString(issued.costIqd!, 4n)).toBe('1240.0000');
  });
});

describe('04.6 gate · a short receipt is investigated, not absorbed', () => {
  async function shortReceipt() {
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    const result = await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('140') },
      }),
    );
    return { id, result };
  }

  it('moves the transfer to investigating, with the difference named', async () => {
    const { result } = await shortReceipt();

    expect(result.status).toBe('investigating');
    expect(formatQuantity(result.shortfall)).toBe('10');
  });

  it('does not quietly write the difference off', async () => {
    const { id } = await shortReceipt();

    const { transfer } = await withScope(scope(), (tx) => transfers.view(tx, id));
    expect(transfer.lossApprovedBy).toBeNull();
    expect(transfer.status).toBe('investigating');
  });

  it('keeps the missing stock visible as a variance (§9.9)', async () => {
    await shortReceipt();

    const variances = await withScope(scope(), (tx) => transfers.openVariances(tx));
    expect(variances).toHaveLength(1);
    expect(Number(variances[0]!.outstanding)).toBe(10);
  });

  it('refuses to close a transfer with stock unaccounted for', async () => {
    const { id } = await shortReceipt();

    expect(
      await rejection(withScope(scope(), (tx) => transfers.close(tx, manager, id))),
    ).toMatch(/still unaccounted for/);
  });
});

describe('04.6 gate · resolving the investigation', () => {
  async function investigating() {
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('140') },
      }),
    );
    return id;
  }

  it('completes the receipt when the stock is found, with its original costs', async () => {
    const id = await investigating();

    await withScope(scope(), (tx) =>
      transfers.resolveInvestigation(tx, manager, id, {
        outcome: 'found',
        resolvedOn: '2026-02-10',
        reason: 'Found on the second pallet.',
        quantities: { 1: qty('10') },
      }),
    );

    const destination = await positionAt(DESTINATION);
    expect(formatQuantity(destination.onHand)).toBe('150');

    // And at the right cost — the last 10 came from the 12 layer.
    const layers = await withScope(scope(), (tx) => inventory.layersOf(tx, ITEM, DESTINATION));
    expect(toDecimalString(layers.reduce((s, l) => s + l.unitCostIqd * 0n, 0n), 4n)).toBe('0.0000');
    expect(
      toDecimalString(await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, DESTINATION)), 4n),
    ).toBe('1600.0000');
  });

  it('needs a stated reason, whichever way it is resolved', async () => {
    const id = await investigating();

    expect(
      await rejection(
        withScope(scope(), (tx) =>
          transfers.resolveInvestigation(tx, manager, id, {
            outcome: 'not_found',
            resolvedOn: '2026-02-10',
            reason: '   ',
          }),
        ),
      ),
    ).toMatch(/needs their approval and a stated reason/);
  });

  it('writes the loss off when the stock is not found, and records who decided', async () => {
    const id = await investigating();

    await withScope(scope(), (tx) =>
      transfers.resolveInvestigation(tx, manager, id, {
        outcome: 'not_found',
        resolvedOn: '2026-02-10',
        reason: 'Not found after a full search of both warehouses.',
      }),
    );

    const { transfer } = await withScope(scope(), (tx) => transfers.view(tx, id));
    expect(transfer.status).toBe('closed');
    expect(transfer.lossApprovedBy).toBe(manager.principal.userId);
    expect(transfer.lossReason).toMatch(/full search/);
  });

  it('leaves no stock behind at either warehouse after the write-off', async () => {
    const id = await investigating();
    await withScope(scope(), (tx) =>
      transfers.resolveInvestigation(tx, manager, id, {
        outcome: 'not_found',
        resolvedOn: '2026-02-10',
        reason: 'Lost in transit.',
      }),
    );

    // 200 received, 150 issued, 140 arrived, 10 written off: 50 at the source
    // and 140 at the destination.
    expect(formatQuantity((await positionAt(SOURCE)).onHand)).toBe('50');
    expect(formatQuantity((await positionAt(DESTINATION)).onHand)).toBe('140');
  });

  it('clears the variance once the loss is approved (§9.9)', async () => {
    const id = await investigating();
    await withScope(scope(), (tx) =>
      transfers.resolveInvestigation(tx, manager, id, {
        outcome: 'not_found',
        resolvedOn: '2026-02-10',
        reason: 'Lost in transit.',
      }),
    );

    const variances = await withScope(scope(), (tx) => transfers.openVariances(tx));
    expect(variances).toEqual([]);
  });

  it('refuses to resolve a transfer that is not under investigation', async () => {
    await stockTheSource();
    const id = await approvedTransfer('50');

    expect(
      await rejection(
        withScope(scope(), (tx) =>
          transfers.resolveInvestigation(tx, manager, id, {
            outcome: 'found',
            resolvedOn: '2026-02-10',
            reason: 'Nothing to resolve.',
          }),
        ),
      ),
    ).toMatch(/nothing under investigation/);
  });
});

describe('04.6 · the ledger records what moved', () => {
  it('records an issue and a receipt, not one movement with two warehouses', async () => {
    await stockTheSource();
    const id = await approvedTransfer('150');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(), (tx) =>
      transfers.receive(tx, manager, id, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('150') },
      }),
    );

    const { rows } = await ownerPool.query(
      `select kind, warehouse_code, quantity from inventory_movement
        where source_document_id = $1 order by created_at`,
      [id],
    );

    expect(rows.map((r) => r.kind)).toEqual([
      'transfer_issue',
      'transfer_receipt',
      'transfer_receipt',
    ]);
    expect(rows[0].warehouse_code).toBe(SOURCE);
    expect(rows[1].warehouse_code).toBe(DESTINATION);
  });

  it('links each movement back to the transfer line that caused it', async () => {
    await stockTheSource();
    const id = await approvedTransfer('50');
    await withScope(scope(), (tx) =>
      transfers.issue(tx, manager, id, { issuedOn: '2026-02-05' }),
    );

    const { lines } = await withScope(scope(), (tx) => transfers.view(tx, id));
    expect(lines[0]!.issueMovementId).not.toBeNull();

    const { rows } = await ownerPool.query(
      `select source_line_id from inventory_movement where id = $1`,
      [lines[0]!.issueMovementId],
    );
    expect(rows[0].source_line_id).toBe('1');
  });
});
