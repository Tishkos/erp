/**
 * The one way an administration form reaches a service.
 *
 * A server action receives the form, runs the service under the caller's own
 * context, and goes back to the page it came from — with `?saved=1`, or with
 * `?error=` carrying the service's own sentence (§25: the reason and the
 * corrective action, not a stack trace). A redirect is thrown by Next, so it
 * is issued after the transaction has settled, never inside the `try`.
 */
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Tx } from './db/client';
import type { ActorContext } from './services/administration';
import { withCurrentUser, type RequestContext } from './session';

/** The one-time secret (a temporary password) handed from an action to the next page. */
export const FLASH_COOKIE = 'erp_admin_secret';

export type AdminHandler<T> = (tx: Tx, ctx: ActorContext, request: RequestContext) => Promise<T>;

function actorFor(request: RequestContext): ActorContext {
  return {
    principal: request.principal,
    branchCode: request.scope.branchCode,
    requestId: request.sessionId,
  };
}

export interface AdminOutcome<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

/** Runs the handler in the caller's transaction and reports, never throws. */
export async function runAdmin<T>(handler: AdminHandler<T>): Promise<AdminOutcome<T>> {
  try {
    const value = await withCurrentUser((tx, request) => handler(tx, actorFor(request), request));
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Runs the handler, then redirects back with the outcome in the query. */
export async function runAdminAndReturn(
  handler: AdminHandler<unknown>,
  back: string | ((value: unknown) => string),
): Promise<never> {
  const outcome = await runAdmin(handler);
  // A one-time secret from an earlier action must not outlive the next one.
  (await cookies()).delete(FLASH_COOKIE);
  // The shell shows the caller's name and picture; a change must reach it now.
  revalidatePath('/', 'layout');
  const target = typeof back === 'function' ? back(outcome.value) : back;
  redirect(outcome.ok ? withQuery(target, 'saved', '1') : withQuery(target, 'error', outcome.error!));
}

export function withQuery(path: string, key: string, value: string): string {
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}${key}=${encodeURIComponent(value)}`;
}

/** Reads a text field. */
export const text = (form: FormData, name: string): string => String(form.get(name) ?? '');

/** Reads a checkbox. */
export const flag = (form: FormData, name: string): boolean => form.get(name) !== null;

/** Reads a multi-select / checkbox group. */
export const list = (form: FormData, name: string): string[] =>
  form.getAll(name).map(String).filter(Boolean);

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // Postgres constraint failures arrive wrapped; the innermost says why.
    let cause: unknown = error;
    const parts: string[] = [];
    while (cause instanceof Error) {
      parts.push(cause.message);
      cause = cause.cause;
    }
    return parts.at(-1) ?? error.message;
  }
  return String(error);
}
