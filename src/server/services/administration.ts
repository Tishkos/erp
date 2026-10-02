/**
 * Administration — the shared shape of the Phase 0 services.
 *
 * Company, Branches, Departments, Users, Roles and Numbering all follow one
 * pattern: authorise on the permission object first, mutate, then record what
 * changed in the audit trail inside the same transaction. This file holds the
 * three pieces they share so each service reads the same way.
 */
import type { Tx } from '../db/client';
import type { PermissionVerb } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

export type { ActorContext };

export class AdminValidationError extends Error {
  readonly code = 'ADMIN_VALIDATION';
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'AdminValidationError';
  }
}

export class AdminNotFoundError extends Error {
  readonly code = 'ADMIN_NOT_FOUND';
  constructor(object: string, id: string) {
    super(`No ${object} '${id}'.`);
    this.name = 'AdminNotFoundError';
  }
}

/** Authorise a verb on an administration object, recording a refusal. */
export async function permit(
  ctx: ActorContext,
  verb: PermissionVerb,
  object: string,
  objectId?: string | null,
): Promise<void> {
  await authz.authorize(ctx.principal, verb, object, {
    branchCode: ctx.branchCode,
    objectId: objectId ?? null,
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** A system-wide guard for actions reserved to a user holding the CEO role. */
export async function permitCeo(ctx: ActorContext): Promise<void> {
  if (!ctx.principal.roleCodes.includes('ceo')) {
    // Force the normal authorization path to record a durable denial even if
    // a different role was mistakenly given a broad administration grant.
    await authz.authorize(
      { ...ctx.principal, isSuperUser: false, grants: [] },
      'administer',
      'permission',
      {
        branchCode: ctx.branchCode,
        objectId: null,
        requestId: ctx.requestId ?? null,
        clientIp: ctx.clientIp ?? null,
      },
    );
  }
  await permit(ctx, 'administer', 'permission');
}

/** Record a successful administration change, in the caller's transaction. */
export async function recordChange(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly action: string;
    readonly objectType: string;
    readonly objectId: string;
    readonly before?: Record<string, unknown> | null;
    readonly after?: Record<string, unknown> | null;
    readonly reason?: string | null;
    /**
     * The branch the record belongs to, for a record that belongs to one.
     *
     * D10 reserves unbranched events for super users, which is right for
     * administration — a company-wide change is not a branch event. A
     * *document* is different: its history has to be readable by the
     * people who work on it, so it records the document's branch and is
     * read back under the same scope the document itself is.
     */
    readonly branchCode?: string | null;
  },
): Promise<void> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    // Administration changes are company-wide, not branch events; the trail
    // keeps them unbranched, which the audit policy reserves for super users.
    // A record that names a branch says so, and stays readable in it.
    branchCode: input.branchCode ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** A code the way every master code is written: upper case, A–Z 0–9 _ -. */
export function normaliseCode(value: string, field = 'code'): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) {
    throw new AdminValidationError(
      field,
      'use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit',
    );
  }
  return code;
}

/**
 * A code derived from what the person typed: "Accountant Branch" becomes
 * ACCOUNTANT_BRANCH, "Head Office / Baghdad" becomes HEAD_OFFICE_BAGHDAD.
 *
 * Codes are cited by documents for the life of the system, so they stay in
 * the ASCII alphabet a keyboard, a barcode and a bank file can all carry. A
 * name with nothing transliterable in it (an Arabic-only name) gets no guess
 * — the screen asks for a code instead of inventing one.
 */
export function codeFromName(name: string, mode: 'upper' | 'lower' = 'upper'): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/g, '');
  if (!ascii) throw new AdminValidationError('code', 'could not be made from the name; type one');
  return mode === 'lower' ? ascii.toLowerCase() : ascii.toUpperCase();
}

/** The derived code, or the next free variant of it (…_2, …_3). */
export async function uniqueCode(
  base: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(base))) return base;
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base.slice(0, 29)}_${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new AdminValidationError('code', 'too many records share that name; type a code');
}

export function requireText(value: string | null | undefined, field: string, max = 200): string {
  const text = (value ?? '').trim();
  if (!text) throw new AdminValidationError(field, 'is required');
  if (text.length > max) throw new AdminValidationError(field, `is longer than ${max} characters`);
  return text;
}

export function optionalText(value: string | null | undefined, max = 500): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw new AdminValidationError('text', `is longer than ${max} characters`);
  return text;
}
