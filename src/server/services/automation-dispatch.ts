/**
 * The one thing a business transaction does for automation — platform phase, Agent 10.
 *
 *     await automation.dispatch(tx, 'ap_invoice.submitted', async (sp) => ({ …payload… }), { window });
 *
 * RECORDS a row in the outbox (`automation_event`), inside the caller's
 * transaction, through `automation_record_event` (a definer function, so the
 * person doing the work needs no grant on automation). It runs no rule, reads no
 * rule's parameters, calls no other service and cannot fail the caller: everything
 * here — asking whether anybody listens, building the payload, the insert — runs in
 * a savepoint of its own, and a failure (a payload that does not fit its event, a
 * database error, a bug in the producer's own query) is logged and the document goes
 * on. A failing rule can therefore never roll back, or delay, a posting or a
 * submission; the runner (`services/automation-runner.ts`) handles the event after
 * the transaction has committed.
 *
 * Nothing is read or recorded when nobody is listening (no enabled rule for the
 * event, or the global switch is off): the payload is given as a function, so a
 * producer's queries are only run for a fact a rule asked for, and the outbox holds
 * only those.
 *
 * This file imports nothing but the database handle and the event catalogue, so
 * any service may import it without a cycle.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { EVENTS, episodeOf, payloadProblems, recordWindow, type EventKey } from '../domain/automation-events';

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

type Payload = Readonly<Record<string, unknown>>;

/** What the event says: the payload itself, or a function that reads it (called only when somebody is listening). */
export type PayloadSource = Payload | ((tx: Tx) => Promise<Payload>);

export async function listening(tx: Tx, key: EventKey): Promise<boolean> {
  const result = await tx.execute(sql`select automation_listening(${key}) as on`);
  return (result.rows[0] as { on: boolean } | undefined)?.on === true;
}

const NOT_RECORDED: DispatchResult = { id: null, recorded: false };

export async function dispatch(tx: Tx, key: EventKey, source: PayloadSource, options: DispatchOptions = {}): Promise<DispatchResult> {
  const def = EVENTS[key];

  // A payload handed over whole is checked at once: a producer that gets the shape wrong is told, whether or not a rule listens.
  const refuse = (problems: string[]): DispatchResult => {
    console.error(`[automation] ${key} was not recorded: ${problems.join('; ')}`);
    return { id: null, recorded: false, problem: problems.join('; ') };
  };
  if (typeof source !== 'function') {
    const problems = payloadProblems(key, source);
    if (problems.length > 0) return refuse(problems);
  }

  const window = options.window ?? recordWindow(new Date().toISOString());
  try {
    return await tx.transaction(async (sp): Promise<DispatchResult> => {
      const savepoint = sp as unknown as Tx;
      if (!(await listening(savepoint, key))) return NOT_RECORDED;
      const payload = typeof source === 'function' ? await source(savepoint) : source;
      if (typeof source === 'function') {
        const problems = payloadProblems(key, payload);
        if (problems.length > 0) return refuse(problems);
      }
      const episode = options.episode ?? episodeOf(key, payload, window);
      const result = await savepoint.execute(sql`
        select automation_record_event(
          ${key}, ${def.subjectType}, ${String(payload.subjectId)}, ${window}, ${episode},
          ${(payload.branchCode as string | null | undefined) ?? null}, ${JSON.stringify(payload)}::jsonb
        )::text as id`);
      const id = (result.rows[0] as { id: string | null } | undefined)?.id ?? null;
      return { id, recorded: id !== null };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[automation] ${key} was not recorded and was left out: ${message}`);
    return { id: null, recorded: false, problem: message };
  }
}
