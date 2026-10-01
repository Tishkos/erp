import { notFound } from 'next/navigation';
import { PartnerList } from '@/components/admin/partner-list';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** Customers — Phase 2 requirement 2. */
export const dynamic = 'force-dynamic';

export default async function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customers')) notFound();
  return <PartnerList role="customer" searchParams={searchParams} />;
}
