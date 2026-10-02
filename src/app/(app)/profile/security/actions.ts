'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as authentication from '@/server/services/authentication';

const BACK = '/profile/security';

/** HD4 — a new secret for the authenticator app; shown once on the page. */
export async function beginEnrolment(): Promise<void> {
  await runAdminAndReturn((tx, ctx) => authentication.beginMfaEnrolment(tx, ctx.principal.userId), BACK, {
    allowRestricted: true,
  });
}

/** HD4 — the app's first code proves the secret was entered right. */
export async function confirmEnrolment(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => authentication.confirmMfaEnrolment(tx, ctx, ctx.principal.userId, text(formData, 'code')),
    `${BACK}?enrolled=1`,
    { allowRestricted: true },
  );
}
