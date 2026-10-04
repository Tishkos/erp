import type { SearchParams } from '@/components/admin/params';
import { DocumentRegister } from '../document-register';

/** Shipment Documents — REQ-LOG-001 item 17: the files on B/Ls, containers and import applications. */
export const dynamic = 'force-dynamic';

export default function ShipmentDocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  return <DocumentRegister scope="shipment" searchParams={searchParams} />;
}
