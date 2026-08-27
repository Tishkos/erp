/**
 * List registrations — Phase 01.12.
 *
 * Every list in the application is declared here or by the module that owns it,
 * and registered once at start-up. Two things are declared per list: what the
 * columns are (the `ListDefinition`, which decides what may be filtered, sorted
 * and searched) and where the rows come from (the `ListSource`).
 *
 * Keeping them apart is what lets the export be provably identical to the
 * screen — the definition decides which rows and columns a person may see, and
 * neither the screen nor the export gets to add to it.
 *
 * Lists for modules that do not exist yet arrive with those modules. This file
 * grows; `services/list.ts` does not.
 */
import { sql } from 'drizzle-orm';
import type { ListDefinition } from '../domain/list-view';
import { registerList } from '../services/list';

/** Chart of Accounts — Phase 02's master, listed under Master Data (Appendix A 19). */
export const chartOfAccountList: ListDefinition = {
  key: 'chart_of_account',
  object: 'chart_of_account',
  columns: [
    { key: 'code', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'name', kind: 'text', searchable: true, sortable: true, filterable: true },
    {
      key: 'account_type',
      kind: 'enum',
      values: ['asset', 'liability', 'equity', 'revenue', 'expense'],
      filterable: true,
      sortable: true,
    },
    {
      key: 'status',
      kind: 'enum',
      values: ['draft', 'submitted', 'approved', 'rejected', 'cancelled'],
      filterable: true,
      sortable: true,
    },
    { key: 'is_group', kind: 'boolean', filterable: true },
    { key: 'is_active', kind: 'boolean', filterable: true },
    { key: 'level', kind: 'number', sortable: true, filterable: true },
    { key: 'control_account', kind: 'text', filterable: true },
    { key: 'currency_restriction', kind: 'text', filterable: true },
  ],
  // Code order, which is the order an accountant reads a chart in — the tree
  // reads top-down only if the sort follows the coding scheme.
  defaultSort: [{ column: 'code', direction: 'asc' }],
};

/**
 * Journal Entries — Phase 02's document, listed under Finance (Appendix A 10).
 *
 * Branch-scoped, unlike the chart: a journal belongs to exactly one branch
 * (§4.1, and Appendix C's "Manual Standard Journal … one branch"), so a user
 * sees the journals of the branches they hold scope for and no others.
 */
export const journalEntryList: ListDefinition = {
  key: 'journal_entry',
  object: 'journal_entry',
  columns: [
    { key: 'entry_no', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'document_date', kind: 'date', sortable: true, filterable: true },
    { key: 'posting_date', kind: 'date', sortable: true, filterable: true },
    { key: 'description', kind: 'text', searchable: true },
    {
      key: 'status',
      kind: 'enum',
      values: [
        'draft',
        'submitted',
        'approved',
        'posted',
        'rejected',
        'cancelled',
        'reversed',
      ],
      filterable: true,
      sortable: true,
    },
    { key: 'journal_type', kind: 'enum', values: ['standard', 'reversal', 'opening', 'closing'], filterable: true },
    { key: 'source', kind: 'enum', values: ['manual', 'system'], filterable: true },
    { key: 'branch_code', kind: 'text', filterable: true, sortable: true },
    { key: 'total_debit_iqd', kind: 'money', sortable: true, filterable: true },
    { key: 'total_credit_iqd', kind: 'money', sortable: true, filterable: true },
  ],
  // Newest first — the working order for a ledger, where the recent entries are
  // the ones being reviewed.
  defaultSort: [
    { column: 'posting_date', direction: 'desc' },
    { column: 'entry_no', direction: 'desc' },
  ],
};

let registered = false;

/**
 * Registers every list. Idempotent, because Next.js re-evaluates modules on
 * hot reload and a duplicate registration would otherwise be a silent replace.
 */
/**
 * Audit Trail — Phase 0 requirement 10, the company-wide report (§5.4).
 *
 * Row scope is the audit policy's, not this list's: a branch-scoped user sees
 * the events of their permitted branches, a super user sees everything
 * including the unbranched administration events. The list adds no branch
 * filter of its own, so it cannot widen or narrow what the policy decided.
 */
export const auditEventList: ListDefinition = {
  key: 'audit_event',
  object: 'audit_event',
  columns: [
    { key: 'occurred_at', kind: 'date', sortable: true, filterable: true },
    { key: 'action', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'object_type', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'object_id', kind: 'text', searchable: true, filterable: true },
    { key: 'actor', kind: 'text', searchable: true, sortable: true },
    { key: 'branch_code', kind: 'text', filterable: true, sortable: true },
    {
      key: 'outcome',
      kind: 'enum',
      values: ['success', 'denied', 'failure'],
      filterable: true,
      sortable: true,
    },
    { key: 'reason', kind: 'text', searchable: true },
  ],
  defaultSort: [{ column: 'occurred_at', direction: 'desc' }],
  maxPageSize: 200,
};

export function registerAllLists(): void {
  if (registered) return;
  registered = true;

  registerList({
    definition: chartOfAccountList,
    from: sql`chart_of_account`,
    columnSql: {
      id: sql`chart_of_account.id`,
      code: sql`chart_of_account.code`,
      name: sql`chart_of_account.name`,
      account_type: sql`chart_of_account.account_type`,
      status: sql`chart_of_account.approval_status`,
      is_group: sql`chart_of_account.is_group`,
      is_active: sql`chart_of_account.is_active`,
      level: sql`chart_of_account.level`,
      control_account: sql`chart_of_account.control_account`,
      currency_restriction: sql`chart_of_account.currency_restriction`,
    },
    // The chart is company-wide, not per branch (§1.2 — "The Chart of Accounts
    // shall remain hierarchical and configurable"), so there is no branch
    // column to scope by. Lists that are branch-scoped name theirs.
  });

  registerList({
    definition: journalEntryList,
    from: sql`journal_entry`,
    columnSql: {
      id: sql`journal_entry.id`,
      entry_no: sql`journal_entry.entry_no`,
      document_date: sql`journal_entry.document_date`,
      posting_date: sql`journal_entry.posting_date`,
      description: sql`journal_entry.description`,
      status: sql`journal_entry.status`,
      journal_type: sql`journal_entry.journal_type`,
      source: sql`journal_entry.source`,
      branch_code: sql`journal_entry.branch_code`,
      total_debit_iqd: sql`journal_entry.total_debit_iqd`,
      total_credit_iqd: sql`journal_entry.total_credit_iqd`,
    },
    branchColumn: 'branch_code',
  });

  registerList({
    definition: auditEventList,
    from: sql`audit_event left join app_user actor_user on actor_user.id = audit_event.actor_user_id`,
    columnSql: {
      id: sql`audit_event.id`,
      occurred_at: sql`audit_event.occurred_at`,
      action: sql`audit_event.action`,
      object_type: sql`audit_event.object_type`,
      object_id: sql`audit_event.object_id`,
      actor: sql`coalesce(actor_user.display_name, actor_user.email)`,
      branch_code: sql`audit_event.branch_code`,
      outcome: sql`audit_event.outcome::text`,
      reason: sql`audit_event.reason`,
    },
  });

  registerList({
    definition: stockPositionList,
    from: sql`stock_position`,
    columnSql: {
      item_code: sql`stock_position.item_code`,
      warehouse_code: sql`stock_position.warehouse_code`,
      branch_code: sql`stock_position.branch_code`,
      on_hand: sql`stock_position.on_hand`,
      available: sql`stock_position.available`,
      reserved: sql`stock_position.reserved`,
      in_transit: sql`stock_position.in_transit`,
      in_quarantine: sql`stock_position.in_quarantine`,
      damaged: sql`stock_position.damaged`,
      returns_stock: sql`stock_position.returns_stock`,
    },
    branchColumn: 'branch_code',
  });
}

/**
 * Stock availability — Phase 04.1's §9.5 buckets, listed under Inventory
 * (Appendix A menu 5).
 *
 * Reads the `stock_position` view, so the figures on screen are the movements
 * summed rather than a stored total that could have drifted from them.
 */
export const stockPositionList: ListDefinition = {
  key: 'stock_position',
  object: 'inventory_movement',
  columns: [
    { key: 'item_code', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'warehouse_code', kind: 'text', searchable: true, sortable: true, filterable: true },
    { key: 'branch_code', kind: 'text', filterable: true, sortable: true },
    { key: 'on_hand', kind: 'number', sortable: true, filterable: true },
    { key: 'available', kind: 'number', sortable: true, filterable: true },
    { key: 'reserved', kind: 'number', sortable: true, filterable: true },
    { key: 'in_transit', kind: 'number', sortable: true, filterable: true },
    { key: 'in_quarantine', kind: 'number', sortable: true, filterable: true },
    { key: 'damaged', kind: 'number', sortable: true, filterable: true },
    { key: 'returns_stock', kind: 'number', sortable: true, filterable: true },
  ],
  defaultSort: [
    { column: 'item_code', direction: 'asc' },
    { column: 'warehouse_code', direction: 'asc' },
  ],
};
