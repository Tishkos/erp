import type { SearchParams } from '@/components/admin/params';
import { ChargeRegister } from '../charge-register';

/** Customs Duties & Taxes — REQ-LOG-001 item 10: the import's `customs_asycuda` charges. */
export const dynamic = 'force-dynamic';

export default function CustomsDutiesPage({ searchParams }: { searchParams: SearchParams }) {
  return <ChargeRegister register="duties" searchParams={searchParams} />;
}
