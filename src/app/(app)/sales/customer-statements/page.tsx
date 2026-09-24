import { notFound } from 'next/navigation';
import { AccountStatement } from '@/components/admin/account-statement';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';

/** Customer Statements — Operations build, block 2. */
export const dynamic = 'force-dynamic';

export default async function CustomerStatementsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/customer-statements')) notFound();
  return <AccountStatement side="customer" searchParams={searchParams} />;
}
