/**
 * A supplier's invoice, read into a draft — REQ-AP-001, the invoice intake.
 *
 * By direction (2026-10-02): the CEO is sent an invoice from a factory in
 * China and wants a draft import application out of it, with anything the
 * reader could not recognise left empty and marked, rather than filled in
 * with a guess.
 *
 * That last part is the whole design. A model reading an invoice is useful
 * exactly to the degree that it is honest about what it did not understand:
 *
 *   * **Nothing is invented.** A field the invoice does not state comes back
 *     empty with a flag, never with a plausible value. An invented supplier
 *     or a guessed quantity is worse than a blank, because a blank is seen
 *     and a wrong figure is signed.
 *   * **Every value carries where it came from.** `confidence` is the
 *     reader's own, and the screen colours by it, so "88.50, and I am sure"
 *     and "88.50, and I am guessing" do not look the same to the accountant.
 *   * **Nothing posts.** A draft is a draft: it is submitted and approved by
 *     people, through the same door as a typed one.
 *
 * This file holds the shape, the reading of the model's answer, and the
 * matching of a description to an item the company already has. It knows
 * nothing about models or databases.
 */

/** How sure the reader is about one value. */
export type Confidence = 'sure' | 'unsure' | 'missing';

/** Something the person must look at, named so the screen can say it. */
export interface DraftFlag {
  /** The field it is about, e.g. `lines[2].unitPrice` or `invoiceDate`. */
  readonly field: string;
  readonly why: string;
}

export interface DraftLine {
  /** The description exactly as the invoice writes it, in its own script. */
  readonly description: string;
  readonly quantity: string | null;
  readonly uom: string | null;
  readonly unitPrice: string | null;
  readonly lineTotal: string | null;
  /** The company's item, when one was matched. Null means a person must pick. */
  readonly itemCode: string | null;
  readonly itemName: string | null;
  readonly confidence: Confidence;
  readonly flags: readonly DraftFlag[];
}

export interface InvoiceDraft {
  readonly supplierName: string | null;
  readonly supplierCode: string | null;
  readonly invoiceNo: string | null;
  readonly invoiceDate: string | null;
  readonly currency: string | null;
  readonly incoterm: string | null;
  readonly totalAmount: string | null;
  readonly lines: readonly DraftLine[];
  readonly flags: readonly DraftFlag[];
  /** What the reader could not do at all, in its own words. */
  readonly note: string | null;
}

/** An empty draft, for a document nothing could be read out of. */
export const NO_DRAFT: InvoiceDraft = Object.freeze({
  supplierName: null,
  supplierCode: null,
  invoiceNo: null,
  invoiceDate: null,
  currency: null,
  incoterm: null,
  totalAmount: null,
  lines: [],
  flags: [],
  note: null,
});

/**
 * What the model is asked for.
 *
 * Written as rules rather than as a schema description, because the failure
 * that matters is not a malformed object — it is a confident wrong number,
 * and only an instruction stops that.
 */
export const EXTRACTION_RULES = [
  'You are reading a supplier invoice for an Iraqi trading company that imports solar equipment and motorcycles, usually from China.',
  'Answer with one JSON object and nothing else. No prose, no code fence.',
  '',
  'THE SHAPE:',
  '{"supplierName":str|null,"invoiceNo":str|null,"invoiceDate":"YYYY-MM-DD"|null,"currency":str|null,"incoterm":str|null,"totalAmount":str|null,',
  ' "lines":[{"description":str,"quantity":str|null,"uom":str|null,"unitPrice":str|null,"lineTotal":str|null,"confidence":"sure"|"unsure"}],',
  ' "note":str|null}',
  '',
  'THE RULES, which matter more than the shape:',
  '• Never invent. A field the invoice does not state is null. A guessed figure is worse than a blank, because a blank gets looked at and a wrong number gets signed.',
  '• Mark a line "unsure" whenever you are reading across a broken layout, a merged cell, or a column whose heading you had to infer. Being unsure is not a failure; saying you were sure when you were not is.',
  '• Copy the description exactly as the invoice writes it, in its own script — Chinese, Arabic or English. Do not translate it, do not tidy it. Somebody will match it to an item by eye.',
  '• Numbers as plain digits: no thousands separators, a dot for the decimal. Keep the invoice\'s own precision.',
  '• A date as YYYY-MM-DD. If the invoice writes 03/04/2026 and you cannot tell March from April, the date is null and say so in the note.',
  '• The currency as its three-letter code when you can see it (USD, CNY, EUR, IQD). A bare $ on a Chinese invoice is usually USD — say USD and mark the note.',
  '• Lines are the goods. Freight, insurance and bank charges are not goods: leave them out of lines and mention them in the note, because they belong to the landed cost rather than to the order.',
  '• If the document is not an invoice at all, return empty lines and say what it looks like in the note.',
].join('\n');

/** A number as the books want it: digits, one dot, no separators. */
export function cleanNumber(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (text === '') return null;

  /*
   * Decoration comes off; words do not.
   *
   * Stripping every non-digit — which is what this did first — turns "about
   * 100" into 100 and "N/A 50" into 50. That is the one behaviour this whole
   * feature exists to prevent: a hedge becoming a figure somebody signs. Only
   * the marks that decorate a number are removed, and whatever is left must
   * be a number on its own or there is no number here.
   */
  text = text.replace(/^(USD|CNY|RMB|EUR|IQD|AED)\s*/i, '').replace(/\s*(USD|CNY|RMB|EUR|IQD|AED)$/i, '');
  text = text.replace(/[$€¥£﷼]/g, '').replace(/[\s ]/g, '');
  // A thousands separator, only where it separates thousands.
  text = text.replace(/,(?=\d{3}(\D|$))/g, '');
  // A decimal comma, as half the world writes it.
  if (/^-?\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');

  return /^-?\d*\.?\d+$/.test(text) ? text : null;
}

/** A date the books accept, or null. */
export function cleanDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function text(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/**
 * The model's answer, read into a draft.
 *
 * Every value it could not make sense of becomes a flag rather than an
 * exception: the point of the screen is to show a person what to look at, and
 * a draft with six flags is still worth more than a refusal.
 */
export function readDraft(answer: unknown): InvoiceDraft {
  if (!answer || typeof answer !== 'object') {
    return { ...NO_DRAFT, note: 'the reader did not answer with an invoice' };
  }
  const source = answer as Record<string, unknown>;
  const flags: DraftFlag[] = [];

  const invoiceDate = cleanDate(source.invoiceDate);
  if (source.invoiceDate && !invoiceDate) {
    flags.push({ field: 'invoiceDate', why: `the date "${String(source.invoiceDate)}" could not be read` });
  }

  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  const lines: DraftLine[] = rawLines.map((raw, index) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const lineFlags: DraftFlag[] = [];
    const description = text(line.description);
    const quantity = cleanNumber(line.quantity);
    const unitPrice = cleanNumber(line.unitPrice);
    const said = line.confidence === 'sure' ? 'sure' : 'unsure';

    if (!description) lineFlags.push({ field: `lines[${index}].description`, why: 'no description was read' });
    if (!quantity) lineFlags.push({ field: `lines[${index}].quantity`, why: 'no quantity was read' });
    if (!unitPrice) lineFlags.push({ field: `lines[${index}].unitPrice`, why: 'no unit price was read' });

    return {
      description: description ?? '',
      quantity,
      uom: text(line.uom),
      unitPrice,
      lineTotal: cleanNumber(line.lineTotal),
      itemCode: null,
      itemName: null,
      // A line missing a figure is `missing` whatever the reader claimed: the
      // colour on the screen has to follow what is actually there.
      confidence: lineFlags.length > 0 ? 'missing' : said,
      flags: lineFlags,
    };
  });

  const supplierName = text(source.supplierName);
  if (!supplierName) flags.push({ field: 'supplierName', why: 'no supplier name was read' });
  const currency = text(source.currency);
  if (!currency) flags.push({ field: 'currency', why: 'no currency was read' });
  if (lines.length === 0) flags.push({ field: 'lines', why: 'no goods lines were read' });

  return {
    supplierName,
    supplierCode: null,
    invoiceNo: text(source.invoiceNo),
    invoiceDate,
    currency: currency ? currency.toUpperCase() : null,
    incoterm: text(source.incoterm),
    totalAmount: cleanNumber(source.totalAmount),
    lines,
    flags,
    note: text(source.note),
  };
}

/** A name reduced to what is worth comparing. */
export function matchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The company's item for a description, when there plainly is one.
 *
 * Deliberately timid. A wrong item silently matched is a wrong stock
 * movement and a wrong cost, and the person reading the draft has no way to
 * tell it was guessed — so a match is only taken when the description
 * contains the item's whole name (or the item's name contains the whole
 * description), and anything less is left for a human to pick. `unsure` means
 * one candidate stood out but not far enough to act on alone.
 */
export function matchItem(
  description: string,
  catalogue: readonly { readonly code: string; readonly name: string }[],
): { readonly code: string; readonly name: string; readonly confidence: Confidence } | null {
  const asked = matchKey(description);
  if (asked === '') return null;

  const exact = catalogue.find((item) => matchKey(item.name) === asked);
  if (exact) return { code: exact.code, name: exact.name, confidence: 'sure' };

  const contained = catalogue.filter((item) => {
    const key = matchKey(item.name);
    return key !== '' && (asked.includes(key) || key.includes(asked));
  });
  if (contained.length === 1) return { code: contained[0]!.code, name: contained[0]!.name, confidence: 'unsure' };

  // Several items could be meant, or none. Either way a person decides.
  return null;
}

/** The draft with its lines matched to the catalogue where that is safe. */
export function matchLines(
  draft: InvoiceDraft,
  catalogue: readonly { readonly code: string; readonly name: string }[],
): InvoiceDraft {
  const lines = draft.lines.map((line, index) => {
    const found = line.description ? matchItem(line.description, catalogue) : null;
    if (!found) {
      return {
        ...line,
        flags: [...line.flags, { field: `lines[${index}].itemCode`, why: 'no item in the catalogue plainly matches this description' }],
      };
    }
    return {
      ...line,
      itemCode: found.code,
      itemName: found.name,
      flags:
        found.confidence === 'sure'
          ? line.flags
          : [...line.flags, { field: `lines[${index}].itemCode`, why: `matched to ${found.code} by name — check it is the right item` }],
    };
  });
  return { ...draft, lines };
}

/** Everything a person has to look at, in one list for the screen. */
export function allFlags(draft: InvoiceDraft): readonly DraftFlag[] {
  return [...draft.flags, ...draft.lines.flatMap((line) => line.flags)];
}
