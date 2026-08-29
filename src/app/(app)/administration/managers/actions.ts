'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as departments from '@/server/services/departments';

const LIST = '/administration/managers';

/**
 * Makes somebody the manager of a department, from the managers screen.
 *
 * The person is scoped to the department if they were not already — the
 * service does both in one act, because a manager who is not a member is not
 * a state §5.2 recognises.
 */
export async function assignManager(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.setManager(tx, ctx, text(formData, 'departmentCode'), text(formData, 'userId'), true),
    LIST,
  );
}

/** Takes the manager flag off; the person stays a member of the department. */
export async function removeManager(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      departments.setManager(tx, ctx, text(formData, 'departmentCode'), text(formData, 'userId'), false),
    LIST,
  );
}
