/**
 * What the posting engine asks the chart for — Appendix C, §3.3.
 *
 * §3.3: "Automatic posting is driven by configurable mappings; the posting
 * engine never chooses an account on its own." That is honoured everywhere —
 * and it left the system with a rule it could state but nobody could satisfy:
 * a document reached `post`, found no mapping, and said so in a sentence
 * pointing at a screen that had never been built.
 *
 * This is the list that screen shows. Each entry is a line the engine really
 * asks for, read from the service that posts it rather than from the
 * blueprint, because the blueprint describes the intention and the service is
 * what will run.
 *
 * ── What is not here ───────────────────────────────────────────────────────
 * A line whose account is a property of the document or a master record: the
 * bank a receipt landed in, the inventory account named on the item, the cost
 * of sales account the item carries. Those are answered once, on the record,
 * and a mapping for them would be a second answer that could disagree.
 */
import type { AccountNode } from './chart-of-accounts';

export interface MappedLine {
  /** The role the posting engine names when it asks for an account. */
  readonly role: string;
  /**
   * True when no document of this kind can post without it.
   *
   * The rest belong to routes a particular document may not take — an invoice
   * with no purchase order never clears GRNI, and one that matches its order
   * exactly posts no variance. They are still worth setting before the day
   * they are needed, which is why they are listed rather than hidden.
   */
  readonly always: boolean;
  readonly controlAccount?: 'customer' | 'supplier';
}

export interface MappedDocument {
  /** The event type the posting engine posts under. */
  readonly event: string;
  readonly lines: readonly MappedLine[];
}

const line = (
  role: string,
  always = false,
  controlAccount?: 'customer' | 'supplier',
): MappedLine => ({ role, always, ...(controlAccount ? { controlAccount } : {}) });

export const POSTING_MAP: readonly MappedDocument[] = Object.freeze([
  {
    event: 'purchasing.ap_invoice',
    lines: [
      // What the company now owes. Every purchase invoice credits it.
      line('supplier_payable', true, 'supplier'),
      // The goods-receipt route: the receipt debited GRNI, the invoice clears
      // it. An invoice that receives its own stock debits the item's account
      // instead and never comes here.
      line('grni'),
      // A service line — nothing was received into a warehouse.
      line('expense'),
      // §8.4 — the difference between what was ordered and what was billed,
      // which never goes into the value of the stock.
      line('purchase_variance'),
    ],
  },
  {
    event: 'sales.ar_invoice',
    lines: [line('customer_receivable', true, 'customer'), line('sales_revenue')],
  },
  {
    event: 'sales.customer_receipt',
    lines: [
      // Money in against a named customer.
      line('customer_receivable', true),
      // Money in that no customer has been put to yet — it waits here rather
      // than being guessed at.
      line('customer_clearing'),
    ],
  },
  {
    event: 'sales.customer_receipt_identified',
    lines: [line('customer_clearing', true), line('customer_receivable', true)],
  },
  {
    event: 'purchasing.supplier_payment',
    lines: [line('supplier_payable', true)],
  },
  {
    event: 'purchasing.supplier_credit_memo',
    lines: [line('supplier_payable', true), line('return_clearing', true)],
  },
  {
    event: 'sales.customer_credit_memo',
    lines: [line('customer_receivable', true), line('sales_returns', true)],
  },
]);

/** The catalogue as flat (event, role) pairs, in the order shown. */
export function mappedLines(): readonly (MappedLine & { event: string })[] {
  return POSTING_MAP.flatMap((document) =>
    document.lines.map((entry) => ({ event: document.event, ...entry })),
  );
}

export function requiredControlAccount(eventType: string, lineRole: string) {
  return POSTING_MAP.find((document) => document.event === eventType)
    ?.lines.find((entry) => entry.role === lineRole)?.controlAccount ?? null;
}

export function assertMappedControlAccount(
  eventType: string,
  lineRole: string,
  account: Pick<AccountNode, 'code' | 'controlAccount'>,
): void {
  const required = requiredControlAccount(eventType, lineRole);
  if (required && account.controlAccount !== required) {
    throw new Error(
      `${account.code} must be designated as a ${required} control account for ${eventType} / ${lineRole}. ` +
      'Set its control account in Chart of Accounts, then choose it in Posting Mappings so the journal and statement are posted together.',
    );
  }
}

export class InvalidSalesRevenueAccountError extends Error {
  readonly code = 'SALES_REVENUE_ACCOUNT_INVALID';
  constructor(code: string) {
    super(`${code} cannot receive sales revenue. Choose a Revenue posting account that is not a control account; customer balances belong on the receivable line.`);
    this.name = 'InvalidSalesRevenueAccountError';
  }
}
export function mappingAccountEligible(
  eventType: string,
  lineRole: string,
  account: Pick<AccountNode, 'accountType' | 'controlAccount'>,
): boolean {
  const required = requiredControlAccount(eventType, lineRole);
  return (!required || account.controlAccount === required) &&
    (eventType !== 'sales.ar_invoice' || lineRole !== 'sales_revenue' ||
      (account.accountType === 'revenue' && account.controlAccount === null));
}
export function assertMappedAccount(
  eventType: string,
  lineRole: string,
  account: Pick<AccountNode, 'code' | 'accountType' | 'controlAccount'>,
): void {
  assertMappedControlAccount(eventType, lineRole, account);
  if (!mappingAccountEligible(eventType, lineRole, account)) throw new InvalidSalesRevenueAccountError(account.code);
}

/**
 * A message key for an event type.
 *
 * The event is `module.document`, and a dot is the catalogue's own nesting, so
 * it is flattened rather than translated twice.
 */
export function eventKey(event: string): string {
  return event.replaceAll('.', '_');
}
