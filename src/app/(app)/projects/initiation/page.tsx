import type { SearchParams } from '@/components/admin/params';
import { InitiationRegister } from './register';

/**
 * Leads — the Project Initiation records at the first stage of their road
 * (Sales Lead, Tender Lead, the financed customer's first contact), and the
 * guide's Main Project Initiation Selector behind *New*. The address is the
 * Project Guide's register's, so every link to a record keeps working.
 */
export const dynamic = 'force-dynamic';

export default function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
  return <InitiationRegister phase="lead" route="/projects/initiation" searchParams={searchParams} />;
}
