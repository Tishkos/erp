/**
 * Audit repository — Phase 01.4.
 *
 * The domain (`@domain/audit`) decides what an event contains and what is
 * redacted. This module decides *which transaction it commits in*, and that
 * turns out to be the whole design:
 *
 *   §5.4 — "Audit entries cannot be edited or deleted by application users."
 *   01.4 gate — "A rolled-back business transaction leaves no audit event —
 *   audit and change commit together or not at all."
 *   01.4 gate — "An authorisation failure is recorded with actor, target and
 *   outcome."
 *
 * Those last two pull in opposite directions. A refused request rolls its
 * transaction back; an event written inside it would roll back with it, and the
 * refusal would go unrecorded — which is precisely the event a security review
 * looks for. So there are two entry points, and choosing between them is not a
 * style preference:
 *
 *   record()          for something that HAPPENED. Joins the caller's
 *                     transaction, so it lives or dies with the change.
 *   recordSecurity()  for something that was REFUSED or FAILED. Commits on its
 *                     own connection, so it survives the rollback.
 */
import { sql } from 'drizzle-orm';
import {
  buildAuditEvent,
  type AuditEventInput,
} from '../domain/audit';
import { auditEvent } from '../db/schema';
import { applyScope, db, type RequestScope, type Tx } from '../db/client';

/**
 * Writes an audit event inside the caller's transaction.
 *
 * Never call this for a refusal: if the caller then throws, the record is lost.
 */
export async function record(tx: Tx, input: AuditEventInput): Promise<void> {
  const draft = buildAuditEvent(input);

  await tx.insert(auditEvent).values({
    actorUserId: draft.actorUserId,
    action: draft.action,
    objectType: draft.objectType,
    objectId: draft.objectId,
    branchCode: draft.branchCode,
    beforeValue: draft.beforeValue,
    afterValue: draft.afterValue,
    reason: draft.reason,
    outcome: draft.outcome,
    sessionId: draft.sessionId,
    requestId: draft.requestId,
    clientIp: draft.clientIp,
    relatedObjectId: draft.relatedObjectId,
  });
}

/**
 * Writes an audit event on its own connection and commits it immediately.
 *
 * For refusals and failures — §25 requires "authentication, authorisation
 * failures, privilege changes, exports, configuration changes, sensitive-data
 * access" to be logged, and every one of those can occur on a request that is
 * about to be rejected.
 *
 * The scope is passed explicitly because this transaction is not the caller's:
 * without it the RLS policy on audit_event would refuse the insert, which is
 * the correct behaviour for an unscoped connection and the wrong outcome here.
 */
export async function recordSecurity(
  scope: RequestScope,
  input: AuditEventInput,
): Promise<void> {
  await db.transaction(async (tx) => {
    await applyScope(tx, scope);
    await record(tx, input);
  });
}

/**
 * Reads the audit trail for one record — the "audit timeline" every record page
 * shows (§5.4, 01.12).
 *
 * Row scope is applied by RLS, not here. A caller cannot widen it by passing a
 * different filter, which is the point of enforcing it in the database.
 */
export async function timelineFor(
  tx: Tx,
  objectType: string,
  objectId: string,
  limit = 200,
): Promise<Array<Record<string, unknown>>> {
  const result = await tx.execute(sql`
    select id, occurred_at, actor_user_id, action, object_id, branch_code,
           before_value, after_value, reason, outcome, related_object_id
      from audit_event
     where object_type = ${objectType}
       and object_id   = ${objectId}
     order by occurred_at desc, id desc
     limit ${limit}
  `);
  return result.rows as Array<Record<string, unknown>>;
}

/** Another audit object whose events belong on a record's log. */
export type RelatedObjects =
  | { readonly objectType: string; readonly objectId: string }
  | { readonly objectType: string; readonly field: string; readonly value: string };

/**
 * The trail of one document, with the paperwork's events folded in.
 *
 * An attachment is its own audit object — it is uploaded, quarantined,
 * disposed of in its own right — but a person reading a journal's history
 * wants to see "a file was attached" among the journal's events, in order.
 * The attachment's events name their parent (`after_value.parent`), so they
 * are read back alongside.
 */
export async function timelineWithAttachments(
  tx: Tx,
  objectType: string,
  objectId: string,
  limit = 200,
  /**
   * Other objects whose events belong on this record's log. A department's
   * memberships are their own audit objects (`user_department_scope`,
   * `<user>:<code>`), but a person reading the department wants "Employee
   * added · made manager" among its events, not an empty log. `objectId` is
   * a LIKE pattern, so `%:FIN` finds every membership of FIN. Where the link
   * is in the event's after-image instead — a person granted the department
   * (`app_user`, `after.departmentCode`) — name the field.
   */
  related: readonly RelatedObjects[] = [],
): Promise<Array<Record<string, unknown>>> {
  const parent = `${objectType}:${objectId}`;
  const also = related.map((r) =>
    'field' in r
      ? sql`or (object_type = ${r.objectType} and after_value->>${r.field} = ${r.value})`
      : sql`or (object_type = ${r.objectType} and object_id like ${r.objectId})`,
  );
  const result = await tx.execute(sql`
    select id, occurred_at, actor_user_id, action, object_type, object_id, branch_code,
           before_value, after_value, reason, outcome, related_object_id
      from audit_event
     where (object_type = ${objectType} and object_id = ${objectId})
        or (object_type = 'attachment' and after_value->>'parent' = ${parent})
        ${sql.join(also, sql` `)}
     order by occurred_at desc, id desc
     limit ${limit}
  `);
  return result.rows as Array<Record<string, unknown>>;
}
