/**
 * The automation runner — platform phase, Agent 10.
 *
 * Consumes the outbox (`automation_event`) one event at a time, in order, with
 * `FOR UPDATE SKIP LOCKED`: two runners at once take different events and never
 * the same one. Each event is its own transaction, opened as the system operator;
 * what that transaction does for each enabled rule is:
 *
 *   1. read the rule's current version and re-validate it against the event's
 *      closed vocabulary;
 *   2. load the rule's OWNER. A deactivated owner, or one who no longer holds
 *      `administer` on automation, PAUSES the rule (and the run is logged as
 *      skipped): a rule never runs on authority its owner has lost;
 *   3. evaluate the conditions (`domain/automation.evaluate`: pure, exact);
 *   4. run each action as the owner (`automation-actions.perform`), each in a
 *      savepoint of its own, so one that fails undoes only itself;
 *   5. write the run — `automation_run`, append-only: the rule version, what was
 *      planned, what each step did, the outcome and why, in plain words.
 *
 * What may fail, and what that means:
 *
 *   refused   the owner could not do it by hand, or the owning service said no
 *             (a section they may not raise a task in, a person they may not give
 *             one to). Logged `skipped`; never retried, never counted against the
 *             rule — it is working as designed.
 *   failed    anything else (a fault). Logged `failed`, the event is retried at
 *             one minute, ten minutes and an hour (the notification runner's own
 *             backoff, three attempts), the actions that already worked are
 *             carried over and not repeated. When the attempts are used up it
 *             counts against the rule, and enough in a row PAUSE it and tell the
 *             administrators. Nothing is swallowed.
 *
 * A rule acts once on a record in a stretch of lateness (`run_key`, held by a
 * unique index); a second run of the same event, a replay, a double dispatch or
 * two runners at once change nothing. None of this runs inside a business
 * transaction: a purchase invoice is submitted or posted whether or not any rule
 * works, and the runner never touches the ledger or the stock.
 */
import { sql } from 'drizzle-orm';
import { applyScope, db, type RequestScope, type Tx } from '../db/client';
import {
  AutomationError,
  MAX_ATTEMPTS,
  describeUnmet,
  evaluate,
  guardOf,
  nextAttemptAt,
  outcomeOf,
  runKeyOf,
  shouldPause,
  validateDefinition,
  type ActionResult,
  type Definition,
  type Outcome,
} from '../domain/automation';
import { EVENTS, PAUSED_KIND, type EventKey } from '../domain/automation-events';
import { PermissionDeniedError, ScopeDeniedError, can, type Principal } from '../domain/permissions';
import { TaskError } from '../domain/tasks';
import { registerAllRecords } from '../records';
import * as audit from './audit';
import * as authz from './authorization';
import * as actions from './automation-actions';
import { PERMISSION_OBJECT, settings } from './automation';
import { ExceptionError } from './exceptions';
import * as notifications from './notifications';
import { systemScope } from './notification-runner';
import { NoWorkflowDefinedError } from './workflow';

type Rows<T> = { rows: T[] };

interface EventRow {
  readonly id: string;
  readonly eventKey: EventKey;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectKey: string;
  readonly windowKey: string;
  readonly episodeKey: string;
  readonly branchCode: string | null;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

interface RuleRow {
  readonly id: string;
  readonly ruleNo: string;
  readonly name: string;
  readonly version: number;
  readonly ownerUserId: string;
  readonly conditions: unknown;
  readonly actions: unknown;
}

export interface RunSummary {
  /** Events taken off the outbox this call. */
  readonly events: number;
  readonly runs: { readonly done: number; readonly skipped: number; readonly failed: number };
  /** Events left for a later attempt. */
  readonly retrying: number;
  /** Rules this call paused. */
  readonly paused: readonly string[];
  /** Automation was switched off: what was waiting was closed without running. */
  readonly switchedOff: boolean;
}

const clip = (value: string, max = 500): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const iso = (value: Date): string => value.toISOString();

// ---------------------------------------------------------------------------
// Refusal or fault
// ---------------------------------------------------------------------------

interface PgLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}

function pgOf(error: unknown): PgLike | null {
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth += 1) {
    const candidate = node as PgLike;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    node = candidate.cause;
  }
  return null;
}

/**
 * Is this the owner's reach or a rule of the owning service (skipped), a refusal that is recorded as a failure but that
 * trying again cannot change (`permanent`), or a fault (failed, and retried)? And what to say.
 */
export function classify(error: unknown): { readonly refused: boolean; readonly permanent: boolean; readonly message: string } {
  if (error instanceof actions.ActionFailedForGood) return { refused: false, permanent: true, message: clip(error.message) };
  if (
    error instanceof actions.ActionRefused ||
    error instanceof AutomationError ||
    error instanceof PermissionDeniedError ||
    error instanceof ScopeDeniedError ||
    error instanceof TaskError ||
    error instanceof ExceptionError ||
    error instanceof NoWorkflowDefinedError
  ) {
    return { refused: true, permanent: false, message: clip(error.message) };
  }
  const pg = pgOf(error);
  if (pg && (pg.code === '23514' || pg.code === '42501')) {
    return { refused: true, permanent: false, message: clip(typeof pg.message === 'string' ? pg.message : 'The database refused it.') };
  }
  if (pg && typeof pg.message === 'string') return { refused: false, permanent: false, message: clip(pg.message) };
  return { refused: false, permanent: false, message: clip(error instanceof Error ? error.message : String(error)) };
}

// ---------------------------------------------------------------------------
// One rule, one event
// ---------------------------------------------------------------------------

interface Pass {
  readonly tx: Tx;
  readonly event: EventRow;
  readonly now: Date;
  readonly scopes: { readonly system: RequestScope };
  readonly threshold: number;
}

interface RuleResult {
  readonly seen: boolean;
  readonly matched: boolean;
  readonly outcome: Outcome | null;
  /** The run was a failure with attempts left: the event must come back. */
  readonly retry: boolean;
  /** The run was a failure and the attempts are used up. */
  readonly finalFailure: string | null;
  readonly paused: boolean;
}

const NOTHING: RuleResult = { seen: false, matched: false, outcome: null, retry: false, finalFailure: null, paused: false };

async function writeRun(
  p: Pass,
  rule: RuleRow,
  input: { attempt: number; outcome: Outcome; reason: string; planned: readonly unknown[]; results: readonly ActionResult[]; startedAt: Date; runKey: string },
): Promise<string> {
  const written = (await p.tx.execute(sql`
    insert into automation_run (rule_id, rule_version, event_id, event_key, subject_key, window_key, episode_key, run_key, attempt,
                                owner_user_id, outcome, reason, planned, results, started_at, finished_at)
    values (${rule.id}::uuid, ${rule.version}, ${p.event.id}::bigint, ${p.event.eventKey}, ${p.event.subjectKey}, ${p.event.windowKey},
            ${p.event.episodeKey}, ${input.runKey}, ${input.attempt}, ${rule.ownerUserId}::uuid, ${input.outcome}, ${input.reason},
            ${JSON.stringify(input.planned)}::jsonb, ${JSON.stringify(input.results)}::jsonb, ${iso(input.startedAt)}::timestamptz, now())
    returning id::text as id`)) as unknown as Rows<{ id: string }>;
  return written.rows[0]!.id;
}

/** Remembers what a run made, so the loop guard knows it: one row per record, named with the run that made it. */
async function rememberMade(p: Pass, rule: RuleRow, runId: string, depth: number, results: readonly ActionResult[]): Promise<void> {
  for (const result of results) {
    if (!result.made || result.status !== 'done') continue; // a carried step was remembered by the attempt that did it
    await p.tx.execute(sql`
      insert into automation_made (record_type, record_id, record_label, rule_id, run_id, depth)
      values (${result.made.type}, ${result.made.id}, ${result.made.label}, ${rule.id}::uuid, ${runId}::bigint, ${depth})
      on conflict (record_type, record_id) do nothing`);
  }
}

/** What automation made of this record, if it did: the rule and how many steps from a person. */
async function madeOf(p: Pass): Promise<{ ruleId: string; ruleNo: string; depth: number } | null> {
  const found = (await p.tx.execute(sql`
    select m.rule_id::text as "ruleId", r.rule_no as "ruleNo", m.depth
      from automation_made m join automation_rule r on r.id = m.rule_id
     where m.record_type = ${p.event.subjectType} and m.record_id = ${p.event.subjectId}`)) as unknown as Rows<{ ruleId: string; ruleNo: string; depth: number }>;
  return found.rows[0] ?? null;
}

async function administrators(tx: Tx): Promise<string[]> {
  const found = (await tx.execute(sql`
    select u.id::text as id
      from app_user u
     where u.is_active
       and (u.is_super_user or exists (
             select 1 from user_role ur join role_grant g on g.role_code = ur.role_code
              where ur.user_id = u.id and g.object = ${PERMISSION_OBJECT} and g.verb = 'administer'))`)) as unknown as Rows<{ id: string }>;
  return found.rows.map((r) => r.id);
}

/** Stops a rule (off, with the reason) and tells the people who administer automation. Once per pause. */
async function pause(p: Pass, rule: RuleRow, reason: string): Promise<void> {
  const stopped = (await p.tx.execute(sql`
    update automation_rule set enabled = false, paused_at = now(), paused_reason = ${reason}
     where id = ${rule.id}::uuid and enabled
     returning paused_at`)) as unknown as Rows<{ paused_at: Date | string }>;
  const at = stopped.rows[0]?.paused_at;
  if (!at) return;
  await audit.record(p.tx, {
    actorUserId: null,
    action: 'automation.rule_paused',
    objectType: PERMISSION_OBJECT,
    objectId: rule.ruleNo,
    before: { enabled: true },
    after: { enabled: false, paused: true },
    reason,
    outcome: 'success',
  });
  await notifications.safely(p.tx, async (sp) => {
    await notifications.emit(sp, {
      kind: PAUSED_KIND,
      objectType: 'automation_rule',
      objectId: rule.id,
      recipients: await administrators(sp),
      subject: `Automation rule ${rule.ruleNo} was paused`,
      body: reason,
      context: { reference: rule.ruleNo, name: rule.name, reason, href: `/administration/automation/${encodeURIComponent(rule.ruleNo)}` },
      occurrence: `${rule.id}:${new Date(at).toISOString()}`,
    });
  });
}

/** Writes the rule's own counters after a run, and pauses it when it has failed too often in a row. */
async function tally(p: Pass, rule: RuleRow, outcome: Outcome, final: boolean): Promise<boolean> {
  const bump = outcome === 'failed' && final ? sql`consecutive_failures + 1` : outcome === 'done' ? sql`0` : sql`consecutive_failures`;
  const updated = (await p.tx.execute(sql`
    update automation_rule set consecutive_failures = ${bump}, last_run_at = now(), last_outcome = ${outcome}
     where id = ${rule.id}::uuid
     returning consecutive_failures as "failures"`)) as unknown as Rows<{ failures: number }>;
  const failures = updated.rows[0]?.failures ?? 0;
  if (outcome === 'failed' && final && shouldPause(failures, p.threshold)) {
    await pause(p, rule, `It failed ${failures} events in a row (the last: ${clip(p.event.subjectKey, 80)}), so it was paused. Look at its runs, fix the cause and switch it on again.`);
    return true;
  }
  return false;
}

async function runRule(p: Pass, rule: RuleRow): Promise<RuleResult> {
  const startedAt = new Date();
  const attempt = p.event.attempts + 1;

  // An earlier pass of this event already dealt with this rule: done and skipped are final, a failure is tried again.
  const prior = (await p.tx.execute(sql`
    select outcome, results from automation_run where event_id = ${p.event.id}::bigint and rule_id = ${rule.id}::uuid order by attempt desc limit 1`)) as unknown as Rows<{ outcome: Outcome; results: ActionResult[] }>;
  const earlier = prior.rows[0];
  if (earlier && earlier.outcome !== 'failed') return NOTHING;

  let definition: Definition;
  try {
    definition = validateDefinition(p.event.eventKey, rule.conditions, rule.actions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `The rule's stored definition no longer fits ${p.event.eventKey}: ${message}`;
    await writeRun(p, rule, { attempt, outcome: 'failed', reason, planned: [], results: [], startedAt, runKey: runKeyOf(rule.id, p.event.eventKey, p.event.subjectKey, p.event.episodeKey) });
    const paused = await tally(p, rule, 'failed', true);
    return { seen: true, matched: false, outcome: 'failed', retry: false, finalFailure: reason, paused };
  }

  const runKey = runKeyOf(rule.id, p.event.eventKey, p.event.subjectKey, p.event.episodeKey);

  // Whose permissions it runs with.
  let owner: Principal | null = null;
  try {
    owner = await authz.loadPrincipal(p.tx, rule.ownerUserId);
  } catch {
    owner = null;
  }
  if (!owner || !owner.isActive || !can(owner, 'administer', PERMISSION_OBJECT)) {
    const why = !owner ? 'its owner no longer exists' : !owner.isActive ? 'its owner is deactivated' : 'its owner no longer holds administer on automation';
    const reason = `Not run: ${why}. The rule was paused; switching it on again makes the person who does it the owner.`;
    await writeRun(p, rule, { attempt, outcome: 'skipped', reason, planned: [], results: [], startedAt, runKey });
    await pause(p, rule, `Paused: ${why}.`);
    await tally(p, rule, 'skipped', false);
    return { seen: true, matched: false, outcome: 'skipped', retry: false, finalFailure: null, paused: true };
  }

  const evaluation = evaluate(definition, p.event.payload);
  if (!evaluation.matched) {
    // A sweep sees the same overdue thing every day; only the event row says "looked, did not match". A record event is looked at once, and says so.
    if (EVENTS[p.event.eventKey].source === 'record') {
      await writeRun(p, rule, { attempt, outcome: 'skipped', reason: `Conditions not met: ${evaluation.unmet.map(describeUnmet).join('; ')}.`, planned: [], results: [], startedAt, runKey });
      await tally(p, rule, 'skipped', false);
      return { seen: true, matched: false, outcome: 'skipped', retry: false, finalFailure: null, paused: false };
    }
    return { seen: true, matched: false, outcome: null, retry: false, finalFailure: null, paused: false };
  }

  // One rule, one record, one stretch of lateness: serialise on the run key, then look again.
  await p.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runKey}, 0))`);
  const already = (await p.tx.execute(sql`select 1 from automation_run where run_key = ${runKey} and outcome = 'done' limit 1`)) as unknown as Rows<unknown>;
  if (already.rows.length > 0) return { seen: true, matched: true, outcome: null, retry: false, finalFailure: null, paused: false };

  // The loop guard: a record automation made does not wake the rule that made it, and a chain stops after two steps.
  const guard = guardOf(await madeOf(p), rule.id);
  if (!guard.allowed) {
    const last = (await p.tx.execute(sql`select reason from automation_run where run_key = ${runKey} order by id desc limit 1`)) as unknown as Rows<{ reason: string }>;
    if (last.rows[0]?.reason !== guard.reason) {
      await writeRun(p, rule, { attempt, outcome: 'skipped', reason: guard.reason, planned: [], results: [], startedAt, runKey });
      await tally(p, rule, 'skipped', false);
    }
    return { seen: true, matched: true, outcome: 'skipped', retry: false, finalFailure: null, paused: false };
  }

  // The owner's scope for the actions; back to the system's for the log.
  const ownerScope: RequestScope = { userId: owner.userId, branchCode: p.event.branchCode ?? owner.defaultBranchCode ?? '', isSuperUser: owner.isSuperUser };
  const doing = {
    ctx: { principal: owner, branchCode: ownerScope.branchCode },
    scopes: { owner: ownerScope, system: p.scopes.system },
    rule: { id: rule.id, ruleNo: rule.ruleNo, name: rule.name, version: rule.version, ownerUserId: rule.ownerUserId },
    event: { id: p.event.id, key: p.event.eventKey, payload: p.event.payload, subjectId: p.event.subjectId, episode: p.event.episodeKey, branchCode: p.event.branchCode },
  };
  const carried = new Map<number, ActionResult>((earlier?.results ?? []).filter((r) => r.status === 'done' || r.status === 'carried').map((r) => [r.index, r]));

  const results: ActionResult[] = [];
  await applyScope(p.tx, ownerScope);
  for (const [index, action] of definition.actions.entries()) {
    const before = carried.get(index);
    if (before) {
      results.push({ ...before, status: 'carried' });
      continue;
    }
    try {
      const result = await p.tx.transaction((savepoint) => actions.perform({ ...doing, tx: savepoint as unknown as Tx }, action, index));
      results.push(result);
    } catch (error) {
      const verdict = classify(error);
      results.push({
        index,
        kind: action.kind,
        status: verdict.refused ? 'skipped' : 'failed',
        detail: verdict.refused ? `Not done: ${verdict.message}` : `Failed: ${verdict.message}`,
        ...(verdict.permanent ? { permanent: true } : {}),
      });
    }
  }
  await applyScope(p.tx, p.scopes.system);

  const outcome = outcomeOf(results);
  // A step refused for good (the assignment scope said no) is not tried again: nothing about the next minute would change it.
  const permanent = outcome === 'failed' && results.filter((r) => r.status === 'failed').every((r) => r.permanent === true);
  const final = attempt >= MAX_ATTEMPTS || permanent;
  const failedStep = results.find((r) => r.status === 'failed');
  const next = outcome === 'failed' && !final ? nextAttemptAt(attempt, p.now) : null;
  const doneSteps = results.filter((r) => r.status === 'done' || r.status === 'carried');
  const reason =
    outcome === 'failed'
      ? `${failedStep!.detail}${next ? ` It will be tried again at ${next.toISOString().slice(11, 16)} UTC (attempt ${attempt} of ${MAX_ATTEMPTS}).` : permanent ? ' It was refused, and trying again would change nothing, so the rule gives up on this one.' : ` Attempt ${attempt} of ${MAX_ATTEMPTS}: the rule gives up on this one.`}`
      : outcome === 'done'
        ? clip(doneSteps.map((r) => r.detail).join(' '), 900)
        : clip(results.map((r) => r.detail).join(' '), 900);

  // A skipped run that says what the last one said, on a sweep's next day, adds nothing to the log.
  let record = true;
  if (outcome === 'skipped' && EVENTS[p.event.eventKey].source === 'sweep') {
    const last = (await p.tx.execute(sql`select outcome, reason from automation_run where run_key = ${runKey} order by id desc limit 1`)) as unknown as Rows<{ outcome: string; reason: string }>;
    if (last.rows[0]?.outcome === 'skipped' && last.rows[0].reason === reason) record = false;
  }
  if (record) {
    const runId = await writeRun(p, rule, { attempt, outcome, reason, planned: evaluation.planned, results, startedAt, runKey });
    await rememberMade(p, rule, runId, guard.depth, results);
    await audit.record(p.tx, {
      actorUserId: rule.ownerUserId,
      action: 'automation.ran',
      objectType: PERMISSION_OBJECT,
      objectId: rule.ruleNo,
      after: { event: p.event.eventKey, subject: p.event.subjectKey, version: rule.version, attempt, outcome, steps: results.map((r) => `${r.kind}:${r.status}`) },
      reason: clip(reason, 400),
      outcome: outcome === 'failed' ? 'failure' : 'success',
    });
    const paused = await tally(p, rule, outcome, final);
    return { seen: true, matched: true, outcome, retry: next !== null, finalFailure: outcome === 'failed' && final ? failedStep!.detail : null, paused };
  }
  return { seen: true, matched: true, outcome, retry: false, finalFailure: null, paused: false };
}

// ---------------------------------------------------------------------------
// One event
// ---------------------------------------------------------------------------

interface Handled {
  readonly id: string;
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retrying: boolean;
  readonly paused: string[];
  readonly switchedOff: boolean;
}

async function processEvent(tx: Tx, event: EventRow, now: Date, scopes: { system: RequestScope }): Promise<Handled> {
  const config = await settings(tx);
  const handled = { id: event.id, done: 0, skipped: 0, failed: 0, retrying: false, paused: [] as string[], switchedOff: false };

  if (!config.enabled) {
    await tx.execute(sql`
      update automation_event set status = 'done', processed_at = now(), last_error = 'Automation was switched off; nothing was run for this event.'
       where id = ${event.id}::bigint`);
    return { ...handled, switchedOff: true };
  }

  const rules = (await tx.execute(sql`
    select r.id::text as id, r.rule_no as "ruleNo", r.name, r.current_version as "version", r.owner_user_id::text as "ownerUserId", v.conditions, v.actions
      from automation_rule r
      join automation_rule_version v on v.rule_id = r.id and v.version = r.current_version
     where r.event_key = ${event.eventKey} and r.enabled
       and r.enabled_at <= (select occurred_at from automation_event where id = ${event.id}::bigint)
     order by r.rule_no`)) as unknown as Rows<RuleRow>;

  const pass: Pass = { tx, event, now, scopes, threshold: config.pauseAfterFailures };
  let seen = 0;
  let matched = 0;
  let retry = false;
  let lastError: string | null = null;
  for (const rule of rules.rows) {
    const result = await runRule(pass, rule);
    if (result.seen) seen += 1;
    if (result.matched) matched += 1;
    if (result.outcome === 'done') handled.done += 1;
    if (result.outcome === 'skipped') handled.skipped += 1;
    if (result.outcome === 'failed') handled.failed += 1;
    if (result.paused) handled.paused.push(rule.ruleNo);
    if (result.retry) retry = true;
    if (result.finalFailure) lastError = result.finalFailure;
  }

  if (retry) {
    const due = nextAttemptAt(event.attempts + 1, now)!;
    await tx.execute(sql`
      update automation_event
         set status = 'retry', attempts = ${event.attempts + 1}, next_attempt_at = ${iso(due)}::timestamptz,
             last_error = 'An action failed; the event will be tried again.', rules_seen = ${seen}, rules_matched = ${matched}
       where id = ${event.id}::bigint`);
    return { ...handled, retrying: true };
  }
  await tx.execute(sql`
    update automation_event
       set status = ${lastError ? 'failed' : 'done'}, attempts = ${event.attempts + 1}, processed_at = now(), last_error = ${lastError},
           rules_seen = ${seen}, rules_matched = ${matched}
     where id = ${event.id}::bigint`);
  return handled;
}

/** What went wrong around an event rather than inside one rule: the whole pass is undone, so the attempt is counted here. */
async function recordCrash(scope: RequestScope, id: string, error: unknown, now: Date): Promise<void> {
  const verdict = classify(error);
  await db.transaction(async (tx) => {
    await applyScope(tx, scope);
    const current = (await tx.execute(sql`select attempts from automation_event where id = ${id}::bigint and status in ('pending', 'retry')`)) as unknown as Rows<{ attempts: number }>;
    const attempts = (current.rows[0]?.attempts ?? 0) + 1;
    if (!current.rows[0]) return;
    const next = nextAttemptAt(attempts, now);
    await tx.execute(sql`
      update automation_event
         set attempts = ${attempts}, status = ${next ? 'retry' : 'failed'}, next_attempt_at = ${iso(next ?? now)}::timestamptz,
             processed_at = ${next ? null : iso(now)}::timestamptz, last_error = ${verdict.message}
       where id = ${id}::bigint`);
  });
  console.error(`[automation] event ${id} could not be processed (attempt counted): ${verdict.message}`);
}

async function handleNext(scope: RequestScope, now: Date): Promise<Handled | null> {
  const picked: { id: string | null } = { id: null };
  try {
    return await db.transaction(async (tx) => {
      await applyScope(tx, scope);
      const found = (await tx.execute(sql`
        select id::text as id, event_key as "eventKey", subject_type as "subjectType", subject_id as "subjectId", subject_key as "subjectKey",
               window_key as "windowKey", episode_key as "episodeKey", branch_code as "branchCode", payload, attempts
          from automation_event
         where status in ('pending', 'retry') and next_attempt_at <= ${iso(now)}::timestamptz
         order by id
         limit 1
           for update skip locked`)) as unknown as Rows<EventRow>;
      const event = found.rows[0];
      if (!event) return null;
      picked.id = event.id;
      return processEvent(tx, event, now, { system: scope });
    });
  } catch (error) {
    if (picked.id === null) throw error;
    await recordCrash(scope, picked.id, error, now);
    return { id: picked.id, done: 0, skipped: 0, failed: 1, retrying: true, paused: [], switchedOff: false };
  }
}

export interface RunOptions {
  /** At most this many events in one call. */
  readonly limit?: number;
  /** The clock the retries are due against (a test moves it; the schedule leaves it). */
  readonly now?: Date;
}

/**
 * One pass over what is due. Safe to call from two processes at once, and again
 * straight after: what was handled is not handled twice.
 */
export async function runOnce(options: RunOptions = {}): Promise<RunSummary> {
  // A notification asks, as each recipient, whether they can open the record: the record registry must be loaded in a script.
  registerAllRecords();
  const scope = await systemScope();
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
  const summary = { events: 0, done: 0, skipped: 0, failed: 0, retrying: 0, paused: [] as string[], switchedOff: false };
  for (let i = 0; i < limit; i += 1) {
    const handled = await handleNext(scope, now);
    if (!handled) break;
    summary.events += 1;
    summary.done += handled.done;
    summary.skipped += handled.skipped;
    summary.failed += handled.failed;
    if (handled.retrying) summary.retrying += 1;
    summary.paused.push(...handled.paused);
    if (handled.switchedOff) summary.switchedOff = true;
  }
  return { events: summary.events, runs: { done: summary.done, skipped: summary.skipped, failed: summary.failed }, retrying: summary.retrying, paused: summary.paused, switchedOff: summary.switchedOff };
}
