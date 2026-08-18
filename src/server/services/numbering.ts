/**
 * Document numbering repository — Phase 01.5.
 *
 * The database owns the counter (a sequence, so numbers are never reused) and
 * `@domain/numbering` owns the format. This module joins them and records the
 * allocation.
 *
 * §14.2 — the number is "generated automatically and never reused".
 * §24 — sequence gaps are a required report.
 */
import { eq, sql } from 'drizzle-orm';
import {
  formatDocumentNumber,
  scopeKeyFor,
  validateSequenceDefinition,
  type NumberingContext,
  type SequenceDefinition,
} from '../domain/numbering';
import { docNumberAllocation, docSequence } from '../db/schema';
import type { Tx } from '../db/client';

export class UnknownSequenceError extends Error {
  readonly code = 'UNKNOWN_SEQUENCE';

  constructor(key: string) {
    super(`No active document sequence is configured for '${key}'.`);
    this.name = 'UnknownSequenceError';
  }
}

export interface AllocatedNumber {
  readonly documentNo: string;
  readonly serial: bigint;
  readonly scopeKey: string;
}

export async function loadSequenceDefinition(tx: Tx, key: string): Promise<SequenceDefinition> {
  const [row] = await tx.select().from(docSequence).where(eq(docSequence.key, key)).limit(1);

  if (!row || !row.active) {
    throw new UnknownSequenceError(key);
  }

  const definition: SequenceDefinition = {
    key: row.key,
    prefix: row.prefix,
    pattern: row.pattern,
    padding: row.padding,
    scopeBranch: row.scopeBranch,
    scopeYear: row.scopeYear,
  };

  validateSequenceDefinition(definition);
  return definition;
}

/**
 * Allocates the next document number.
 *
 * The serial is drawn from a sequence, which does not roll back. If the caller's
 * transaction then fails, the number is spent and shows up in
 * `gapsFor()` — deliberately. §14.2 forbids handing it to the next document.
 *
 * `context.year` must come from the **document date**, not from today:
 * back-dated posting into an open period is legal (§14.6), and a back-dated
 * document belongs to its own year's sequence.
 */
export async function allocateDocumentNumber(
  tx: Tx,
  key: string,
  context: NumberingContext = {},
  allocatedBy: string | null = null,
): Promise<AllocatedNumber> {
  const definition = await loadSequenceDefinition(tx, key);
  const scopeKey = scopeKeyFor(definition, context);

  const result = await tx.execute(
    sql`select next_document_serial(${key}, ${scopeKey})::text as serial`,
  );
  const serial = BigInt((result.rows[0] as { serial: string }).serial);
  const documentNo = formatDocumentNumber(definition, serial, context);

  await tx.insert(docNumberAllocation).values({
    sequenceKey: key,
    scopeKey,
    serial,
    documentNo,
    allocatedBy,
  });

  return { documentNo, serial, scopeKey };
}

/**
 * The §24 sequence-gap report for one sequence and scope.
 *
 * A gap is a number the sequence issued that never reached a committed
 * document. It is explanatory, not an error: a growing gap count means
 * documents are failing after allocation, and that is what it is there to show.
 */
export async function gapsFor(
  tx: Tx,
  key: string,
  context: NumberingContext = {},
): Promise<bigint[]> {
  const definition = await loadSequenceDefinition(tx, key);
  const scopeKey = scopeKeyFor(definition, context);

  const result = await tx.execute(
    sql`select missing_serial::text as missing_serial from document_number_gaps(${key}, ${scopeKey})`,
  );
  return (result.rows as Array<{ missing_serial: string }>).map((r) => BigInt(r.missing_serial));
}
