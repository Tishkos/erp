/**
 * What each screen shows — the column set and headline figures per module.
 *
 * The seven archetypes decide a screen's *layout*. They cannot decide its
 * *content*: a Sales Order list and an A/R Ageing report are both tables, but
 * one shows a partner and an amount and the other shows an outstanding balance
 * and a days-overdue bucket. Rendering every module through one column set is
 * what makes a mock look like filler, so the content varies here.
 *
 * Twelve row shapes cover 218 screens. Each names the columns it shows and how
 * each column is formatted; a screen then picks a shape and its figures. That
 * is far fewer decisions than 218 bespoke tables, and it keeps two screens of
 * the same kind — every ageing report, say — reading the same way.
 *
 * Column and metric names are catalogue keys, never text. Values are data.
 */

export type FieldKind = 'code' | 'text' | 'date' | 'money' | 'number' | 'percent' | 'status';

export interface SpecColumn {
  /** A key under `column.*` in the message catalogue. */
  readonly key: string;
  readonly kind: FieldKind;
}

export type EntityKind =
  | 'document'
  | 'ledger'
  | 'ageing'
  | 'item'
  | 'stock'
  | 'party'
  | 'person'
  | 'asset'
  | 'job'
  | 'transfer'
  | 'budget'
  | 'run';

/** The columns each row shape shows, in reading order. */
export const ENTITY_COLUMNS: Readonly<Record<EntityKind, readonly SpecColumn[]>> = {
  document: [
    { key: 'reference', kind: 'code' },
    { key: 'document_date', kind: 'date' },
    { key: 'partner', kind: 'text' },
    { key: 'description', kind: 'text' },
    { key: 'branch_code', kind: 'code' },
    { key: 'amount', kind: 'money' },
    { key: 'status', kind: 'status' },
  ],
  ledger: [
    { key: 'entry_no', kind: 'code' },
    { key: 'posting_date', kind: 'date' },
    { key: 'description', kind: 'text' },
    { key: 'debit', kind: 'money' },
    { key: 'credit', kind: 'money' },
    { key: 'balance', kind: 'money' },
  ],
  ageing: [
    { key: 'partner', kind: 'text' },
    { key: 'reference', kind: 'code' },
    { key: 'due_date', kind: 'date' },
    { key: 'amount', kind: 'money' },
    { key: 'outstanding', kind: 'money' },
    { key: 'days_overdue', kind: 'number' },
    { key: 'ageing_bucket', kind: 'text' },
  ],
  item: [
    { key: 'item_code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'category', kind: 'text' },
    { key: 'quantity', kind: 'number' },
    { key: 'unit_price', kind: 'money' },
    { key: 'line_total', kind: 'money' },
  ],
  stock: [
    { key: 'item_code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'warehouse_code', kind: 'code' },
    { key: 'on_hand', kind: 'number' },
    { key: 'reserved', kind: 'number' },
    { key: 'available', kind: 'number' },
    { key: 'valuation', kind: 'money' },
  ],
  party: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'category', kind: 'text' },
    { key: 'branch_code', kind: 'code' },
    { key: 'balance', kind: 'money' },
    { key: 'status', kind: 'status' },
  ],
  person: [
    { key: 'code', kind: 'code' },
    { key: 'employee', kind: 'text' },
    { key: 'department', kind: 'text' },
    { key: 'category', kind: 'text' },
    { key: 'amount', kind: 'money' },
    { key: 'status', kind: 'status' },
  ],
  asset: [
    { key: 'asset_code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'category', kind: 'text' },
    { key: 'document_date', kind: 'date' },
    { key: 'depreciation', kind: 'money' },
    { key: 'net_book_value', kind: 'money' },
    { key: 'status', kind: 'status' },
  ],
  job: [
    { key: 'job_number', kind: 'code' },
    { key: 'document_date', kind: 'date' },
    { key: 'customer', kind: 'text' },
    { key: 'route', kind: 'text' },
    { key: 'carrier', kind: 'text' },
    { key: 'cost', kind: 'money' },
    { key: 'margin', kind: 'percent' },
    { key: 'status', kind: 'status' },
  ],
  transfer: [
    { key: 'reference', kind: 'code' },
    { key: 'value_date', kind: 'date' },
    { key: 'beneficiary', kind: 'text' },
    { key: 'channel', kind: 'text' },
    { key: 'amount', kind: 'money' },
    { key: 'fee', kind: 'money' },
    { key: 'status', kind: 'status' },
  ],
  budget: [
    { key: 'period', kind: 'text' },
    { key: 'department', kind: 'text' },
    { key: 'budget_amount', kind: 'money' },
    { key: 'actual_amount', kind: 'money' },
    { key: 'variance', kind: 'money' },
  ],
  run: [
    { key: 'reference', kind: 'code' },
    { key: 'last_run', kind: 'date' },
    { key: 'user', kind: 'text' },
    { key: 'result', kind: 'text' },
    { key: 'status', kind: 'status' },
  ],
};

export interface ScreenSpec {
  readonly entity: EntityKind;
  /** Keys under `screen.metric.*`, in strip order. */
  readonly metrics: readonly string[];
}

const DOCUMENT_METRICS = ['open_value', 'this_period', 'awaiting_approval', 'count'] as const;
const LEDGER_METRICS = ['posted_value', 'this_period', 'net_position', 'count'] as const;
const AGEING_METRICS = ['open_value', 'overdue', 'average', 'count'] as const;
const STOCK_METRICS = ['on_hand', 'committed', 'valuation_total', 'count'] as const;

/**
 * The default shape for a whole menu section.
 *
 * Most screens in a module share a shape — every Purchasing document lists a
 * supplier and a value — so the section carries the default and only the
 * screens that genuinely differ are named below.
 */
const SECTION_DEFAULTS: Readonly<Record<string, ScreenSpec>> = {
  home: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  crm: { entity: 'party', metrics: ['open_value', 'this_period', 'count', 'average'] },
  sales: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  purchasing: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  inventory: { entity: 'stock', metrics: ['on_hand', 'committed', 'open_value', 'count'] },
  projects: { entity: 'document', metrics: ['open_value', 'committed', 'margin', 'count'] },
  logistics: { entity: 'job', metrics: ['open_value', 'this_period', 'margin', 'count'] },
  money_transfer: { entity: 'transfer', metrics: ['open_value', 'this_period', 'margin', 'count'] },
  investments: { entity: 'document', metrics: ['open_value', 'net_position', 'this_period', 'count'] },
  finance_gl: { entity: 'ledger', metrics: [...LEDGER_METRICS] },
  finance_ar: { entity: 'ageing', metrics: [...AGEING_METRICS] },
  finance_ap: { entity: 'ageing', metrics: [...AGEING_METRICS] },
  treasury: { entity: 'document', metrics: ['net_position', 'this_period', 'open_value', 'count'] },
  fixed_assets: { entity: 'asset', metrics: ['open_value', 'this_period', 'net_position', 'count'] },
  budgeting: { entity: 'budget', metrics: ['budget_total', 'actual_total', 'variance', 'count'] },
  hr_payroll: { entity: 'person', metrics: ['headcount', 'this_period', 'awaiting_approval', 'count'] },
  documents: { entity: 'run', metrics: ['count', 'this_period', 'awaiting_approval', 'overdue'] },
  reports: { entity: 'ledger', metrics: ['posted_value', 'this_period', 'net_position', 'count'] },
  master_data: { entity: 'party', metrics: ['count', 'this_period', 'average', 'open_value'] },
  administration: { entity: 'run', metrics: ['count', 'this_period', 'awaiting_approval', 'overdue'] },
  integrations: { entity: 'run', metrics: ['count', 'this_period', 'overdue', 'awaiting_approval'] },
};

/**
 * Screens whose content differs from their section's default.
 *
 * A short list on purpose. Every entry here is a screen that would read wrongly
 * under its neighbours' columns — a stock count is not a sales document, a
 * customer ledger is not an ageing report — not merely one that could be
 * tuned further.
 */
const OVERRIDES: Readonly<Record<string, ScreenSpec>> = {
  // Home — my work, not a module's documents.
  my_tasks: { entity: 'run', metrics: ['count', 'overdue', 'this_period', 'average'] },
  my_approvals: { entity: 'document', metrics: ['awaiting_approval', 'overdue', 'count', 'open_value'] },
  notifications: { entity: 'run', metrics: ['count', 'this_period', 'overdue', 'average'] },
  recent_records: { entity: 'document', metrics: [...DOCUMENT_METRICS] },

  // CRM — the pipeline is money, the register is parties.
  leads: { entity: 'party', metrics: ['count', 'this_period', 'open_value', 'average'] },
  opportunities: { entity: 'document', metrics: ['open_value', 'this_period', 'average', 'count'] },
  activities: { entity: 'run', metrics: ['count', 'this_period', 'overdue', 'average'] },
  contacts: { entity: 'party', metrics: ['count', 'this_period', 'average', 'open_value'] },
  business_partners: { entity: 'party', metrics: ['count', 'open_value', 'overdue', 'average'] },

  // Sales and Purchasing — the item-level screens.
  customer_price_lists: { entity: 'item', metrics: ['count', 'average', 'this_period', 'margin'] },
  pick_lists: { entity: 'stock', metrics: ['count', 'committed', 'this_period', 'on_hand'] },
  credit_control: { entity: 'ageing', metrics: [...AGEING_METRICS] },
  warranty_inquiry: { entity: 'run', metrics: ['count', 'this_period', 'overdue', 'average'] },
  match_exceptions: { entity: 'document', metrics: ['count', 'overdue', 'open_value', 'awaiting_approval'] },

  // Inventory — movements are documents, the registers are stock.
  opening_stock: { entity: 'stock', metrics: [...STOCK_METRICS] },
  stock_movements: { entity: 'stock', metrics: [...STOCK_METRICS] },
  transfer_requests: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  inventory_returns: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  damaged_goods: { entity: 'stock', metrics: [...STOCK_METRICS] },
  uom: { entity: 'party', metrics: ['count', 'this_period', 'average', 'open_value'] },
  fifo_valuation: { entity: 'stock', metrics: ['valuation_total', 'on_hand', 'average', 'count'] },

  // Finance — a ledger is not an ageing.
  customer_ledger: { entity: 'ledger', metrics: [...LEDGER_METRICS] },
  supplier_ledger: { entity: 'ledger', metrics: [...LEDGER_METRICS] },
  ar_receipts: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  ap_payments: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  ap_advances: { entity: 'document', metrics: [...DOCUMENT_METRICS] },
  credit_limits: { entity: 'party', metrics: ['open_value', 'overdue', 'count', 'average'] },

  // Treasury — statements and reconciliation read as a ledger.
  bank_statements: { entity: 'ledger', metrics: [...LEDGER_METRICS] },
  bank_reconciliation: { entity: 'ledger', metrics: ['net_position', 'count', 'overdue', 'this_period'] },
  bank_cash_accounts: { entity: 'party', metrics: ['net_position', 'count', 'this_period', 'average'] },
  daily_position: { entity: 'ledger', metrics: ['net_position', 'this_period', 'posted_value', 'count'] },
  cash_forecast: { entity: 'budget', metrics: ['net_position', 'this_period', 'variance', 'count'] },

  // Master data — the item and account registers.
  items: { entity: 'item', metrics: ['count', 'average', 'on_hand', 'open_value'] },
  supplier_item_codes: { entity: 'item', metrics: ['count', 'average', 'this_period', 'open_value'] },
  barcodes: { entity: 'item', metrics: ['count', 'this_period', 'average', 'open_value'] },
  price_lists: { entity: 'item', metrics: ['count', 'average', 'margin', 'this_period'] },
  chart_of_accounts: { entity: 'ledger', metrics: [...LEDGER_METRICS] },
  currencies_rates: { entity: 'run', metrics: ['count', 'this_period', 'average', 'overdue'] },

  // Administration and integrations — people and machinery.
  users: { entity: 'person', metrics: ['headcount', 'count', 'this_period', 'overdue'] },
  roles: { entity: 'party', metrics: ['count', 'headcount', 'this_period', 'average'] },
  audit_trail: { entity: 'run', metrics: ['count', 'this_period', 'overdue', 'average'] },
  api_clients: { entity: 'party', metrics: ['count', 'this_period', 'overdue', 'average'] },
  change_requests: { entity: 'document', metrics: ['count', 'awaiting_approval', 'overdue', 'this_period'] },

  // HR.
  employees: { entity: 'person', metrics: ['headcount', 'this_period', 'count', 'average'] },
  payslips: { entity: 'person', metrics: ['this_period', 'headcount', 'posted_value', 'count'] },
  expense_claims: { entity: 'document', metrics: ['awaiting_approval', 'this_period', 'open_value', 'count'] },
  employee_advances: { entity: 'document', metrics: ['open_value', 'overdue', 'this_period', 'count'] },
  asset_assignment: { entity: 'asset', metrics: ['count', 'headcount', 'net_position', 'this_period'] },
};

const FALLBACK: ScreenSpec = { entity: 'document', metrics: [...DOCUMENT_METRICS] };

export function specFor(menuKey: string, sectionKey: string): ScreenSpec {
  return OVERRIDES[menuKey] ?? SECTION_DEFAULTS[sectionKey] ?? FALLBACK;
}

/** Columns a screen shows, optionally trimmed for a narrow layout. */
export function columnsFor(spec: ScreenSpec, compact = false): readonly SpecColumn[] {
  const columns = ENTITY_COLUMNS[spec.entity];
  if (!compact || columns.length <= 5) return columns;
  // Drop the widest free-text columns first; keep the identifier, the figure
  // and the status, which are what a reader scans a narrow table for.
  const droppable = new Set(['description', 'category', 'route', 'channel', 'branch_code', 'department']);
  const trimmed = columns.filter((column) => !droppable.has(column.key));
  return trimmed.length >= 4 ? trimmed : columns.slice(0, 5);
}
