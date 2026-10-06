/**
 * What is waiting, and whether a document would go through — by direction,
 * 2026-10-05: "What's stuck? One list of everything waiting" and "Check
 * before posting: warns about duplicates, an unusual price, a due date equal
 * to the invoice date, no stock".
 *
 * The first real question in the group was a sales invoice that had been
 * approved and never posted. Nobody knew it was sitting there, and nobody
 * knew whether posting it would even go through.
 *
 *   `stuckDocuments`  every document resting in a status that is not an end —
 *                     a draft nobody submitted, a submission nobody approved,
 *                     an approval nobody posted — with how long it has been
 *                     there and what it is waiting FOR.
 *   `reviewDocument`  one document, read the way its own service will read it
 *                     at the next step: what that step would REFUSE, what is
 *                     legal and worth a second look, and what was checked and
 *                     found in order.
 *
 * Both are the asker's own reading: their scope, their row-level security, a
 * transaction PostgreSQL holds read-only. Nothing here writes, nothing here
 * decides, and no service that writes is called. Every read sits in its own
 * savepoint (`inSavepoint`), so a table this role cannot see is left out and
 * the rest still answers.
 *
 * `reviewDocument` repeats rules that live in the services — it has to, to say
 * "this would be refused" without trying it. Each check names the function it
 * mirrors; when a service's rule changes, its check here changes with it.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessDateOf, businessToday } from '../domain/business-date';
import { divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import { can, type Principal } from '../domain/permissions';
import { profileHref } from '../domain/profiles';
import { QUANTITY_FACTOR, parseQuantity } from '../domain/uom';
import { money, quantity } from '../domain/whatsapp';
import { DOCUMENT_FAMILIES, familyOf, tidyNumber, type DocumentFamily } from '../domain/whatsapp-do';
import * as approvals from './approvals';
import { inSavepoint } from './whatsapp-sql';

const NL = String.fromCharCode(10);
type Row = Record<string, unknown>;
type Key = DocumentFamily['key'];

const rowsOf = async (tx: Tx, query: SQL): Promise<Row[]> => ((await tx.execute(query)) as unknown as { rows?: Row[] }).rows ?? [];

/** A reading that may be refused (a table this role cannot see) without ending the rest. */
const tryRows = (tx: Tx, query: SQL): Promise<Row[]> => inSavepoint(tx, () => rowsOf(tx, query)).catch(() => []);

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const day = (value: unknown): string => (value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A figure of nothing is not a figure worth saying. */
const some = (value: unknown): boolean => /[1-9]/.test(text(value));

// ---------------------------------------------------------------------------
// Where each family lives, and what each resting status waits for
// ---------------------------------------------------------------------------

interface Register {
  readonly table: string;
  readonly number: string;
  /** The document's own date — for most of them, the date it will post on. */
  readonly date: string;
  /** False where the document writes no journal of its own, so no period is asked. */
  readonly posts: boolean;
  readonly page: Parameters<typeof profileHref>[0] | null;
  readonly party?: { readonly column: string; readonly side: 'supplier' | 'customer' };
  /** Its amount, over the alias `t` — null where the header and lines carry none. */
  readonly amount: SQL | null;
  readonly unit: string;
  /** Each status that is not an end, and what a document in it is waiting for. */
  readonly waits: Readonly<Record<string, string>>;
  /** Who takes the step out of each of those statuses. */
  readonly next: Readonly<Record<string, string>>;
}

const SENT_BACK = 'sent back — to be corrected and submitted again';

const REGISTERS: Readonly<Record<Key, Register>> = {
  ap_invoice: {
    table: 'ap_invoice',
    number: 'invoice_no',
    date: 'invoice_date',
    posts: true,
    page: 'purchase_invoice',
    party: { column: 'supplier_id', side: 'supplier' },
    amount: sql`coalesce(nullif(t.total_iqd, 0), (select sum(l.quantity * l.unit_price - l.discount_iqd) from ap_invoice_line l where l.ap_invoice_id = t.id))`,
    unit: 'IQD',
    waits: {
      draft: 'to be submitted — nothing is owed and no stock has come in',
      submitted: 'to be posted — until then the supplier is owed nothing and its stock lines are not in any warehouse',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Submit it (document_step submit) — whoever holds submit on purchase invoices. It is posted after that.',
      submitted: 'Post it (document_step post) — somebody who holds both post and approve on purchase invoices; posting is the approval.',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
  ar_invoice: {
    table: 'ar_invoice',
    number: 'invoice_no',
    date: 'invoice_date',
    posts: true,
    page: 'sales_invoice',
    party: { column: 'customer_id', side: 'customer' },
    amount: sql`t.net_iqd`,
    unit: 'IQD',
    waits: {
      draft: 'to be approved — nothing has posted',
      approved: 'to be POSTED — until then the customer’s account and the stock are untouched',
    },
    next: {
      draft: 'Approve it (document_step approve) — whoever holds approve on sales invoices. Then it is posted.',
      approved: 'Post it (document_step post) — whoever holds post on sales invoices and may move stock. Posting writes the customer’s account and takes the goods out.',
    },
  },
  purchase_order: {
    table: 'purchase_order',
    number: 'order_no',
    date: 'order_date',
    posts: false,
    page: 'purchase_order',
    party: { column: 'supplier_id', side: 'supplier' },
    amount: sql`(select sum(l.quantity * l.unit_price) from purchase_order_line l where l.purchase_order_id = t.id)`,
    unit: '',
    waits: {
      draft: 'to be submitted — nothing is ordered yet',
      submitted: 'to be approved — until then nothing can be received or invoiced against it',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Submit it (document_step submit).',
      submitted: 'Approve it (document_step approve) — somebody other than whoever raised it, unless they are a super user.',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
  goods_receipt: {
    table: 'goods_receipt',
    number: 'receipt_no',
    date: 'receipt_date',
    posts: true,
    page: 'goods_receipt',
    amount: null,
    unit: '',
    waits: {
      draft: 'to be submitted — the goods are not in stock',
      submitted: 'to be posted — until then the goods are not in the warehouse',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Submit it (document_step submit).',
      submitted: 'Post it (document_step post) — that is what puts the goods in the warehouse.',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
  goods_return: {
    table: 'goods_return',
    number: 'return_no',
    date: 'return_date',
    posts: true,
    page: 'goods_return',
    party: { column: 'supplier_id', side: 'supplier' },
    amount: null,
    unit: '',
    waits: {
      draft: 'to be approved — nothing has gone back',
      submitted: 'to be approved — nothing has gone back',
      approved: 'to be posted — until then the stock has not left and the supplier owes nothing back',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Approve it (document_step approve).',
      submitted: 'Approve it (document_step approve).',
      approved: 'Post it (document_step post).',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
  supplier_payment: {
    table: 'supplier_payment',
    number: 'payment_no',
    date: 'payment_date',
    posts: true,
    page: 'supplier_payment',
    party: { column: 'supplier_id', side: 'supplier' },
    amount: sql`t.amount_iqd`,
    unit: 'IQD',
    waits: {
      draft: 'to be posted — no money has moved and no invoice is settled',
      approved: 'to be posted — no money has moved and no invoice is settled',
    },
    next: {
      draft: 'Post it (document_step post).',
      approved: 'Post it (document_step post).',
    },
  },
  customer_receipt: {
    table: 'customer_receipt',
    number: 'receipt_no',
    date: 'receipt_date',
    posts: true,
    page: 'customer_receipt',
    party: { column: 'customer_id', side: 'customer' },
    amount: sql`t.amount_iqd`,
    unit: 'IQD',
    waits: {
      draft: 'to be approved — the money is not in the books',
      approved: 'to be posted — until then the money is not in the books and the customer still owes it',
    },
    next: {
      draft: 'Approve it (document_step approve).',
      approved: 'Post it (document_step post).',
    },
  },
  journal_entry: {
    table: 'journal_entry',
    number: 'entry_no',
    date: 'posting_date',
    posts: true,
    page: 'journal',
    amount: sql`t.total_debit_iqd`,
    unit: 'IQD',
    waits: {
      draft: 'to be submitted — nothing is in the ledger',
      submitted: 'to be approved — approval is what posts it',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Submit it (document_step submit) — somebody in the Finance department who holds submit on journals.',
      submitted: 'Approve it (document_step approve) — a second person, or a super user; approval posts it.',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
  bank_transfer: {
    table: 'bank_transfer',
    number: 'transfer_no',
    date: 'transfer_date',
    posts: true,
    page: null,
    amount: sql`t.amount`,
    unit: '',
    waits: {
      draft: 'to be approved — no money has moved',
      approved: 'to be posted — until then neither account has moved',
    },
    next: {
      draft: 'Approve it (document_step approve) — somebody other than whoever raised it, unless they are a super user.',
      approved: 'Post it (document_step post).',
    },
  },
  opening_stock: {
    table: 'opening_stock',
    number: 'document_no',
    date: 'document_date',
    posts: true,
    page: 'opening_stock',
    amount: sql`(select sum(l.quantity * l.unit_cost_iqd) from opening_stock_line l where l.opening_stock_id = t.id)`,
    unit: 'IQD',
    waits: {
      draft: 'to be submitted — its quantities are not in the inventory ledger',
      submitted: 'to be APPROVED — until then its quantities read zero everywhere',
      rejected: SENT_BACK,
    },
    next: {
      draft: 'Submit it (document_step submit).',
      submitted: 'Approve it (approve_opening_stock) — whoever holds approve on opening stock; it does not matter who raised it.',
      rejected: 'It goes back to draft to be corrected, on its page.',
    },
  },
};

/**
 * The grant a family's screen asks for. Every family is its own permission
 * object but one: internal transfers are read under the bank and cash accounts'
 * grant (`treasury.PERMISSION_OBJECT`) — `bank_transfer` is their document
 * type, and nobody holds a grant on it.
 */
const viewObject = (key: Key): string => (key === 'bank_transfer' ? 'bank_cash_account' : key);

/** Where a family's register is: its record's address without the number. */
function registerHref(key: Key): string {
  const register = REGISTERS[key];
  if (!register.page) return '/treasury/transfers';
  return (profileHref(register.page, 'X') ?? '').replace(/\/X(\?.*)?$/, '');
}

function recordHref(key: Key, no: string): string | null {
  const register = REGISTERS[key];
  if (!register.page) return key === 'bank_transfer' ? `/treasury/transfers/${encodeURIComponent(no)}` : null;
  return profileHref(register.page, no);
}

const LABEL_PLURAL: Readonly<Record<Key, string>> = {
  ap_invoice: 'PURCHASE INVOICES',
  ar_invoice: 'SALES INVOICES',
  purchase_order: 'PURCHASE ORDERS',
  goods_receipt: 'GOODS RECEIPTS',
  goods_return: 'PURCHASE RETURNS',
  supplier_payment: 'SUPPLIER PAYMENTS',
  customer_receipt: 'CUSTOMER RECEIPTS',
  journal_entry: 'JOURNAL ENTRIES',
  bank_transfer: 'INTERNAL TRANSFERS',
  opening_stock: 'OPENING STOCK',
};

/** How a status reads beside a count: "approved, never posted". */
function restingIn(key: Key, status: string): string {
  if (status === 'draft') return 'draft, never sent on';
  if (status === 'rejected') return 'rejected';
  if (status === 'approved') return 'approved, never posted';
  if (status === 'submitted') return key === 'opening_stock' || key === 'purchase_order' || key === 'journal_entry' || key === 'goods_return' ? 'submitted, not approved' : 'submitted, never posted';
  return status.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Everything waiting
// ---------------------------------------------------------------------------

const GROUP_CAP = 8;
const FETCH_CAP = 300;

/** Which families a word names: a prefix (INV), a key (ar_invoice) or part of the label (sales). */
function familiesNamed(kind: string): Key[] | 'extras' | null {
  const wanted = kind.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  if (!wanted) return null;
  // A prefix says exactly one family ("INV" is not every label with "inv" in it).
  const byPrefix = DOCUMENT_FAMILIES.filter((family) => wanted === family.prefix.toLowerCase() || wanted.startsWith(`${family.prefix.toLowerCase()} `));
  if (byPrefix.length > 0) return byPrefix.map((family) => family.key);
  const hits = DOCUMENT_FAMILIES.filter((family) => {
    const key = family.key.replace(/_/g, ' ');
    return wanted === key || family.label.includes(wanted) || wanted.includes(family.label) || key.includes(wanted);
  }).map((family) => family.key);
  if (hits.length > 0) return hits;
  return 'extras';
}

/**
 * The `stuck_documents` reading: everything resting in a status that is not an end.
 *
 * `olderThanDays` keeps what has waited at least that long (0, the default, is
 * everything), `mine` what the asker raised, `kind` one family by its prefix,
 * its key or part of its name — or "payment applications", "prospects",
 * "inbox" for the three lists beside the families.
 */
export async function stuckDocuments(
  tx: Tx,
  principal: Principal,
  args: { readonly olderThanDays?: number; readonly mine?: boolean; readonly kind?: string },
  baseUrl: string,
): Promise<string> {
  const today = businessToday();
  const olderThan = Math.max(0, Math.floor(Number(args.olderThanDays) || 0));
  const mine = args.mine === true;
  const kind = (args.kind ?? '').trim();
  const named = kind ? familiesNamed(kind) : null;
  const kindWords = kind.toLowerCase();
  const wantsExtra = (words: RegExp) => !kind || (named === 'extras' && words.test(kindWords));
  if (kind && named === 'extras' && !/pay(ment)?\s*app|payapp|prospect|partner|customer|supplier|inbox|approval/.test(kindWords)) {
    return `I do not know a kind of document called "${kind}". The kinds: ${DOCUMENT_FAMILIES.map((family) => `${family.label} (${family.prefix})`).join(', ')}; and "payment applications", "prospects", "inbox".`;
  }

  const families = DOCUMENT_FAMILIES.filter((family) => (Array.isArray(named) ? named.includes(family.key) : named === null));
  const sections: string[] = [];
  const hidden: string[] = [];
  let total = 0;
  let kinds = 0;

  for (const family of families) {
    if (!can(principal, 'view', viewObject(family.key))) {
      hidden.push(family.label);
      continue;
    }
    const register = REGISTERS[family.key];
    const statuses = Object.keys(register.waits);
    const party = register.party
      ? sql`(select bp.code || ' · ' || bp.legal_name from business_partner bp where bp.id = t.${sql.identifier(register.party.column)})`
      : sql`null::text`;
    const rows = await tryRows(
      tx,
      sql`select t.${sql.identifier(register.number)} as doc_no,
                 t.status::text as status,
                 t.${sql.identifier(register.date)}::text as on_date,
                 (${today}::date - (t.created_at at time zone 'Asia/Baghdad')::date)::int as age,
                 ${register.amount ? sql`(${register.amount})::numeric(19,4)::text` : sql`null::text`} as amount,
                 ${family.key === 'bank_transfer' ? sql`t.from_currency::text` : sql`null::text`} as currency,
                 ${party} as party,
                 (select u.display_name from app_user u where u.id = t.created_by) as raised_by,
                 count(*) over (partition by t.status)::int as of_status
            from ${sql.identifier(register.table)} t
           where t.status::text in (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
             and (${today}::date - (t.created_at at time zone 'Asia/Baghdad')::date) >= ${olderThan}
             ${mine ? sql`and t.created_by = ${principal.userId}` : sql``}
           order by t.created_at
           limit ${FETCH_CAP}`,
    );
    if (rows.length === 0) continue;

    for (const status of statuses) {
      const group = rows.filter((row) => row.status === status);
      if (group.length === 0) continue;
      const count = Number(group[0]!.of_status) || group.length;
      total += count;
      kinds += 1;
      const lines = group.slice(0, GROUP_CAP).map((row) => {
        const amount = some(row.amount) ? ` · ${money(text(row.amount))}${text(row.currency) || register.unit ? ` ${text(row.currency) || register.unit}` : ''}` : '';
        const age = Number(row.age) || 0;
        return `• ${text(row.doc_no)}${row.party ? ` · ${text(row.party)}` : ''}${amount} · dated ${day(row.on_date)} · raised ${age === 0 ? 'today' : `${plural(age, 'day')} ago`}${row.raised_by ? ` by ${text(row.raised_by)}` : ''}`;
      });
      sections.push(
        [
          `${LABEL_PLURAL[family.key]} — ${restingIn(family.key, status)} (${count}): waiting ${register.waits[status]}.`,
          ...lines,
          ...(count > lines.length ? [`… and ${count - lines.length} more — the register shows them all.`] : []),
          `Register: ${baseUrl}${registerHref(family.key)}`,
        ].join(NL),
      );
    }
  }

  // ── payment applications: asked of the bank and not yet answered ──
  if (wantsExtra(/pay(ment)?\s*app|payapp/) && !mine) {
    if (!can(principal, 'view', 'payment_application')) {
      if (kind) hidden.push('payment application');
    } else {
      const waits: Readonly<Record<string, string>> = {
        draft: 'to be sent for approval — nothing has been asked of the bank',
        submitted: 'to be approved — nothing has been asked of the bank',
        approved: 'to be sent to the bank',
        sent: 'for the bank’s confirmation — the money is not confirmed as paid',
      };
      const rows = await tryRows(
        tx,
        sql`select pa.application_no as doc_no, pa.status as status, pa.application_date::text as on_date,
                   (${today}::date - coalesce((pa.sent_at at time zone 'Asia/Baghdad')::date, (pa.created_at at time zone 'Asia/Baghdad')::date))::int as age,
                   pa.amount_txn::text as amount, pa.currency::text as currency,
                   (select bp.code || ' · ' || bp.legal_name from business_partner bp where bp.id = pa.supplier_id) as party,
                   count(*) over (partition by pa.status)::int as of_status
              from payment_application pa
             where pa.status in ('draft', 'submitted', 'approved', 'sent')
               and (${today}::date - coalesce((pa.sent_at at time zone 'Asia/Baghdad')::date, (pa.created_at at time zone 'Asia/Baghdad')::date)) >= ${olderThan}
             order by pa.created_at
             limit ${FETCH_CAP}`,
      );
      for (const status of Object.keys(waits)) {
        const group = rows.filter((row) => row.status === status);
        if (group.length === 0) continue;
        const count = Number(group[0]!.of_status) || group.length;
        total += count;
        kinds += 1;
        const lines = group.slice(0, GROUP_CAP).map((row) => {
          const age = Number(row.age) || 0;
          return `• ${text(row.doc_no)}${row.party ? ` · ${text(row.party)}` : ''} · ${money(text(row.amount))} ${text(row.currency).trim()} · dated ${day(row.on_date)} · ${status === 'sent' ? 'sent' : 'raised'} ${age === 0 ? 'today' : `${plural(age, 'day')} ago`}`;
        });
        sections.push(
          [
            `PAYMENT APPLICATIONS — ${status} (${count}): waiting ${waits[status]}.`,
            ...lines,
            ...(count > lines.length ? [`… and ${count - lines.length} more.`] : []),
            `Register: ${baseUrl}/payables/payment-applications`,
          ].join(NL),
        );
      }
    }
  }

  // ── customers and suppliers entered and not yet approved ──
  if (wantsExtra(/prospect|partner|customer|supplier/)) {
    if (!can(principal, 'view', 'business_partner')) {
      if (kind) hidden.push('customers and suppliers');
    } else {
      const rows = await tryRows(
        tx,
        sql`select bp.code, bp.legal_name, bp.is_customer, bp.is_supplier,
                   (${today}::date - (bp.created_at at time zone 'Asia/Baghdad')::date)::int as age,
                   count(*) over ()::int as of_all
              from business_partner bp
             where bp.status = 'prospect' and bp.active
               and (${today}::date - (bp.created_at at time zone 'Asia/Baghdad')::date) >= ${olderThan}
               ${mine ? sql`and bp.created_by = ${principal.userId}` : sql``}
             order by bp.created_at
             limit ${FETCH_CAP}`,
      );
      if (rows.length > 0) {
        const count = Number(rows[0]!.of_all) || rows.length;
        total += count;
        kinds += 1;
        const lines = rows.slice(0, GROUP_CAP).map((row) => {
          const age = Number(row.age) || 0;
          const side = row.is_customer && row.is_supplier ? 'customer and supplier' : row.is_supplier ? 'supplier' : 'customer';
          return `• ${text(row.code)} · ${text(row.legal_name)} · ${side} · entered ${age === 0 ? 'today' : `${plural(age, 'day')} ago`}`;
        });
        sections.push(
          [
            `CUSTOMERS AND SUPPLIERS — prospects (${count}): waiting to be approved — until then they cannot be chosen on an order or an invoice (approve_partner).`,
            ...lines,
            ...(count > lines.length ? [`… and ${count - lines.length} more.`] : []),
          ].join(NL),
        );
      }
    }
  }

  // ── what is waiting for the asker's own decision ──
  let inbox = 0;
  if (wantsExtra(/inbox|approval/)) {
    inbox = await inSavepoint(tx, async () => (await approvals.inbox(tx, principal)).length).catch(() => 0);
  }

  const filters = [olderThan > 0 ? `waiting ${plural(olderThan, 'day')} or more` : '', mine ? 'that you raised' : '', kind ? `of the kind "${kind}"` : ''].filter(Boolean).join(', ');
  const closing: string[] = [];
  if (inbox > 0) closing.push(`${plural(inbox, 'document')} ${inbox === 1 ? 'is' : 'are'} in YOUR approval inbox, waiting for your decision — approvals_waiting lists ${inbox === 1 ? 'it' : 'them'}.`);
  if (hidden.length > 0) closing.push(`Not shown, because this person's role does not include them: ${hidden.join(', ')}.`);

  if (total === 0) {
    return [`Nothing is waiting${filters ? ` (${filters})` : ''}: every document this person can see is either finished or not begun.`, ...closing].join(NL);
  }
  return [
    `${plural(total, 'document')} ${total === 1 ? 'is' : 'are'} waiting, in ${plural(kinds, 'group')}${filters ? ` (${filters})` : ''} — oldest first in each. A document in one of these statuses has changed NOTHING in the books yet.`,
    '',
    sections.join(`${NL}${NL}`),
    ...(closing.length > 0 ? ['', ...closing] : []),
    '',
    'To see whether one would go through, check it (review_document); to move it, document_step — after the person says yes.',
  ].join(NL);
}

// ---------------------------------------------------------------------------
// One document, checked
// ---------------------------------------------------------------------------

interface Findings {
  readonly blockers: string[];
  readonly warnings: string[];
  readonly fine: string[];
}

const ENDS = new Set(['posted', 'settled', 'partially_executed', 'executed', 'reversed', 'cancelled', 'closed']);

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * May this date be posted into? — `periods.authorisePosting`, as the posting
 * engine calls it for an operational document (no override) and as
 * `journal.submit` calls it for a journal (a Finance Manager's, with a reason).
 */
async function checkPeriod(tx: Tx, date: string, found: Findings, what: 'document' | 'journal'): Promise<void> {
  if (!date) return;
  const [period] = await tryRows(tx, sql`select p.name, p.status::text as status from fiscal_period p where p.starts_on <= ${date}::date and p.ends_on >= ${date}::date limit 1`);
  if (!period) {
    found.blockers.push(`No accounting period covers ${date}, so nothing can post on that date. The fiscal year has to be opened first (Accounting → Accounting Periods), or the date moved.`);
    return;
  }
  if (period.status === 'closed') {
    found.blockers.push(`${date} is in ${text(period.name)}, which is CLOSED. A closed period is final: the date has to move into an open period.`);
  } else if (period.status === 'soft_closed') {
    found.blockers.push(
      what === 'journal'
        ? `${date} is in ${text(period.name)}, which is SOFT-CLOSED. Only a Finance Manager may submit a journal into it, and only with a reason; anybody else is refused.`
        : `${date} is in ${text(period.name)}, which is SOFT-CLOSED. A document does not post into a soft-closed period — only a Finance Manager's approved journal may. The period has to be reopened, or the date moved.`,
    );
  } else {
    found.fine.push(`the period (${text(period.name)}) is open`);
  }
}

/** A date nobody meant: tomorrow's, or one from two months back. */
function checkDate(date: string, today: string, label: string, found: Findings): void {
  if (!date) return;
  const ahead = daysBetween(today, date);
  if (ahead > 0) found.warnings.push(`It is ${label} ${date}, which is ${plural(ahead, 'day')} in the FUTURE.`);
  else if (-ahead > 60) found.warnings.push(`It is ${label} ${date}, ${-ahead} days back. A date that old is usually a slip of the year or the month.`);
  else found.fine.push(`the date (${date}) is a sensible one`);
}

/** A draft that has sat for more than a week is usually a forgotten one. */
function checkAge(doc: Row, today: string, found: Findings): void {
  if (text(doc.status) !== 'draft' || !doc.created_at) return;
  const at = new Date(text(doc.created_at));
  if (Number.isNaN(at.getTime())) return;
  const age = daysBetween(businessDateOf(at), today);
  if (age > 7) found.warnings.push(`It has been a draft for ${age} days. Either it is forgotten or it should be cancelled.`);
}

/** The customer or supplier: usable, and — for a customer — not over what they may owe. */
async function checkParty(tx: Tx, id: string, side: 'supplier' | 'customer', found: Findings, addingIqd: bigint | null): Promise<void> {
  if (!id) return;
  const [party] = await tryRows(
    tx,
    sql`select code, legal_name, status::text as status, active, on_credit_hold, credit_hold_reason, credit_limit_iqd::text as credit_limit from business_partner where id = ${id}`,
  );
  if (!party) return;
  const who = `${text(party.code)} · ${text(party.legal_name)}`;
  let clean = true;
  if (party.status !== 'active' || party.active === false) {
    clean = false;
    found.warnings.push(
      `The ${side} ${who} is ${party.active === false ? 'switched off' : text(party.status).replace(/_/g, ' ')}${party.status === 'prospect' ? ' — not approved yet (approve_partner)' : ''}. This document still goes through, but they cannot be chosen on anything new.`,
    );
  }
  if (side === 'customer') {
    if (party.on_credit_hold) {
      clean = false;
      found.warnings.push(`The customer ${who} is on CREDIT HOLD${party.credit_hold_reason ? ` ("${text(party.credit_hold_reason).slice(0, 120)}")` : ''}. A sales order to them would be refused; a direct invoice is not, so it is somebody's decision.`);
    }
    const limit = party.credit_limit ? parseDecimal(text(party.credit_limit), 4n) : 0n;
    if (limit > 0n && addingIqd !== null) {
      const [open] = await tryRows(
        tx,
        sql`select coalesce(sum(i.net_iqd - i.allocated_iqd), 0)::numeric(19,4)::text as owed from ar_invoice i where i.customer_id = ${id} and i.status::text in ('posted', 'partially_executed')`,
      );
      const owed = parseDecimal(text(open?.owed) || '0', 4n);
      if (owed + addingIqd > limit) {
        clean = false;
        found.warnings.push(
          `Over the credit limit: ${who} already owes ${money(toDecimalString(owed, 4n))} IQD, this invoice adds ${money(toDecimalString(addingIqd, 4n))}, and their limit is ${money(toDecimalString(limit, 4n))} IQD.`,
        );
      }
    }
  }
  if (clean) found.fine.push(`the ${side} (${text(party.code)}) is active${side === 'customer' ? ', not on hold and within their limit' : ''}`);
}

/** Does a rule give this role an account for this event — `posting.post`'s first question. */
async function mapped(tx: Tx, eventType: string, role: string): Promise<boolean> {
  const rows = await tryRows(tx, sql`select 1 as one from posting_rule where event_type = ${eventType} and line_role = ${role} and is_active limit 1`);
  return rows.length > 0;
}

// ── a purchase invoice — `ap-invoice.submit` / `post` ──
async function reviewPurchaseInvoice(tx: Tx, doc: Row, today: string, found: Findings): Promise<void> {
  const id = text(doc.id);
  const lines = await tryRows(
    tx,
    sql`select l.line_no, l.item_code, l.description, l.quantity::text as quantity, l.unit_price::text as unit_price, l.discount_iqd::text as discount, l.is_inventory, l.warehouse_code,
               i.inventory_account_id::text as inventory_account, i.tracking::text as tracking
          from ap_invoice_line l left join item i on i.code = l.item_code
         where l.ap_invoice_id = ${id} order by l.line_no`,
  );
  if (lines.length === 0) {
    found.blockers.push('It has no lines: an invoice with no lines charges nothing, and cannot be posted.');
  } else {
    let total = 0n;
    for (const line of lines) {
      const qty = parseQuantity(text(line.quantity) || '0');
      const price = parseDecimal(text(line.unit_price) || '0', 4n);
      total += divideHalfUp(qty * price, QUANTITY_FACTOR) - parseDecimal(text(line.discount) || '0', 4n);
      const name = text(line.item_code) || text(line.description);
      if (qty === 0n) found.warnings.push(`Line ${text(line.line_no)} (${name}) has a quantity of zero.`);
      if (price === 0n) found.warnings.push(`Line ${text(line.line_no)} (${name}) has a unit price of zero — it brings the goods in at no cost.`);
      // `inventoryAccountFor` and `batchFor`: what receiving a stock line at posting refuses.
      if (line.warehouse_code && line.item_code) {
        if (!line.inventory_account) found.blockers.push(`Line ${text(line.line_no)}: item ${text(line.item_code)} names no inventory account, so its stock has nowhere to be held. Set one on the item.`);
        if (line.tracking === 'serial' || line.tracking === 'serial_and_batch') {
          found.blockers.push(`Line ${text(line.line_no)}: item ${text(line.item_code)} is tracked by serial number, which an invoice does not carry. It has to come in on a Goods Receipt.`);
        }
      }
    }
    found.fine.push(`${plural(lines.length, 'line')}, total ${money(toDecimalString(total, 4n))} IQD`);

    // The same charge keyed twice under two of our numbers: the same supplier,
    // the same date, and line for line the same items, quantities and prices.
    // (The same total alone is not enough — four at 10,000 is not two at 20,000.)
    const signature = (of: SQL) =>
      sql`(select coalesce(string_agg(coalesce(l.item_code, l.description) || ' ' || l.quantity::text || ' ' || l.unit_price::text || ' ' || l.discount_iqd::text, '|' order by coalesce(l.item_code, l.description), l.quantity, l.unit_price), '') from ap_invoice_line l where l.ap_invoice_id = ${of})`;
    const twins = await tryRows(
      tx,
      sql`select o.invoice_no, o.status::text as status
            from ap_invoice o
           where o.supplier_id = ${text(doc.supplier_id)} and o.id <> ${id} and o.invoice_date = ${day(doc.invoice_date)}::date
             and o.status::text not in ('cancelled', 'reversed', 'rejected')
             and ${signature(sql`o.id`)} = ${signature(sql`${id}`)}
           order by o.invoice_no limit 3`,
    );
    if (twins.length > 0) {
      found.warnings.push(
        `It looks entered twice: ${twins.map((twin) => `${text(twin.invoice_no)} (${text(twin.status)})`).join(', ')} ${twins.length === 1 ? 'is' : 'are'} from the same supplier, on the same date, with the same lines.`,
      );
    }
  }

  // §15 — the supplier's own number, twice (`DuplicateSupplierInvoiceError` at entry; accepted only with a reason).
  const theirs = text(doc.supplier_invoice_no).trim();
  if (theirs && theirs !== text(doc.invoice_no)) {
    const same = await tryRows(
      tx,
      sql`select o.invoice_no, o.status::text as status from ap_invoice o where o.supplier_id = ${text(doc.supplier_id)} and o.supplier_invoice_no = ${theirs} and o.id <> ${id} order by o.invoice_no limit 3`,
    );
    if (same.length > 0) {
      found.warnings.push(`The supplier's invoice number "${theirs}" is already on ${same.map((one) => `${text(one.invoice_no)} (${text(one.status)})`).join(', ')}. The same number from the same supplier is nearly always the same invoice.`);
    } else found.fine.push(`the supplier's number "${theirs}" is on no other invoice of theirs`);
  }

  // A price far from the last one paid for the same item.
  const prices = await tryRows(
    tx,
    sql`select l.line_no, l.item_code, l.unit_price::text as unit_price, last.unit_price::text as last_price, last.invoice_no as last_no, last.invoice_date::text as last_date
          from ap_invoice_line l
          join lateral (
                 select pl.unit_price, pi.invoice_no, pi.invoice_date
                   from ap_invoice_line pl join ap_invoice pi on pi.id = pl.ap_invoice_id
                  where pl.item_code = l.item_code and pi.id <> ${id} and pi.status::text in ('posted', 'partially_executed', 'settled') and pl.unit_price > 0
                  order by pi.invoice_date desc, pi.posted_at desc nulls last
                  limit 1) last on true
         where l.ap_invoice_id = ${id} and l.item_code is not null and l.unit_price > 0
           and abs(l.unit_price - last.unit_price) > last.unit_price * 0.30
         order by l.line_no`,
  );
  for (const row of prices) {
    found.warnings.push(
      `Line ${text(row.line_no)} (${text(row.item_code)}) is priced at ${money(text(row.unit_price))}, and the last purchase was at ${money(text(row.last_price))} (${text(row.last_no)}, ${day(row.last_date)}) — more than 30% apart.`,
    );
  }
  if (prices.length === 0 && lines.some((line) => line.item_code)) found.fine.push('no price is more than 30% from the last purchase of its item');

  const due = day(doc.due_date);
  const dated = day(doc.invoice_date);
  if (!due) found.warnings.push('It has no due date, so the payables ageing cannot say when it falls due.');
  else if (due === dated) found.warnings.push(`The due date is the invoice date (${dated}): it will show as due at once. If the supplier gave terms, the real date is set on its page.`);
  else if (due < dated) found.warnings.push(`The due date (${due}) is BEFORE the invoice date (${dated}).`);
  else found.fine.push(`due ${due}`);

  const currency = (text(doc.agreed_currency) || text(doc.currency) || 'IQD').trim();
  if (doc.is_import === true && currency === 'IQD') found.warnings.push('It is marked as an IMPORT and priced in IQD. An import is normally in the supplier’s currency — check which of the two is wrong.');
  if (doc.is_import !== true && currency !== 'IQD') found.warnings.push(`It is a local purchase priced in ${currency}. A purchase in a foreign currency is normally an import (it opens the import application the goods are tracked on).`);

  // `post`: the variances the match raised have to be approved first (`VarianceNotApprovedError`).
  const open = await tryRows(tx, sql`select kind::text as kind, difference::text as difference from ap_match_exception where ap_invoice_id = ${id} and resolved_at is null order by raised_at limit 4`);
  if (open.length > 0) {
    found.blockers.push(`${plural(open.length, 'match variance')} ${open.length === 1 ? 'is' : 'are'} not approved (${open.map((one) => `${text(one.kind).replace(/_/g, ' ')} ${money(text(one.difference))}`).join('; ')}). Posting is refused until somebody other than whoever entered the invoice approves them, with a reason.`);
  } else found.fine.push('no match variance is open');

  if (!doc.payable_account_id && !(await mapped(tx, 'purchasing.ap_invoice', 'supplier_payable'))) {
    found.blockers.push('No account is mapped for what is owed to the supplier (supplier_payable on Purchase Invoice): posting has nowhere to put the credit. Accounting → Posting Mappings.');
  }
}

// ── a sales invoice — `ar-invoice.post` ──
async function reviewSalesInvoice(tx: Tx, doc: Row, found: Findings): Promise<void> {
  const id = text(doc.id);
  const lines = await tryRows(
    tx,
    sql`select l.line_no, l.item_code, l.quantity::text as quantity, l.unit_price::text as unit_price, l.net_iqd::text as net, l.warehouse_code, l.supplier_id::text as supplier_id,
               i.inventory_account_id::text as inventory_account, i.cogs_account_id::text as cogs_account, (i.code is not null) as item_exists
          from ar_invoice_line l left join item i on i.code = l.item_code
         where l.ar_invoice_id = ${id} order by l.line_no`,
  );
  if (lines.length === 0) {
    found.blockers.push('It has no lines: there is nothing to sell, and posting it would write an empty entry.');
    return;
  }

  // FIFO, as `post` will take it: the oldest layers first, one pool per item and warehouse,
  // narrowed to one supplier's stock where the line names one. Read once, consumed in memory.
  const pools = new Map<string, { remaining: bigint; cost: bigint; supplier: string }[]>();
  let short = 0;
  let belowCost = 0;
  for (const line of lines) {
    const name = text(line.item_code);
    const qty = parseQuantity(text(line.quantity) || '0');
    const price = parseDecimal(text(line.unit_price) || '0', 4n);
    if (qty === 0n) found.warnings.push(`Line ${text(line.line_no)} (${name}) has a quantity of zero.`);
    if (price === 0n) found.warnings.push(`Line ${text(line.line_no)} (${name}) has a unit price of zero — the goods leave and nothing is charged.`);
    if (line.item_exists === false) {
      found.blockers.push(`Line ${text(line.line_no)} names no item '${name}'.`);
      continue;
    }
    if (!line.warehouse_code) continue;
    const warehouse = text(line.warehouse_code);
    // `stockAccountsFor`: the two accounts the cost goes between.
    if (!line.inventory_account) found.blockers.push(`Line ${text(line.line_no)} sells ${name}, which names no inventory account. Set one on the item.`);
    if (!line.cogs_account) found.blockers.push(`Line ${text(line.line_no)} sells ${name}, which names no COGS account, so its cost has nowhere to go. Set one on the item.`);

    const key = `${name}|${warehouse}`;
    if (!pools.has(key)) {
      const layers = await tryRows(
        tx,
        sql`select remaining_quantity::text as remaining, unit_cost_iqd::text as cost, coalesce(supplier_id::text, '') as supplier
              from cost_layer where item_code = ${name} and warehouse_code = ${warehouse} and remaining_quantity > 0
             order by layer_date, sequence`,
      );
      pools.set(key, layers.map((layer) => ({ remaining: parseQuantity(text(layer.remaining)), cost: parseDecimal(text(layer.cost), 4n), supplier: text(layer.supplier) })));
    }
    const pool = pools.get(key)!.filter((layer) => !line.supplier_id || layer.supplier === text(line.supplier_id));
    const held = pool.reduce((sum, layer) => sum + layer.remaining, 0n);
    let outstanding = qty;
    let cost = 0n;
    for (const layer of pool) {
      if (outstanding === 0n) break;
      const take = layer.remaining < outstanding ? layer.remaining : outstanding;
      cost += divideHalfUp(take * layer.cost, QUANTITY_FACTOR);
      layer.remaining -= take;
      outstanding -= take;
    }
    if (outstanding > 0n) {
      short += 1;
      found.blockers.push(
        `Line ${text(line.line_no)} sells ${quantity(text(line.quantity))} of ${name} and ${warehouse} holds ${quantity(toDecimalString(held, 6n))}${line.supplier_id ? ' of that supplier’s stock' : ''} — ${quantity(toDecimalString(outstanding, 6n))} short. Negative stock is not allowed: posting is refused until the stock is brought in (a purchase invoice or goods receipt posted, or opening stock approved).`,
      );
    } else if (qty > 0n && cost > 0n) {
      const unitCost = divideHalfUp(cost * QUANTITY_FACTOR, qty);
      if (price < unitCost) {
        belowCost += 1;
        found.warnings.push(`Line ${text(line.line_no)} sells ${name} at ${money(toDecimalString(price, 4n))} each, BELOW its cost: the stock it will take cost ${money(toDecimalString(unitCost, 4n))} each (FIFO).`);
      }
    }
  }
  if (short === 0) found.fine.push('every line has its stock in its warehouse');
  if (belowCost === 0 && short === 0) found.fine.push('no line sells below its FIFO cost');

  const due = day(doc.due_date);
  const dated = day(doc.invoice_date);
  if (!due) found.warnings.push('It has no due date, so the receivables ageing cannot say when it falls due.');
  else if (due === dated) found.warnings.push(`The due date is the invoice date (${dated}): it will show as overdue from tomorrow. If the customer has terms, set the real date.`);
  else if (due < dated) found.warnings.push(`The due date (${due}) is BEFORE the invoice date (${dated}).`);
  else found.fine.push(`due ${due}`);

  if (!doc.receivable_account_id && !(await mapped(tx, 'sales.ar_invoice', 'customer_receivable'))) {
    found.blockers.push('No account is mapped for what the customer owes (customer_receivable on Sales Invoice): posting has nowhere to put the debit. Accounting → Posting Mappings.');
  }
}

// ── a journal entry — `journal.submit` (`assertJournalValid`, `assertPostable`) ──
async function reviewJournal(tx: Tx, principal: Principal, doc: Row, found: Findings): Promise<void> {
  const id = text(doc.id);
  const lines = await tryRows(
    tx,
    sql`select l.line_no, l.debit_iqd::text as debit, l.credit_iqd::text as credit, l.branch_code,
               a.code, a.name, a.is_group, a.is_active, a.approval_status::text as approval, a.control_account::text as control
          from journal_line l join chart_of_account a on a.id = l.account_id
         where l.journal_entry_id = ${id} order by l.line_no`,
  );
  if (lines.length < 2) {
    found.blockers.push(`It has ${plural(lines.length, 'line')}. A journal needs at least two — one debit and one credit — or it cannot balance.`);
  }
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    debits += parseDecimal(text(line.debit) || '0', 4n);
    credits += parseDecimal(text(line.credit) || '0', 4n);
    const account = `${text(line.code)} · ${text(line.name)}`;
    if (line.approval !== 'approved') found.blockers.push(`Line ${text(line.line_no)}: ${account} is still '${text(line.approval)}'. An account accepts entries only once it has been approved.`);
    else if (line.is_active === false) found.blockers.push(`Line ${text(line.line_no)}: ${account} is inactive. An inactive account accepts no new entries.`);
    else if (line.is_group) found.blockers.push(`Line ${text(line.line_no)}: ${account} is a heading. Nothing posts to a heading; it has to be an account under it.`);
    if (line.control) found.warnings.push(`Line ${text(line.line_no)} posts by hand to ${account}, the ${text(line.control)} control account. That is normally written by its own documents, and a hand entry there makes the ${text(line.control)} statements disagree with the ledger.`);
    if (line.branch_code && doc.branch_code && line.branch_code !== doc.branch_code) found.blockers.push(`Line ${text(line.line_no)} is in branch ${text(line.branch_code)} and the journal is in ${text(doc.branch_code)}. A journal belongs to one branch.`);
  }
  if (lines.length >= 2) {
    if (debits === 0n && credits === 0n) found.blockers.push('It totals zero. An entry that moves nothing has no effect — it is cancelled, not posted.');
    else if (debits !== credits) {
      const out = debits > credits ? debits - credits : credits - debits;
      found.blockers.push(`It does not balance: debits ${money(toDecimalString(debits, 4n))}, credits ${money(toDecimalString(credits, 4n))} — out by ${money(toDecimalString(out, 4n))}.`);
    } else found.fine.push(`${plural(lines.length, 'line')}, debits ${money(toDecimalString(debits, 4n))} = credits`);
  }
  if (lines.length > 0 && !lines.some((line) => line.is_group || line.is_active === false || line.approval !== 'approved')) found.fine.push('every account is approved, active and takes postings');

  const posting = day(doc.posting_date);
  const document = day(doc.document_date);
  if (posting && document && posting < document) found.blockers.push(`The posting date ${posting} is before the document date ${document}.`);
  if (!text(doc.description).trim()) found.warnings.push('It has no description: whoever reads the ledger later will not know what it was for.');

  // §14 — journals belong to the Finance department (`assertFinanceDepartment`), asked of whoever submits.
  if (text(doc.status) === 'draft') {
    const finance = await tryRows(tx, sql`select 1 as one from user_department_scope s join department d on d.code = s.department_code where s.user_id = ${principal.userId} and d.is_finance limit 1`);
    if (finance.length === 0) found.blockers.push('Submitting it is for the Finance department, and this person is not in it: their own submit would be refused. Somebody in Finance submits it.');
  }
}

/**
 * The `review_document` reading: would the next step go through, and is
 * anything about the document odd.
 *
 * BLOCKERS are what the document's own service would refuse; WARNINGS are
 * legal and worth a second look; FINE is what was checked and found in order.
 */
export async function reviewDocument(tx: Tx, principal: Principal, raw: string, baseUrl: string): Promise<string> {
  const no = tidyNumber(raw);
  if (!no) return 'Which document? Give its number.';
  const family = familyOf(no);
  if (!family) {
    return `I cannot tell what kind of document ${no} is from its number. The kinds I can check: ${DOCUMENT_FAMILIES.map((one) => `${one.label} (${one.prefix}-…)`).join(', ')}.`;
  }
  if (!can(principal, 'view', viewObject(family.key))) {
    return `This person's role does not include "${family.label}" (the permission view on ${viewObject(family.key)}), so it is not theirs to see. Tell them so, and that an administrator gives it on Settings → Administration → Roles.`;
  }
  const register = REGISTERS[family.key];
  const [header] = await rowsOf(tx, sql`select to_jsonb(t) as row from ${sql.identifier(register.table)} t where upper(t.${sql.identifier(register.number)}) = ${no} limit 1`);
  const doc = header?.row as Row | undefined;
  if (!doc) return `There is no ${family.label} ${no} that this person can see.`;

  const status = text(doc.status);
  const href = recordHref(family.key, no);
  const head = `${no} · ${family.label} · status: ${status.replace(/_/g, ' ').toUpperCase()}${doc.branch_code ? ` · branch ${text(doc.branch_code)}` : ''}`;
  if (ENDS.has(status) || !(status in register.waits)) {
    return [
      head,
      `It is already ${status.replace(/_/g, ' ')}: there is no step left to check it before. What it wrote is document_story's to say.`,
      ...(href ? [`its page: ${baseUrl}${href}`] : []),
    ].join(NL);
  }

  const today = businessToday();
  const found: Findings = { blockers: [], warnings: [], fine: [] };
  const date = day(doc[register.date]);

  if (family.key === 'ap_invoice') await reviewPurchaseInvoice(tx, doc, today, found);
  else if (family.key === 'ar_invoice') await reviewSalesInvoice(tx, doc, found);
  else if (family.key === 'journal_entry') await reviewJournal(tx, principal, doc, found);
  else if (family.key === 'opening_stock') {
    const [lines] = await tryRows(tx, sql`select count(*)::int as n, count(*) filter (where unit_cost_iqd = 0)::int as free from opening_stock_line where opening_stock_id = ${text(doc.id)}`);
    if (lines && Number(lines.n) === 0) found.blockers.push('It has no lines: there is no stock on it to bring in.');
    else if (lines) {
      found.fine.push(plural(Number(lines.n), 'line'));
      if (Number(lines.free) > 0) found.warnings.push(`${plural(Number(lines.free), 'line')} ${Number(lines.free) === 1 ? 'has' : 'have'} a unit cost of zero: that stock comes in worth nothing, and every sale of it shows no cost.`);
    }
  } else if (family.key === 'purchase_order' || family.key === 'goods_receipt') {
    const table = family.key === 'purchase_order' ? 'purchase_order_line' : 'goods_receipt_line';
    const key = family.key === 'purchase_order' ? 'purchase_order_id' : 'goods_receipt_id';
    const [lines] = await tryRows(tx, sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(key)} = ${text(doc.id)}`);
    if (lines && Number(lines.n) === 0) found.blockers.push('It has no lines.');
    else if (lines) found.fine.push(plural(Number(lines.n), 'line'));
  } else if (family.key === 'supplier_payment' || family.key === 'customer_receipt' || family.key === 'bank_transfer') {
    const amount = family.key === 'bank_transfer' ? doc.amount : doc.amount_iqd;
    if (!some(amount)) found.warnings.push('Its amount is zero.');
    else found.fine.push(`amount ${money(text(amount))}${family.key === 'bank_transfer' ? ` ${text(doc.from_currency).trim()}` : ' IQD'}`);
  }

  // What every family is asked.
  if (register.posts) await checkPeriod(tx, date, found, family.key === 'journal_entry' ? 'journal' : 'document');
  checkDate(date, today, family.key === 'journal_entry' ? 'to post on' : 'dated', found);
  checkAge(doc, today, found);
  if (register.party && doc[register.party.column]) {
    const adding = family.key === 'ar_invoice' && doc.net_iqd !== null && doc.net_iqd !== undefined ? parseDecimal(text(doc.net_iqd), 4n) : null;
    await checkParty(tx, text(doc[register.party.column]), register.party.side, found, adding);
  }

  const verdict =
    found.blockers.length > 0
      ? `VERDICT: it would be REFUSED as it stands — ${plural(found.blockers.length, 'blocker')}${found.warnings.length > 0 ? `, ${plural(found.warnings.length, 'warning')}` : ''}.`
      : found.warnings.length > 0
        ? `VERDICT: nothing blocks it, and ${plural(found.warnings.length, 'thing')} ${found.warnings.length === 1 ? 'is' : 'are'} worth a second look first.`
        : 'VERDICT: nothing blocks it and nothing looks odd.';

  return [
    head,
    ...(href ? [`its page: ${baseUrl}${href}`] : []),
    verdict,
    '',
    found.blockers.length > 0 ? `BLOCKERS — the system would refuse the step (${found.blockers.length}):` : 'BLOCKERS: none found.',
    ...found.blockers.map((line) => `✗ ${line}`),
    '',
    found.warnings.length > 0 ? `WARNINGS — allowed, and worth a second look (${found.warnings.length}):` : 'WARNINGS: none.',
    ...found.warnings.map((line) => `! ${line}`),
    '',
    `FINE — checked and in order: ${found.fine.length > 0 ? found.fine.join('; ') : 'nothing beyond what is above'}.`,
    '',
    `NEXT: ${register.next[status] ?? 'see its page.'} Who may take it is decided when it runs — their permission, and whether they raised it.`,
    'These are the checks that can be made by reading. The step itself asks more — the permission of whoever takes it, and anything that changes before then.',
  ].join(NL);
}
