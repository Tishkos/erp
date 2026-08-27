'use server';

import { list, runAdminAndReturn, text } from '@/server/admin-action';
import * as roles from '@/server/services/roles';

/** Each ticked box is `grant=object:verb`; the role's grants become exactly that set. */
export async function savePermissions(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  const grants = list(formData, 'grant').map((pair) => {
    const [object, verb] = pair.split(':');
    return { object: object ?? '', verb: verb ?? '' };
  });
  const offered = list(formData, 'offered');
  await runAdminAndReturn(
    (tx, ctx) => roles.setGrants(tx, ctx, code, grants, { offeredObjects: offered }),
    `/administration/permissions?role=${encodeURIComponent(code)}`,
  );
}
