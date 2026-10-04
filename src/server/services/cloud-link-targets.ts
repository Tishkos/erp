/**
 * Which ERP records a cloud file can be linked to — and who may say so.
 *
 * The attachment service asks the *record's* module whether a person may see
 * the record before it will staple anything to it (`registerParentAccessCheck`).
 * A link between a cloud file and a record is the same kind of act, so it is
 * held to the same rule by the same idea: a registry keyed by the record's
 * object type, where a record kind that has not been registered cannot be
 * linked to at all (deny by default), and where "may I open this record?" is
 * answered in the asker's own scope — row-level security decides the branch.
 *
 * A kind is a small description, not a service: which table holds the record,
 * which column is the id the record's paperclip files under, which column is
 * the number a person knows it by, which permission object opens it and which
 * route shows it. Where the attachment registry already knows how to answer
 * for that kind (it has a dozen special cases — an employee's request is also
 * the employee's own), its answer is used; otherwise the kind's permission
 * object and a visible row are the answer.
 *
 * The Task Center and the other platform modules register their own kinds
 * with `registerCloudLinkTarget` when they are built; nothing here needs to
 * change for them.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { can, type Principal } from '../domain/permissions';
import * as attachments from './attachments';

export interface CloudLinkTarget {
  /** The object type — the same string the record's paperclip and history use. */
  readonly type: string;
  /** The permission object that lets a person open this kind of record. */
  readonly object: string;
  readonly table: string;
  /** The column the paperclip files under (`id`, or the code/number for a record addressed by it). */
  readonly idColumn: string;
  readonly idKind: 'uuid' | 'text';
  /** The column a person knows the record by. */
  readonly labelColumn: string;
  /** Null for a company-wide record. */
  readonly branchColumn: string | null;
  /** An extra condition on the row (a business partner is a customer or a supplier), as SQL. */
  readonly where?: string;
  /** The screen that shows the record. */
  readonly href: (label: string, id: string) => string;
  /** The folder a record of this kind gets under the record root. Stable English: it is a name in the cloud. */
  readonly folderName: string;
  /** The audit object the record's history is read under, where it is not `type` (a customer's is `business_partner`). */
  readonly auditObject?: string;
}

export interface RecordRef {
  readonly type: string;
  readonly id: string;
  readonly label: string;
  readonly branchCode: string | null;
  readonly href: string;
  /** The audit object and id the record's history is kept under. */
  readonly auditObject: string;
}

const targets = new Map<string, CloudLinkTarget>();

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function registerCloudLinkTarget(target: CloudLinkTarget): void {
  for (const identifier of [target.table, target.idColumn, target.labelColumn, ...(target.branchColumn ? [target.branchColumn] : [])]) {
    if (!SAFE_IDENTIFIER.test(identifier)) throw new Error(`Cloud link target '${target.type}': '${identifier}' is not an identifier.`);
  }
  targets.set(target.type, target);
}

export function clearCloudLinkTargets(): void {
  targets.clear();
}

export function targetOf(type: string): CloudLinkTarget | null {
  return targets.get(type) ?? null;
}

export function allTargets(): readonly CloudLinkTarget[] {
  return [...targets.values()];
}

/** The kinds this person may open at all — what a "link to a record" form offers. */
export function targetsFor(principal: Principal): readonly CloudLinkTarget[] {
  return allTargets().filter((target) => can(principal, 'view', target.object));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lookup(tx: Tx, target: CloudLinkTarget, column: string, value: string): Promise<{ id: string; label: string; branch: string | null } | null> {
  const idColumn = sql.identifier(target.idColumn);
  const labelColumn = sql.identifier(target.labelColumn);
  const branch = target.branchColumn ? sql`${sql.identifier(target.branchColumn)}::text` : sql`null::text`;
  const match =
    column === target.idColumn && target.idKind === 'uuid'
      ? UUID.test(value)
        ? sql`${idColumn} = ${value}::uuid`
        : null
      : sql`${sql.identifier(column)} = ${value}`;
  if (!match) return null;
  const extra = target.where ? sql` and ${sql.raw(target.where)}` : sql``;
  const result = await tx.execute(
    sql`select ${idColumn}::text as id, ${labelColumn}::text as label, ${branch} as branch
          from ${sql.identifier(target.table)} where ${match}${extra} limit 1`,
  );
  const row = result.rows[0] as { id: string; label: string; branch: string | null } | undefined;
  return row ?? null;
}

async function mayOpen(tx: Tx, principal: Principal, target: CloudLinkTarget, id: string): Promise<boolean> {
  if (!can(principal, 'view', target.object)) return false;
  // The paperclip's own answer, where the owning module gave one.
  const answered = await attachments.mayAccessParent(tx, principal, target.type, id);
  return answered === null ? true : answered;
}

/**
 * The record, if this person may open it — null if it does not exist, is in a
 * branch they cannot see, or they hold no grant. One answer for all three:
 * the difference would itself tell them about records they cannot open.
 */
export async function openRecord(tx: Tx, principal: Principal, type: string, id: string): Promise<RecordRef | null> {
  const target = targets.get(type);
  if (!target) return null;
  const row = await lookup(tx, target, target.idColumn, id);
  if (!row) return null;
  if (!(await mayOpen(tx, principal, target, row.id))) return null;
  return { type, id: row.id, label: row.label, branchCode: row.branch, href: target.href(row.label, row.id), auditObject: target.auditObject ?? target.type };
}

/** The same, finding the record by the number a person types. */
export async function findRecord(tx: Tx, principal: Principal, type: string, label: string): Promise<RecordRef | null> {
  const target = targets.get(type);
  if (!target) return null;
  const wanted = label.trim();
  if (wanted === '') return null;
  const row = await lookup(tx, target, target.labelColumn, wanted);
  if (!row) return null;
  if (!(await mayOpen(tx, principal, target, row.id))) return null;
  return { type, id: row.id, label: row.label, branchCode: row.branch, href: target.href(row.label, row.id), auditObject: target.auditObject ?? target.type };
}
