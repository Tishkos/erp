/**
 * What Noah needs to understand a thing rather than only look it up — by
 * direction, 2026-10-04: "make it drastically understand everything".
 *
 * Three readings, each the asker's own (their scope, their row-level
 * security, a transaction PostgreSQL holds read-only):
 *
 *   `documentStory`  everything about one document by its number — what it
 *                    is, its lines, the journal it wrote, the stock it moved,
 *                    what settled it, who did what to it and when, and what
 *                    comes next. The first real question in the group was
 *                    "I completed the sale and the customer's account is
 *                    empty": the answer is one reading of the invoice, and he
 *                    had to write four queries to get there.
 *   `activityLog`    the audit trail, searched — who did what, who was
 *                    refused and why.
 *   `systemStatus`   whether the system itself is well: the database, the
 *                    migrations, the build, the scheduled jobs, the errors the
 *                    application logged lately.
 *
 * Nothing here writes, and nothing here decides: each reads what a screen
 * already shows — the record's page, its clock door, the Audit Log, the
 * Background Jobs and Health screens — and says it in one piece.
 */
import { existsSync, openSync, readSync, closeSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { can, type Principal } from '../domain/permissions';
import { profileHref } from '../domain/profiles';
import { parseLastRun } from '../domain/scheduled-jobs';
import { money, quantity } from '../domain/whatsapp';
import { DOCUMENT_FAMILIES, familyOf, tidyNumber, type DocumentFamily } from '../domain/whatsapp-do';
import { probe } from './system-health';
import { inSavepoint } from './whatsapp-sql';

const NL = String.fromCharCode(10);
type Row = Record<string, unknown>;
type Key = DocumentFamily['key'];

const rowsOf = async (tx: Tx, query: SQL): Promise<Row[]> => ((await tx.execute(query)) as unknown as { rows?: Row[] }).rows ?? [];

/** A reading that may be refused (a table this role cannot see) without ending the rest. */
const tryRows = (tx: Tx, query: SQL): Promise<Row[]> => inSavepoint(tx, () => rowsOf(tx, query)).catch(() => []);

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const day = (value: unknown): string => {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
/** An instant in the company's own time, to the minute. */
const when = (value: unknown): string => {
  if (!value) return '';
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(at)
    .replace(',', '');
};

// ---------------------------------------------------------------------------
// One document, whole
// ---------------------------------------------------------------------------

interface Shape {
  readonly table: string;
  readonly number: string;
  /** The record's page, for the address. */
  readonly page: Parameters<typeof profileHref>[0] | null;
  /** The party column on the header, and which side it is. */
  readonly party?: { readonly column: string; readonly side: 'supplier' | 'customer' };
  /** The header's own dates worth saying, in order. */
  readonly dates: readonly (readonly [column: string, label: string])[];
  /** Its lines: the table, the key back to the header, and how one line reads. */
  readonly lines?: { readonly table: string; readonly key: string; readonly read: (row: Row) => string };
  /** True when the header carries `journal_entry_id`. */
  readonly journal: boolean;
  /** Its total, when the header keeps one. */
  readonly total?: (row: Row) => string;
}

const itemLine = (row: Row) =>
  `${text(row.item_code) || text(row.description)}${row.item_code && row.description ? ` · ${text(row.description)}` : ''} — ${quantity(text(row.quantity))}${row.uom_code ? ` ${text(row.uom_code)}` : ''}${row.unit_price !== undefined && row.unit_price !== null ? ` × ${money(text(row.unit_price))}` : ''}${row.warehouse_code ? ` · warehouse ${text(row.warehouse_code)}` : ''}`;

const SHAPES: Readonly<Record<Key, Shape>> = {
  ap_invoice: {
    table: 'ap_invoice',
    number: 'invoice_no',
    page: 'purchase_invoice',
    party: { column: 'supplier_id', side: 'supplier' },
    dates: [
      ['invoice_date', 'dated'],
      ['due_date', 'due'],
    ],
    lines: { table: 'ap_invoice_line', key: 'ap_invoice_id', read: (row) => `${itemLine(row)}${Number(text(row.discount_iqd)) ? ` − ${money(text(row.discount_iqd))}` : ''}${row.is_inventory === false ? ' · a service, not stock' : ''}` },
    journal: true,
    total: (row) =>
      Number(text(row.total_iqd)) ? `total ${money(text(row.total_iqd))} IQD · settled ${money(text(row.settled_amount_iqd))} IQD${row.is_import ? ' · an IMPORT (its goods go through the import application and the stage warehouses)' : ''}` : row.is_import ? 'an IMPORT' : '',
  },
  ar_invoice: {
    table: 'ar_invoice',
    number: 'invoice_no',
    page: 'sales_invoice',
    party: { column: 'customer_id', side: 'customer' },
    dates: [
      ['invoice_date', 'dated'],
      ['due_date', 'due'],
    ],
    lines: { table: 'ar_invoice_line', key: 'ar_invoice_id', read: (row) => `${itemLine(row)} → ${money(text(row.net_iqd))} IQD` },
    journal: true,
    total: (row) => `net ${money(text(row.net_iqd))} IQD · received against it ${money(text(row.allocated_iqd))} IQD`,
  },
  purchase_order: {
    table: 'purchase_order',
    number: 'order_no',
    page: 'purchase_order',
    party: { column: 'supplier_id', side: 'supplier' },
    dates: [
      ['order_date', 'dated'],
      ['expected_date', 'expected'],
    ],
    lines: {
      table: 'purchase_order_line',
      key: 'purchase_order_id',
      read: (row) => `${itemLine(row)} · received ${quantity(text(row.received_quantity))} · invoiced ${quantity(text(row.invoiced_quantity))}`,
    },
    journal: false,
  },
  goods_receipt: {
    table: 'goods_receipt',
    number: 'receipt_no',
    page: 'goods_receipt',
    dates: [['receipt_date', 'dated']],
    lines: { table: 'goods_receipt_line', key: 'goods_receipt_id', read: itemLine },
    journal: false,
  },
  goods_return: {
    table: 'goods_return',
    number: 'return_no',
    page: 'goods_return',
    party: { column: 'supplier_id', side: 'supplier' },
    dates: [['return_date', 'dated']],
    journal: true,
  },
  supplier_payment: {
    table: 'supplier_payment',
    number: 'payment_no',
    page: 'supplier_payment',
    party: { column: 'supplier_id', side: 'supplier' },
    dates: [['payment_date', 'dated']],
    journal: true,
    total: (row) => `amount ${money(text(row.amount_iqd))} IQD · applied to invoices ${money(text(row.allocated_amount_iqd))} IQD`,
  },
  customer_receipt: {
    table: 'customer_receipt',
    number: 'receipt_no',
    page: 'customer_receipt',
    party: { column: 'customer_id', side: 'customer' },
    dates: [['receipt_date', 'dated']],
    journal: true,
    total: (row) => `amount ${money(text(row.amount_iqd))} IQD · applied to invoices ${money(text(row.allocated_iqd))} IQD`,
  },
  journal_entry: {
    table: 'journal_entry',
    number: 'entry_no',
    page: 'journal',
    dates: [
      ['document_date', 'document date'],
      ['posting_date', 'posting date'],
    ],
    journal: false,
    total: (row) => `debits ${money(text(row.total_debit_iqd))} = credits ${money(text(row.total_credit_iqd))} IQD · source ${text(row.source)}${row.source_module ? ` (${text(row.source_module)})` : ''}`,
  },
  bank_transfer: {
    table: 'bank_transfer',
    number: 'transfer_no',
    page: null,
    dates: [['transfer_date', 'dated']],
    journal: true,
    total: (row) => `${money(text(row.amount))} ${text(row.from_currency)}${row.to_currency && row.to_currency !== row.from_currency ? ` → ${money(text(row.received_amount))} ${text(row.to_currency)}` : ''}`,
  },
  opening_stock: {
    table: 'opening_stock',
    number: 'document_no',
    page: 'opening_stock',
    dates: [['document_date', 'dated']],
    lines: {
      table: 'opening_stock_line',
      key: 'opening_stock_id',
      read: (row) => `${text(row.item_code)} — ${quantity(text(row.quantity))}${row.uom_code ? ` ${text(row.uom_code)}` : ''} @ ${money(text(row.unit_cost_iqd))} IQD`,
    },
    journal: true,
  },
};

/** Who did each thing on the header: the column, and what it says they did. */
const HANDS: readonly (readonly [column: string, did: string, at: string | null])[] = [
  ['created_by', 'raised', 'created_at'],
  ['submitted_by', 'submitted', null],
  ['approved_by', 'approved', 'approved_at'],
  ['posted_by', 'posted', 'posted_at'],
  ['reversed_by', 'reversed', 'reversed_at'],
  ['cancelled_by', 'cancelled', 'cancelled_at'],
];

/** What the document is waiting for, said the way its screen would. */
function nextFor(key: Key, status: string): string {
  const say: Partial<Record<Key, Record<string, string>>> = {
    ar_invoice: {
      draft: 'NOTHING HAS POSTED: no journal, no receivable on the customer, no stock out. Next: it is approved (by whoever holds approve on sales invoices), then posted — posting is what writes the customer’s account and moves the stock.',
      approved: 'NOTHING HAS POSTED YET: it is approved but not posted, so the customer’s account and the stock movements are still empty. Next: post it (document_step post) — that writes Dr receivable / Cr revenue and takes the goods out at FIFO cost. Posting is refused if the item has no stock in that warehouse.',
      posted: 'It is in the books. Next: a customer receipt against it; or, if it should not have been posted, reverse it with a reason.',
      reversed: 'It was reversed: its journal is mirrored and its stock put back. It cannot be used again; raise a new one.',
    },
    ap_invoice: {
      draft: 'NOTHING HAS POSTED: no journal, no stock in, nothing owed. Next: submit it, then it is posted by somebody who may approve and did not raise it (a super user may post their own). WHAT POSTING WILL DO: credit the supplier with what is owed, and every stock line that names a warehouse receives its goods into that warehouse at that moment — no separate goods receipt is needed for such a line (a line whose goods already came in on a goods receipt names no warehouse and clears GRNI instead). On an IMPORT the warehouse is In Process: the goods are then owned and in transit, not yet available to sell, and move on to the real warehouse as the import’s containers are received.',
      submitted: 'Waiting to be posted by a second person — or by a super user, who may post their own (posting IS the approval). Nothing is owed and no stock has arrived until then. WHAT POSTING WILL DO: credit the supplier, and bring each stock line that names a warehouse into that warehouse (an import’s into In Process — in transit, not yet available).',
      posted: 'It is in the books: the supplier is owed, and its stock lines are in their warehouse — see STOCK MOVEMENTS above (an import’s are in In Process: owned, in transit, not available until the containers are received). Next: payment; or reverse it with a reason.',
      reversed: 'It was reversed: its journal is mirrored and its stock put back.',
    },
    journal_entry: {
      draft: 'A draft: nothing is in the ledger. Next: submit it; a second person (or a super user) approves, which posts it.',
      submitted: 'Waiting for a second person to approve it, which posts it.',
      posted: 'It is in the ledger. It is never edited: reverse it and raise another.',
    },
    purchase_order: {
      draft: 'A draft: nothing is committed. Next: submit, then a second person (or a super user) approves.',
      submitted: 'Waiting for approval by a second person.',
      approved: 'Approved: goods can be received against it and invoices raised from it.',
    },
    opening_stock: {
      draft: 'A draft: its quantities are NOT in the inventory ledger. Next: submit, then approve.',
      submitted: 'Submitted and NOT yet approved: its quantities read zero everywhere until it is approved.',
      approved: 'Approved: its quantities are in the inventory ledger.',
    },
    supplier_payment: { draft: 'A draft: no money has moved. Next: post it.', posted: 'Posted: the bank or cash account is credited and its invoices settled.' },
    customer_receipt: { draft: 'A draft: nothing received in the books yet. Next: approve, then post.', approved: 'Approved, not posted: the money is not in the books yet. Next: post.', posted: 'Posted: the account is debited and its invoices settled.' },
    goods_receipt: { draft: 'A draft: the goods are NOT in stock yet. Next: submit, then post.', posted: 'Posted: the goods are in the warehouse.' },
  };
  return say[key]?.[status] ?? '';
}

/**
 * The `document_story` tool: one document, whole.
 *
 * Every part is read on its own, so a part this person's role cannot see
 * (the audit trail, the journal) is left out and the rest still answers.
 */
export async function documentStory(tx: Tx, principal: Principal, raw: string, baseUrl: string): Promise<string> {
  const no = tidyNumber(raw);
  if (!no) return 'Which document? Give its number.';
  const family = familyOf(no);
  if (!family) {
    return `I cannot tell what kind of document ${no} is from its number. The kinds I can read whole: ${DOCUMENT_FAMILIES.map((one) => `${one.label} (${one.prefix}-…)`).join(', ')}. For a payable (IMP-, PUR-, SVC-…) use payable_status; for a payment application, application_status.`;
  }
  if (!can(principal, 'view', family.key)) {
    return `This person's role does not include "${family.label}" (the permission view on ${family.key}), so it is not theirs to see. Tell them so, and that an administrator gives it on Settings → Administration → Roles.`;
  }
  const shape = SHAPES[family.key];
  const [header] = await rowsOf(tx, sql`select to_jsonb(t) as row from ${sql.identifier(shape.table)} t where upper(t.${sql.identifier(shape.number)}) = ${no} limit 1`);
  const doc = header?.row as Row | undefined;
  if (!doc) return `There is no ${family.label} ${no} that this person can see.`;
  const id = text(doc.id);
  const status = text(doc.status);
  const out: string[] = [];

  // ── what it is ──
  const href = shape.page ? profileHref(shape.page, no) : family.key === 'bank_transfer' ? `/treasury/transfers/${encodeURIComponent(no)}` : null;
  out.push(`${no} · ${family.label} · status: ${status.replace(/_/g, ' ').toUpperCase()}${doc.branch_code ? ` · branch ${text(doc.branch_code)}` : ''}`);
  if (shape.party && doc[shape.party.column]) {
    const [party] = await tryRows(tx, sql`select code, legal_name, status::text as status from business_partner where id = ${text(doc[shape.party.column])}`);
    if (party) out.push(`${shape.party.side}: ${text(party.code)} · ${text(party.legal_name)}${party.status && party.status !== 'active' ? ` (${text(party.status)})` : ''}`);
  }
  const dates = shape.dates.filter(([column]) => doc[column]).map(([column, label]) => `${label} ${day(doc[column])}`);
  if (dates.length > 0) out.push(dates.join(' · '));
  const total = shape.total?.(doc);
  if (total) out.push(total);
  for (const note of ['description', 'note', 'reference', 'reason'] as const) if (doc[note]) out.push(`${note}: ${text(doc[note]).slice(0, 200)}`);
  if (doc.reversal_reason) out.push(`reversal reason: ${text(doc.reversal_reason).slice(0, 200)}`);
  if (doc.cancellation_reason) out.push(`cancellation reason: ${text(doc.cancellation_reason).slice(0, 200)}`);
  if (href) out.push(`its page: ${baseUrl}${href}`);

  // ── who did what, from the header itself ──
  const ids = HANDS.map(([column]) => text(doc[column])).filter(Boolean);
  const people = new Map<string, string>();
  if (ids.length > 0) {
    for (const row of await tryRows(tx, sql`select id::text as id, display_name from app_user where id::text in (${sql.join(ids.map((one) => sql`${one}`), sql`, `)})`)) {
      people.set(text(row.id), text(row.display_name));
    }
  }
  const hands = HANDS.filter(([column]) => doc[column]).map(([column, did, at]) => `${did} by ${people.get(text(doc[column])) ?? 'somebody'}${at && doc[at] ? ` on ${when(doc[at])}` : ''}`);
  if (hands.length > 0) out.push('', `WHO: ${hands.join(' · ')}`);

  // ── its lines ──
  if (shape.lines) {
    const lines = await tryRows(
      tx,
      sql`select to_jsonb(l) as row from ${sql.identifier(shape.lines.table)} l where l.${sql.identifier(shape.lines.key)} = ${id} order by l.line_no limit 41`,
    );
    out.push('', `LINES (${lines.length > 40 ? 'the first 40' : lines.length}):`);
    if (lines.length === 0) out.push('none');
    for (const [index, line] of lines.slice(0, 40).entries()) out.push(`${index + 1}. ${shape.lines.read(line.row as Row)}`);
  }

  // ── the journal it wrote ──
  const journalId = family.key === 'journal_entry' ? id : shape.journal ? text(doc.journal_entry_id) : '';
  const journals = journalId
    ? await tryRows(tx, sql`select id::text as id, entry_no, status::text as status, posting_date::text as posting_date, description from journal_entry where id = ${journalId}`)
    : family.key === 'journal_entry'
      ? []
      : await tryRows(tx, sql`select id::text as id, entry_no, status::text as status, posting_date::text as posting_date, description from journal_entry where source_doc_id::text = ${id} order by created_at limit 3`);
  if (journals.length === 0 && family.key !== 'journal_entry') {
    out.push('', 'JOURNAL: none — this document has written NOTHING to the ledger. No account, no customer or supplier balance, has moved because of it.');
  }
  for (const journal of journals) {
    const lines = await tryRows(
      tx,
      sql`select l.line_no, a.code, a.name, l.debit_iqd::text as debit, l.credit_iqd::text as credit, l.business_partner_code, l.warehouse_code, l.line_description
            from journal_line l join chart_of_account a on a.id = l.account_id
           where l.journal_entry_id = ${text(journal.id)} order by l.line_no limit 41`,
    );
    out.push('', `JOURNAL ${family.key === 'journal_entry' ? 'LINES' : `${text(journal.entry_no)} · ${text(journal.status)} · posting date ${text(journal.posting_date)}`}:`);
    if (lines.length === 0) out.push('no lines');
    for (const line of lines.slice(0, 40)) {
      const side = Number(text(line.debit)) ? `Dr ${money(text(line.debit))}` : `Cr ${money(text(line.credit))}`;
      out.push(`${text(line.line_no)}. ${side} — ${text(line.code)} · ${text(line.name)}${line.business_partner_code ? ` · ${text(line.business_partner_code)}` : ''}${line.warehouse_code ? ` · ${text(line.warehouse_code)}` : ''}`);
    }
  }

  // ── the stock it moved ──
  if (family.key !== 'journal_entry' && family.key !== 'bank_transfer' && family.key !== 'supplier_payment' && family.key !== 'customer_receipt') {
    const moves = await tryRows(
      tx,
      sql`select movement_date::text as on_date, kind::text as kind, item_code, warehouse_code, quantity::text as quantity, (reverses_movement_id is not null) as reversal
            from inventory_movement where source_document_id = ${id} order by created_at limit 41`,
    );
    out.push('', moves.length === 0 ? 'STOCK MOVEMENTS: none — this document has moved no stock.' : `STOCK MOVEMENTS (${moves.length > 40 ? 'the first 40' : moves.length}):`);
    for (const move of moves.slice(0, 40)) {
      out.push(`${text(move.on_date)} · ${text(move.kind).replace(/_/g, ' ')}${move.reversal ? ' (a reversal)' : ''} · ${text(move.item_code)} · ${quantity(text(move.quantity))} · warehouse ${text(move.warehouse_code)}`);
    }
  }

  // ── what settled it ──
  if (family.key === 'ar_invoice') {
    const paid = await tryRows(tx, sql`select r.receipt_no, r.status::text as status, a.amount_iqd::text as amount from customer_receipt_allocation a join customer_receipt r on r.id = a.customer_receipt_id where a.ar_invoice_id = ${id} order by a.allocated_at limit 20`);
    out.push('', paid.length === 0 ? 'RECEIPTS AGAINST IT: none.' : `RECEIPTS AGAINST IT: ${paid.map((row) => `${text(row.receipt_no)} (${text(row.status)}) ${money(text(row.amount))}`).join('; ')}`);
  }
  if (family.key === 'ap_invoice') {
    const paid = await tryRows(tx, sql`select p.payment_no, p.status::text as status, a.amount_iqd::text as amount from supplier_payment_allocation a join supplier_payment p on p.id = a.supplier_payment_id where a.ap_invoice_id = ${id} and a.reversed_at is null order by a.allocated_at limit 20`);
    out.push('', paid.length === 0 ? 'PAYMENTS AGAINST IT: none.' : `PAYMENTS AGAINST IT: ${paid.map((row) => `${text(row.payment_no)} (${text(row.status)}) ${money(text(row.amount))}`).join('; ')}`);
  }
  if (family.key === 'customer_receipt') {
    const to = await tryRows(tx, sql`select i.invoice_no, a.amount_iqd::text as amount from customer_receipt_allocation a join ar_invoice i on i.id = a.ar_invoice_id where a.customer_receipt_id = ${id} limit 20`);
    out.push('', to.length === 0 ? 'APPLIED TO: no invoice yet — it sits on the customer as an unapplied credit.' : `APPLIED TO: ${to.map((row) => `${text(row.invoice_no)} ${money(text(row.amount))}`).join('; ')}`);
  }
  if (family.key === 'supplier_payment') {
    const to = await tryRows(tx, sql`select i.invoice_no, a.amount_iqd::text as amount from supplier_payment_allocation a join ap_invoice i on i.id = a.ap_invoice_id where a.supplier_payment_id = ${id} and a.reversed_at is null limit 20`);
    out.push('', to.length === 0 ? 'APPLIED TO: no invoice yet — it sits on the supplier as an advance.' : `APPLIED TO: ${to.map((row) => `${text(row.invoice_no)} ${money(text(row.amount))}`).join('; ')}`);
  }

  // ── its history, from the audit trail ──
  const history = await tryRows(
    tx,
    sql`select e.occurred_at, coalesce(u.display_name, 'the system') as who, e.action, e.outcome::text as outcome, e.reason
          from audit_event e left join app_user u on u.id = e.actor_user_id
         where e.object_id in (${id}, ${no}) or e.related_object_id in (${id}, ${no})
         order by e.occurred_at limit 31`,
  );
  if (history.length > 0) {
    out.push('', `HISTORY (${history.length > 30 ? 'the first 30 events' : `${history.length} event(s)`}, oldest first):`);
    for (const event of history.slice(0, 30)) {
      out.push(`${when(event.occurred_at)} · ${text(event.who)} · ${text(event.action)}${event.outcome !== 'success' ? ` · ${text(event.outcome).toUpperCase()}` : ''}${event.reason ? ` — ${text(event.reason).slice(0, 160)}` : ''}`);
    }
  }

  // ── what comes next ──
  const next = nextFor(family.key, status);
  out.push('', `WHAT THIS MEANS: ${next || `It is ${status.replace(/_/g, ' ')}.`}`, `Steps it has from chat: ${family.steps.join(', ')} (document_step) — whether one applies now depends on its status and on who is asking.`);
  return out.join(NL);
}

// ---------------------------------------------------------------------------
// The audit trail, searched
// ---------------------------------------------------------------------------

/** A value from the trail, short, and never a secret. */
function brief(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value).slice(0, 140);
  const kept = Object.entries(value as Row)
    .filter(([key]) => !/pass|secret|token|hash|creds|otp|totp|key/i.test(key))
    .slice(0, 8)
    .map(([key, one]) => `${key}=${typeof one === 'object' && one !== null ? '{…}' : String(one).slice(0, 40)}`);
  return kept.join(', ').slice(0, 200);
}

/**
 * The `activity_log` tool: what was done, by whom, and what was refused.
 *
 * The Audit Log screen's own reading: it needs that screen's grant, and it is
 * read as the asker, so a branch they cannot see is not in it.
 */
export async function activityLog(
  tx: Tx,
  principal: Principal,
  args: { readonly user?: string; readonly document?: string; readonly action?: string; readonly object?: string; readonly outcome?: string; readonly from?: string; readonly to?: string; readonly limit?: number },
): Promise<string> {
  if (!can(principal, 'view', 'audit_event')) {
    return `This person's role does not include the audit log (the permission view on audit_event), so who did what is not theirs to be told. For one document they may see, document_story gives its own history. An administrator gives the permission on Settings → Administration → Roles.`;
  }
  const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const like = (value: string) => `%${value.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const limit = Math.min(Math.max(1, Number(args.limit) || 40), 80);
  const filters: SQL[] = [];
  const said: string[] = [];

  if (args.user?.trim()) {
    filters.push(sql`(u.display_name ilike ${like(args.user.trim())} or u.email ilike ${like(args.user.trim())})`);
    said.push(`by "${args.user.trim()}"`);
  }
  if (args.document?.trim()) {
    const no = tidyNumber(args.document);
    const family = familyOf(no);
    let id = '';
    if (family) {
      const shape = SHAPES[family.key];
      const [found] = await tryRows(tx, sql`select id::text as id from ${sql.identifier(shape.table)} where upper(${sql.identifier(shape.number)}) = ${no} limit 1`);
      id = text(found?.id);
    }
    filters.push(id ? sql`(e.object_id in (${id}, ${no}) or e.related_object_id in (${id}, ${no}))` : sql`(e.object_id = ${no} or e.related_object_id = ${no} or e.object_id = ${args.document.trim()})`);
    said.push(`on ${no}`);
  }
  if (args.action?.trim()) {
    filters.push(sql`e.action ilike ${like(args.action.trim())}`);
    said.push(`action like "${args.action.trim()}"`);
  }
  if (args.object?.trim()) {
    filters.push(sql`e.object_type ilike ${like(args.object.trim())}`);
    said.push(`on ${args.object.trim()}`);
  }
  const outcome = String(args.outcome ?? '').toLowerCase();
  if (outcome === 'denied' || outcome === 'failure' || outcome === 'success') {
    filters.push(sql`e.outcome = ${outcome}::audit_outcome`);
    said.push(outcome === 'success' ? 'that went through' : outcome === 'denied' ? 'that were REFUSED' : 'that FAILED');
  } else if (outcome === 'refused' || outcome === 'problems') {
    filters.push(sql`e.outcome <> 'success'::audit_outcome`);
    said.push('that were refused or failed');
  }
  if (isDate(args.from)) {
    filters.push(sql`e.occurred_at >= ${`${args.from}T00:00:00+03:00`}::timestamptz`);
    said.push(`from ${args.from}`);
  }
  if (isDate(args.to)) {
    filters.push(sql`e.occurred_at < (${`${args.to}T00:00:00+03:00`}::timestamptz + interval '1 day')`);
    said.push(`to ${args.to}`);
  }
  const where = filters.length > 0 ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  const rows = await rowsOf(
    tx,
    sql`select e.occurred_at, coalesce(u.display_name, 'the system') as who, e.action, e.object_type, e.object_id, e.branch_code, e.outcome::text as outcome, e.reason, e.after_value
          from audit_event e left join app_user u on u.id = e.actor_user_id
          ${where}
         order by e.occurred_at desc
         limit ${limit + 1}`,
  );
  if (rows.length === 0) return `Nothing in the audit trail${said.length > 0 ? ` ${said.join(', ')}` : ''}.`;
  return [
    `${rows.length > limit ? `The latest ${limit}` : rows.length} event(s)${said.length > 0 ? ` ${said.join(', ')}` : ''}, newest first:`,
    ...rows.slice(0, limit).map((row) => {
      const refused = row.outcome !== 'success';
      const detail = refused ? text(row.reason) || brief(row.after_value) : brief(row.after_value);
      return `${when(row.occurred_at)} · ${text(row.who)} · ${text(row.action)}${refused ? ` · ${text(row.outcome).toUpperCase()}` : ''} · ${text(row.object_type)}${row.object_id ? ` ${text(row.object_id).slice(0, 40)}` : ''}${row.branch_code ? ` · ${text(row.branch_code)}` : ''}${detail ? ` — ${detail.slice(0, 180)}` : ''}`;
    }),
    'An action reads "<what>.<verb>" — e.g. ar_invoice.posted, whatsapp.action.document_step. A REFUSED row is the system saying no (a permission, maker-checker, a closed period): its reason is the sentence the person was shown.',
  ].join(NL);
}

// ---------------------------------------------------------------------------
// The system itself
// ---------------------------------------------------------------------------

/** The end of a file, without reading the whole of a large log. */
function tail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, 'r');
  try {
    readSync(handle, buffer, 0, length, size - length);
  } finally {
    closeSync(handle);
  }
  return buffer.toString('utf8');
}

/** The application's own error log, newest last: what failed, where, and its reference. */
function recentErrors(limit: number): string[] {
  const file = process.env.ERP_ERROR_LOG?.trim() || '/root/.pm2/logs/qs-erp-error.log';
  if (!existsSync(file)) return [];
  const seen = new Map<string, { line: string; count: number }>();
  for (const raw of tail(file, 200_000).split(/\r?\n/)) {
    // A stack frame, a brace, a warning about listeners: not what went wrong.
    if (!/(Error|error|MISSING_MESSAGE|digest|failed)/.test(raw) || /^\S*\s+at |MaxListenersExceeded|DeprecationWarning/.test(raw)) continue;
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(raw)?.[1] ?? '';
    const said = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:]+:\s*/, '').trim().slice(0, 220);
    if (!said) continue;
    const before = seen.get(said);
    seen.set(said, { line: `${stamp} ${said}`, count: (before?.count ?? 0) + 1 });
  }
  return [...seen.values()].slice(-limit).map((one) => `${one.line}${one.count > 1 ? ` (×${one.count})` : ''}`);
}

/**
 * The `system_status` tool: is the system itself well.
 *
 * For the people who keep it running — a super user, or whoever holds the
 * Health or Background Jobs screens. Everybody else is told that it is up and
 * at which version, which is what the footer already shows them.
 */
export async function systemStatus(tx: Tx, principal: Principal): Promise<string> {
  const seen = await inSavepoint(tx, () => probe(tx));
  const out: string[] = [
    `The system is ${seen.ok ? 'HEALTHY' : 'DEGRADED'}: the database ${seen.database ? 'answers' : 'DOES NOT ANSWER'}; migrations ${seen.migrations.applied} applied of ${seen.migrations.expected ?? '?'} — ${seen.migrations.atHead ? 'at head, nothing waiting' : 'NOT at head: a deploy has not finished applying them'}.`,
    `Version ${seen.version} · build ${seen.build} · revision ${seen.revision.slice(0, 12)}${seen.revision.includes(' ') ? ` (${seen.revision.split(' ').slice(1).join(' ')})` : ''}.`,
  ];
  const keeper = principal.isSuperUser || can(principal, 'view', 'job') || can(principal, 'view', 'system_health');
  if (!keeper) {
    out.push('The rest — the scheduled jobs and the error log — is for the people who keep the system running (the Health and Background Jobs screens).');
    return out.join(NL);
  }

  // The scheduled jobs: what run-job.sh left behind.
  const stateDir = process.env.JOB_STATE_DIR ?? join(process.cwd(), 'var', 'jobs');
  if (existsSync(stateDir)) {
    const jobs = readdirSync(stateDir)
      .filter((name) => name.endsWith('.last'))
      .map((name) => ({ name: name.replace(/\.last$/, ''), last: parseLastRun(readFileSync(join(stateDir, name), 'utf8')) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const failed = jobs.filter((job) => job.last && job.last.exit !== 0);
    out.push('', `SCHEDULED JOBS (${jobs.length}): ${failed.length === 0 ? 'every one ended well on its last run.' : `${failed.length} FAILED on its last run.`}`);
    for (const job of jobs) out.push(`${job.name}: ${job.last ? `${job.last.exit === 0 ? 'ok' : `FAILED (exit ${job.last.exit})`} · last run ${when(job.last.at)}${job.last.seconds !== null ? ` · ${job.last.seconds}s` : ''}` : 'never run'}`);
    if (failed.length > 0) out.push(`A failed job's own words are in /var/log/qs-erp/<job>.log on the server; the Background Jobs screen shows the same list.`);
  }

  // Money or messages waiting where they should not be.
  const [waiting] = await tryRows(tx, sql`select count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'pending')::int as pending from notification_delivery`);
  if (waiting) out.push('', `NOTIFICATIONS: ${text(waiting.pending)} waiting to be delivered, ${text(waiting.failed)} failed.`);

  const errors = recentErrors(12);
  out.push('', errors.length === 0 ? 'ERROR LOG: nothing recent that I can read from here.' : `ERROR LOG — the latest ${errors.length} distinct error(s) the application wrote (UTC), oldest first:`, ...errors);
  if (errors.length > 0) out.push('An error a person saw carries a reference (its digest): ask them for it and look for it here. A repeated one is a defect — write it down with report_issue.');
  return out.join(NL);
}
