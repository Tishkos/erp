'use server';

import { list, runAdminAndReturn, text } from '@/server/admin-action';
import * as roles from '@/server/services/roles';

const LIST = '/administration/roles';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function createRole(formData: FormData): Promise<void> {
  const code = text(formData, 'code').trim().toLowerCase();
  await runAdminAndReturn(
    (tx, ctx) =>
      roles.create(tx, ctx, {
        code,
        name: text(formData, 'name'),
        description: text(formData, 'description'),
      }),
    (value) => (value ? record(code) : LIST),
  );
}

export async function updateRole(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      roles.update(tx, ctx, code, {
        name: text(formData, 'name'),
        description: text(formData, 'description'),
      }),
    record(code),
  );
}

/** Each ticked box is `grant=object:verb`. */
export async function saveRoleGrants(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  const grants = list(formData, 'grant').map((pair) => {
    const [object, verb] = pair.split(':');
    return { object: object ?? '', verb: verb ?? '' };
  });
  const offered = list(formData, 'offered');
  await runAdminAndReturn(
    (tx, ctx) => roles.setGrants(tx, ctx, code, grants, { offeredObjects: offered }),
    record(code),
  );
}
