'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { CreditApplicationError, isCreditSourceKind, isDebtTargetKind } from '@domain/customer-credits';
import * as credits from '@/server/services/customer-credits';

const LIST = '/sales/customer-credits';

/**
 * Puts one credit against one debt — a row of the Apply table.
 *
 * The amount comes from the box: part of a credit is the ordinary case, and
 * the service refuses anything past either ceiling with a sentence that says
 * which.
 */
export async function applyCredit(formData: FormData): Promise<void> {
  const creditNo = text(formData, 'credit_no');
  const back = `${LIST}?credit=${encodeURIComponent(creditNo)}`;
  await runAdminAndReturn(async (tx, ctx) => {
    const sourceKind = text(formData, 'source_kind');
    const targetKind = text(formData, 'target_kind');
    if (!isCreditSourceKind(sourceKind) || !isDebtTargetKind(targetKind)) {
      throw new CreditApplicationError('That is not a credit and a debt this screen can pair.');
    }
    return credits.apply(tx, ctx, {
      source: { kind: sourceKind, id: text(formData, 'source_id') },
      target: { kind: targetKind, id: text(formData, 'target_id') },
      amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
    });
  }, back);
}
