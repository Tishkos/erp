/**
 * The ERP Control Center — platform phase, Agent 9: "is Qimah internally healthy?", asked of the system now.
 *
 * `run` takes the signed-in person's transaction and asks every check of
 * `domain/control-center.CHECKS`, one at a time, each as that person:
 *
 *   * **Their grants.** A check is run only if the person holds `view` on the
 *     screens it summarises (`CheckDefinition.requires`); otherwise it is
 *     `not_checked` and says so — a figure the person may not see is not shown,
 *     and not turned into a zero. Their branches are held by row-level
 *     security, so what a check compares is what they may read.
 *   * **Read only.** The transaction is made read-only first
 *     (`set local transaction_read_only = on`): a check that tried to write
 *     would fail. The Control Center fixes, posts, edits and resolves nothing.
 *   * **One failure never blanks the page.** Each check runs in a savepoint of
 *     its own under a statement timeout; a check that fails or runs out of
 *     time is `unavailable` with the reason, never a green tick, and the others
 *     go on. A whole-run time budget turns the checks not reached in time into
 *     `unavailable` too, so the page always answers.
 *   * **Nothing stored.** The answer is computed on every request; there is no
 *     table of results to go stale. The Exception Center is the system of
 *     record for what needs a person, and its counts are shown beside the
 *     domains.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import {
  CHECKS,
  CC_DOMAINS,
  missingRequirement,
  reasonFromError,
  resultOf,
  summarize,
  withheld,
  type CcDomain,
  type CheckDefinition,
  type CheckResult,
  type Summary,
} from '../domain/control-center';
import type { ExceptionDomain } from '../domain/exceptions';
import { assertCan, can, PermissionDeniedError, ScopeDeniedError, type Principal } from '../domain/permissions';
import { logger } from '../logging';
import { READERS, type CheckContext, type HostOptions } from './control-center-readers';
import * as exceptions from './exceptions';

export const PERMISSION_OBJECT = 'control_center';

/** A check that takes longer than this is reported unavailable rather than waited for. */
export const CHECK_TIMEOUT_MS = 10_000;
/** The whole run's budget; checks not reached by then are unavailable, so the page always answers. */
export const RUN_BUDGET_MS = 90_000;

export interface RunInput {
  readonly principal: Principal;
  /** The branch the request works in — the scope the jobs service authorises against. */
  readonly branchCode: string;
  /** Only this domain's checks. */
  readonly domain?: CcDomain | null;
  /** Only these checks (tests). */
  readonly only?: readonly string[] | null;
  readonly now?: Date;
  readonly host?: HostOptions;
  readonly checkTimeoutMs?: number;
  readonly budgetMs?: number;
}

export interface ExceptionCounts {
  readonly total: number;
  readonly byDomain: Readonly<Record<ExceptionDomain, number>>;
}

export interface ControlReport {
  /** The business day the checks were asked as of. */
  readonly asOf: string;
  /** When the run finished (ISO) and how long it took. */
  readonly ranAt: string;
  readonly elapsedMs: number;
  readonly results: readonly CheckResult[];
  readonly summary: Summary;
  /** The Exception Center's open counts as this person may see them; null when they may not open it. */
  readonly exceptions: ExceptionCounts | null;
  readonly scope: { readonly companyWide: boolean; readonly branches: readonly string[] };
}

const secondsOf = (ms: number): number => Math.max(1, Math.round(ms / 1000));

async function runOne(
  definition: CheckDefinition,
  base: Omit<CheckContext, 'tx'>,
  tx: Tx,
  limits: { readonly checkTimeoutMs: number; readonly deadline: number },
): Promise<CheckResult> {
  const { principal } = base;
  const missing = missingRequirement(definition, (verb, object) => can(principal, verb, object));
  if (missing) return withheld(definition, 'not_checked', { code: 'no_access', params: { object: missing.object } });
  if (performance.now() > limits.deadline) {
    return withheld(definition, 'unavailable', { code: 'budget', params: { seconds: secondsOf(RUN_BUDGET_MS) } });
  }
  const reader = READERS[definition.code];
  if (!reader) return withheld(definition, 'unavailable', { code: 'error', params: { message: 'no reader' } });

  const started = performance.now();
  const before = (await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string };
  await tx.execute(sql`select set_config('statement_timeout', ${String(limits.checkTimeoutMs)}, true)`);
  try {
    const reading = await tx.transaction((savepoint) => reader({ ...base, tx: savepoint as unknown as Tx }));
    return resultOf(definition, reading, Math.round(performance.now() - started));
  } catch (cause) {
    const elapsed = Math.round(performance.now() - started);
    // A service that refused the person is "not checked" for them, not a fault of the system.
    if (cause instanceof PermissionDeniedError) {
      return withheld(definition, 'not_checked', { code: 'no_access', params: { object: cause.object } }, elapsed);
    }
    if (cause instanceof ScopeDeniedError) {
      return withheld(definition, 'not_checked', { code: 'no_access', params: { object: definition.requires[0]?.object ?? '' } }, elapsed);
    }
    logger.error('a Control Center check could not be completed', { error: cause, check: definition.code });
    return withheld(definition, 'unavailable', reasonFromError(cause, secondsOf(limits.checkTimeoutMs)), elapsed);
  } finally {
    await tx.execute(sql`select set_config('statement_timeout', ${before.v}, true)`);
  }
}

/**
 * Asks the checks, as the person in `input.principal`, inside `tx` (their scoped transaction).
 * Throws `PermissionDeniedError` without the grant on the Control Center.
 */
export async function run(tx: Tx, input: RunInput): Promise<ControlReport> {
  const { principal } = input;
  assertCan(principal, 'view', PERMISSION_OBJECT);
  await tx.execute(sql`set local transaction_read_only = on`);

  const started = performance.now();
  const now = input.now ?? new Date();
  const today = businessToday(now);
  const limits = { checkTimeoutMs: input.checkTimeoutMs ?? CHECK_TIMEOUT_MS, deadline: started + (input.budgetMs ?? RUN_BUDGET_MS) };
  const memoStore = new Map<string, unknown>();
  const base: Omit<CheckContext, 'tx'> = {
    principal,
    branchCode: input.branchCode,
    today,
    now,
    host: input.host ?? {},
    memo: async <T>(key: string, load: () => Promise<T>): Promise<T> => {
      if (memoStore.has(key)) return memoStore.get(key) as T;
      const value = await load();
      memoStore.set(key, value);
      return value;
    },
  };

  const only = input.only ? new Set(input.only) : null;
  const selected = CHECKS.filter((check) => (!input.domain || check.domain === input.domain) && (!only || only.has(check.code)));

  // One after the other: a transaction is one connection and answers one question at a time.
  const results: CheckResult[] = [];
  for (const definition of selected) results.push(await runOne(definition, base, tx, limits));

  let counts: ExceptionCounts | null = null;
  if (can(principal, 'view', exceptions.PERMISSION_OBJECT)) {
    try {
      const found = await tx.transaction((savepoint) => exceptions.countsFor(savepoint as unknown as Tx, principal));
      counts = { total: found.total, byDomain: found.byDomain };
    } catch (cause) {
      logger.error('the Exception Center counts could not be read for the Control Center', { error: cause });
    }
  }

  return {
    asOf: today,
    ranAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    results,
    summary: summarize(results),
    exceptions: counts,
    scope: { companyWide: principal.isSuperUser, branches: principal.branchCodes },
  };
}

/** The domains a person can filter by, in screen order. */
export const DOMAINS: readonly CcDomain[] = CC_DOMAINS;
