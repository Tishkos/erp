'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseQuantity } from '@domain/uom';
import * as counts from '@/server/services/stock-count';
import type { CountScope } from '@/server/services/stock-count';

const LIST = '/inventory/stock-count';
const record = (countNo: string) => `${LIST}/${encodeURIComponent(countNo)}`;

/**
 * Stock Count — §9.6 on the existing engine (`services/stock-count.ts`): plan,
 * count, recount, approve the variance, adjust. No engine of its own.
 */
export async function planCount(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => {
      const scope = text(formData, 'scope').trim() as CountScope;
      const scopeFilter = text(formData, 'scope_filter').trim();
      if ((scope === 'item' || scope === 'category') && !scopeFilter) {
        throw new Error(scope === 'item' ? 'Name the item to count.' : 'Name the category to count.');
      }
      return counts.plan(tx, ctx, {
        branchCode: ctx.branchCode,
        warehouseCode: text(formData, 'warehouse_code').trim(),
        plannedOn: text(formData, 'planned_on').trim(),
        scope,
        scopeFilter: scope === 'item' || scope === 'category' ? scopeFilter : null,
      });
    },
    (value) => {
      const created = value as { countNo?: string } | undefined;
      return created?.countNo ? record(created.countNo) : LIST;
    },
  );
}

/** The physical count (or the recount): one quantity per line, a note where something looked wrong. */
export async function recordCount(formData: FormData): Promise<void> {
  const countNo = text(formData, 'count_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const quantities: Record<number, bigint> = {};
      const notes: Record<number, string> = {};
      for (const [name, value] of formData.entries()) {
        const match = /^qty_(\d+)$/.exec(name);
        if (!match) continue;
        const typed = String(value).trim();
        if (!typed) continue;
        const lineNo = Number(match[1]);
        quantities[lineNo] = parseQuantity(typed);
        const note = text(formData, `note_${lineNo}`).trim();
        if (note) notes[lineNo] = note;
      }
      if (Object.keys(quantities).length === 0) throw new Error('Enter what was found on at least one line.');
      await counts.recordCount(tx, ctx, text(formData, 'id'), { countedOn: text(formData, 'counted_on').trim(), quantities, notes });
    },
    record(countNo),
  );
}

export async function requestRecount(formData: FormData): Promise<void> {
  const countNo = text(formData, 'count_no');
  await runAdminAndReturn((tx, ctx) => counts.requestRecount(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(countNo));
}

export async function approveVariance(formData: FormData): Promise<void> {
  const countNo = text(formData, 'count_no');
  await runAdminAndReturn((tx, ctx) => counts.approveVariance(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(countNo));
}

/** The adjustment: the movements and their journal (Dr/Cr inventory adjustment), in one transaction. */
export async function adjustCount(formData: FormData): Promise<void> {
  const countNo = text(formData, 'count_no');
  await runAdminAndReturn(
    (tx, ctx) => counts.adjust(tx, ctx, text(formData, 'id'), { adjustedOn: text(formData, 'adjusted_on').trim(), post: true }),
    record(countNo),
  );
}

export async function cancelCount(formData: FormData): Promise<void> {
  const countNo = text(formData, 'count_no');
  await runAdminAndReturn((tx, ctx) => counts.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(countNo));
}
