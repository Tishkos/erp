import { notFound } from 'next/navigation';
import { PartnerList } from '@/components/admin/partner-list';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** Suppliers — Phase 2 requirement 3. */
export const dynamic = 'force-dynamic';

export default async function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/suppliers')) notFound();
  return <PartnerList role="supplier" searchParams={searchParams} />;
}
