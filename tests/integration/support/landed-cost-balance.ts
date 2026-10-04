/**
 * Landed-cost balance assertions — IMPROVEMENT-002 (migration 0280).
 *
 * A lock spreads an import's charges over the layers its containers created.
 * What is still on hand is restated into the layer's unit cost; what had
 * already left follows the business event that took it (a sale to cost of
 * sales, a project issue to the project, a write-off to inventory loss …) and
 * is written as one `landed_cost_departure` row per lock × layer × departed
 * movement. These helpers hold every lock, and every import, to that account:
 * not one dinar created, lost, or posted somewhere the rows do not say.
 *
 * They read through `ownerPool` (the owner bypasses row-level security, so the
 * figures are the database's, not one user's view of them) and compare money
 * exactly: every figure is rounded to four places in SQL, read as text and
 * compared as a scaled bigint — never as a JavaScript number.
 */
import { expect } from 'vitest';
import { ownerPool } from '../setup';
import { parseDecimal, toDecimalString } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';

const MONEY = 4n;
/** A numeric(…,4) from PostgreSQL, as a scaled bigint. */
const money = (value: string | null | undefined): bigint => parseDecimal(value ?? '0', MONEY);
const show = (value: bigint): string => toDecimalString(value, MONEY);

/** Sorted, labelled `[key, amount]` pairs without zeroes — a readable `toEqual` diff. */
function entries(map: ReadonlyMap<string, bigint>): [string, string][] {
  return [...map.entries()]
    .filter(([, value]) => value !== 0n)
    .map(([key, value]) => [key, show(value)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
}

function add(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + value);
}

interface LockRow {
  readonly id: string;
  readonly payable_id: string;
  readonly sequence: number;
  readonly total: string;
  readonly inventory: string;
  readonly cogs: string;
  readonly journal_entry_id: string;
}

async function lockRow(lockId: string): Promise<LockRow> {
  const { rows } = await ownerPool.query(
    `select id, payable_id, sequence, round(total_iqd, 4)::text as total,
            round(inventory_iqd, 4)::text as inventory, round(cogs_iqd, 4)::text as cogs, journal_entry_id
       from landed_cost_lock where id = $1`,
    [lockId],
  );
  if (rows.length !== 1) throw new Error(`No landed-cost lock '${lockId}'.`);
  return rows[0] as LockRow;
}

/**
 * One lock, whole.
 *
 *   identities    total = inventory + departed (`cogs_iqd`); the departure and
 *                 rounding rows sum to the departed part; the layer
 *                 adjustments' `inventory_iqd` sums to the inventory part; the
 *                 charges the lock consumed sum to its total.
 *   provenance    every departure row names its lock's journal and import,
 *                 copies the kind and source of the movement it names, and
 *                 that movement really did consume the quantity from the layer
 *                 named (or from a layer relocated out of it, by
 *                 `cost_layer.origin_layer_id`); one row per lock × layer ×
 *                 movement.
 *   the journal   posted, debits = credits = the lock's total; per account,
 *                 the net is exactly the departures to that account plus the
 *                 inventory restated into it, and the clearing account is
 *                 credited with the total; the inventory lines, per account ×
 *                 warehouse, are exactly the layer adjustments in that
 *                 warehouse.
 *
 * `return` rows are not part of a lock's balance: they are written by a later
 * event with a journal of its own (the next release) and move an amount
 * between two destinations rather than creating one.
 */
export async function assertLockBalanced(lockId: string): Promise<void> {
  const lock = await lockRow(lockId);
  const label = `lock ${lock.sequence} (${lockId})`;
  const total = money(lock.total);
  const inventory = money(lock.inventory);
  const departed = money(lock.cogs);

  expect(show(inventory + departed), `${label}: total = inventory + departed`).toBe(show(total));

  // ── The rows behind the two parts ──────────────────────────────────────
  const { rows: departures } = await ownerPool.query(
    `select id, kind, payable_id, journal_entry_id, account_id, round(amount_iqd, 4)::text as amount
       from landed_cost_departure where lock_id = $1 and kind in ('departure', 'rounding')`,
    [lockId],
  );
  const departedRows = departures.reduce((sum, row) => sum + money(row.amount), 0n);
  expect(show(departedRows), `${label}: departure + rounding rows = cogs_iqd`).toBe(show(departed));
  for (const row of departures) {
    expect(row.journal_entry_id, `${label}: departure ${row.id} names the lock's journal`).toBe(lock.journal_entry_id);
    expect(row.payable_id, `${label}: departure ${row.id} names the lock's import`).toBe(lock.payable_id);
    expect(money(row.amount) >= 0n, `${label}: departure ${row.id} is not negative`).toBe(true);
  }

  const { rows: restated } = await ownerPool.query(
    `select coalesce(round(sum(inventory_iqd), 4), 0)::text as inventory
       from landed_cost_layer_adjustment where lock_id = $1`,
    [lockId],
  );
  expect(restated[0].inventory, `${label}: layer adjustments = inventory_iqd`).toBe(show(inventory));

  const { rows: charged } = await ownerPool.query(
    `select coalesce(round(sum(amount_iqd), 4), 0)::text as total from landed_cost_charge where lock_id = $1`,
    [lockId],
  );
  expect(charged[0].total, `${label}: the charges it consumed = total_iqd`).toBe(show(total));

  // ── Provenance: each departure is a real movement out of a real layer ──
  const { rows: provenance } = await ownerPool.query(
    `with recursive reach as (
       select d.id as departure_id, d.cost_layer_id as layer_id
         from landed_cost_departure d
        where d.lock_id = $1 and d.kind = 'departure'
       union
       select r.departure_id, cl.id
         from reach r join cost_layer cl on cl.origin_layer_id = r.layer_id
     )
     select d.id, d.quantity::text as quantity, d.movement_kind, d.source_document_type,
            d.source_document_id, d.source_line_id,
            m.id as movement, m.kind::text as m_kind, m.source_document_type as m_type,
            m.source_document_id as m_id, m.source_line_id as m_line,
            (select coalesce(sum(c.quantity), 0)::text from cost_layer_consumption c
              where c.movement_id = d.movement_id
                and c.layer_id in (select r.layer_id from reach r where r.departure_id = d.id)) as consumed
       from landed_cost_departure d
       left join inventory_movement m on m.id = d.movement_id
      where d.lock_id = $1 and d.kind = 'departure'`,
    [lockId],
  );
  for (const row of provenance) {
    const at = `${label}: departure ${row.id}`;
    expect(row.movement, `${at} names a movement that exists`).not.toBeNull();
    expect(
      [row.movement_kind, row.source_document_type, row.source_document_id, row.source_line_id],
      `${at} copies the movement's kind and source`,
    ).toEqual([row.m_kind, row.m_type, row.m_id, row.m_line]);
    expect(parseQuantity(row.quantity) > 0n, `${at} has a quantity`).toBe(true);
    expect(
      parseQuantity(row.consumed) >= parseQuantity(row.quantity),
      `${at}: the movement consumed ${row.consumed} from the layer named (or one relocated out of it); the row says ${row.quantity}`,
    ).toBe(true);
  }
  const { rows: twice } = await ownerPool.query(
    `select cost_layer_id, movement_id, count(*)::int as n from landed_cost_departure
      where lock_id = $1 and kind = 'departure' group by 1, 2 having count(*) > 1`,
    [lockId],
  );
  expect(twice, `${label}: one departure row per layer × movement`).toEqual([]);

  // ── The journal ────────────────────────────────────────────────────────
  const { rows: header } = await ownerPool.query(
    `select status::text as status, round(total_debit_iqd, 4)::text as debit, round(total_credit_iqd, 4)::text as credit
       from journal_entry where id = $1`,
    [lock.journal_entry_id],
  );
  expect(header[0], `${label}: its journal`).toEqual({ status: 'posted', debit: show(total), credit: show(total) });

  const { rows: lines } = await ownerPool.query(
    `select l.account_id, a.code || ' ' || a.name as account, l.line_role, l.warehouse_code,
            round(l.debit_iqd - l.credit_iqd, 4)::text as net
       from journal_line l join chart_of_account a on a.id = l.account_id
      where l.journal_entry_id = $1`,
    [lock.journal_entry_id],
  );
  const { rows: accounts } = await ownerPool.query(`select id, code || ' ' || name as account from chart_of_account`);
  const nameOf = new Map<string, string>(accounts.map((row) => [row.id as string, row.account as string]));
  const named = (id: string | null) => (id ? (nameOf.get(id) ?? id) : '(none)');

  const clearing = lines.filter((line) => line.line_role === 'landed_cost_clearing');
  expect(
    [...new Set(clearing.map((line) => line.account_id as string))],
    `${label}: one landed-cost clearing account`,
  ).toHaveLength(1);
  expect(
    show(clearing.reduce((sum, line) => sum - money(line.net), 0n)),
    `${label}: the clearing account is credited with the total`,
  ).toBe(show(total));

  const expected = new Map<string, bigint>();
  for (const row of departures) add(expected, named(row.account_id), money(row.amount));
  const { rows: byWarehouse } = await ownerPool.query(
    `select i.inventory_account_id as account_id, a.warehouse_code, round(sum(a.inventory_iqd), 4)::text as amount
       from landed_cost_layer_adjustment a join item i on i.code = a.item_code
      where a.lock_id = $1 group by 1, 2`,
    [lockId],
  );
  for (const row of byWarehouse) add(expected, named(row.account_id), money(row.amount));
  add(expected, named(clearing[0]!.account_id), -total);

  const actual = new Map<string, bigint>();
  for (const line of lines) add(actual, line.account as string, money(line.net));
  expect(entries(actual), `${label}: journal, net per account`).toEqual(entries(expected));

  // The inventory side, per account × warehouse: the item's account in the
  // warehouse the restated layer stands in.
  const expectedStock = new Map<string, bigint>();
  for (const row of byWarehouse) add(expectedStock, `${named(row.account_id)} @ ${row.warehouse_code}`, money(row.amount));
  const actualStock = new Map<string, bigint>();
  for (const line of lines.filter((l) => l.line_role === 'inventory')) {
    add(actualStock, `${line.account as string} @ ${line.warehouse_code ?? '(none)'}`, money(line.net));
  }
  expect(entries(actualStock), `${label}: inventory lines per account × warehouse`).toEqual(entries(expectedStock));
}

export interface ImportAccount {
  /** Every charge a lock of the import consumed. */
  readonly chargesIqd: string;
  /** What the locks restated into stock (Σ lock.inventory_iqd). */
  readonly inventoryIqd: string;
  /** What followed departed stock: Σ departure and rounding rows. */
  readonly departedIqd: string;
}

/**
 * One import, across all its locks: the charges locked are exactly what went
 * into stock plus what followed the stock that had left —
 *
 *     Σ locked charges = Σ inventory parts + Σ departures (incl. rounding)
 *
 * — and each side agrees with the rows beneath it (the layer adjustments, the
 * locks' own departed figures). Returns the three figures so a scenario can
 * state them exactly.
 */
export async function assertImportFullyAccounted(payableId: string): Promise<ImportAccount> {
  const { rows } = await ownerPool.query(
    `select
       (select coalesce(round(sum(amount_iqd), 4), 0) from landed_cost_charge where payable_id = $1 and lock_id is not null)::text as charges,
       (select coalesce(round(sum(total_iqd), 4), 0) from landed_cost_lock where payable_id = $1)::text as locked,
       (select coalesce(round(sum(inventory_iqd), 4), 0) from landed_cost_lock where payable_id = $1)::text as inventory,
       (select coalesce(round(sum(cogs_iqd), 4), 0) from landed_cost_lock where payable_id = $1)::text as cogs,
       (select coalesce(round(sum(inventory_iqd), 4), 0) from landed_cost_layer_adjustment where payable_id = $1)::text as restated,
       (select coalesce(round(sum(amount_iqd), 4), 0) from landed_cost_departure
         where payable_id = $1 and kind in ('departure', 'rounding'))::text as departed`,
    [payableId],
  );
  const figures = rows[0] as Record<string, string>;
  const charges = money(figures.charges);
  const inventory = money(figures.inventory);
  const departed = money(figures.departed);
  const label = `import ${payableId}`;

  expect(figures.locked, `${label}: the locks' totals = the charges they locked`).toBe(show(charges));
  expect(figures.restated, `${label}: the layer adjustments = the locks' inventory parts`).toBe(show(inventory));
  expect(figures.cogs, `${label}: the departure rows = the locks' departed parts`).toBe(show(departed));
  expect(show(inventory + departed), `${label}: locked charges = into stock + departed`).toBe(show(charges));

  return { chargesIqd: show(charges), inventoryIqd: show(inventory), departedIqd: show(departed) };
}

/** What the layers hold and what the inventory accounts say, at one moment. */
export interface LayerGlSnapshot {
  readonly itemCodes: readonly string[];
  /** Σ remaining × unit cost over the items' layers, each layer rounded to the fils. */
  readonly layersIqd: string;
  /** The posted balance of the items' inventory accounts (posted and reversed journals). */
  readonly glIqd: string;
}

/**
 * Reads both sides of `assertLayersMatchGl`. The items must be every item
 * holding stock on their inventory accounts: an account is a balance, not a
 * per-item figure, so an item left out would sit in the ledger and not in the
 * layers. That is refused here rather than reported as a difference.
 */
export async function layersAndGl(itemCodes: readonly string[]): Promise<LayerGlSnapshot> {
  const codes = [...itemCodes];
  const { rows: sharing } = await ownerPool.query(
    `select distinct i.code from item i
      where i.inventory_account_id in (select inventory_account_id from item where code = any($1::text[]))
        and not (i.code = any($1::text[]))
        and exists (select 1 from cost_layer cl where cl.item_code = i.code)`,
    [codes],
  );
  if (sharing.length > 0) {
    throw new Error(
      `${sharing.map((row) => row.code).join(', ')} share the inventory account of ${codes.join(', ')} and hold layers; ` +
        'name them too, or the ledger and the layers are not the same set of goods.',
    );
  }
  const { rows } = await ownerPool.query(
    `select
       (select coalesce(sum(round(cl.remaining_quantity * cl.unit_cost_iqd, 4)), 0)
          from cost_layer cl where cl.item_code = any($1::text[]))::text as layers,
       (select coalesce(round(sum(l.debit_iqd - l.credit_iqd), 4), 0)
          from journal_line l join journal_entry e on e.id = l.journal_entry_id
         where e.status in ('posted', 'reversed')
           and l.account_id in (select inventory_account_id from item
                                 where code = any($1::text[]) and inventory_account_id is not null))::text as gl`,
    [codes],
  );
  return { itemCodes: codes, layersIqd: show(money(rows[0].layers)), glIqd: show(money(rows[0].gl)) };
}

/**
 * The warehouse and the ledger hold one figure: Σ cost_layer remaining × unit
 * cost for the items equals the posted balance of their inventory accounts.
 *
 * With `since` (a `layersAndGl` taken earlier) the DELTA is compared instead:
 * what the scenario did to the layers equals what it did to the accounts.
 * That is for a world where absolute equality cannot hold for reasons that are
 * not the landed cost's — a movement that moves value without posting (an
 * unposted write-off, a bare `inventory.issue`, an in-transit transfer issued
 * without `post`), so the layers lost value the ledger never heard about.
 * Returns the snapshot it took, to chain.
 */
export async function assertLayersMatchGl(
  itemCodes: readonly string[],
  since?: LayerGlSnapshot,
): Promise<LayerGlSnapshot> {
  const now = await layersAndGl(itemCodes);
  if (!since) {
    expect(now.layersIqd, `layers vs inventory accounts for ${itemCodes.join(', ')}`).toBe(now.glIqd);
    return now;
  }
  expect([...since.itemCodes].sort(), 'the snapshot is of the same items').toEqual([...itemCodes].sort());
  const layersDelta = money(now.layersIqd) - money(since.layersIqd);
  const glDelta = money(now.glIqd) - money(since.glIqd);
  expect(show(layersDelta), `change in the layers vs change in the inventory accounts for ${itemCodes.join(', ')}`).toBe(
    show(glDelta),
  );
  return now;
}
