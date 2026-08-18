/**
 * Item duplicate detection — Phase 03.3, §4.4.
 *
 * 03.3 gate: *"Item duplicate detection runs before save."*
 *
 * The damage from two records for one item is not a tidiness problem. Stock
 * splits across both, FIFO layers build against each separately, and the
 * valuation of the thing on the shelf becomes the sum of two half-truths. It is
 * also close to unfixable afterwards: merging two items means rewriting posted
 * inventory movements, which §1.1 forbids.
 *
 * So the check runs before the save, on the identifiers people actually retype:
 *
 *   name              the same product typed twice, with different punctuation
 *   barcode           the strongest signal — a barcode identifies one product
 *   supplier item code the same supplier's code for the same thing
 *
 * Deliberately not fuzzier than that. A near-match that is genuinely a
 * different item — "Cable 2m" and "Cable 3m" — trains people to click through
 * the warning, and a warning nobody reads is worse than none.
 *
 * Pure, and separate from the partner version, because the identifiers differ
 * and a shared "duplicate engine" over two unrelated field sets would be a
 * layer with no rule of its own.
 */

/** What is compared. Any field may be absent — an item need not have a barcode. */
export interface ItemIdentity {
  readonly id?: string;
  readonly code?: string;
  readonly name: string;
  readonly barcodes?: readonly string[];
  readonly supplierItemCodes?: readonly { supplierCode: string; itemCode: string }[];
}

export interface ItemDuplicateMatch {
  readonly itemId: string;
  readonly itemCode: string;
  readonly name: string;
  readonly matchedOn: readonly string[];
}

export class DuplicateItemError extends Error {
  readonly code = 'ITEM_DUPLICATE';

  constructor(readonly matches: readonly ItemDuplicateMatch[]) {
    // §25 — what matched, why it matters, and what to do instead.
    super(
      `This looks like an existing item: ${matches
        .map((m) => `${m.itemCode} ${m.name} (matched on ${m.matchedOn.join(', ')})`)
        .join('; ')}. ` +
        'Use the existing item, or confirm this is genuinely a different product (§4.4). ' +
        'Two records for one product split its stock and its FIFO layers, and cannot be merged afterwards.',
    );
    this.name = 'DuplicateItemError';
  }
}

/**
 * Normalises a product name for comparison.
 *
 * The same rule as the partner name: case, punctuation and spacing are noise.
 * Digits are kept, because in an item name they are usually the size — and
 * "Cable 2m" must not collapse into "Cable 3m".
 */
export function normaliseItemName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Barcodes compare on their digits and letters, ignoring separators. */
export function normaliseBarcode(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
}

/** Which identifiers two items share. */
export function matchedItemIdentifiers(
  candidate: ItemIdentity,
  existing: ItemIdentity,
): string[] {
  const matched: string[] = [];

  if (normaliseItemName(candidate.name) === normaliseItemName(existing.name)) {
    matched.push('name');
  }

  const candidateBarcodes = new Set((candidate.barcodes ?? []).map(normaliseBarcode));
  for (const barcode of existing.barcodes ?? []) {
    if (candidateBarcodes.has(normaliseBarcode(barcode))) {
      matched.push('barcode');
      break;
    }
  }

  const candidateSupplierCodes = new Set(
    (candidate.supplierItemCodes ?? []).map((s) => `${s.supplierCode}|${s.itemCode.trim().toUpperCase()}`),
  );
  for (const supplied of existing.supplierItemCodes ?? []) {
    if (
      candidateSupplierCodes.has(
        `${supplied.supplierCode}|${supplied.itemCode.trim().toUpperCase()}`,
      )
    ) {
      matched.push('supplier item code');
      break;
    }
  }

  return matched;
}

/**
 * The candidates that look like this item.
 *
 * The item being edited is excluded by id, so saving an existing record does
 * not report it as its own duplicate.
 */
export function findItemDuplicates(
  candidate: ItemIdentity,
  existing: readonly ItemIdentity[],
): ItemDuplicateMatch[] {
  const matches: ItemDuplicateMatch[] = [];

  for (const other of existing) {
    if (candidate.id && other.id === candidate.id) continue;

    const matchedOn = matchedItemIdentifiers(candidate, other);
    if (matchedOn.length > 0) {
      matches.push({
        itemId: other.id ?? '',
        itemCode: other.code ?? '',
        name: other.name,
        matchedOn,
      });
    }
  }

  return matches;
}

/**
 * The check, as an assertion.
 *
 * `confirmedNotDuplicate` is the override a user gives after seeing the
 * warning — recorded by the service in the audit trail, because "someone
 * decided these are different products" is exactly the kind of judgement an
 * auditor needs to be able to find later (§4.4).
 */
export function assertNotDuplicateItem(
  candidate: ItemIdentity,
  existing: readonly ItemIdentity[],
  options: { readonly confirmedNotDuplicate?: boolean } = {},
): void {
  if (options.confirmedNotDuplicate) return;

  const matches = findItemDuplicates(candidate, existing);
  if (matches.length > 0) throw new DuplicateItemError(matches);
}
