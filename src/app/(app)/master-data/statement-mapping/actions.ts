'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import type { StatementFace } from '@domain/financial-statements';
import * as statementLines from '@/server/services/statement-lines';

const SCREEN = '/master-data/statement-mapping';

/** Back to the tab the change was made on. */
const back = (form: FormData) => {
  const tab = text(form, 'tab');
  return tab ? `${SCREEN}?statement=${encodeURIComponent(tab)}` : SCREEN;
};

export async function createLine(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) =>
      statementLines.create(tx, ctx, {
        statement: text(formData, 'statement') as StatementFace,
        name: text(formData, 'name'),
        isHeader: text(formData, 'kind') === 'header',
        // The Cash Flow Statement's third kind: the line that *is* the cash
        // whose movement the statement explains.
        isCash: text(formData, 'kind') === 'cash',
        parentId: text(formData, 'parentId') || null,
        role: text(formData, 'role') || null,
        side: text(formData, 'side') || null,
        cashFlowCategory: text(formData, 'cashFlowCategory') || null,
      }),
    target,
  );
}

export async function renameLine(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) => statementLines.rename(tx, ctx, text(formData, 'id'), text(formData, 'name')),
    target,
  );
}

export async function moveLine(formData: FormData): Promise<void> {
  const target = back(formData);
  const direction = text(formData, 'direction') === 'up' ? 'up' : 'down';
  await runAdminAndReturn(
    (tx, ctx) => statementLines.move(tx, ctx, text(formData, 'id'), direction),
    target,
  );
}

export async function deleteLine(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) => statementLines.remove(tx, ctx, text(formData, 'id')),
    target,
  );
}

export async function setLineCategory(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) =>
      statementLines.setCashFlowCategory(
        tx,
        ctx,
        text(formData, 'id'),
        text(formData, 'category') as 'operating' | 'investing' | 'financing',
      ),
    target,
  );
}

export async function setLineCash(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) => statementLines.setCash(tx, ctx, text(formData, 'id'), flag(formData, 'isCash')),
    target,
  );
}
