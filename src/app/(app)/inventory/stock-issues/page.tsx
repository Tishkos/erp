import type { SearchParams } from '@/components/admin/params';
import { StockFlowRegister } from '../stock-receipts/register';

/** Stock Issues — what left stock, from the movement ledger (IMPROVEMENT-002). */
export const dynamic = 'force-dynamic';

export default async function StockIssuesPage({ searchParams }: { searchParams: SearchParams }) {
  return StockFlowRegister({ direction: 'issue', searchParams });
}
