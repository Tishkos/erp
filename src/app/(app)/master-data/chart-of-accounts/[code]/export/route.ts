import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { withCurrentUser } from '@/server/session';
import * as audit from '@/server/services/audit';
import * as coa from '@/server/services/chart-of-accounts';
import * as trialBalance from '@/server/services/trial-balance';
import { toCsv } from '@/server/services/csv';

/**
 * One account's postings as a file — every line ever posted to it, in the
 * branches the reader may see, oldest first.
 *
 * Gated like the list export (view *and* export on the chart), and recorded
 * the same way: who took a copy of which account, and how many rows, is an
 * audit question (§5.4). The rows themselves are not written to the trail.
 */
export const dynamic = 'force-dynamic';

const COLUMNS = [
  'posting_date',
  'entry_no',
  'line_no',
  'description',
  'currency',
  'debit_iqd',
  'credit_iqd',
  'debit_usd',
  'credit_usd',
  'department_code',
  'business_partner_code',
  'status',
] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  if (!visibleRoute('/master-data/chart-of-accounts')) return new Response(null, { status: 404 });
  const code = decodeURIComponent((await params).code);

  const result = await withCurrentUser(async (tx, context) => {
    if (!can(context.principal, 'view', coa.PERMISSION_OBJECT)) return { status: 404 as const };
    if (!can(context.principal, 'export', coa.PERMISSION_OBJECT)) return { status: 403 as const };
    const node = await coa.loadAccountByCode(tx, code).catch(() => null);
    if (!node) return { status: 404 as const };

    const activity = node.isGroup
      ? []
      : await trialBalance.accountActivity(tx, code, {
          from: '0001-01-01',
          to: '9999-12-31',
          allPermittedBranches: true,
        });

    await audit.record(tx, {
      actorUserId: context.principal.userId,
      action: `${coa.DOCUMENT_TYPE}.exported`,
      objectType: coa.DOCUMENT_TYPE,
      objectId: node.code,
      outcome: 'success',
      after: { rowCount: activity.length, columns: [...COLUMNS] },
    });

    return {
      status: 200 as const,
      rows: activity.map((row) => ({
        posting_date: row.postingDate,
        entry_no: row.entryNo,
        line_no: row.lineNo,
        description: row.description ?? '',
        currency: row.currency,
        debit_iqd: row.debitIqd,
        credit_iqd: row.creditIqd,
        debit_usd: row.debitUsd,
        credit_usd: row.creditUsd,
        department_code: row.departmentCode ?? '',
        business_partner_code: row.businessPartnerCode ?? '',
        status: row.status,
      })),
    };
  });
  if (result.status !== 200) return new Response(null, { status: result.status });

  return new Response(toCsv(COLUMNS, result.rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="account-${code.replace(/[^A-Za-z0-9_.-]/g, '_')}.csv"`,
      // Never cached: an export reflects one person's permissions at one
      // moment, and a shared cache would serve it to the next reader.
      'cache-control': 'no-store, private',
    },
  });
}
