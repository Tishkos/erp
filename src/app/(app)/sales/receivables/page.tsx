import { notFound } from 'next/navigation';
import { OpenItemsReport } from '@/components/admin/open-items-report';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/delivered';

/**
 * Receivables — what customers owe, invoice by invoice, and how late.
 *
 * The whole report is `OpenItemsReport`, shared with Payables: the two are the
 * same report in a mirror, and keeping them as one component is what stops
 * them drifting into two different definitions of "overdue".
 */
export const dynamic = 'force-dynamic';

export default async function ReceivablesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/receivables')) notFound();
  return (
    <OpenItemsReport
      exportKey="receivables"
      invoiceHref={(invoiceNo) => `/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`}
      route="/sales/receivables"
      searchParams={searchParams}
      side="customer"
      titleKey="ar_open_items"
    />
  );
}
