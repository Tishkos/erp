'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { POSTING_MAP } from '@domain/posting-map';
import * as posting from '@/server/services/posting';

const SCREEN = '/finance/posting-mappings';

/**
 * Point one document's lines at their accounts — or take a mapping off.
 *
 * One save for the document, not one per line. The lines of a journal are
 * decided together: somebody setting up a Purchase Invoice is answering "where
 * does this entry post", and answering it four times with four buttons made
 * the screen a column of buttons rather than a document.
 *
 * Choosing the blank entry is how a mapping is removed. It is the same gesture
 * as choosing a different account, so it needs no second control to explain
 * itself.
 *
 * All of it in one transaction: half a Purchase Invoice mapped is not a state
 * anybody asked for, and if one line is refused — the account lost its
 * approval, or its control designation — the rest are not written either.
 * The roles come from the catalogue rather than the form, so a field somebody
 * appends to the request maps nothing.
 */
export async function setPostingMappings(formData: FormData): Promise<void> {
  const eventType = text(formData, 'event_type');

  await runAdminAndReturn(async (tx, ctx) => {
    const document = POSTING_MAP.find((entry) => entry.event === eventType);
    if (!document) {
      throw new Error(`${eventType || 'That document'} is not a document the posting engine posts.`);
    }

    for (const line of document.lines) {
      const field = `account_id_${line.role}`;
      // A line the form did not carry is a line the reader could not change —
      // a select the screen did not render because they may only look. Leave
      // it exactly as it is rather than reading "absent" as "clear it".
      if (!formData.has(field)) continue;

      const accountId = text(formData, field).trim();
      if (accountId) {
        await posting.setMapping(tx, ctx, { eventType, lineRole: line.role, accountId });
      } else {
        await posting.clearMapping(tx, ctx, { eventType, lineRole: line.role });
      }
    }
  }, SCREEN);
}
