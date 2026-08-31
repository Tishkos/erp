import { notFound } from 'next/navigation';
import { AccountList } from '@/components/admin/bank-cash-account';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** Company cash accounts — Phase 2 requirement 6. */
export const dynamic = 'force-dynamic';

export default async function CashAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/cash-accounts')) notFound();
  return <AccountList kind="cash" searchParams={searchParams} />;
}
