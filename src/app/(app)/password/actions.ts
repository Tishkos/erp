'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { runAdmin, text, withQuery } from '@/server/admin-action';
import * as users from '@/server/services/users';

/** HD2 — replaces the temporary password; the restriction lifts with it. */
export async function replaceTemporaryPassword(formData: FormData): Promise<void> {
  const outcome = await runAdmin(
    (tx, ctx, request) =>
      users.changeOwnPassword(
        tx,
        ctx,
        {
          currentPassword: text(formData, 'currentPassword'),
          newPassword: text(formData, 'newPassword'),
          confirm: text(formData, 'confirm'),
        },
        request.sessionId,
      ),
    { allowRestricted: true },
  );
  if (!outcome.ok) redirect(withQuery('/password', 'error', outcome.error!));
  // The shell drew no menu for the restricted session; it is redrawn now.
  revalidatePath('/', 'layout');
  redirect('/?saved=1');
}
