'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { businessToday } from '@/server/domain/business-date';
import * as attachments from '@/server/services/attachments';
import * as recurring from '@/server/services/recurring-journals';
import type { Tx } from '@/server/db/client';
import type { ActorContext } from '@/server/services/chart-of-accounts';

/** Recurring Journals — REQ-ACC-001 Part D-7. Every verb is `recurring-journals.ts`'s. */
const LIST = '/finance/recurring-journals';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;

const schedule = (formData: FormData): recurring.TemplateInput => ({
  name: text(formData, 'name'),
  description: text(formData, 'description') || null,
  frequency: text(formData, 'frequency') as recurring.RecurringFrequency,
  intervalCount: Number(text(formData, 'interval_count') || '1'),
  startsOn: text(formData, 'starts_on'),
  endsOn: text(formData, 'ends_on') || null,
});

async function idOf(tx: Tx, ctx: ActorContext, no: string): Promise<string> {
  return (await recurring.view(tx, ctx, no)).template.id;
}

export async function createRecurringAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => recurring.create(tx, ctx, schedule(formData)),
    (value) => {
      const made = value as { templateNo?: string } | null | undefined;
      return made?.templateNo ? record(made.templateNo) : `${LIST}?template=new`;
    },
  );
}

export async function updateRecurringAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(async (tx, ctx) => recurring.updateDraft(tx, ctx, await idOf(tx, ctx, no), schedule(formData)), record(no));
}

export async function addRecurringLineAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  const side = text(formData, 'side');
  const amount = text(formData, 'amount');
  await runAdminAndReturn(
    async (tx, ctx) =>
      recurring.addLine(tx, ctx, await idOf(tx, ctx, no), {
        accountId: text(formData, 'account_id'),
        ...(side === 'credit' ? { credit: amount } : { debit: amount }),
        departmentCode: text(formData, 'department_code') || null,
        description: text(formData, 'line_description') || null,
      }),
    record(no),
  );
}

export async function removeRecurringLineAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(async (tx, ctx) => recurring.removeLine(tx, ctx, await idOf(tx, ctx, no), text(formData, 'line_id')), record(no));
}

export async function activateRecurringAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(async (tx, ctx) => recurring.activate(tx, ctx, await idOf(tx, ctx, no)), record(no));
}

export async function pauseRecurringAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(async (tx, ctx) => recurring.pause(tx, ctx, await idOf(tx, ctx, no), text(formData, 'reason')), record(no));
}

export async function endRecurringAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(async (tx, ctx) => recurring.end(tx, ctx, await idOf(tx, ctx, no), text(formData, 'reason')), record(no));
}

/** The journals due up to today, as drafts — for one template, or all of them. */
export async function raiseDueAction(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  await runAdminAndReturn(
    async (tx, ctx) => (no ? recurring.raiseDue(tx, ctx, await idOf(tx, ctx, no), businessToday()) : recurring.raiseAllDue(tx, ctx, businessToday())),
    no ? record(no) : `${LIST}?view=active`,
  );
}

/** The lease, the subscription agreement — paperwork on the template. */
export async function attachToRecurring(formData: FormData): Promise<void> {
  const no = text(formData, 'template_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(no)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(
    async (tx, ctx) =>
      attachments.upload(tx, ctx, { objectType: recurring.DOCUMENT_TYPE, objectId: await idOf(tx, ctx, no), fileName: upload.name, content }),
    record(no),
  );
}
