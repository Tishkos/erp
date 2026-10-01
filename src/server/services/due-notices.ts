import type { Tx } from '../db/client';
import { daysBetween } from '../domain/ageing';
import type { Principal } from '../domain/permissions';
import * as notifications from './notifications';
import * as openItems from './open-items';

/**
 * Telling people what is about to fall due, and what already has — §15, §16, §21.
 *
 * ── Why this is a sweep and not an event ──────────────────────────────────
 * "Approved" is something that happens; "due tomorrow" is something that
 * becomes true while nobody is looking. There is no moment to hang a trigger
 * on, so the state is read once a day and whatever is true that morning is
 * raised. That is also why the notification carries the date it was raised
 * for: two sweeps on the same day must produce one notice, and the day after
 * must produce a new one.
 *
 * `occurrence` is the day, which makes `dedupeKeyFor` — rule, object, id,
 * occurrence, recipient — collapse a repeat within the day and let tomorrow
 * through. Job delivery is at-least-once (01.10), so a repeat is the normal
 * consequence of a retry rather than an edge case.
 *
 * ── Why one notice per invoice and not one per customer ───────────────────
 * A person acts on an invoice: they ring somebody about *that* one, and the
 * notification links to it. A digest saying "four customers owe you money"
 * links nowhere and is read once.
 *
 * The cost is volume, which is why "due soon" is a week and not a month: a
 * horizon long enough to act on, short enough that the same invoice is not
 * announced thirty mornings running before it is even late.
 */

/**
 * How far ahead "soon" reaches — the report's horizon, not a second one.
 *
 * Re-exported rather than restated so that a notification calling an invoice
 * "due soon" and the Account Statement listing it under "falling due soon"
 * cannot come to mean different weeks.
 */
export const DUE_SOON_DAYS = openItems.DUE_SOON_DAYS;

export interface NoticeRun {
  readonly asOf: string;
  readonly dueSoon: number;
  readonly dueToday: number;
  readonly overdue: number;
  /** Raised minus suppressed — what actually reached somebody. */
  readonly created: number;
  readonly suppressed: number;
}

const EVENT = {
  customer: {
    objectType: 'ar_invoice',
    due_soon: 'ar_invoice.due_soon',
    due_today: 'ar_invoice.due_today',
    overdue: 'ar_invoice.overdue',
  },
  supplier: {
    objectType: 'ap_invoice',
    due_soon: 'ap_invoice.due_soon',
    due_today: 'ap_invoice.due_today',
    overdue: 'ap_invoice.overdue',
  },
} as const;

/**
 * One morning's notices, both sides.
 *
 * Reads through `open-items.ts`, so what a notification says about an invoice
 * is what the Receivables screen says about it. A sweep with its own query
 * would eventually announce an invoice the report considered settled.
 */
export async function raiseDueNotices(
  tx: Tx,
  principal: Principal,
  asOf: string,
  filter: { readonly branchCode?: string | null } = {},
): Promise<NoticeRun> {
  let dueSoon = 0;
  let dueToday = 0;
  let overdue = 0;
  let created = 0;
  let suppressed = 0;

  for (const side of ['customer', 'supplier'] as const) {
    const events = EVENT[side];
    const items = await openItems.openItems(tx, principal, side, asOf, {
      ...filter,
      outstandingOnly: true,
    });

    for (const item of items) {
      const untilDue = daysBetween(asOf, item.dueDate);

      // Exactly one of the three, so an invoice is never announced twice on
      // the same morning under two headings.
      const kind =
        untilDue < 0 ? 'overdue' : untilDue === 0 ? 'due_today' : untilDue <= DUE_SOON_DAYS ? 'due_soon' : null;
      if (kind === null) continue;

      if (kind === 'overdue') overdue += 1;
      else if (kind === 'due_today') dueToday += 1;
      else dueSoon += 1;

      const outcome = await notifications.raise(
        tx,
        {
          eventType: events[kind],
          objectType: events.objectType,
          objectId: item.invoiceId,
          // The day, so one notice per invoice per morning — and a fresh one
          // tomorrow, because tomorrow it is a day later.
          occurrence: asOf,
        },
        {
          reference: item.invoiceNo,
          party: `${item.partyName} (${item.partyCode})`,
          due_date: item.dueDate,
          outstanding: item.outstandingIqd,
          ...(kind === 'overdue'
            ? { days_overdue: item.daysOverdue }
            : { days_until_due: untilDue }),
          // Where to go. §21's notices link to the thing rather than describe it.
          link:
            side === 'customer'
              ? `/sales/ar-invoices/${item.invoiceNo}`
              : `/payables/invoices/${item.invoiceNo}`,
        },
        { branchCode: filter.branchCode ?? null },
      );
      created += outcome.created;
      suppressed += outcome.suppressed;
    }
  }

  return { asOf, dueSoon, dueToday, overdue, created, suppressed };
}

/**
 * Money arrived, or money went out.
 *
 * Raised by the document that posted, not by the sweep: this one *is* an
 * event, and a receipt the treasury banked at ten o'clock should not wait
 * until tomorrow morning to be mentioned.
 */
export async function announceSettlement(
  tx: Tx,
  input: {
    readonly side: openItems.Side;
    readonly documentId: string;
    readonly documentNo: string;
    readonly partyName: string | null;
    readonly amountIqd: string;
    readonly branchCode: string | null;
    readonly link: string;
  },
): Promise<void> {
  const eventType =
    input.side === 'customer' ? 'customer_receipt.received' : 'supplier_payment.made';
  const objectType = input.side === 'customer' ? 'customer_receipt' : 'supplier_payment';

  await notifications.raise(
    tx,
    { eventType, objectType, objectId: input.documentId, occurrence: 'posted' },
    {
      reference: input.documentNo,
      party: input.partyName ?? '—',
      amount: input.amountIqd,
      link: input.link,
    },
    { branchCode: input.branchCode },
  );
}

/**
 * An invoice settled after the date it was due.
 *
 * Not a chase — the money is in. It is the record of how an account actually
 * behaves, which is the thing a credit controller cannot get from a list of
 * what is currently overdue: a customer who always pays eleven days late never
 * appears on an overdue report for long enough to notice.
 */
export async function announcePaidLate(
  tx: Tx,
  input: {
    readonly side: openItems.Side;
    readonly invoiceId: string;
    readonly invoiceNo: string;
    readonly partyName: string | null;
    readonly dueDate: string;
    readonly paidOn: string;
    readonly branchCode: string | null;
    readonly link: string;
  },
): Promise<void> {
  const daysLate = daysBetween(input.dueDate, input.paidOn);
  if (daysLate <= 0) return; // paid on time is not news

  await notifications.raise(
    tx,
    {
      eventType: input.side === 'customer' ? 'ar_invoice.paid_late' : 'ap_invoice.paid_late',
      objectType: input.side === 'customer' ? 'ar_invoice' : 'ap_invoice',
      objectId: input.invoiceId,
      occurrence: `settled:${input.paidOn}`,
    },
    {
      reference: input.invoiceNo,
      party: input.partyName ?? '—',
      due_date: input.dueDate,
      paid_on: input.paidOn,
      days_late: daysLate,
      link: input.link,
    },
    { branchCode: input.branchCode },
  );
}
