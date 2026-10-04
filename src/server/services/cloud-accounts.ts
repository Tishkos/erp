/**
 * QS Cloud Files — one person's linked account (Platform phase, Agent 4;
 * REQ-FIX-001 FIX-6, D-FX-3).
 *
 * A person reaches the cloud as themselves, never through a shared service
 * account, so that what the cloud shows them is what the cloud lets them see.
 * They link by Nextcloud's Login Flow v2: Qimah asks the cloud to start a
 * sign-in, the person opens the cloud's own page and grants access, and Qimah
 * receives an *app password* made for it. The password:
 *
 *   - is sealed with the server's key (`ERP_SECRET_KEY`, AES-256-GCM, bound to
 *     the person) before it touches the database, and is never shown again,
 *     logged, audited or sent to a browser;
 *   - is revoked at the cloud when the person unlinks, and when they are
 *     deactivated — the row is then deleted, so nothing is left to use.
 *
 * Calls to the cloud are made outside the page's database work where they can
 * be (`connect` reads and unseals; the caller does the I/O); the link and
 * unlink steps do their one or two quick calls inside the transaction because
 * the row and the cloud have to agree.
 */
import { eq } from 'drizzle-orm';
import { applyScope, db, type Tx } from '../db/client';
import { cloudAccount, cloudLinkAttempt } from '../db/schema';
import {
  attemptExpiry,
  attemptState,
  connectionState,
  type ConnectionState,
} from '../domain/cloud-files';
import { SecretKeyError, openSecret, sealSecret, secretKeyProblem } from '../secret-box';
import { AdminValidationError, recordChange } from './administration';
import type { ActorContext } from './chart-of-accounts';
import {
  CloudAuthError,
  CloudClient,
  CloudHttpError,
  pollLoginFlow,
  startLoginFlow,
} from './cloud-client';
import * as settings from './cloud-settings';

export const ACCOUNT_OBJECT = 'cloud_account';

/** Why a person cannot use the cloud right now — the screen explains each in its own words. */
export class CloudStateError extends Error {
  constructor(
    readonly state: Exclude<ConnectionState, 'ready'>,
    detail: string,
  ) {
    super(detail);
    this.name = 'CloudStateError';
  }
}

const accountBind = (userId: string) => `cloud-files:${userId}`;
const attemptBind = (userId: string) => `cloud-link:${userId}`;

export interface AccountView {
  readonly cloudUser: string;
  readonly displayName: string | null;
  readonly serverUrl: string;
  readonly linkedAt: Date;
  readonly lastOkAt: Date | null;
  readonly lastError: string | null;
}

export async function accountOf(tx: Tx, userId: string): Promise<AccountView | null> {
  const [row] = await tx.select().from(cloudAccount).where(eq(cloudAccount.userId, userId)).limit(1);
  if (!row) return null;
  return {
    cloudUser: row.cloudUser,
    displayName: row.displayName,
    serverUrl: row.serverUrl,
    linkedAt: row.linkedAt,
    lastOkAt: row.lastOkAt,
    lastError: row.lastError,
  };
}

export interface CloudState {
  readonly settings: settings.CloudSettings;
  readonly account: AccountView | null;
  readonly state: ConnectionState;
}

/** Where this person stands: not configured, not linked, link again, or ready. */
export async function stateFor(tx: Tx, userId: string): Promise<CloudState> {
  const current = await settings.get(tx);
  const account = await accountOf(tx, userId);
  return {
    settings: current,
    account,
    state: connectionState({ enabled: current.enabled, baseUrl: current.baseUrl, account }),
  };
}

/** A client that speaks to the cloud as this person, or the reason it cannot. */
export async function connect(tx: Tx, userId: string): Promise<{ client: CloudClient; settings: settings.CloudSettings; account: AccountView }> {
  const { settings: current, account, state } = await stateFor(tx, userId);
  if (state === 'not_configured') throw new CloudStateError(state, 'This integration is not configured.');
  if (state === 'not_linked' || !account) throw new CloudStateError('not_linked', 'Link your Cloud Files account to continue.');
  if (state === 'relink') throw new CloudStateError(state, 'Your Cloud Files link is no longer valid. Link your account again.');
  const [row] = await tx.select({ secret: cloudAccount.secret }).from(cloudAccount).where(eq(cloudAccount.userId, userId)).limit(1);
  if (!row) throw new CloudStateError('not_linked', 'Link your Cloud Files account to continue.');
  const password = openSecret(row.secret, accountBind(userId));
  return { client: new CloudClient({ baseUrl: account.serverUrl, user: account.cloudUser, password }), settings: current, account };
}

/**
 * Records what the cloud last said about this account, on its own connection:
 * a refusal rolls the caller's transaction back, and the fact that the cloud
 * turned the person away is the part worth keeping.
 */
export async function noteOutcome(userId: string, branchCode: string, outcome: 'ok' | 'unauthorised'): Promise<void> {
  await db.transaction(async (tx) => {
    await applyScope(tx, { userId, branchCode });
    await tx
      .update(cloudAccount)
      .set(outcome === 'ok' ? { lastOkAt: new Date(), lastError: null } : { lastError: 'unauthorised' })
      .where(eq(cloudAccount.userId, userId));
  });
}

/** Re-notes a good answer at most this often: the common path should not write on every page view. */
const OK_NOTE_EVERY_MS = 10 * 60_000;

/**
 * Runs a cloud call for this person. If the cloud turns the account away
 * (401 — the app password was revoked there) that is noted, so the next screen
 * says "link again" instead of failing the same way; a good answer refreshes
 * "last connected" now and then.
 */
export async function withCloud<T>(
  ctx: Pick<ActorContext, 'principal' | 'branchCode'>,
  account: Pick<AccountView, 'lastOkAt' | 'lastError'> | null,
  work: () => Promise<T>,
): Promise<T> {
  try {
    const value = await work();
    const stale = !account?.lastOkAt || Date.now() - account.lastOkAt.getTime() > OK_NOTE_EVERY_MS;
    if (account && (stale || account.lastError)) await noteOutcome(ctx.principal.userId, ctx.branchCode, 'ok').catch(() => undefined);
    return value;
  } catch (error) {
    if (error instanceof CloudAuthError) await noteOutcome(ctx.principal.userId, ctx.branchCode, 'unauthorised').catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Linking — Login Flow v2
// ---------------------------------------------------------------------------

export interface LinkStart {
  readonly loginUrl: string;
  readonly expiresAt: Date;
}

/** Starts a sign-in at the cloud. Replaces any earlier attempt of this person's. */
export async function beginLink(tx: Tx, ctx: ActorContext): Promise<LinkStart> {
  const { settings: current } = await stateFor(tx, ctx.principal.userId);
  if (!settings.isConfigured(current) || !current.baseUrl) throw new CloudStateError('not_configured', 'This integration is not configured.');
  const problem = secretKeyProblem();
  if (problem) throw new AdminValidationError('server key', `${problem} Ask your administrator.`);

  const flow = await startLoginFlow(current.baseUrl);
  const now = new Date();
  const expiresAt = attemptExpiry(now);
  await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, ctx.principal.userId));
  await tx.insert(cloudLinkAttempt).values({
    userId: ctx.principal.userId,
    serverUrl: current.baseUrl,
    pollEndpoint: flow.pollEndpoint,
    pollToken: sealSecret(flow.pollToken, attemptBind(ctx.principal.userId)),
    loginUrl: flow.loginUrl,
    createdAt: now,
    expiresAt,
  });
  return { loginUrl: flow.loginUrl, expiresAt };
}

export interface PendingLink {
  readonly loginUrl: string;
  readonly expiresAt: Date;
  readonly expired: boolean;
}

/** The sign-in this person has started and not finished, if any. */
export async function pendingLink(tx: Tx, userId: string): Promise<PendingLink | null> {
  const [row] = await tx.select().from(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId)).limit(1);
  if (!row) return null;
  return { loginUrl: row.loginUrl, expiresAt: row.expiresAt, expired: attemptState({ expiresAt: row.expiresAt }, new Date()) === 'expired' };
}

export type LinkProgress = 'linked' | 'pending' | 'expired' | 'none';

/**
 * Asks the cloud whether the person has granted access yet. When they have,
 * the app password is checked (the cloud says who it belongs to, and their
 * root folder is read), sealed and kept. Anything that goes wrong after the
 * cloud has issued a password revokes it again, so no orphan is left behind.
 */
export async function completeLink(tx: Tx, ctx: ActorContext): Promise<LinkProgress> {
  const userId = ctx.principal.userId;
  const [attempt] = await tx.select().from(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId)).limit(1);
  if (!attempt) return 'none';
  if (attemptState({ expiresAt: attempt.expiresAt }, new Date()) === 'expired') {
    await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId));
    return 'expired';
  }
  const current = await settings.get(tx);
  if (!settings.isConfigured(current) || current.baseUrl !== attempt.serverUrl) {
    await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId));
    return 'none';
  }

  const granted = await pollLoginFlow(
    { pollEndpoint: attempt.pollEndpoint, pollToken: openSecret(attempt.pollToken, attemptBind(userId)) },
    attempt.serverUrl,
  );
  if (!granted) return 'pending';

  // From here the cloud holds an app password for us; every failure revokes it.
  const probe = new CloudClient({ baseUrl: attempt.serverUrl, user: granted.loginName, password: granted.appPassword });
  let cloudUser = granted.loginName;
  let displayName: string | null = null;
  let client = probe;
  try {
    const who = await probe.whoAmI();
    cloudUser = who.id;
    displayName = who.displayName;
    client = new CloudClient({ baseUrl: attempt.serverUrl, user: cloudUser, password: granted.appPassword });
    // The password must open this person's own folder, or it is no use to anyone.
    if (!(await client.stat('/'))) throw new CloudHttpError('Cloud Files did not open your folder with the new app password.', null);
  } catch (error) {
    await client.revokeAppPassword().catch(() => undefined);
    throw error;
  }

  const [previous] = await tx.select().from(cloudAccount).where(eq(cloudAccount.userId, userId)).limit(1);
  if (previous) await revokeStored(userId, previous).catch(() => undefined);
  const sealed = sealSecret(granted.appPassword, accountBind(userId));
  const now = new Date();
  await tx
    .insert(cloudAccount)
    .values({ userId, serverUrl: attempt.serverUrl, cloudUser, displayName, secret: sealed, linkedAt: now, lastOkAt: now, lastError: null })
    .onConflictDoUpdate({
      target: cloudAccount.userId,
      set: { serverUrl: attempt.serverUrl, cloudUser, displayName, secret: sealed, linkedAt: now, lastOkAt: now, lastError: null },
    });
  await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId));
  await recordChange(tx, ctx, {
    action: 'cloud_account.linked',
    objectType: ACCOUNT_OBJECT,
    objectId: userId,
    // Who the cloud says this is — never the password.
    after: { server: attempt.serverUrl, cloudUser, replacedPrevious: Boolean(previous) },
    branchCode: ctx.branchCode,
  });
  return 'linked';
}

export async function cancelLink(tx: Tx, userId: string): Promise<void> {
  await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId));
}

// ---------------------------------------------------------------------------
// Unlinking
// ---------------------------------------------------------------------------

export type RevokeOutcome = 'revoked' | 'already_gone' | 'failed' | 'no_key';

async function revokeStored(userId: string, row: typeof cloudAccount.$inferSelect): Promise<RevokeOutcome> {
  let password: string;
  try {
    password = openSecret(row.secret, accountBind(userId));
  } catch (error) {
    if (error instanceof SecretKeyError) return 'no_key';
    throw error;
  }
  try {
    return await new CloudClient({ baseUrl: row.serverUrl, user: row.cloudUser, password }).revokeAppPassword();
  } catch {
    return 'failed';
  }
}

/**
 * Unlinks this person: the app password is revoked at the cloud and the stored
 * copy deleted. If the cloud cannot be reached the copy is deleted all the
 * same — a credential Qimah no longer needs is not kept — and the outcome says
 * the password is still to be removed at the cloud (Settings → Security).
 */
export async function unlink(tx: Tx, ctx: ActorContext): Promise<RevokeOutcome | 'not_linked'> {
  const userId = ctx.principal.userId;
  const [row] = await tx.select().from(cloudAccount).where(eq(cloudAccount.userId, userId)).limit(1);
  await tx.delete(cloudLinkAttempt).where(eq(cloudLinkAttempt.userId, userId));
  if (!row) return 'not_linked';
  const outcome = await revokeStored(userId, row);
  await tx.delete(cloudAccount).where(eq(cloudAccount.userId, userId));
  await recordChange(tx, ctx, {
    action: 'cloud_account.unlinked',
    objectType: ACCOUNT_OBJECT,
    objectId: userId,
    before: { server: row.serverUrl, cloudUser: row.cloudUser },
    after: { appPassword: outcome },
    branchCode: ctx.branchCode,
  });
  return outcome;
}

/**
 * A person has been deactivated: their app password goes with their access
 * (D-FX-3). Called by `users.setActive` inside the deactivation, which has
 * already authorised the administrator; the account's row policy lets one who
 * may administer users read and delete it.
 */
export async function removeForDeactivation(tx: Tx, ctx: ActorContext, userId: string): Promise<RevokeOutcome | 'not_linked'> {
  const [row] = await tx.select().from(cloudAccount).where(eq(cloudAccount.userId, userId)).limit(1);
  if (!row) return 'not_linked';
  const outcome = await revokeStored(userId, row);
  await tx.delete(cloudAccount).where(eq(cloudAccount.userId, userId));
  await recordChange(tx, ctx, {
    action: 'cloud_account.revoked_on_deactivation',
    objectType: ACCOUNT_OBJECT,
    objectId: userId,
    before: { server: row.serverUrl, cloudUser: row.cloudUser },
    after: { appPassword: outcome },
    branchCode: ctx.branchCode,
  });
  return outcome;
}
