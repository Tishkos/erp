/**
 * Every movement behind a warehouse's on-hand figure, in order, with a running
 * balance.
 *
 *   npx tsx scripts/ops/stock-movement-trace.ts [warehouse] [item]
 *
 * `warehouse` and `item` match on code or name, case-insensitively, and both
 * are optional — given neither, every position in the company is traced.
 *
 * Written for the question "the screen says X and my arithmetic says Y".
 * On-hand is not a stored number that could drift: `stock_position` sums
 * `inventory_movement.quantity`, so the figure on the screen is the sum of
 * these rows and nothing else. A figure that disagrees with somebody's
 * arithmetic therefore has exactly one cause — a row they did not know was
 * there, or a row that is not the quantity they thought it was. Printing the
 * rows with the balance carried down each one shows which, at the line it
 * happens.
 *
 * Three things it checks that a reader cannot see on any screen:
 *
 *   * whether the same warehouse holds movements under more than one branch
 *     code, which splits `stock_position` into two rows for one warehouse;
 *   * whether a movement's branch is the branch the warehouse belongs to;
 *   * whether every stock document has its ledger rows, and every ledger row
 *     its document — `services/inventory-integrity.ts`, run company-wide.
 *
 * Read-only. Safe against production.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/server/db/schema';
import * as integrity from '../../src/server/services/inventory-integrity';

const [, , warehouseArg, itemArg] = process.argv;

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_OWNER (or DATABASE_URL) before running this.');
const pool = new Pool({ connectionString: url, max: 2 });

/** Quantities are plain decimals in the column; trailing zeros only add noise. */
const qty = (value: string) => {
  const n = Number(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
};

const pad = (text: string, width: number) => text.padEnd(width).slice(0, width);
const padStart = (text: string, width: number) => text.padStart(width);

interface MovementRow {
  readonly item_code: string;
  readonly warehouse_code: string;
  readonly branch_code: string;
  readonly kind: string;
  readonly quantity: string;
  readonly movement_date: string;
  readonly source_document_type: string | null;
  readonly source_document_id: string | null;
  readonly batch_number: string | null;
  readonly created_at: string;
  readonly created_by_email: string | null;
  readonly document_no: string | null;
}

async function main(): Promise<void> {
  /*
   * Read every movement, not a position: the position is the thing being
   * explained, so deriving the explanation from it would prove nothing.
   *
   * `document_no` is resolved with a left join per document type rather than
   * a union, because a movement whose source document was deleted must still
   * print — it is exactly the kind of row that makes a figure unexplainable.
   */
  const { rows: movements } = await pool.query<MovementRow>(
    `select m.item_code,
            m.warehouse_code,
            m.branch_code,
            m.kind,
            m.quantity,
            m.movement_date::text as movement_date,
            m.source_document_type,
            m.source_document_id,
            m.batch_number,
            m.created_at::text as created_at,
            u.email as created_by_email,
            coalesce(ap.invoice_no, ar.invoice_no, gr.receipt_no, os.document_no,
                     sr.return_no, st.transfer_no) as document_no
       from inventory_movement m
       join warehouse w on w.code = m.warehouse_code
       join item i on i.code = m.item_code
       left join app_user u on u.id = m.created_by
       left join ap_invoice ap on ap.id::text = m.source_document_id
       left join ar_invoice ar on ar.id::text = m.source_document_id
       left join goods_receipt gr on gr.id::text = m.source_document_id
       left join opening_stock os on os.id::text = m.source_document_id
       left join sales_return sr on sr.id::text = m.source_document_id
       left join stock_transfer st on st.id::text = m.source_document_id
      where ($1::text is null
             or lower(w.code) = lower($1) or lower(w.name) like '%' || lower($1) || '%')
        and ($2::text is null
             or lower(i.code) = lower($2) or lower(i.name) like '%' || lower($2) || '%')
      order by m.item_code, m.warehouse_code, m.movement_date, m.created_at`,
    [warehouseArg ?? null, itemArg ?? null],
  );

  const warnings: string[] = [];

  /*
   * The other direction: not "does the screen match the movements" but "does
   * every document have its movements". A Transfer with no ledger rows moved
   * nothing, whatever its page says — and that is how 2026-09-27's question
   * arose. Asked company-wide and before the early return below, because an
   * empty ledger beside a full Transfer page is precisely the state to catch.
   */
  const report = await drizzle(pool, { schema }).transaction((tx) => integrity.check(tx));
  for (const orphan of report.documentsWithoutLedger) {
    warnings.push(
      `${orphan.documentType} ${orphan.documentNo} (${orphan.branchCode}) has no rows in ` +
        'inventory_movement. It moved nothing the system can see.',
    );
  }
  for (const stray of report.ledgerWithoutDocument) {
    warnings.push(
      `Movement ${stray.movementId} (${stray.kind} ${stray.quantity} of ${stray.itemCode} in ` +
        `${stray.warehouseCode}) names ${stray.sourceDocumentType} ${stray.sourceDocumentId}, which no longer exists.`,
    );
  }
  for (const transfer of report.unbalancedTransfers) {
    warnings.push(
      `${transfer.sourceDocumentType} ${transfer.documentNo ?? transfer.sourceDocumentId}: ` +
        `${qty(transfer.issued)} of ${transfer.itemCode} left and ${qty(transfer.received)} arrived` +
        `${transfer.documented ? `; the document says ${qty(transfer.documented)}` : ''}.`,
    );
  }

  if (movements.length === 0) {
    console.log(
      `No stock movements match${warehouseArg ? ` warehouse '${warehouseArg}'` : ''}` +
        `${itemArg ? ` item '${itemArg}'` : ''}.`,
    );
    console.log('Nothing has moved, so the on-hand figure for it is zero.');
    printWarnings(warnings);
    return;
  }

  // The warehouse each movement should have been recorded under, to flag the
  // ones that were not.
  const { rows: houses } = await pool.query<{ code: string; branch_code: string; name: string }>(
    `select code, branch_code, name from warehouse`,
  );
  const branchOfWarehouse = new Map(houses.map((house) => [house.code, house.branch_code]));
  const nameOfWarehouse = new Map(houses.map((house) => [house.code, house.name]));

  // What the application would report, read the way `positionOf` reads it.
  const { rows: positions } = await pool.query<{
    item_code: string;
    warehouse_code: string;
    branch_code: string;
    on_hand: string;
  }>(`select item_code, warehouse_code, branch_code, on_hand from stock_position`);

  const groups = new Map<string, MovementRow[]>();
  for (const movement of movements) {
    const key = `${movement.item_code}\0${movement.warehouse_code}`;
    const group = groups.get(key);
    if (group) group.push(movement);
    else groups.set(key, [movement]);
  }

  for (const [key, rows] of groups) {
    const [itemCode, warehouseCode] = key.split('\0') as [string, string];
    const house = nameOfWarehouse.get(warehouseCode) ?? warehouseCode;

    console.log('');
    console.log('='.repeat(118));
    console.log(`${itemCode}  in  ${warehouseCode} — ${house}`);
    console.log('='.repeat(118));
    console.log(
      `${pad('Date', 12)}${pad('Kind', 18)}${padStart('Quantity', 16)}` +
        `${padStart('Balance', 16)}  ${pad('Document', 24)}${pad('Branch', 10)}Entered by`,
    );
    console.log('-'.repeat(118));

    let balance = 0;
    for (const row of rows) {
      const amount = Number(row.quantity);
      balance += amount;

      const document = row.document_no
        ? `${row.document_no}`
        : row.source_document_type
          ? `${row.source_document_type} (no no.)`
          : '—';

      const expectedBranch = branchOfWarehouse.get(row.warehouse_code);
      const branchFlag = expectedBranch && expectedBranch !== row.branch_code ? ' *' : '';

      console.log(
        `${pad(row.movement_date, 12)}${pad(row.kind, 18)}` +
          `${padStart((amount > 0 ? '+' : '') + qty(row.quantity), 16)}` +
          `${padStart(qty(String(balance)), 16)}  ${pad(document, 24)}` +
          `${pad(row.branch_code + branchFlag, 10)}${row.created_by_email ?? '—'}`,
      );

      if (branchFlag) {
        warnings.push(
          `${itemCode} in ${warehouseCode}: a ${row.kind} on ${row.movement_date} is recorded ` +
            `under branch ${row.branch_code}, but the warehouse belongs to ${expectedBranch}.`,
        );
      }
    }

    console.log('-'.repeat(118));
    console.log(`${pad('', 30)}${padStart('movements say', 16)}${padStart(qty(String(balance)), 16)}`);

    /*
     * `stock_position` groups by branch as well as by item and warehouse, so
     * a warehouse whose movements carry two branch codes appears twice.
     * `positionOf` now sums the rows it is handed, so the screen shows the
     * whole; the split is still worth naming, because a movement under the
     * wrong branch is a movement somebody in that branch cannot see.
     */
    const reported = positions.filter(
      (position) => position.item_code === itemCode && position.warehouse_code === warehouseCode,
    );

    for (const position of reported) {
      console.log(
        `${pad('', 30)}${padStart(`position (${position.branch_code})`, 16)}` +
          `${padStart(qty(position.on_hand), 16)}`,
      );
    }

    if (reported.length > 1) {
      warnings.push(
        `${itemCode} in ${warehouseCode}: stock_position returns ${reported.length} rows — one per ` +
          `branch code its movements carry (${reported.map((r) => r.branch_code).join(', ')}). ` +
          'The screens sum them, but a user of one branch sees only their own rows.',
      );
    }

    const positionTotal = reported.reduce((sum, row) => sum + Number(row.on_hand), 0);
    if (Math.abs(positionTotal - balance) > 1e-6) {
      warnings.push(
        `${itemCode} in ${warehouseCode}: the movements sum to ${qty(String(balance))} but ` +
          `stock_position totals ${qty(String(positionTotal))}.`,
      );
    }
  }

  printWarnings(warnings);
}

function printWarnings(warnings: readonly string[]): void {
  console.log('');
  if (warnings.length === 0) {
    console.log('No discrepancy between the movements and the reported position.');
    console.log(
      'Where a figure still surprises, it is one of the rows above — read the balance column ' +
        'down to the line where it stops matching the arithmetic you expected.',
    );
  } else {
    console.log(`${warnings.length} thing(s) to look at:`);
    for (const warning of warnings) console.log(`  * ${warning}`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(1);
  });
