'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as costCentres from '@/server/services/cost-centres';

const LIST = '/master-data/cost-centres';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

/**
 * Where a successful create lands.
 *
 * The code is read from what the service returned, not from the form: when
 * nobody typed one the service derives it from the name, and only it knows
 * what it settled on.
 */
const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

export async function createCostCentre(formData: FormData): Promise<void> {
  const code = text(formData, 'code').trim().toUpperCase();
  await runAdminAndReturn(
    (tx, ctx) =>
      costCentres.create(tx, ctx, {
        code,
        name: text(formData, 'name'),
        ownerUserId: text(formData, 'ownerUserId') || null,
        branchCode: text(formData, 'branchCode') || null,
      }),
    createdRecord,
  );
}

export async function updateCostCentre(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      costCentres.update(tx, ctx, code, {
        name: text(formData, 'name'),
        ownerUserId: text(formData, 'ownerUserId') || null,
        branchCode: text(formData, 'branchCode') || null,
      }),
    record(code),
  );
}

export async function setCostCentreActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      costCentres.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
