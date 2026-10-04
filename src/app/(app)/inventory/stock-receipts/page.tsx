import type { SearchParams } from '@/components/admin/params';
import { StockFlowRegister } from './register';

/** Stock Receipts — what came into stock, from the movement ledger (IMPROVEMENT-002). */
export const dynamic = 'force-dynamic';

export default async function StockReceiptsPage({ searchParams }: { searchParams: SearchParams }) {
  return StockFlowRegister({ direction: 'receipt', searchParams });
}
