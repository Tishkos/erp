'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  FLASH_COOKIE,
  flag,
  list,
  runAdmin,
  runAdminAndReturn,
  text,
  withQuery,
} from '@/server/admin-action';
import * as company from '@/server/services/company';
import * as mail from '@/server/services/mail';
import * as users from '@/server/services/users';
import { withCurrentUser } from '@/server/session';

const LIST = '/administration/users';
const record = (id: string) => `${LIST}/${id}`;

// The temporary password is shown exactly once, on the next page. It travels
// in a short-lived httpOnly cookie rather than the URL, so it is never in a
// browser history, a log line or a referrer.
async function stash(secret: string) {
  const jar = await cookies();
  jar.set(FLASH_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: LIST,
    maxAge: 90,
  });
}

/**
 * Hands the temporary password over: by e-mail when mail is configured and
 * the message is accepted, otherwise on screen, once. The query string says
 * which happened so the page can tell the administrator.
 */
async function deliver(
  id: string,
  to: { email: string; displayName: string },
  password: string,
  reason: 'created' | 'reset',
): Promise<never> {
  let mailed = false;
  let mailFailed = false;
  if (mail.isConfigured()) {
    try {
      const current = await withCurrentUser((tx) => company.current(tx));
      mailed = await mail.sendTemporaryPassword({
        to: to.email,
        displayName: to.displayName,
        password,
        reason,
        companyName: current?.legalName ?? 'QS',
      });
    } catch {
      mailFailed = true;
    }
  }
  if (!mailed) await stash(password);
  let target = withQuery(record(id), 'saved', '1');
  if (mailed) target = withQuery(target, 'mailed', '1');
  if (mailFailed) target = withQuery(target, 'mail_failed', '1');
  redirect(target);
}

export async function createUser(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    users.create(tx, ctx, {
      email: text(formData, 'email'),
      displayName: text(formData, 'displayName'),
      roleCodes: list(formData, 'roleCodes'),
      branchCodes: list(formData, 'branchCodes'),
      defaultBranchCode: text(formData, 'defaultBranchCode') || null,
      departmentCodes: list(formData, 'departmentCodes'),
      // REQ-FIX-001 FIX-5 — ticked by default; unticked, the account is only a sign-in.
      employee: flag(formData, 'alsoEmployee')
        ? { departmentCode: text(formData, 'employeeDepartmentCode') || null, positionCode: text(formData, 'employeePositionCode') || null }
        : null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  const created = outcome.value!;
  await deliver(created.id, created, created.temporaryPassword, 'created');
}

export async function updateUser(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) => users.update(tx, ctx, id, { displayName: text(formData, 'displayName') }),
    record(id),
  );
}

export async function setUserActive(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) => users.setActive(tx, ctx, id, flag(formData, 'active'), text(formData, 'reason')),
    record(id),
  );
}

export async function resetUserPassword(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  const outcome = await runAdmin(async (tx, ctx) => {
    const password = await users.resetPassword(tx, ctx, id);
    const user = await users.get(tx, id);
    return { password, email: user.email, displayName: user.displayName };
  });
  if (!outcome.ok) redirect(withQuery(record(id), 'error', outcome.error!));
  await deliver(id, outcome.value!, outcome.value!.password, 'reset');
}

export async function setUserRole(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) => users.setRole(tx, ctx, id, text(formData, 'roleCode'), flag(formData, 'on')),
    record(id),
  );
}

export async function setUserBranch(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) => users.setBranchScope(tx, ctx, id, text(formData, 'branchCode'), flag(formData, 'on')),
    record(id),
  );
}

export async function setUserDefaultBranch(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) => users.setDefaultBranch(tx, ctx, id, text(formData, 'branchCode')),
    record(id),
  );
}

export async function setUserDepartment(formData: FormData): Promise<void> {
  const id = text(formData, 'id');
  await runAdminAndReturn(
    (tx, ctx) =>
      users.setDepartmentScope(tx, ctx, id, text(formData, 'departmentCode'), flag(formData, 'on')),
    record(id),
  );
}
