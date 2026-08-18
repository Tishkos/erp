/**
 * Phase 10.6 — the §11.3 boundary, enforced as a structural test.
 *
 * §11.3: *"Goods imported for a client do not enter company warehouses."*
 * §11.3: *"No Sales Invoice is issued for the goods because the company is
 * providing a service rather than selling the goods."*
 *
 * A logistics job cannot create company stock, and the reason it cannot is not a
 * rule anybody applies — it is that no table in Phase 10 has an item, a quantity,
 * a unit of measure or a warehouse to put one in, and no Phase 10 module imports
 * the inventory layer. That is a much stronger guarantee than a check, and it is
 * exactly the kind of guarantee that erodes silently: somebody adds a
 * `warehouse_code` for "reporting", and two releases later a movement is being
 * written.
 *
 * So the absence is asserted. Without this test the boundary is a comment, and
 * comments do not fail builds.
 *
 * The integration suite proves the same thing from the other end — a whole job
 * lifecycle leaves every Phase 04 availability bucket untouched. This test says
 * *why* that will keep being true.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PHASE_10_SOURCES = [
  '../../src/server/db/schema/logistics.ts',
  '../../src/server/services/logistics.ts',
  '../../src/server/services/logistics-reports.ts',
  '../../src/server/domain/logistics.ts',
] as const;

async function sourceOf(relativePath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/**
 * Strips block and line comments.
 *
 * Every file here explains at length *why* it has no warehouse column, so a
 * naive search would match the explanation and the test would fail for saying
 * the right thing.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('§11.3 — a logistics job cannot name company stock', () => {
  it('declares no item, quantity, unit-of-measure or warehouse column', async () => {
    const schema = code(await sourceOf('../../src/server/db/schema/logistics.ts'));

    // The column names Phase 04 and Phase 05 use for stock. If one of these ever
    // appears here, a logistics job has acquired the vocabulary to move goods.
    for (const column of [
      'item_code',
      'item_id',
      'quantity',
      'uom_code',
      'warehouse_code',
      'bin_code',
      'serial_number',
      'batch_number',
      'movement_id',
      'cost_layer',
    ]) {
      expect(schema, `schema/logistics.ts declares "${column}" — §11.3 says client goods never enter company inventory`)
        .not.toContain(`'${column}'`);
    }
  });

  it('imports nothing from the inventory or sales layers', async () => {
    for (const path of PHASE_10_SOURCES) {
      const source = code(await sourceOf(path));

      for (const forbidden of [
        './inventory',
        './transfer',
        './opening-stock',
        './stock-count',
        '../domain/inventory',
        '../domain/fifo',
        '../domain/uom',
        './inventory-reports',
        './stock-states',
        './transfers',
      ]) {
        expect(source, `${path} imports "${forbidden}" — §11.3 keeps client goods out of company inventory`)
          .not.toContain(`'${forbidden}'`);
      }
    }
  });

  it('never references an inventory table in its SQL', async () => {
    for (const path of PHASE_10_SOURCES) {
      const source = code(await sourceOf(path));

      for (const table of [
        'inventory_movement',
        'stock_reservation',
        'cost_layer',
        'warehouse_transfer',
        'opening_stock',
        'stock_count',
      ]) {
        expect(source, `${path} references "${table}" — a logistics job has no stock to move (§11.3)`)
          .not.toContain(table);
      }
    }
  });

  it('raises no Sales Invoice — the sales layer is not reachable from here', async () => {
    // §11.3: "No Sales Invoice is issued for the goods because the company is
    // providing a service rather than selling the goods." Sales is Phase 06 and
    // does not exist yet; this asserts Phase 10 will not be the thing that
    // reaches for it when it does.
    for (const path of PHASE_10_SOURCES) {
      const source = code(await sourceOf(path));

      for (const forbidden of ['sales_invoice', 'salesInvoice', 'ar_invoice', 'arInvoice']) {
        expect(source, `${path} mentions "${forbidden}" — §11.3 issues no Sales Invoice for a logistics job`)
          .not.toContain(forbidden);
      }
    }
  });

  it('posts logistics revenue under its own line role, never a shared one', async () => {
    // Appendix C: "Logistics service recognition … Separate from Money Transfer
    // margin." The separation is a line role no other module emits, resolved to
    // an account by §3.3's mapping.
    const service = code(await sourceOf('../../src/server/services/logistics.ts'));

    expect(service).toContain("role: 'logistics_revenue'");
    expect(service).toContain("role: 'logistics_job_cost'");
    // The money transfer side has its own roles and its own accounts; Phase 10
    // must not name them.
    for (const forbidden of ['money_transfer', 'transfer_clearing', 'client_clearing']) {
      expect(service, `services/logistics.ts names "${forbidden}" — §11.3 keeps the two services' accounting apart`)
        .not.toContain(forbidden);
    }
  });
});
