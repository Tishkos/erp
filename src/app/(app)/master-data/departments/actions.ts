'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as departments from '@/server/services/departments';

const LIST = '/master-data/departments';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function createDepartment(formData: FormData): Promise<void> {
  // No code: the system mints it (Critical Rule 1).
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.create(tx, ctx, {
        name: text(formData, 'name'),
        parentCode: text(formData, 'parentCode') || null,
        isFinance: flag(formData, 'isFinance'),
      }),
    (value) => {
      const created = value as { code?: string } | null | undefined;
      return created?.code ? record(created.code) : LIST;
    },
  );
}

export async function updateDepartment(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.update(tx, ctx, code, {
        name: text(formData, 'name'),
        parentCode: text(formData, 'parentCode') || null,
        isFinance: flag(formData, 'isFinance'),
      }),
    record(code),
  );
}

export async function setDepartmentActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}

/** Adds a member (and optionally makes them manager), or flips the manager flag. */
export async function setDepartmentManager(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.setManager(tx, ctx, code, text(formData, 'userId'), flag(formData, 'isManager')),
    record(code),
  );
}

/** Takes a member out of the department. */
export async function removeDepartmentMember(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => departments.removeMember(tx, ctx, code, text(formData, 'userId')),
    record(code),
  );
}
