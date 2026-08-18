import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { RecordPage } from '@/components/record-page';
import { registerAllRecords } from '@/server/records';
import { RecordNotFoundError, view } from '@/server/services/record';
import { Denied } from '@/components/denied';
import { PermissionDeniedError } from '@domain/permissions';
import { withCurrentUser } from '@/server/session';

/**
 * One account — Phase 01.12's first screen on the record framework.
 *
 * The page assembles nothing itself. `services/record.ts` returns the nine
 * facts Appendix A requires along with the actions this reader may take in this
 * status, and the component renders them. A module that wanted a different
 * record page would be a module whose controls differ from everyone else's,
 * which is what §24 exists to prevent.
 */
export const dynamic = 'force-dynamic';

export default async function AccountRecordPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  registerAllRecords();

  const { code } = await params;

  const record = await withCurrentUser((tx, context) =>
    view(tx, context.principal, 'chart_of_account', decodeURIComponent(code)),
  ).catch((error) => {
    if (error instanceof RecordNotFoundError) notFound();
    throw error;
  });

  return (
    <AppShell>
      <RecordPage view={record} />
    </AppShell>
  );
}
