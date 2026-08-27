/**
 * Automatic Document Numbering, the configuration half — Phase 0 requirement 9.
 *
 * "Every future transaction or document receives a unique system-generated
 * number and that number is not reused." The allocation half is
 * `numbering.ts`; this is where the series themselves are maintained: prefix,
 * pattern, padding and the reset rules. Changing a series never renumbers
 * what was already issued — allocations are append-only at the database.
 */
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { docNumberAllocation, docSequence } from '../db/schema';
import { validateSequenceDefinition } from '../domain/numbering';
import {
  AdminNotFoundError,
  AdminValidationError,
  normaliseCode,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'number_series';

export interface SeriesInput {
  readonly prefix: string;
  readonly pattern: string;
  readonly padding: number;
  readonly scopeBranch: boolean;
  readonly scopeYear: boolean;
}

export async function listAll(tx: Tx) {
  const series = await tx.select().from(docSequence).orderBy(asc(docSequence.key));
  const issued = await tx
    .select({
      key: docNumberAllocation.sequenceKey,
      count: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${docNumberAllocation.documentNo})`,
    })
    .from(docNumberAllocation)
    .groupBy(docNumberAllocation.sequenceKey);
  const byKey = new Map(issued.map((i) => [i.key, i]));
  return series.map((s) => ({
    ...s,
    issuedCount: byKey.get(s.key)?.count ?? 0,
    lastNumber: byKey.get(s.key)?.last ?? null,
  }));
}

export async function get(tx: Tx, key: string) {
  const [row] = await tx.select().from(docSequence).where(eq(docSequence.key, key)).limit(1);
  if (!row) throw new AdminNotFoundError('number series', key);
  return row;
}

/** The most recent numbers a series handed out — what "not reused" looks like. */
export async function recentAllocations(tx: Tx, key: string, limit = 20) {
  return tx
    .select({
      documentNo: docNumberAllocation.documentNo,
      scopeKey: docNumberAllocation.scopeKey,
      serial: docNumberAllocation.serial,
      allocatedAt: docNumberAllocation.allocatedAt,
    })
    .from(docNumberAllocation)
    .where(eq(docNumberAllocation.sequenceKey, key))
    .orderBy(desc(docNumberAllocation.allocatedAt))
    .limit(limit);
}

function normalise(key: string, input: SeriesInput) {
  const padding = Number(input.padding);
  if (!Number.isInteger(padding) || padding < 1 || padding > 18) {
    throw new AdminValidationError('padding', 'is a whole number from 1 to 18');
  }
  const definition = {
    key,
    prefix: requireText(input.prefix, 'prefix', 10).toUpperCase(),
    pattern: requireText(input.pattern, 'pattern', 60).toUpperCase(),
    padding,
    scopeBranch: Boolean(input.scopeBranch),
    scopeYear: Boolean(input.scopeYear),
  };
  try {
    validateSequenceDefinition(definition);
  } catch (error) {
    throw new AdminValidationError('pattern', (error as Error).message);
  }
  return definition;
}

export async function create(tx: Tx, ctx: ActorContext, input: SeriesInput & { readonly key: string }) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const key = normaliseCode(input.key, 'key');
  const [existing] = await tx.select({ key: docSequence.key }).from(docSequence).where(eq(docSequence.key, key));
  if (existing) throw new AdminValidationError('key', `'${key}' is already a series`);
  const values = { ...normalise(key, input), active: true };
  await tx.insert(docSequence).values(values);
  await recordChange(tx, ctx, {
    action: 'number_series.created',
    objectType: PERMISSION_OBJECT,
    objectId: key,
    after: values,
  });
  return get(tx, key);
}

export async function update(tx: Tx, ctx: ActorContext, key: string, input: SeriesInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, key);
  const before = await get(tx, key);
  const { key: _key, ...values } = normalise(key, input);
  await tx.update(docSequence).set(values).where(eq(docSequence.key, key));
  await recordChange(tx, ctx, {
    action: 'number_series.updated',
    objectType: PERMISSION_OBJECT,
    objectId: key,
    before: {
      prefix: before.prefix,
      pattern: before.pattern,
      padding: before.padding,
      scopeBranch: before.scopeBranch,
      scopeYear: before.scopeYear,
    },
    after: values,
  });
  return get(tx, key);
}

export async function setActive(tx: Tx, ctx: ActorContext, key: string, active: boolean) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, key);
  const before = await get(tx, key);
  if (before.active === active) return before;
  await tx.update(docSequence).set({ active }).where(eq(docSequence.key, key));
  await recordChange(tx, ctx, {
    action: active ? 'number_series.reactivated' : 'number_series.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: key,
    before: { active: before.active },
    after: { active },
    reason: active ? null : 'Series closed by administrator',
  });
  return get(tx, key);
}
