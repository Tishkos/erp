import { notFound } from 'next/navigation';
import { ReceivablesAgeing } from '@/components/admin/receivables-ageing';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/delivered';

/**
 * Receivables Ageing — what customers owe, invoice by invoice and debit note
 * by debit note, and how late.
 *
 * Read through `open-items.ts`, the service the Payables ageing shares, so
 * the two cannot drift into two definitions of "overdue". The screen itself
 * is Receivables' own since 2026-10-04 (its summary, filters and drill-down),
 * so the Payables screen is not touched by it.
 */
export const dynamic = 'force-dynamic';

export default async function ReceivablesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/receivables')) notFound();
  return <ReceivablesAgeing searchParams={searchParams} />;
}
