import { notFound } from 'next/navigation';
import { AccountRecord } from '@/components/admin/bank-cash-account';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** One bank account — Phase 2 requirement 5. */
export const dynamic = 'force-dynamic';

export default async function BankAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/bank-accounts')) notFound();
  return <AccountRecord kind="bank" params={params} searchParams={searchParams} />;
}
