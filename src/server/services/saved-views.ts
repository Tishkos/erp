/**
 * Saved views — Phase 01.12, Appendix A global UI rule 1.
 *
 * A view stores a question. Opening one re-validates it against the current
 * list definition and runs it as the *reader*, so:
 *
 *   - a view saved before a column was removed reports that clearly instead of
 *     failing at the database,
 *   - a shared view cannot show its reader anything their own permissions and
 *     data scope would not.
 *
 * The second point is why `open()` returns a normalised query rather than rows
 * the author already fetched.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { savedView } from '../db/schema';
import { normaliseQuery, type ListQuery, type RawListQuery } from '../domain/list-view';
import type { Principal } from '../domain/permissions';
import { assertCan } from '../domain/permissions';
import { listSource } from './list';

export class SavedViewNotFoundError extends Error {
  readonly code = 'SAVED_VIEW_NOT_FOUND';
  constructor(readonly viewId: string) {
    super('That saved view no longer exists, or is not shared with you.');
    this.name = 'SavedViewNotFoundError';
  }
}

export class SavedViewNotOwnedError extends Error {
  readonly code = 'SAVED_VIEW_NOT_OWNED';
  constructor(readonly viewId: string) {
    // §25 — reason and corrective action, not a bare refusal.
    super(
      'Only the person who created a saved view may change it. Save a copy under your own name instead.',
    );
    this.name = 'SavedViewNotOwnedError';
  }
}

export interface SavedViewRecord {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly isShared: boolean;
  readonly isDefault: boolean;
  readonly query: RawListQuery;
}

export interface SaveViewInput {
  readonly listKey: string;
  readonly name: string;
  readonly query: RawListQuery;
  readonly isShared?: boolean;
  readonly isDefault?: boolean;
}

/**
 * Create or replace one of the caller's views.
 *
 * The query is validated before it is stored, so an unusable view cannot be
 * saved and then fail for whoever opens it — including its author, a month
 * later, with no memory of what they set.
 */
export async function save(
  tx: Tx,
  principal: Principal,
  input: SaveViewInput,
): Promise<SavedViewRecord> {
  const source = listSource(input.listKey);
  assertCan(principal, 'view', source.definition.object);
  normaliseQuery(source.definition, principal, input.query);

  if (input.isDefault) await clearDefault(tx, principal, input.listKey);

  const [row] = await tx
    .insert(savedView)
    .values({
      listKey: input.listKey,
      name: input.name.trim(),
      ownerUserId: principal.userId,
      isShared: input.isShared ?? false,
      isDefault: input.isDefault ?? false,
      query: input.query,
    })
    .onConflictDoUpdate({
      target: [savedView.ownerUserId, savedView.listKey, savedView.name],
      set: {
        query: input.query,
        isShared: input.isShared ?? false,
        isDefault: input.isDefault ?? false,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return toRecord(row!);
}

async function clearDefault(tx: Tx, principal: Principal, listKey: string): Promise<void> {
  // Cleared before the new default is written — the partial unique index allows
  // exactly one, and doing it the other way round collides with itself.
  await tx
    .update(savedView)
    .set({ isDefault: false })
    .where(
      and(
        eq(savedView.ownerUserId, principal.userId),
        eq(savedView.listKey, listKey),
        eq(savedView.isDefault, true),
      ),
    );
}

/** The caller's own views for a list, plus the ones others shared. */
export async function listFor(
  tx: Tx,
  principal: Principal,
  listKey: string,
): Promise<readonly SavedViewRecord[]> {
  const rows = await tx
    .select()
    .from(savedView)
    .where(
      and(
        eq(savedView.listKey, listKey),
        or(eq(savedView.ownerUserId, principal.userId), eq(savedView.isShared, true)),
      ),
    )
    .orderBy(savedView.name);

  return rows.map(toRecord);
}

/**
 * Resolve a saved view into a query this principal may run.
 *
 * Re-validation here is the control: the author's permissions at save time say
 * nothing about the reader's now.
 */
export async function open(
  tx: Tx,
  principal: Principal,
  viewId: string,
): Promise<{ view: SavedViewRecord; query: ListQuery }> {
  const [row] = await tx.select().from(savedView).where(eq(savedView.id, viewId)).limit(1);
  if (!row) throw new SavedViewNotFoundError(viewId);

  const view = toRecord(row);
  const source = listSource(view.listKey);
  assertCan(principal, 'view', source.definition.object);

  return { view, query: normaliseQuery(source.definition, principal, view.query) };
}

/** The view that opens when the user arrives at a list, if they set one. */
export async function defaultFor(
  tx: Tx,
  principal: Principal,
  listKey: string,
): Promise<SavedViewRecord | null> {
  const [row] = await tx
    .select()
    .from(savedView)
    .where(
      and(
        eq(savedView.listKey, listKey),
        eq(savedView.ownerUserId, principal.userId),
        eq(savedView.isDefault, true),
      ),
    )
    .limit(1);

  return row ? toRecord(row) : null;
}

export async function remove(tx: Tx, principal: Principal, viewId: string): Promise<void> {
  const [row] = await tx.select().from(savedView).where(eq(savedView.id, viewId)).limit(1);
  if (!row) throw new SavedViewNotFoundError(viewId);
  if (row.ownerUserId !== principal.userId) throw new SavedViewNotOwnedError(viewId);

  await tx.delete(savedView).where(eq(savedView.id, viewId));
}

function toRecord(row: typeof savedView.$inferSelect): SavedViewRecord {
  return {
    id: row.id,
    listKey: row.listKey,
    name: row.name,
    ownerUserId: row.ownerUserId,
    isShared: row.isShared,
    isDefault: row.isDefault,
    query: row.query as RawListQuery,
  };
}
