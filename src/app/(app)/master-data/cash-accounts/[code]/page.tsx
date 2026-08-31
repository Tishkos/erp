import { notFound } from 'next/navigation';
import { AccountRecord } from '@/components/admin/bank-cash-account';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** One cash account — Phase 2 requirement 6. */
export const dynamic = 'force-dynamic';

export default async function CashAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/cash-accounts')) notFound();
  return <AccountRecord kind="cash" params={params} searchParams={searchParams} />;
}
