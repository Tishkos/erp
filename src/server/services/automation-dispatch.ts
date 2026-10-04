/**
 * The one thing a business transaction does for automation — platform phase, Agent 10.
 *
 *     await automation.dispatch(tx, 'ap_invoice.submitted', { …payload… }, { window });
 *
 * RECORDS a row in the outbox (`automation_event`), inside the caller's
 * transaction, through `automation_record_event` (a definer function, so the
 * person doing the work needs no grant on automation). It runs no rule, reads no
 * rule's parameters, calls no other service and cannot fail the caller: the
 * insert runs in its own savepoint, and a failure — a payload that does not fit
 * its event, a database error — is logged and the document goes on. A failing
 * rule can therefore never roll back, or delay, a posting or a submission; the
 * runner (`services/automation-runner.ts`) handles the event after the
 * transaction has committed.
 *
 * Nothing is recorded when nobody is listening (no enabled rule for the event,
 * or the global switch is off), so the outbox holds only facts a rule asked for.
 *
 * This file imports nothing but the database handle and the event catalogue, so
 * any service may import it without a cycle.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { EVENTS, episodeOf, payloadProblems, recordWindow, subjectKeyOf, type EventKey } from '../domain/automation-events';

export interface DispatchResult {
  /** The outbox row written; null when nothing was (nobody is listening, the same fact was recorded already, or it failed). */
  readonly id: string | null;
  readonly recorded: boolean;
  /** Why nothing was written, when it is a fault rather than "nobody is listening". */
  readonly problem?: string;
}

export interface DispatchOptions {
  /** What makes this occurrence distinct from the next one of the same fact. Default: the moment it is recorded. */
  readonly window?: string;
  /** For a sweep: the stretch of lateness. Default: from the payload (`episodeField`). */
  readonly episode?: string;
}

export async function dispatch(
  tx: Tx,
  key: EventKey,
  payload: Readonly<Record<string, unknown>>,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const def = EVENTS[key];
  const problems = payloadProblems(key, payload);
  if (problems.length > 0) {
    console.error(`[automation] ${key} was not recorded: ${problems.join('; ')}`);
    return { id: null, recorded: false, problem: problems.join('; ') };
  }
  const window = options.window ?? recordWindow(new Date().toISOString());
  const episode = options.episode ?? episodeOf(key, payload, window);
  const subjectKey = subjectKeyOf(key, payload);
  try {
    const id = await tx.transaction(async (savepoint) => {
      const result = await savepoint.execute(sql`
        select automation_record_event(
          ${key}, ${def.subjectType}, ${String(payload.subjectId)}, ${window}, ${episode},
          ${(payload.branchCode as string | null | undefined) ?? null}, ${JSON.stringify(payload)}::jsonb
        )::text as id`);
      return (result.rows[0] as { id: string | null } | undefined)?.id ?? null;
    });
    return { id, recorded: id !== null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[automation] ${key} for ${subjectKey} was not recorded and was left out: ${message}`);
    return { id: null, recorded: false, problem: message };
  }
}

/** Is any enabled rule waiting for this event (and is automation switched on)? A producer asks before it reads anything. */
export async function listening(tx: Tx, key: EventKey): Promise<boolean> {
  const result = await tx.execute(sql`select automation_listening(${key}) as on`);
  return (result.rows[0] as { on: boolean } | undefined)?.on === true;
}
