/**
 * Shipment & warehouse — REQ-AP-001 §17, §18, the rules a database cannot
 * hold. Pure and framework-free.
 *
 *   * **Container numbers (§17.2).** ISO 6346's shape — owner code, category
 *     letter, six digits and a check digit — read out of whatever was pasted
 *     (one per line, or separated by commas or spaces, with the usual spaces
 *     and dashes inside a number), every unreadable one named.
 *   * **The stages a person moves a container through.** Forward only:
 *     loaded on the sea, at port, customs cleared. Received is the receipt's
 *     to set and Late the sweep's; a late container moves on when it arrives.
 *   * **X of Y (§17.5)** and the **spread** of a B/L total over its
 *     containers when no detail was given (§24.3, flagged estimated).
 *   * **The receipt's variance (§18).** What was planned against what came:
 *     received, damaged, short.
 */
import { checkDigitFor } from '../../lib/container-number';
import { QUANTITY_SCALE } from './uom';

export class ShipmentValidationError extends Error {
  readonly code = 'SHIPMENT_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'ShipmentValidationError';
  }
}

// ---------------------------------------------------------------------------
// §17.2 — container numbers
// ---------------------------------------------------------------------------

const CONTAINER_NO = /^[A-Z]{3}[UJZR][0-9]{7}$/;

/** ISO 6346 shape: three-letter owner code, category U/J/Z/R, seven digits. */
export function isContainerNo(value: string): boolean {
  return CONTAINER_NO.test(value);
}

/** ISO 6346 check digit — the seventh digit computed from the first ten characters. */
export function checkDigitOk(value: string): boolean {
  if (!isContainerNo(value)) return false;
  return checkDigitFor(value.slice(0, 10)) === Number(value[10]);
}

/** The check digit a container number's first ten characters call for (ISO 6346). */
export function expectedCheckDigit(value: string): number | null {
  return checkDigitFor(value.slice(0, 10));
}

/**
 * A container number typed on a screen: the ISO 6346 shape *and* its check
 * digit (IM2, 2026-10-03). A typo in the last digit used to be stored, and a
 * shipping line cannot find a box by a wrong number. The legacy sheet keeps to
 * the shape alone (its numbers are history, not typing).
 */
export function assertContainerNumber(value: string): string {
  const number = value.replace(/[\s-]+/g, '').toUpperCase();
  if (!isContainerNo(number)) {
    throw new ShipmentValidationError(
      `'${value.trim()}' is not a container number: four letters (the owner code and U, J, Z or R) and seven digits, e.g. MSCU1234566.`,
    );
  }
  if (!checkDigitOk(number)) {
    throw new ShipmentValidationError(
      `${number}: its last digit is the check digit and should be ${expectedCheckDigit(number)} — check the number on the B/L.`,
    );
  }
  return number;
}

/**
 * The usual ISO 6346 size and type codes, as the B/L writes them. A fixed
 * list: it is the standard's, not the company's (the ISO code is kept with it).
 */
export const SIZE_TYPES = [
  { code: '20GP', iso: '22G1' },
  { code: '40GP', iso: '42G1' },
  { code: '40HC', iso: '45G1' },
  { code: '45HC', iso: 'L5G1' },
  { code: '20RF', iso: '22R1' },
  { code: '40RH', iso: '45R1' },
  { code: '20OT', iso: '22U1' },
  { code: '40OT', iso: '42U1' },
  { code: '20FR', iso: '22P1' },
  { code: '40FR', iso: '42P1' },
  { code: '20TK', iso: '22T1' },
] as const;
export const isSizeType = (value: string) => SIZE_TYPES.some((type) => type.code === value);

/**
 * Reads pasted container numbers: one per line, or separated by commas,
 * semicolons or runs of spaces; `MSKU 123456-7` reads as `MSKU1234567`.
 * Duplicates in the paste are named once.
 */
export function parseContainerList(text: string): { numbers: string[]; invalid: string[]; repeated: string[] } {
  const numbers: string[] = [];
  const invalid: string[] = [];
  const repeated: string[] = [];
  const pieces = text
    .split(/[\n,;]+/)
    .flatMap((piece) => {
      // "MSKU 1234567" is one number; "MSKU1234567 TGHU7654321" is two.
      const compact = piece.trim();
      if (!compact) return [];
      const joined = compact.replace(/[\s-]+/g, '').toUpperCase();
      if (isContainerNo(joined)) return [joined];
      return compact.split(/\s{1,}/).map((part) => part.replace(/-/g, '').toUpperCase());
    })
    .filter(Boolean);
  for (const piece of pieces) {
    if (!isContainerNo(piece)) {
      invalid.push(piece);
      continue;
    }
    if (numbers.includes(piece)) {
      if (!repeated.includes(piece)) repeated.push(piece);
      continue;
    }
    numbers.push(piece);
  }
  return { numbers, invalid, repeated };
}

// ---------------------------------------------------------------------------
// The stages a person sets
// ---------------------------------------------------------------------------

/** The normal path, in order. */
export const CONTAINER_PATH = ['not_loaded', 'on_sea', 'at_port', 'customs_cleared'] as const;
/** Set only by the container receipt. */
export const RECEIPT_STATUSES = ['received', 'missing_damaged'] as const;

/** The dated column each stage stamps (§17.2 — one date per stage, all kept). */
export const STAGE_DATE: Readonly<Record<string, string>> = {
  on_sea: 'departedOn',
  at_port: 'arrivedPortOn',
  customs_cleared: 'customsClearedOn',
};

/**
 * May a person move a container from `from` to `to`? Forward along the path
 * (skipping is allowed — a container can be cleared the day it lands); a late
 * container moves on when it is seen again; the receipt statuses and Late
 * belong to the receipt and the sweep.
 */
export function assertStatusMove(containerNo: string, from: string, to: string): void {
  if ((RECEIPT_STATUSES as readonly string[]).includes(from)) {
    throw new ShipmentValidationError(`${containerNo} has been received; its stages are closed.`);
  }
  if ((RECEIPT_STATUSES as readonly string[]).includes(to)) {
    throw new ShipmentValidationError(
      `${containerNo} is received by its container receipt, which counts what came — not by a status change.`,
    );
  }
  if (to === 'late') {
    throw new ShipmentValidationError('Late is set by the daily check when the ETA passes, not by hand.');
  }
  const fromIndex = from === 'late' ? 1 : CONTAINER_PATH.indexOf(from as (typeof CONTAINER_PATH)[number]);
  const toIndex = CONTAINER_PATH.indexOf(to as (typeof CONTAINER_PATH)[number]);
  if (toIndex < 0) throw new ShipmentValidationError(`'${to}' is not a container stage a person sets.`);
  if (from !== 'late' && toIndex <= fromIndex) {
    throw new ShipmentValidationError(
      `${containerNo} is already past that. A container goes forward — not loaded, on the sea, at port, customs cleared; a wrong date is corrected by a note.`,
    );
  }
}

// ---------------------------------------------------------------------------
// §17.5 — X of Y; §24.3 — the spread
// ---------------------------------------------------------------------------

export function progress(containers: readonly { countsAsReceived: boolean; cancelled?: boolean }[]) {
  const live = containers.filter((c) => !c.cancelled);
  const received = live.filter((c) => c.countsAsReceived).length;
  return { received, total: live.length, partly: received > 0 && received < live.length, all: live.length > 0 && received === live.length };
}

const UNIT = 10n ** BigInt(QUANTITY_SCALE);

/**
 * A quantity spread over `n` containers in whole units, the last taking the
 * remainder (§24.3 — the warehouse confirms it).
 */
export function spreadEqually(total: bigint, n: number): bigint[] {
  if (n <= 0) return [];
  const count = BigInt(n);
  const wholeUnits = total / UNIT;
  const base = (wholeUnits / count) * UNIT;
  const out = Array.from({ length: n }, () => base);
  out[n - 1] = total - base * (count - 1n);
  return out;
}

/**
 * IM2 — the containers of a B/L and what each carries, model by model.
 *
 * `available` is what of a model is still to be put in a container: ordered,
 * less what live containers already plan. A model whose column is left empty
 * in every row is divided equally over the new containers (whole units, the
 * last taking the rest — §24.3, flagged estimated). Typed quantities are taken
 * as typed, an empty cell beside them meaning none of it in that container.
 * Never more than is available: a B/L does not ship what was not ordered.
 */
export interface PlanModel {
  readonly key: string;
  readonly label: string;
  readonly available: bigint;
}

export function planContainers(
  models: readonly PlanModel[],
  rows: readonly { readonly quantities: Readonly<Record<string, bigint | null>> }[],
): { plan: bigint[][]; estimated: boolean } {
  const plan = rows.map(() => models.map(() => 0n));
  let estimated = false;
  for (const [m, model] of models.entries()) {
    const typed = rows.map((row) => row.quantities[model.key] ?? null);
    if (typed.some((value) => value !== null && value < 0n)) {
      throw new ShipmentValidationError(`${model.label}: a container carries none or more, never less than none.`);
    }
    if (typed.every((value) => value === null)) {
      if (model.available <= 0n || rows.length === 0) continue;
      const shares = spreadEqually(model.available, rows.length);
      for (const [r, share] of shares.entries()) plan[r]![m] = share;
      estimated = true;
      continue;
    }
    const total = typed.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
    if (total > model.available) {
      throw new ShipmentValidationError(
        `${model.label}: ${formatPlain(total)} in these containers, but only ${formatPlain(model.available)} is left to ship of what was ordered.`,
      );
    }
    for (const [r, value] of typed.entries()) plan[r]![m] = value ?? 0n;
  }
  return { plan, estimated };
}

/** A scaled quantity as plain digits (no grouping) — for messages. */
function formatPlain(value: bigint): string {
  const whole = value / UNIT;
  const fraction = value % UNIT;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(Number(QUANTITY_SCALE), '0').replace(/0+$/, '')}`;
}

// ---------------------------------------------------------------------------
// §18 — the receipt
// ---------------------------------------------------------------------------

export interface ReceiptLineInput {
  readonly planned: bigint;
  readonly received: bigint;
  readonly damaged: bigint;
  readonly short: bigint;
}

/** Planned − received: what the warehouse did not get in good order. */
export function lineVariance(line: ReceiptLineInput): bigint {
  return line.planned - line.received;
}

/** Received only if every line came whole: nothing damaged, nothing short, nothing missing. */
export function receiptOutcome(lines: readonly ReceiptLineInput[]): 'received' | 'missing_damaged' {
  return lines.every((line) => line.received === line.planned && line.damaged === 0n && line.short === 0n)
    ? 'received'
    : 'missing_damaged';
}

export function assertReceiptLines(lines: readonly ReceiptLineInput[], varianceReason: string | null | undefined) {
  if (lines.length === 0) throw new ShipmentValidationError('The container has no lines to receive. Load its plan first.');
  for (const line of lines) {
    if (line.received < 0n || line.damaged < 0n || line.short < 0n) {
      throw new ShipmentValidationError('Quantities received, damaged and short are counted, so never below zero.');
    }
    // IM2-1 — the three account for the plan: what arrived whole, what arrived
    // damaged, what was not there. More than planned arrives with nothing short.
    const arrived = line.received + line.damaged;
    if (arrived >= line.planned ? line.short !== 0n : arrived + line.short !== line.planned) {
      throw new ShipmentValidationError(
        arrived >= line.planned
          ? 'More than planned arrived, so nothing on that line is short. Leave Short empty.'
          : 'Received, damaged and short together make the planned quantity. Leave Short empty and it is worked out.',
      );
    }
  }
  if (receiptOutcome(lines) === 'missing_damaged' && !varianceReason?.trim()) {
    throw new ShipmentValidationError(
      'What arrived is not what was planned. Say what happened — the reason opens the claim for purchasing (§18).',
    );
  }
}
