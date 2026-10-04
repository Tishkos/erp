import type { SearchParams } from '@/components/admin/params';
import { ChargeRegister } from '../charge-register';

/** Freight & Shipping Costs — REQ-LOG-001 item 16: the `freight`, `port_forwarding` and `other` charges. */
export const dynamic = 'force-dynamic';

export default function FreightCostsPage({ searchParams }: { searchParams: SearchParams }) {
  return <ChargeRegister register="freight" searchParams={searchParams} />;
}
