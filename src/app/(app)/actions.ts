'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { BRANCH_COOKIE, requireContext } from '@/server/session';

/**
 * The header's branch picker — the writer the session comment always promised.
 *
 * `currentContext` has read the `erp_branch` cookie since Phase 01 and checked
 * it against the person's own scope on every request; nothing ever wrote it,
 * so a person with three branches was pinned to their default. This is the
 * missing half.
 *
 * The scope check here is a courtesy, not the control: a cookie naming a
 * branch outside the person's scope is ignored by the session on every later
 * request anyway. Checking on the way in just means the picker never appears
 * to work and then silently not have.
 */
export async function switchBranch(formData: FormData): Promise<void> {
  const branch = String(formData.get('branch') ?? '');
  const { principal } = await requireContext();

  if (!principal.branchCodes.includes(branch)) return;

  (await cookies()).set(BRANCH_COOKIE, branch, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
  });

  // Every screen reads the branch, so everything under the layout is stale.
  revalidatePath('/', 'layout');
}
