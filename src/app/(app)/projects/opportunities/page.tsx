import type { SearchParams } from '@/components/admin/params';
import { InitiationRegister } from '../initiation/register';

/**
 * Opportunities — the Project Initiation records past their first stage and
 * not yet a project: the Pre-Sales Form onwards, a tender from Go / No-Go, a
 * financed customer from the quotation. Each keeps the number it had as a lead.
 */
export const dynamic = 'force-dynamic';

export default function OpportunitiesPage({ searchParams }: { searchParams: SearchParams }) {
  return <InitiationRegister phase="opportunity" route="/projects/opportunities" searchParams={searchParams} />;
}
