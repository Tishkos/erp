import type { SearchParams } from '@/components/admin/params';
import { DocumentRegister } from '../document-register';

/** Customs Documents — REQ-LOG-001 item 11: the files on PDs, ASYCUDA readings and customs declarations. */
export const dynamic = 'force-dynamic';

export default function CustomsDocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  return <DocumentRegister scope="customs" searchParams={searchParams} />;
}
