'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as branches from '@/server/services/branches';
import * as company from '@/server/services/company';

export async function saveCompany(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      company.save(tx, ctx, {
        code: text(formData, 'code'),
        legalName: text(formData, 'legalName'),
        tradeName: text(formData, 'tradeName'),
        registrationNo: text(formData, 'registrationNo'),
        taxIdentifier: text(formData, 'taxIdentifier'),
        baseCurrency: text(formData, 'baseCurrency'),
        address: text(formData, 'address'),
      }),
    '/administration/company',
  );
}

export async function saveMainBranch(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      branches.update(tx, ctx, code, {
        name: text(formData, 'name'),
        address: text(formData, 'address'),
        managerUserId: text(formData, 'managerUserId') || null,
      }),
    '/administration/company',
  );
}
