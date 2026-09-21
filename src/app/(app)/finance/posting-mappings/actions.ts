'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as posting from '@/server/services/posting';

const SCREEN = '/finance/posting-mappings';

/**
 * Point one line of one document at an account — or take the mapping off.
 *
 * One action for both, because the screen has one control: the account chosen
 * on the row. Choosing the blank entry is how a mapping is removed, which is
 * the same gesture as choosing a different account and needs no second button
 * to explain itself.
 */
export async function setPostingMapping(formData: FormData): Promise<void> {
  const eventType = text(formData, 'event_type');
  const lineRole = text(formData, 'line_role');
  const accountId = text(formData, 'account_id').trim();

  await runAdminAndReturn(
    (tx, ctx) =>
      accountId
        ? posting.setMapping(tx, ctx, { eventType, lineRole, accountId })
        : posting.clearMapping(tx, ctx, { eventType, lineRole }),
    SCREEN,
  );
}
