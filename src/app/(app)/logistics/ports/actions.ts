'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as ports from '@/server/services/ports';

/** Ports — REQ-LOG-001 item 15. Every verb is the service's. */
const LIST = '/logistics/ports';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const fieldsOf = (formData: FormData) => ({
  name: text(formData, 'name'),
  locode: text(formData, 'locode') || null,
  country: text(formData, 'country') || null,
});

export async function addPort(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => ports.add(tx, ctx, fieldsOf(formData)),
    (value) => {
      const created = value as { code?: string } | null | undefined;
      return created?.code ? record(created.code) : LIST;
    },
  );
}

export async function renamePort(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => ports.rename(tx, ctx, code, fieldsOf(formData)), record(code));
}

export async function retirePort(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => ports.deactivate(tx, ctx, code, text(formData, 'reason')), record(code));
}

export async function reactivatePort(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => ports.reactivate(tx, ctx, code, text(formData, 'reason')), record(code));
}
