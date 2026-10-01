import { notFound } from 'next/navigation';
import { OpenItemsReport } from '@/components/admin/open-items-report';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/delivered';

/** Payables — the supplier's side of the same mirror. See Receivables. */
export const dynamic = 'force-dynamic';

export default async function PayablesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/open-items')) notFound();
  return (
    <OpenItemsReport
      exportKey="payables"
      invoiceHref={(invoiceNo) => `/payables/invoices/${encodeURIComponent(invoiceNo)}`}
      route="/payables/open-items"
      searchParams={searchParams}
      side="supplier"
      titleKey="ap_open_items"
    />
  );
}
