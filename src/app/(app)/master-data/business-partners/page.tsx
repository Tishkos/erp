import { notFound } from 'next/navigation';
import { PartnerList } from '@/components/admin/partner-list';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/**
 * Every business partner, whichever role they hold.
 *
 * The combined view. A partner is created from Customers or from Suppliers,
 * because creating one means giving them a role; this is where they are read
 * together.
 */
export const dynamic = 'force-dynamic';

export default async function BusinessPartnersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/business-partners')) notFound();
  return <PartnerList searchParams={searchParams} />;
}
