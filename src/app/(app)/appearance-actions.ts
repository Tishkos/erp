'use server';

import type { UserAppearanceSettings } from '@/server/domain/appearance';
import { withCurrentUser } from '@/server/session';
import { setMySettings } from '@/server/services/user-appearance';

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
