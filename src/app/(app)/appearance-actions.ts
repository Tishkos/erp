'use server';

import type { UserAppearanceSettings } from '@/server/domain/appearance';
import { withCurrentUser } from '@/server/session';
import { CompanyNotSetUpError, makeMineCompanyDefault, resetCompanyDefaults, setMySettings } from '@/server/services/user-appearance';

/** Why everyone's default could not change: no company row yet (2026-10-07 — the live install had none), or anything else. */
export type CompanyDefaultFailure = 'no_company' | 'failed';

/** Autosaves only the signed-in user's own layout preferences. */
export async function saveMyAppearanceSettings(input: UserAppearanceSettings): Promise<{
  readonly ok: boolean;
  readonly error?: string;
}> {
  try {
    await withCurrentUser((tx, request) =>
      setMySettings(tx, {
        principal: request.principal,
        branchCode: request.scope.branchCode,
        requestId: request.sessionId,
      }, input),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The appearance settings could not be saved.',
    };
  }
}

/**
 * "Make my appearance everyone's default" (0419): the caller's appearance as
 * they see it becomes the company's default. `configure` on the company,
 * checked and audited by the service.
 */
export async function makeMyAppearanceEveryonesDefault(): Promise<{ readonly ok: boolean; readonly error?: string; readonly failure?: CompanyDefaultFailure }> {
  try {
    await withCurrentUser((tx, request) =>
      makeMineCompanyDefault(tx, {
        principal: request.principal,
        branchCode: request.scope.branchCode,
        requestId: request.sessionId,
      }),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof CompanyNotSetUpError ? 'no_company' : 'failed',
      error: error instanceof Error ? error.message : 'Everyone\'s default could not be set.',
    };
  }
}

/** "Reset everyone's default to the built-in" (0419). */
export async function resetEveryonesAppearanceDefault(): Promise<{ readonly ok: boolean; readonly error?: string; readonly failure?: CompanyDefaultFailure }> {
  try {
    await withCurrentUser((tx, request) =>
      resetCompanyDefaults(tx, {
        principal: request.principal,
        branchCode: request.scope.branchCode,
        requestId: request.sessionId,
      }),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof CompanyNotSetUpError ? 'no_company' : 'failed',
      error: error instanceof Error ? error.message : 'Everyone\'s default could not be reset.',
    };
  }
}
