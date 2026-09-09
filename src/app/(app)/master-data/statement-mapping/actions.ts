'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import type { StatementFace } from '@domain/financial-statements';
import * as statementLines from '@/server/services/statement-lines';

const SCREEN = '/master-data/statement-mapping';

/** Back to the tab the change was made on. */
const back = (form: FormData) => {
  const tab = text(form, 'tab');
  return tab ? `${SCREEN}?statement=${encodeURIComponent(tab)}` : SCREEN;
};

/** The answers one report asks for, read from whichever fields it showed. */
const vocabularyOf = (formData: FormData) => ({
  isHeader: text(formData, 'kind') === 'header',
  isSubtotal: text(formData, 'kind') === 'subtotal',
  side: text(formData, 'side') || null,
  cashFlowCategory: text(formData, 'cashFlowCategory') || null,
  isCash: text(formData, 'isCash') === 'yes',
});

export async function createLine(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) =>
      statementLines.create(tx, ctx, {
        statement: text(formData, 'statement') as StatementFace,
        name: text(formData, 'name'),
        parentId: text(formData, 'parentId') || null,
        ...vocabularyOf(formData),
      }),
    target,
  );
}

/** Name, kind and the report's own field, all in one change. */
export async function updateLine(formData: FormData): Promise<void> {
  const target = back(formData);
  await runAdminAndReturn(
    (tx, ctx) =>
      statementLines.update(tx, ctx, text(formData, 'id'), {
        name: text(formData, 'name'),
        parentId: text(formData, 'parentId') || null,
        ...vocabularyOf(formData),
      }),
    target,
  );
}

/** Up or down among the lines it is printed beside. */
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
