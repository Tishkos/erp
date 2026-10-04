/**
 * Related records — platform phase, Agent 9: how the real records of Qimah connect, drawn as chains.
 *
 *   Import     Application → Purchase invoices → B/L → Containers → Customs (PD) → Declarations →
 *              Landed cost → Receipts → Inventory → FIFO layers
 *   Supplier   Purchase orders → Goods receipts → Purchase invoices → Payments → Statement → Ageing
 *   Customer   Sales invoices → Receipts → Credit notes → Returns → Statement → Ageing
 *   Item       Warehouses → FIFO layers → Movements → Source documents
 *
 * `services/relationships.ts` reads the chain; this file holds the rules that need no database:
 *
 *   * **A node is a row.** Every node is a record the system already holds, joined to the one before it
 *     by a foreign key (a container's `bl_id`, a declaration's `pd_id`, a layer's `created_by_movement_id`).
 *     There is no table of relationships and no way to draw one by hand: the graph cannot say what the
 *     rows do not.
 *   * **A step is drawn only for a viewer who may open its records.** Each step names the grants that open
 *     its source (`requires`, reusing the Home import journey's `STAGE_SOURCES` where the step is one of
 *     its stages). A step the viewer lacks is *absent* — not empty, not zero — so the picture never reveals
 *     that a restricted record exists or how many there are.
 *   * **"Not yet" is a fact about the process, not a gap in the picture.** A step with no records is shown
 *     "not yet" only when the step before it HAS records the viewer can see and the chain can still go on
 *     (the import is neither cancelled nor closed); otherwise it is left out. A supplier with no purchase
 *     order has no "goods receipt: not yet".
 */
import { STAGE_SOURCES } from './import-journey';
import { can, type Principal } from './permissions';

export const ROOT_KINDS = ['import', 'supplier', 'customer', 'item'] as const;
export type RootKind = (typeof ROOT_KINDS)[number];

export const isRootKind = (value: unknown): value is RootKind =>
  typeof value === 'string' && (ROOT_KINDS as readonly string[]).includes(value);

/** The permission object that opens the record a chain starts from. */
export const ROOT_OBJECT: Readonly<Record<RootKind, string>> = Object.freeze({
  import: 'payable',
  supplier: 'business_partner',
  customer: 'business_partner',
  item: 'item',
});

/** The step a chain's own start stands for: always present, so the first step after it can be "not yet". */
export const ROOT = '@root';

export interface StepDefinition {
  /** `<chain>.<step>`; the message key under `admin.relationships.step` swaps the dot. */
  readonly code: string;
  readonly chain: RootKind;
  /** The `view` grants that open the step's records — ALL of them. */
  readonly requires: readonly string[];
  /** A step with no records is "not yet" only if at least one of these has records (or is `ROOT`). */
  readonly after: readonly string[];
}

const step = (chain: RootKind, name: string, requires: readonly string[], after: readonly string[] = []): StepDefinition => ({
  code: `${chain}.${name}`,
  chain,
  requires,
  after: after.map((one) => (one === ROOT ? ROOT : `${chain}.${one}`)),
});

/** In the order they are drawn. */
export const STEPS: readonly StepDefinition[] = Object.freeze([
  // An import: the application, then what was bought, shipped, cleared, costed and received.
  step('import', 'invoice', ['ap_invoice'], [ROOT]),
  step('import', 'bl', STAGE_SOURCES.bl, ['invoice']),
  step('import', 'container', STAGE_SOURCES.container, ['bl']),
  step('import', 'customs', STAGE_SOURCES.customs, ['container']),
  step('import', 'declaration', ['customs_declaration'], ['customs']),
  step('import', 'landed_cost', STAGE_SOURCES.landed_cost, ['receipt']),
  step('import', 'receipt', STAGE_SOURCES.receipt, ['container']),
  step('import', 'inventory', STAGE_SOURCES.inventory, ['receipt']),
  step('import', 'layer', STAGE_SOURCES.inventory, ['receipt']),

  // A supplier.
  step('supplier', 'purchase_order', ['purchase_order']),
  step('supplier', 'goods_receipt', ['goods_receipt'], ['purchase_order']),
  step('supplier', 'invoice', ['ap_invoice'], ['purchase_order', 'goods_receipt']),
  step('supplier', 'payment', ['supplier_payment'], ['invoice']),
  step('supplier', 'statement', ['business_partner', 'ap_invoice']),
  step('supplier', 'ageing', ['ap_invoice']),

  // A customer.
  step('customer', 'invoice', ['ar_invoice']),
  step('customer', 'receipt', ['customer_receipt'], ['invoice']),
  step('customer', 'credit', ['customer_credit_memo']),
  step('customer', 'return', ['sales_return']),
  step('customer', 'statement', ['business_partner', 'ar_invoice']),
  step('customer', 'ageing', ['ar_invoice']),

  // An item: where it stands, what layers its cost, which movements made them and which documents moved it.
  step('item', 'warehouse', ['inventory_movement']),
  step('item', 'layer', ['inventory_movement']),
  step('item', 'movement', ['stock_movement']),
  step('item', 'document', ['stock_movement']),
]);

export const stepOf = (code: string): StepDefinition | undefined => STEPS.find((one) => one.code === code);

export const stepsOf = (chain: RootKind): readonly StepDefinition[] => STEPS.filter((one) => one.chain === chain);

/** The message key of a step: `import.bl` → `import_bl`. */
export const stepKey = (code: string): string => code.replace('.', '_');

/** The steps this person may open the records of, in drawing order. The rest are not drawn at all. */
export function visibleSteps(chain: RootKind, principal: Principal): readonly StepDefinition[] {
  if (!principal.isActive) return [];
  return stepsOf(chain).filter((one) => one.requires.every((object) => can(principal, 'view', object)));
}

export type StepState = 'present' | 'pending' | 'unavailable';

/**
 * What a step with `count` records the viewer may open is drawn as — or null when it is left out.
 *
 *   records            → present
 *   none, can go on    → pending ("not yet") if the step before it has records
 *   none, anything else → left out
 *
 * `counts` holds the records found per step the viewer may see (a step they may not see is simply not a key,
 * so it can neither be present nor be the reason another is pending). `open` is whether the chain can still
 * go on: an import neither cancelled nor closed, a supplier or customer always, an item never "pending".
 */
export function stateOf(definition: StepDefinition, count: number, counts: Readonly<Record<string, number>>, open: boolean): StepState | null {
  if (count > 0) return 'present';
  if (!open) return null;
  const prepared = definition.after.some((code) => code === ROOT || (counts[code] ?? 0) > 0);
  return prepared && definition.after.length > 0 ? 'pending' : null;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type FigureKind = 'amountIqd' | 'quantity' | 'count';

export interface NodeFigure {
  readonly kind: FigureKind;
  readonly value: string;
}

/** A line of evidence the node carries, worded by `admin.relationships.note.<key>`; parameter names follow the Exception Center's suffixes (Iqd, Qty, Date). */
export interface NodeNote {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface RelNode {
  /** The kind of record (`ap_invoice`, `shipment_container`, `cost_layer` …). */
  readonly kind: string;
  /** Unique within its step: the row's id. */
  readonly key: string;
  /** The number a person knows it by; null for a node the page names by its kind (a statement, an ageing). */
  readonly label: string | null;
  /** The page that opens the record; null for one without a page of its own. */
  readonly href: string | null;
  /** The record in the step before that this one hangs from, by its foreign key. */
  readonly from: string | null;
  readonly date: string | null;
  readonly status: string | null;
  /** A master-data name for a status that is not a document status (a container's, a PD's). */
  readonly statusName: string | null;
  readonly figure: NodeFigure | null;
  readonly note: NodeNote | null;
}

export interface RelStep {
  readonly code: string;
  readonly state: StepState;
  readonly nodes: readonly RelNode[];
  /** Records the viewer may open beyond those drawn. */
  readonly more: number;
  /** The read stopped at `FETCH_LIMIT`, so there are more than the count says. */
  readonly truncated: boolean;
}

export interface RelRoot {
  readonly kind: RootKind;
  readonly key: string;
  readonly label: string;
  readonly name: string | null;
  readonly href: string;
  /** Whether the chain can still go on (an import neither cancelled nor closed). */
  readonly open: boolean;
}

export interface RelGraph {
  readonly root: RelRoot;
  readonly steps: readonly RelStep[];
}

/** Records drawn per step, and records read per step (the rest are counted, not drawn). */
export const NODE_CAP = 6;
export const FETCH_LIMIT = 24;

/**
 * The first `NODE_CAP` of what the viewer may open, and how many more there were. `truncated` is the reader
 * saying it stopped at `FETCH_LIMIT` (it asks for one more than that to know).
 */
export function shape<T>(allowed: readonly T[], truncated: boolean): { nodes: readonly T[]; more: number; truncated: boolean } {
  return { nodes: allowed.slice(0, NODE_CAP), more: Math.max(0, allowed.length - NODE_CAP), truncated };
}

/** A step's counts for `stateOf`: only the steps that were read and are present. */
export function countsOf(found: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries(found);
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/**
 * The chip tone a status wears — tones the application already has (`status--<tone>`): green is done,
 * blue is waiting for a decision, red is stopped, grey is a draft or a state with no verdict.
 */
export function toneOf(status: string | null): string {
  switch (status) {
    case 'posted':
    case 'approved':
    case 'executed':
    case 'settled':
    case 'closed':
    case 'accepted':
    case 'assessed':
    case 'cleared':
      return 'approved';
    case 'submitted':
    case 'partially_executed':
      return 'submitted';
    case 'rejected':
    case 'cancelled':
    case 'reversed':
      return 'rejected';
    default:
      return 'draft';
  }
}

/** The page of the chain of one record — the section's "see the whole chain" link. */
export function relationshipsHref(kind: RootKind, key: string): string {
  return `/control-center/relationships?type=${kind}&id=${encodeURIComponent(key)}`;
}

/** Document types a stock movement names, with the grant that opens the document and the page that shows it. */
export const SOURCE_DOCUMENT_OBJECT: Readonly<Record<string, string>> = Object.freeze({
  ap_invoice: 'ap_invoice',
  supplier_shipment: 'ap_invoice',
  ar_invoice: 'ar_invoice',
  sales_return: 'sales_return',
  goods_return: 'goods_return',
  opening_stock: 'opening_stock',
  stock_transfer: 'warehouse_transfer',
  stock_adjustment: 'stock_reconciliation',
  container_receipt: 'shipment_container',
});
