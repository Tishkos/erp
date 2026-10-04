/**
 * A draft, from chat — by direction, 2026-10-04: "draft maker".
 *
 * Noah keys a document's lines from what somebody told him, and saves it as a
 * **draft**: a journal entry, a purchase invoice, a sales invoice. A draft
 * posts nothing and moves no stock — it is the form filled in, with a number,
 * waiting on its own page to be read, changed, and then submitted and posted
 * by the people whose job that is. That is what makes it safe to take from a
 * sentence, where an approval or a posting is not.
 *
 * The same three-party rule as every other action (`domain/whatsapp-do.ts`):
 *
 *   `prepareDraft`  reads. Every name is resolved to a real record under the
 *                   asker's own read-only scope — the supplier, each item,
 *                   each warehouse, each account — the arithmetic is done in
 *                   scaled integers, and the facts are written out line by
 *                   line for the person to check. Nothing changes.
 *   `runDraft`      writes, once, after a plain yes — through the calls the
 *                   screens make (`journal.createDraft` / `addLine`,
 *                   `ap.create`, `ar.createDirect`), as that person, so their
 *                   permissions and every rule of the form apply.
 *
 * The purchase invoice follows `payables/invoices/actions.ts` ›
 * `createApInvoice` and the sales invoice `sales/ar-invoices/actions.ts` ›
 * `createArInvoice`: what the form sends, this sends.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { RATE_SCALE, parseDecimal, toDecimalString, toIqd } from '../domain/money';
import { profileHref } from '../domain/profiles';
import { QUANTITY_FACTOR, parseQuantity } from '../domain/uom';
import { money, quantity } from '../domain/whatsapp';
import { DRAFT_KINDS, type DraftKind, type DraftLine, type DraftPayload } from '../domain/whatsapp-do';
import * as apInvoices from './ap-invoice';
import * as arInvoices from './ar-invoice';
import type { ActorContext } from './chart-of-accounts';
import * as rates from './exchange-rates';
import * as expenses from './expenses';
import * as journals from './journal';
import * as partnersService from './partners';
import { appUrl } from './system-guide';
import type { ReadContext } from './whatsapp';

const NL = String.fromCharCode(10);
const MAX_LINES = 40;

export type PreparedDraft =
  | { readonly ok: true; readonly draft: DraftPayload; readonly sentence: string; readonly label: string }
  | { readonly ok: false; readonly reason: string };

const LABEL: Readonly<Record<DraftKind, string>> = {
  journal_entry: 'journal entry',
  purchase_invoice: 'purchase invoice',
  sales_invoice: 'sales invoice',
};

/** A figure as people write it: "1,250,000", " 12.5 ", 300. */
function figure(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[,\s٬]/g, '')
    .trim();
}

function amount(raw: unknown): bigint | null {
  const text = figure(raw);
  if (!text) return null;
  try {
    return parseDecimal(text, 4n);
  } catch {
    return null;
  }
}

const say = (scaled: bigint) => money(toDecimalString(scaled, 4n));
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

async function partyFor(tx: Tx, side: 'supplier' | 'customer', asked: string) {
  const rows = await partnersService.listActiveInRole(tx, side);
  const wanted = asked.trim().toLowerCase();
  const byCode = rows.filter((row) => row.code.toLowerCase() === wanted);
  if (byCode.length === 1) return { found: byCode[0]!, near: [] as typeof rows };
  const exact = rows.filter((row) => row.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return { found: exact[0]!, near: [] as typeof rows };
  const near = rows.filter((row) => row.name.toLowerCase().includes(wanted) || row.code.toLowerCase().includes(wanted));
  if (near.length === 1) return { found: near[0]!, near: [] as typeof rows };
  return { found: null, near };
}

async function itemFor(tx: Tx, asked: string) {
  const wanted = asked.trim();
  const result = await tx.execute(sql`
    select code, name, active
      from item
     where upper(code) = upper(${wanted}) or lower(btrim(name)) = lower(${wanted})
     order by (upper(code) = upper(${wanted})) desc
     limit 2`);
  return result.rows as { code: string; name: string; active: boolean }[];
}

async function warehousesFor(tx: Tx, branchCode: string) {
  const result = await tx.execute(sql`
    select code, name, (is_transit or shipment_stage is not null) as transit
      from warehouse
     where active and branch_code = ${branchCode}
     order by code`);
  return result.rows as { code: string; name: string; transit: boolean }[];
}

async function accountFor(tx: Tx, code: string) {
  const result = await tx.execute(sql`
    select id::text as id, code, name, is_group, is_active
      from chart_of_account
     where upper(code) = upper(${code.trim()})
     limit 1`);
  return result.rows[0] as { id: string; code: string; name: string; is_group: boolean; is_active: boolean } | undefined;
}

/** Resolve and describe, without changing anything. */
export async function prepareDraft(ctx: ReadContext, args: Record<string, unknown>): Promise<PreparedDraft> {
  const kind = String(args.kind ?? '').trim() as DraftKind;
  if (!(DRAFT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `Which kind of draft? One of: ${DRAFT_KINDS.join(', ')}. Anything else is entered on its screen — walk them through it.` };
  }
  const given = Array.isArray(args.lines) ? (args.lines as Record<string, unknown>[]) : [];
  if (given.length === 0) return { ok: false, reason: `A ${LABEL[kind]} needs at least one line. Ask what goes on it.` };
  if (given.length > MAX_LINES) return { ok: false, reason: `That is ${given.length} lines; a draft from chat takes up to ${MAX_LINES}. Longer ones are better typed or pasted on the screen.` };
  const date = isDate(args.date) ? args.date : ctx.today;
  const description = String(args.description ?? args.note ?? '').trim() || null;

  // ── a journal entry ───────────────────────────────────────────────────────
  if (kind === 'journal_entry') {
    const lines: DraftLine[] = [];
    let debits = 0n;
    let credits = 0n;
    for (const [index, raw] of given.entries()) {
      const where = `Line ${index + 1}`;
      const code = String(raw.account ?? '').trim();
      if (!code) return { ok: false, reason: `${where} names no account. Ask which account (its code, such as A000003; the trial balance and the chart list them).` };
      const account = await accountFor(ctx.tx, code);
      if (!account) return { ok: false, reason: `${where}: there is no account ${code} in the chart. Look the code up (query chart_of_account) and propose again.` };
      if (account.is_group) return { ok: false, reason: `${where}: ${account.code} · ${account.name} is a heading, and nothing posts to a heading. Ask which account under it.` };
      if (!account.is_active) return { ok: false, reason: `${where}: ${account.code} · ${account.name} is not active.` };
      const debit = amount(raw.debit) ?? 0n;
      const credit = amount(raw.credit) ?? 0n;
      if ((debit > 0n) === (credit > 0n)) return { ok: false, reason: `${where} (${account.code}) needs a debit or a credit — one of them, and more than zero.` };
      if (debit < 0n || credit < 0n) return { ok: false, reason: `${where}: an amount cannot be negative; put it on the other side instead.` };
      debits += debit;
      credits += credit;
      const department = String(raw.department ?? '').trim().toUpperCase();
      lines.push({
        account: account.code,
        accountId: account.id,
        accountName: account.name,
        ...(debit > 0n ? { debit: toDecimalString(debit, 4n) } : { credit: toDecimalString(credit, 4n) }),
        ...(department ? { department } : {}),
        ...(String(raw.description ?? '').trim() ? { description: String(raw.description).trim() } : {}),
      });
    }
    if (debits !== credits) {
      return {
        ok: false,
        reason: `It does not balance: debits ${say(debits)}, credits ${say(credits)} — out by ${say(debits > credits ? debits - credits : credits - debits)}. Tell them, and ask which line is wrong or missing.`,
      };
    }
    const sentence = [
      `create a DRAFT journal entry dated ${date}${description ? ` — "${description}"` : ''}, branch ${ctx.branchCode}`,
      ...lines.map(
        (line, index) =>
          `${index + 1}. ${line.account} · ${line.accountName} — ${line.debit ? `debit ${money(line.debit)}` : `credit ${money(line.credit)}`}${line.department ? ` · department ${line.department}` : ''}`,
      ),
      `debits ${say(debits)} = credits ${say(credits)} (IQD)`,
      'It is saved as a draft with its own number. Nothing is posted: it has to be submitted, and then approved by a second person, before it reaches the ledger. It can be opened and changed on its page first.',
    ].join(NL);
    return { ok: true, label: LABEL[kind], sentence, draft: { kind, date, currency: 'IQD', description, lines } };
  }

  // ── an invoice, either side ───────────────────────────────────────────────
  const side = kind === 'purchase_invoice' ? 'supplier' : 'customer';
  const asked = String(args.party ?? '').trim();
  if (!asked) return { ok: false, reason: `Which ${side}? Ask for the name or the code.` };
  const party = await partyFor(ctx.tx, side, asked);
  if (!party.found) {
    return {
      ok: false,
      reason:
        party.near.length > 1
          ? `"${asked}" could be several ${side}s: ${party.near.slice(0, 8).map((row) => `${row.code} · ${row.name}`).join('; ')}. Ask which.`
          : `No active, approved ${side} matches "${asked}". list_partners shows the ones that can be used; one that is still a prospect has to be approved first (approve_partner), and one that does not exist can be created (create_partner).`,
    };
  }

  const currency = kind === 'purchase_invoice' ? (String(args.currency ?? 'IQD').trim().toUpperCase() || 'IQD') : 'IQD';
  let rateLine = '';
  let iqdPerUnit: bigint | null = null;
  if (currency !== 'IQD') {
    try {
      const rate = await rates.rateOn(ctx.tx, currency, date);
      iqdPerUnit = rate.iqdPerUnit;
      rateLine = ` (1 ${currency} = ${money(toDecimalString(rate.iqdPerUnit, RATE_SCALE))} IQD on ${date})`;
    } catch (error) {
      return { ok: false, reason: `There is no ${currency} rate for ${date}: ${error instanceof Error ? error.message : String(error)} Tell them a rate is added on Accounting → Master Data — Financial → Currencies and Rates.` };
    }
  }

  const houses = await warehousesFor(ctx.tx, ctx.branchCode);
  const shelves = houses.filter((house) => !house.transit);
  const lines: DraftLine[] = [];
  let total = 0n;
  for (const [index, raw] of given.entries()) {
    const where = `Line ${index + 1}`;
    const wanted = String(raw.item ?? '').trim();
    if (!wanted) return { ok: false, reason: `${where} names no item. Ask which item (its code or exact name; the items tool finds it).` };
    const items = await itemFor(ctx.tx, wanted);
    if (items.length === 0) return { ok: false, reason: `${where}: no item "${wanted}". Find it with the items tool, or tell them it is created on Accounting → Master Data — Inventory Reference → Items.` };
    const item = items[0]!;
    if (!item.active) return { ok: false, reason: `${where}: ${item.code} · ${item.name} is not active.` };

    const qtyText = figure(raw.quantity);
    let qty: bigint;
    try {
      qty = parseQuantity(qtyText);
    } catch {
      return { ok: false, reason: `${where} (${item.code}): how many? "${String(raw.quantity ?? '')}" is not a quantity.` };
    }
    if (qty <= 0n) return { ok: false, reason: `${where} (${item.code}): the quantity has to be more than zero.` };
    const price = amount(raw.unitPrice);
    if (price === null || price < 0n) return { ok: false, reason: `${where} (${item.code}): what is the unit price${currency === 'IQD' ? ' in IQD' : ` in ${currency}`}?` };
    const discount = amount(raw.discount) ?? 0n;
    if (discount < 0n) return { ok: false, reason: `${where} (${item.code}): a discount cannot be negative.` };

    let warehouse = String(raw.warehouse ?? '').trim().toUpperCase();
    if (!warehouse) {
      if (shelves.length !== 1) {
        return {
          ok: false,
          reason: `${where} (${item.code}): which warehouse ${kind === 'purchase_invoice' ? 'does it arrive in' : 'is it sold from'}? ${shelves.length === 0 ? `Branch ${ctx.branchCode} has no warehouse yet.` : `The choices: ${shelves.map((house) => `${house.code} · ${house.name}`).join('; ')}.`}`,
        };
      }
      warehouse = shelves[0]!.code;
    } else if (!houses.some((house) => house.code.toUpperCase() === warehouse)) {
      return { ok: false, reason: `${where} (${item.code}): there is no active warehouse ${warehouse} in branch ${ctx.branchCode}. The choices: ${shelves.map((house) => `${house.code} · ${house.name}`).join('; ') || 'none'}.` };
    }

    const lineTotal = (price * qty) / QUANTITY_FACTOR - discount;
    if (lineTotal < 0n) return { ok: false, reason: `${where} (${item.code}): the discount is more than the line.` };
    total += lineTotal;
    lines.push({
      item: item.code,
      itemName: item.name,
      quantity: qtyText,
      unitPrice: toDecimalString(price, 4n),
      ...(discount > 0n ? { discount: toDecimalString(discount, 4n) } : {}),
      warehouse,
      ...(String(raw.description ?? '').trim() ? { description: String(raw.description).trim().slice(0, 200) } : {}),
    });
  }

  const isImport = kind === 'purchase_invoice' && args.import === true;
  const dueDate = isDate(args.dueDate) ? args.dueDate : null;
  // The number on the supplier's own paper: what a duplicate is recognised by.
  const supplierInvoiceNo = kind === 'purchase_invoice' ? String(args.supplierInvoiceNo ?? '').trim().slice(0, 60) : '';
  const sentence = [
    `create a DRAFT ${LABEL[kind]} — ${side} ${party.found.code} · ${party.found.name}, dated ${date}${dueDate ? `, due ${dueDate}` : ''}, in ${currency}${rateLine}, branch ${ctx.branchCode}`,
    supplierInvoiceNo ? `the supplier's own invoice number: ${supplierInvoiceNo}` : '',
    kind === 'purchase_invoice'
      ? isImport
        ? 'an IMPORT: saving it also opens the import application and its purchase order, and the goods go to the In Process warehouse until they are received'
        : 'a local purchase (not an import)'
      : '',
    ...lines.map(
      (line, index) =>
        `${index + 1}. ${line.item} · ${line.itemName} — ${quantity(line.quantity)} × ${money(line.unitPrice)}${line.discount ? ` − ${money(line.discount)}` : ''} → warehouse ${line.warehouse}`,
    ),
    `total ${say(total)} ${currency}${iqdPerUnit ? ` (${say(toIqd(total, iqdPerUnit))} IQD)` : ''}`,
    description ? `note: ${description}` : '',
    kind === 'purchase_invoice'
      ? 'It is saved as a draft with its own number: no journal, no stock, nothing owed yet. It is submitted, and then posted by somebody who may approve and did not raise it. It can be opened and changed on its page first.'
      : 'It is saved as a draft with its own number: no journal and no stock leaves yet. It is approved and then posted afterwards. It can be opened and changed on its page first.',
  ]
    .filter((part) => part !== '')
    .join(NL);
  return {
    ok: true,
    label: LABEL[kind],
    sentence,
    draft: { kind, date, dueDate, currency, isImport, description, party: { id: party.found.id, code: party.found.code, name: party.found.name }, ...(supplierInvoiceNo ? { supplierInvoiceNo } : {}), lines },
  };
}

/** Save it — as the person who said yes, through the call its screen makes. */
export async function runDraft(tx: Tx, ctx: ActorContext, draft: DraftPayload): Promise<string> {
  const link = (kind: Parameters<typeof profileHref>[0], no: string) => {
    const href = profileHref(kind, no);
    return href ? `${appUrl()}${href}` : '';
  };

  if (draft.kind === 'journal_entry') {
    const made = await journals.createDraft(tx, ctx, {
      branchCode: ctx.branchCode,
      documentDate: draft.date,
      postingDate: draft.date,
      description: draft.description ?? null,
    });
    for (const line of draft.lines) {
      await journals.addLine(tx, ctx, made.id, {
        accountId: line.accountId ?? '',
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        dimensions: { department: line.department ?? null },
        ...(line.description ? { description: line.description } : {}),
      });
    }
    return [
      `Journal entry ${made.entryNo} is saved as a draft with ${draft.lines.length} line(s).`,
      `Open it: ${link('journal', made.entryNo)}`,
      'Nothing is posted yet — when it is right, submit it (I can do that for you: say so), and a second person approves it.',
    ].join(NL);
  }

  if (!draft.party) throw new Error('The draft names no customer or supplier.');

  if (draft.kind === 'purchase_invoice') {
    const typed = draft.lines.map((line) => ({
      itemCode: line.item ?? '',
      description: line.description ?? null,
      quantity: parseQuantity(line.quantity ?? '0'),
      unitPriceIqd: parseDecimal(line.unitPrice ?? '0', 4n),
      ...(line.discount ? { discountIqd: parseDecimal(line.discount, 4n) } : {}),
      uomCode: null,
      isInventory: true,
      warehouseCode: line.warehouse ?? '',
    }));
    // The rate is read here, at the moment of saving, as the form's action reads it.
    let agreedRate: string | null = null;
    let priced: apInvoices.InvoiceLineInput[] = typed;
    if (draft.currency !== 'IQD') {
      const rate = await rates.rateOn(tx, draft.currency, draft.date);
      agreedRate = toDecimalString(rate.iqdPerUnit, RATE_SCALE);
      priced = typed.map((line) => ({
        ...line,
        unitPriceTxn: line.unitPriceIqd,
        unitPriceIqd: toIqd(line.unitPriceIqd, rate.iqdPerUnit),
        ...(line.discountIqd === undefined ? {} : { discountIqd: toIqd(line.discountIqd, rate.iqdPerUnit) }),
      }));
    }
    const made = await apInvoices.create(tx, ctx, {
      supplierId: draft.party.id,
      supplierInvoiceNo: draft.supplierInvoiceNo ?? '',
      purchaseOrderId: null,
      branchCode: ctx.branchCode,
      invoiceDate: draft.date,
      dueDate: draft.dueDate ?? undefined,
      payableAccountId: null,
      expenseAccountId: null,
      isImport: draft.isImport === true,
      ...(draft.currency === 'IQD' ? {} : { importCurrency: draft.currency }),
      payableId: null,
      advancePercent: null,
      agreedCurrency: draft.currency === 'IQD' ? null : draft.currency,
      agreedRate,
      projectCode: null,
      wbsCode: null,
      costCode: null,
      lines: priced,
    });
    if (draft.description) await expenses.addNote(tx, ctx, made.id, draft.description);
    return [
      `Purchase invoice ${made.invoiceNo} is saved as a draft for ${draft.party.code} · ${draft.party.name}.`,
      made.importPayableNo ? `It opened the import application ${made.importPayableNo}.` : '',
      `Open it: ${link('purchase_invoice', made.invoiceNo)}`,
      'Nothing is posted yet — check it on its page, then submit it (I can do that for you: say so).',
    ]
      .filter((part) => part !== '')
      .join(NL);
  }

  const made = await arInvoices.createDirect(tx, ctx, {
    customerId: draft.party.id,
    branchCode: ctx.branchCode,
    invoiceDate: draft.date,
    ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
    note: null,
    receivableAccountId: null,
    revenueAccountId: null,
    lines: draft.lines.map((line) => ({
      itemCode: line.item ?? '',
      quantity: parseQuantity(line.quantity ?? '0'),
      unitPriceIqd: parseDecimal(line.unitPrice ?? '0', 4n),
      ...(line.discount ? { discountIqd: parseDecimal(line.discount, 4n) } : {}),
      warehouseCode: line.warehouse ?? '',
    })),
  });
  return [
    `Sales invoice ${made.invoiceNo} is saved as a draft for ${draft.party.code} · ${draft.party.name}.`,
    `Open it: ${link('sales_invoice', made.invoiceNo)}`,
    'Nothing is posted and no stock has left yet — check it on its page; it is approved and then posted (I can take those steps for you: say so).',
  ].join(NL);
}
