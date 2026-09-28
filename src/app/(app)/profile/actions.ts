'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as users from '@/server/services/users';
import * as company from '@/server/services/company';

const BACK = '/profile';

export async function saveProfile(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => users.updateOwnProfile(tx, ctx, { displayName: text(formData, 'displayName') }),
    BACK,
  );
}

export async function changePassword(formData: FormData): Promise<void> {
  await runAdminAndReturn(
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
    `${BACK}?password=1`,
  );
}

export async function saveAvatar(formData: FormData): Promise<void> {
  const file = formData.get('avatar');
  const remove = formData.get('remove') !== null;
  await runAdminAndReturn(
    (tx, ctx) =>
      users.updateOwnAvatar(
        tx,
        ctx,
        remove || !(file instanceof File) || file.size === 0
          ? null
          : {
              type: file.type,
              size: file.size,
              bytes: async () => new Uint8Array(await file.arrayBuffer()),
            },
      ),
    BACK,
  );
}

/** Save this account's own palette and accent. */
export async function saveMyAppearance(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      company.setMyAppearance(tx, ctx, {
        palette: text(formData, 'uiPalette'),
        accent: text(formData, 'uiAccent'),
      }),
    BACK,
  );
}
