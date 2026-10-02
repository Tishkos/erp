/**
 * Document actions — Phase 01.12.
 *
 * 01.12 gate: *"An action invalid for the current status is disabled **and**
 * rejected server-side if invoked directly."*
 *
 * The two halves of that sentence are one function. `actionsFor` in the domain
 * decides what the screen enables; `perform` below re-asks the same question
 * before it does anything. Nothing reaches a status change except through here,
 * so a button that was never rendered, a stale tab, a replayed request and a
 * direct API call all meet the same refusal.
 *
 * §23 states the requirement for APIs: *"Every create/update API must enforce
 * the same permissions and business validations as the user interface."* The
 * way to be certain of that is for there to be one implementation, and for the
 * user interface to be one of its callers rather than its owner.
 */
import type { Tx } from '../db/client';
import { assertCan, type Principal } from '../domain/permissions';
import { actionsFor, type RecordAction } from '../domain/record-view';
import * as authz from './authorization';
import { assertTransition, type DocumentStatus } from '../domain/statuses';
import * as audit from './audit';
import { recordSource, transitionsFor } from './record';

export class ActionNotAvailableError extends Error {
  readonly code = 'ACTION_NOT_AVAILABLE';

  constructor(
    readonly action: string,
    readonly status: DocumentStatus,
    readonly reasonKey: string,
  ) {
    // §25 — the field, the reason and what to do instead. A refusal that says
    // only "not allowed" sends the user to the help desk to find out why.
    super(
      `'${action}' is not available while this document is '${status}'. ` +
        `Reason: ${reasonKey.split('.').pop()}. ` +
        'Refresh the record to see the actions that are available now.',
    );
    this.name = 'ActionNotAvailableError';
  }
}

export class UnknownActionError extends Error {
  readonly code = 'UNKNOWN_ACTION';
  constructor(action: string, documentType: string) {
    super(`'${action}' is not an action of a ${documentType}.`);
    this.name = 'UnknownActionError';
  }
}

export interface PerformInput {
  readonly documentType: string;
  readonly documentId: string;
  readonly action: string;
  /** §5.4 — required for cancellation, rejection and override actions. */
  readonly reason?: string | null;
  /** The branch the session is in, for the audit trail. */
  readonly branchCode?: string | null;
}

export interface PerformResult {
  readonly documentType: string;
  readonly documentId: string;
  readonly from: DocumentStatus;
  readonly to: DocumentStatus | null;
}

/**
 * The effect an action has, supplied by the module that owns the document.
 *
 * Registered separately from the record source because an effect writes and a
 * record source reads; a module can have record pages before it has actions.
 */
export interface ActionContext {
  readonly principal: Principal;
  /** The branch the session is working in — not the document's own. */
  readonly branchCode: string;
  readonly reason: string | null;
}

export type ActionEffect = (
  tx: Tx,
  documentId: string,
  context: ActionContext,
) => Promise<void>;

const effects = new Map<string, ActionEffect>();

const effectKey = (documentType: string, action: string) => `${documentType}:${action}`;

export function registerActionEffect(
  documentType: string,
  action: string,
  effect: ActionEffect,
): void {
  effects.set(effectKey(documentType, action), effect);
}

/**
 * Perform an action, or refuse it with a reason.
 *
 * The order is deliberate: resolve the document, ask the same question the
 * screen asked, refuse if the answer is no, and only then run the effect. The
 * effect never re-decides — if it could, there would be two answers to "may
 * this happen?" and the one that mattered would be whichever ran last.
 */
export async function perform(
  tx: Tx,
  principal: Principal,
  input: PerformInput,
): Promise<PerformResult> {
  const source = recordSource(input.documentType);
  assertCan(principal, 'view', source.object);

  const header = await source.loadHeader(tx, input.documentId);
  if (!header) {
    throw new Error(`No ${input.documentType} '${input.documentId}' is visible to you.`);
  }

  const transitions = await transitionsFor(tx, input.documentType);
  const overrides = (await source.actionOverrides?.(tx, header)) ?? {};

  const available: readonly RecordAction[] = actionsFor(
    {
      documentType: source.object,
      status: header.status,
      transitions,
      principal,
      overrides,
    },
    source.actions,
  );

  const action = available.find((a) => a.key === input.action);
  if (!action) throw new UnknownActionError(input.action, input.documentType);

  // HD6 — the verb is authorised through the one door every service uses,
  // so a refusal is written to the audit trail (§25: authorisation failures
  // are logged) and the branch is checked, not only the grant.
  await authz.authorize(principal, action.verb, source.object, {
    branchCode: input.branchCode ?? header.branchCode ?? principal.defaultBranchCode ?? '',
    objectId: header.auditObjectId ?? input.documentId,
  });

  if (!action.enabled) {
    // Recorded, not just refused: an attempt to act outside the status machine
    // is exactly the kind of thing §5.4's trail exists to show. Written on this
    // transaction, which the caller is expected to roll back — see the note in
    // `services/authorization.ts` about refusals that vanish with their own
    // transaction; the route handler commits the refusal separately.
    throw new ActionNotAvailableError(
      input.action,
      header.status,
      action.disabledReasonKey ?? 'action.disabled.wrong_status',
    );
  }

  if (action.targetStatus !== null) {
    // The status machine is asked again in its own terms, so a document type
    // whose transition table and action list disagree fails closed.
    assertTransition(
      input.documentType,
      transitions,
      header.status,
      action.targetStatus,
      input.reason,
    );
  }

  const effect = effects.get(effectKey(input.documentType, input.action));
  if (effect) {
    await effect(tx, input.documentId, {
      principal,
      branchCode: input.branchCode ?? header.branchCode ?? principal.defaultBranchCode ?? '',
      reason: input.reason ?? null,
    });
  }

  await audit.record(tx, {
    actorUserId: principal.userId,
    action: `${source.object}.${input.action}`,
    objectType: source.object,
    objectId: header.auditObjectId ?? input.documentId,
    branchCode: header.branchCode,
    before: { status: header.status },
    after: { status: action.targetStatus ?? header.status },
    reason: input.reason ?? null,
    outcome: 'success',
  });

  return {
    documentType: input.documentType,
    documentId: input.documentId,
    from: header.status,
    to: action.targetStatus,
  };
}

/** Exposed for tests: clears registered effects between suites. */
export function resetActionEffects(): void {
  effects.clear();
}
