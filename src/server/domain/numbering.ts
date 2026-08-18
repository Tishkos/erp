/**
 * Document numbering — Phase 01.5.
 *
 * Blueprint §3.4: "Unique document numbering."
 * Blueprint §14.2: the Journal Entry Number is "Generated automatically and
 * never reused."
 * Blueprint §24 requires a report of "duplicate source references and sequence
 * gaps".
 *
 * ── Never reused, therefore not gapless ─────────────────────────────────────
 * These two requirements point in opposite directions and only one of them is
 * in the blueprint. A counter incremented inside the caller's transaction is
 * gapless, but a rolled-back document hands its number to the next document —
 * the number *is* reused, which §14.2 forbids and which makes an audit trail
 * ambiguous ("which INV-000042 does this receipt refer to?").
 *
 * So allocation is deliberately non-transactional: the serial comes from a
 * PostgreSQL sequence, which does not roll back. A failed document leaves a
 * hole, and §24's gap report is what explains the hole. The Phase 01.5 gate
 * states this outright: "A rolled-back document leaves a recorded, reportable
 * gap rather than silently reusing the number."
 *
 * The database owns the counter. This module owns the *format* — one formatter,
 * so a number is never assembled two different ways.
 */

/** A sequence definition, per §4.3: prefix, pattern, next number, reset rules. */
export interface SequenceDefinition {
  /** Document type key, e.g. 'JOURNAL_ENTRY'. */
  readonly key: string;
  readonly prefix: string;
  /** Template over {PREFIX} {BRANCH} {YY} {YYYY} {SERIAL}. */
  readonly pattern: string;
  /** Digits the serial is padded to. */
  readonly padding: number;
  /** Reset rule: a separate counter per branch. */
  readonly scopeBranch: boolean;
  /** Reset rule: a separate counter per year. */
  readonly scopeYear: boolean;
}

/** The values a number is resolved against. */
export interface NumberingContext {
  readonly branchCode?: string | null;
  /** Full year of the **document date** — not today. Back-dating is legal (§14.6). */
  readonly year?: number | null;
}

const TOKEN_RE = /\{([A-Z]+)\}/g;
const KNOWN_TOKENS = new Set(['PREFIX', 'BRANCH', 'YY', 'YYYY', 'SERIAL']);

export class SequenceDefinitionError extends Error {
  readonly code = 'SEQUENCE_DEFINITION_INVALID';

  constructor(key: string, detail: string) {
    super(`Sequence '${key}' is not usable: ${detail}`);
    this.name = 'SequenceDefinitionError';
  }
}

export class NumberingContextError extends Error {
  readonly code = 'NUMBERING_CONTEXT_INCOMPLETE';

  constructor(key: string, detail: string) {
    super(`Cannot allocate a number for '${key}': ${detail}`);
    this.name = 'NumberingContextError';
  }
}

/**
 * Checks a definition is coherent before it can issue anything.
 *
 * A definition that resets per branch but omits {BRANCH} from its pattern would
 * mint the same document number in two branches. That has to fail at
 * configuration time, not on the day two branches collide.
 */
export function validateSequenceDefinition(def: SequenceDefinition): void {
  const tokens = [...def.pattern.matchAll(TOKEN_RE)].map((m) => m[1]!);
  const unknown = tokens.filter((t) => !KNOWN_TOKENS.has(t));

  if (unknown.length > 0) {
    throw new SequenceDefinitionError(def.key, `unknown token(s) ${unknown.join(', ')}`);
  }
  if (!tokens.includes('SERIAL')) {
    throw new SequenceDefinitionError(def.key, 'the pattern must contain {SERIAL}');
  }
  if (def.scopeBranch && !tokens.includes('BRANCH')) {
    throw new SequenceDefinitionError(
      def.key,
      'it resets per branch, so the pattern must contain {BRANCH} or two branches would share a number',
    );
  }
  if (def.scopeYear && !tokens.includes('YY') && !tokens.includes('YYYY')) {
    throw new SequenceDefinitionError(
      def.key,
      'it resets per year, so the pattern must contain {YY} or {YYYY} or two years would share a number',
    );
  }
  if (def.padding < 1 || def.padding > 18 || !Number.isInteger(def.padding)) {
    throw new SequenceDefinitionError(def.key, `padding must be 1–18, received ${def.padding}`);
  }
}

/**
 * The discriminator that selects which counter to draw from.
 *
 * Stable and canonical: it is stored on every allocation row and is what the
 * gap report groups by, so it must not change shape between releases.
 */
export function scopeKeyFor(def: SequenceDefinition, context: NumberingContext = {}): string {
  const parts: string[] = [];

  if (def.scopeBranch) {
    if (!context.branchCode) {
      throw new NumberingContextError(def.key, 'it resets per branch and no branch was supplied');
    }
    parts.push(context.branchCode);
  }
  if (def.scopeYear) {
    if (!context.year) {
      throw new NumberingContextError(def.key, 'it resets per year and no year was supplied');
    }
    parts.push(String(context.year));
  }
  return parts.join('|');
}

/** Renders the document number for an already-allocated serial. */
export function formatDocumentNumber(
  def: SequenceDefinition,
  serial: bigint,
  context: NumberingContext = {},
): string {
  validateSequenceDefinition(def);

  if (serial <= 0n) {
    throw new RangeError(`Serial must be positive, received ${serial}`);
  }

  return def.pattern.replace(TOKEN_RE, (_match, token: string) => {
    switch (token) {
      case 'PREFIX':
        return def.prefix;
      case 'BRANCH':
        if (!context.branchCode) {
          throw new NumberingContextError(def.key, 'the pattern uses {BRANCH} but none was supplied');
        }
        return context.branchCode;
      case 'YY':
        return String(requireYear(def, context) % 100).padStart(2, '0');
      case 'YYYY':
        return String(requireYear(def, context));
      case 'SERIAL':
        return serial.toString().padStart(def.padding, '0');
      default:
        // Unreachable — validateSequenceDefinition rejects unknown tokens.
        throw new SequenceDefinitionError(def.key, `unknown token {${token}}`);
    }
  });
}

function requireYear(def: SequenceDefinition, context: NumberingContext): number {
  if (!context.year) {
    throw new NumberingContextError(def.key, 'the pattern uses a year token but no year was supplied');
  }
  return context.year;
}

/**
 * The §24 gap report, as pure arithmetic.
 *
 * `issuedUpTo` is how far the sequence has advanced; `recorded` is the serials
 * that actually reached a committed document. The difference is the set of
 * numbers consumed by work that was rolled back — expected to be small, and
 * explainable one by one.
 */
export function findGaps(issuedUpTo: bigint, recorded: readonly bigint[]): bigint[] {
  const present = new Set(recorded.map((s) => s.toString()));
  const gaps: bigint[] = [];
  for (let serial = 1n; serial <= issuedUpTo; serial++) {
    if (!present.has(serial.toString())) gaps.push(serial);
  }
  return gaps;
}
