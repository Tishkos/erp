/**
 * The Account Statement — Operations build, blocks 2, 3 and 6 (2026-09-12).
 *
 * The sponsor asked for three, and described them as mirrors of one another:
 *
 *   Customer   sales are Debit; payments or discounts are Credit.
 *   Supplier   purchases are Credit; payments or discounts are Debit.
 *   Bank/Cash  incoming amounts are Debit; outgoing are Credit.
 *
 * They are not three reports. All three read the subledger the posting engine
 * already writes beside every journal, and each entry carries its own debit
 * and credit — an invoice debits the customer, a receipt credits them; an
 * invoice credits the supplier, a payment debits them; and the bank is
 * debited by what arrives and credited by what leaves. Nothing has to be
 * classified here, and nothing is re-derived from the document it came from.
 *
 * What differs is only which way the running balance is read:
 *
 *   a customer owes the company     balance = debits less credits
 *   the company owes a supplier     balance = credits less debits
 *   a bank account holds money      balance = debits less credits
 *
 * so each ends at a positive figure when there is something there — money
 * outstanding, or money in the account — which is how a person reading any of
 * them expects it to look. A bank reads the same way as a customer for the
 * same reason: both are debit-normal, and what is owed to you and what you
 * hold are the same kind of number.
 */
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  arInvoice,
  customerCreditMemo,
  customerReceipt,
  goodsReturn,
  journalEntry,
  subledgerEntry,
  supplierPayment,
} from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import * as trialBalance from './trial-balance';

/** Which side of the ledger the party sits on. */
export type PartySide = 'customer' | 'supplier' | 'bank';

/**
 * Which currency the statement is read in.
 *
 * §2.3 — the ledger is kept in IQD and USD is a way of *reading* it: the same
 * posted lines at the historical rate each one carried when it posted. Nothing
 * is converted at report time, so both readings of one statement are the
 * ledger rather than one of them an estimate.
 */
export type StatementCurrency = 'IQD' | 'USD';

/** The operational documents that reach a party's account. */
export type DocumentKind =
  | 'ar_invoice'
  | 'customer_receipt'
  | 'customer_credit_memo'
  | 'ap_invoice'
  | 'supplier_payment'
  | 'goods_return';

/** The document a line came from, as the person who raised it knows it. */
export interface StatementDocument {
  readonly kind: DocumentKind;
  readonly number: string;
  /**
   * When it falls due — invoices only.
   *
   * A statement that lists what is owed without saying when it was due makes
   * the reader open every line to find out which ones are late. Null on a
   * receipt, a payment or a return: those settle a debt rather than create
   * one, and a due date on them would be a date that means nothing.
   */
  readonly dueDate?: string | null;
}

export interface StatementLine {
  readonly postingDate: string;
  /** The journal this came from, for the drill-down. */
  readonly entryNo: string;
  readonly description: string | null;
  /** The invoice, receipt, payment or return behind it. Null for a manual journal. */
  readonly document: StatementDocument | null;
  readonly debit: string;
  readonly credit: string;
  /** Running, in the direction that party's balance is owed. */
  readonly balance: string;
}

export interface PartnerStatement {
  readonly partyCode: string;
  readonly side: PartySide;
  readonly currency: StatementCurrency;
  readonly from: string | null;
  readonly to: string;
  /** What was outstanding before the first line shown. */
  readonly opening: string;
  readonly lines: readonly StatementLine[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /**
   * What is there at `to`. Positive means money is owed to the company, owed
   * by it, or held in the account — whichever this side measures.
   */
  readonly closing: string;
}

const decimal = (value: bigint) => toDecimalString(value, MONEY_SCALE);

/**
 * Which subledger each side keeps. The names are the seven control-account
 * kinds the ledger has used since Phase 02.
 */
const SUBLEDGER = { customer: 'customer', supplier: 'supplier', bank: 'bank' } as const;

/**
 * A supplier's balance runs one way; a customer's and a bank's the other.
 * See the note above.
 */
const owed = (side: PartySide, debit: bigint, credit: bigint) =>
  side === 'supplier' ? credit - debit : debit - credit;

/**
 * Which documents reach each side's account, and the number each is known by.
 *
 * The subledger keeps the journal's source reference — the module and the
 * document's id — because that is what the posting engine knows at the moment
 * it posts. Nobody reads their own statement by document id, so the id is
 * turned back into the number the document was raised under, here, against the
 * documents that side can raise.
 *
 * Keyed lookups, one per kind: a statement of a thousand lines still asks
 * three questions, and each is answered from a primary key.
 *
 * A purchase return is here as the goods return itself, because that is the
 * document the supplier credit memo posts against — the source reference is
 * the return's id, not the memo's. A sales return posts under its credit memo,
 * so that is the number the customer's side carries. Each side names what its
 * own posting named; neither is translated into the other.
 */
interface DocumentSource {
  readonly kind: DocumentKind;
  readonly find: (
    tx: Tx,
    ids: string[],
  ) => Promise<{ readonly id: string; readonly number: string }[]>;
}

const AR_INVOICE: DocumentSource = {
  kind: 'ar_invoice',
  find: (tx, ids) =>
    tx
      .select({ id: arInvoice.id, number: arInvoice.invoiceNo, dueDate: arInvoice.dueDate })
      .from(arInvoice)
      .where(inArray(arInvoice.id, ids)),
};

const CUSTOMER_RECEIPT: DocumentSource = {
  kind: 'customer_receipt',
  find: (tx, ids) =>
    tx
      .select({ id: customerReceipt.id, number: customerReceipt.receiptNo })
      .from(customerReceipt)
      .where(inArray(customerReceipt.id, ids)),
};

const CUSTOMER_CREDIT_MEMO: DocumentSource = {
  kind: 'customer_credit_memo',
  find: (tx, ids) =>
    tx
      .select({ id: customerCreditMemo.id, number: customerCreditMemo.memoNo })
      .from(customerCreditMemo)
      .where(inArray(customerCreditMemo.id, ids)),
};

const AP_INVOICE: DocumentSource = {
  kind: 'ap_invoice',
  find: (tx, ids) =>
    tx
      .select({ id: apInvoice.id, number: apInvoice.invoiceNo, dueDate: apInvoice.dueDate })
      .from(apInvoice)
      .where(inArray(apInvoice.id, ids)),
};

const SUPPLIER_PAYMENT: DocumentSource = {
  kind: 'supplier_payment',
  find: (tx, ids) =>
    tx
      .select({ id: supplierPayment.id, number: supplierPayment.paymentNo })
      .from(supplierPayment)
      .where(inArray(supplierPayment.id, ids)),
};

const GOODS_RETURN: DocumentSource = {
  kind: 'goods_return',
  find: (tx, ids) =>
    tx
      .select({ id: goodsReturn.id, number: goodsReturn.returnNo })
      .from(goodsReturn)
      .where(inArray(goodsReturn.id, ids)),
};

const RAISED_BY: Readonly<Record<PartySide, readonly DocumentSource[]>> = {
  customer: [AR_INVOICE, CUSTOMER_RECEIPT, CUSTOMER_CREDIT_MEMO],
  supplier: [AP_INVOICE, SUPPLIER_PAYMENT, GOODS_RETURN],
  // Money arrives from a customer and leaves to a supplier; a bank account
  // sees both halves and neither of its own.
  bank: [CUSTOMER_RECEIPT, SUPPLIER_PAYMENT],
};

/**
 * A document id is a uuid. A source reference is not always a document.
 *
 * The cut-over's opening balances post with a source of their own making —
 * `opening-IQD-…`, one per currency — because there is no invoice behind
 * them: they are the old system's closing position, carried in as a journal.
 * Every lookup below compares against a `uuid` column, so handing it one of
 * those makes PostgreSQL refuse the whole query ("invalid input syntax for
 * type uuid") and the statement fails rather than the one line being
 * unnamed. Found 2026-10-02: every partner carried in from the old books had
 * no statement at all, on the screen as well as in chat.
 *
 * So anything that is not a uuid is left out of the lookup. It has no
 * document to name, which is the truth about it, and the line still shows
 * with its journal's own reference.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function documentsFor(
  tx: Tx,
  side: PartySide,
  ids: readonly string[],
): Promise<ReadonlyMap<string, StatementDocument>> {
  const found = new Map<string, StatementDocument>();
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
  if (wanted.length === 0) return found;

  for (const source of RAISED_BY[side]) {
    for (const row of await source.find(tx, wanted)) {
      found.set(row.id, {
        kind: source.kind,
        number: row.number,
        dueDate: 'dueDate' in row ? ((row as { dueDate: string | null }).dueDate ?? null) : null,
      });
    }
  }
  return found;
}

/**
 * One party's account, in posting order, with a running balance.
 *
 * `from` is optional: without it the statement starts at the beginning and
 * opens at zero. With it, everything before is folded into the opening figure
 * rather than dropped, so the closing balance is the same either way.
 */
export async function statementFor(
  tx: Tx,
  side: PartySide,
  partyCode: string,
  window: {
    readonly from?: string | null;
    readonly to: string;
    readonly currency?: StatementCurrency;
  },
): Promise<PartnerStatement> {
  const currency: StatementCurrency = window.currency === 'USD' ? 'USD' : 'IQD';
  const debitColumn = currency === 'USD' ? subledgerEntry.debitUsd : subledgerEntry.debitIqd;
  const creditColumn = currency === 'USD' ? subledgerEntry.creditUsd : subledgerEntry.creditIqd;

  const mine = and(
    eq(subledgerEntry.subledgerType, SUBLEDGER[side]),
    eq(subledgerEntry.partyCode, partyCode),
  );

  const before = window.from
    ? await tx
        .select({
          debit: sql<string>`coalesce(sum(${debitColumn}), 0)::text`,
          credit: sql<string>`coalesce(sum(${creditColumn}), 0)::text`,
        })
        .from(subledgerEntry)
        .where(and(mine, sql`${subledgerEntry.postingDate} < ${window.from}::date`))
    : [];

  const opening = before[0]
    ? owed(
        side,
        parseDecimal(before[0].debit, MONEY_SCALE),
        parseDecimal(before[0].credit, MONEY_SCALE),
      )
    : 0n;

  const rows = await tx
    .select({
      postingDate: subledgerEntry.postingDate,
      entryNo: journalEntry.entryNo,
      description: journalEntry.description,
      sourceDocId: subledgerEntry.sourceDocId,
      debit: debitColumn,
      credit: creditColumn,
    })
    .from(subledgerEntry)
    .innerJoin(journalEntry, eq(journalEntry.id, subledgerEntry.journalEntryId))
    .where(
      and(
        mine,
        lte(subledgerEntry.postingDate, window.to),
        window.from ? sql`${subledgerEntry.postingDate} >= ${window.from}::date` : undefined,
      ),
    )
    .orderBy(asc(subledgerEntry.postingDate), asc(subledgerEntry.id));

  const documents = await documentsFor(
    tx,
    side,
    rows.flatMap((row) => (row.sourceDocId ? [row.sourceDocId] : [])),
  );

  let balance = opening;
  let totalDebit = 0n;
  let totalCredit = 0n;
  const lines: StatementLine[] = rows.map((row) => {
    const debit = parseDecimal(row.debit, MONEY_SCALE);
    const credit = parseDecimal(row.credit, MONEY_SCALE);
    totalDebit += debit;
    totalCredit += credit;
    balance += owed(side, debit, credit);
    return {
      postingDate: row.postingDate,
      entryNo: row.entryNo,
      description: row.description,
      document: (row.sourceDocId ? documents.get(row.sourceDocId) : undefined) ?? null,
      debit: decimal(debit),
      credit: decimal(credit),
      balance: decimal(balance),
    };
  });

  return {
    partyCode,
    side,
    currency,
    from: window.from ?? null,
    to: window.to,
    opening: decimal(opening),
    lines,
    totalDebit: decimal(totalDebit),
    totalCredit: decimal(totalCredit),
    closing: decimal(balance),
  };
}

/**
 * A bank or cash account's statement, read from the ledger account it posts
 * to — Operations block 6: "Incoming amounts are shown as Debit. Outgoing
 * amounts are shown as Credit."
 *
 * Why not the bank subledger (`statementFor(tx, 'bank', …)`): the subledger
 * is written only for a line that names its bank account, and the supplier
 * payment and customer receipt postings do not name it. An account left
 * unmarked keeps no subledger at all, so its statement would be empty; one
 * marked as the bank control account refuses those postings outright. Each
 * bank or cash account carries a ledger account no other one may carry, so
 * that account's postings are exactly this account's movements — the same
 * figures, from the posted lines themselves.
 *
 * The same shape as a partner's statement, so one table shows both: the
 * opening balance folds in everything before `from`, and each line carries
 * the balance it left, debits less credits.
 */
export async function ledgerStatementFor(
  tx: Tx,
  account: { readonly code: string; readonly glAccountCode: string | null },
  window: {
    readonly from?: string | null;
    readonly to: string;
    readonly currency?: StatementCurrency;
  },
): Promise<PartnerStatement> {
  const currency: StatementCurrency = window.currency === 'USD' ? 'USD' : 'IQD';
  const usd = currency === 'USD';
  const debitOf = (row: { debitIqd: string; debitUsd: string }) => parseDecimal(usd ? row.debitUsd : row.debitIqd, MONEY_SCALE);
  const creditOf = (row: { creditIqd: string; creditUsd: string }) =>
    parseDecimal(usd ? row.creditUsd : row.creditIqd, MONEY_SCALE);

  // An account with no ledger account has posted nothing.
  const ledgerCode = account.glAccountCode ?? '';
  let opening = 0n;
  if (window.from && ledgerCode) {
    const [y, m, d] = window.from.split('-').map(Number);
    const dayBefore = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
    for (const row of await trialBalance.accountActivity(tx, ledgerCode, {
      from: '0001-01-01',
      to: dayBefore,
      allPermittedBranches: true,
    })) {
      opening += debitOf(row) - creditOf(row);
    }
  }

  const rows = ledgerCode
    ? await trialBalance.accountActivity(tx, ledgerCode, {
        from: window.from ?? '0001-01-01',
        to: window.to,
        allPermittedBranches: true,
      })
    : [];
  const documents = await documentsFor(
    tx,
    'bank',
    rows.flatMap((row) => (row.sourceDocId ? [String(row.sourceDocId)] : [])),
  );

  let balance = opening;
  let totalDebit = 0n;
  let totalCredit = 0n;
  const lines: StatementLine[] = rows.map((row) => {
    const debit = debitOf(row);
    const credit = creditOf(row);
    totalDebit += debit;
    totalCredit += credit;
    balance += debit - credit;
    return {
      postingDate: String(row.postingDate),
      entryNo: row.entryNo,
      description: row.description,
      document: (row.sourceDocId ? documents.get(String(row.sourceDocId)) : undefined) ?? null,
      debit: decimal(debit),
      credit: decimal(credit),
      balance: decimal(balance),
    };
  });

  return {
    partyCode: account.code,
    side: 'bank',
    currency,
    from: window.from ?? null,
    to: window.to,
    opening: decimal(opening),
    lines,
    totalDebit: decimal(totalDebit),
    totalCredit: decimal(totalCredit),
    closing: decimal(balance),
  };
}
