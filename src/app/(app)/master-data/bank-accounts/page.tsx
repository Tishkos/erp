import { notFound } from 'next/navigation';
import { AccountList } from '@/components/admin/bank-cash-account';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** Company bank accounts — Phase 2 requirement 5. */
export const dynamic = 'force-dynamic';

export default async function BankAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/bank-accounts')) notFound();
  return <AccountList kind="bank" searchParams={searchParams} />;
}
