'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as branches from '@/server/services/branches';

const LIST = '/master-data/branches';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function createBranch(formData: FormData): Promise<void> {
  const code = text(formData, 'code').trim().toUpperCase();
  await runAdminAndReturn(
    (tx, ctx) =>
      branches.create(tx, ctx, {
        code,
        name: text(formData, 'name'),
        address: text(formData, 'address'),
        managerUserId: text(formData, 'managerUserId') || null,
      }),
    (value) => (value ? record(code) : LIST),
  );
}

export async function updateBranch(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      branches.update(tx, ctx, code, {
        name: text(formData, 'name'),
        address: text(formData, 'address'),
        managerUserId: text(formData, 'managerUserId') || null,
      }),
    record(code),
  );
}

export async function setBranchActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => branches.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
