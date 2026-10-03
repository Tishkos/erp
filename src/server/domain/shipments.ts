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
  const letterValue = (c: string) => {
    // A=10 … skipping multiples of 11 (11, 22, 33).
    let v = 10;
    for (let code = 65; code < c.charCodeAt(0); code += 1) {
      v += 1;
      if (v % 11 === 0) v += 1;
    }
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const c = value[i]!;
    const v = /[A-Z]/.test(c) ? letterValue(c) : Number(c);
    sum += v * 2 ** i;
  }
  return (sum % 11) % 10 === Number(value[10]);
}

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
