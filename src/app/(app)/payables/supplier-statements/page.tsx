import { notFound } from 'next/navigation';
import { AccountStatement } from '@/components/admin/account-statement';
import type { SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/delivered';

/** Supplier Statements — Operations build, block 3. */
export const dynamic = 'force-dynamic';

export default async function SupplierStatementsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/supplier-statements')) notFound();
  return <AccountStatement side="supplier" searchParams={searchParams} />;
}
