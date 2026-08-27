import { notFound } from 'next/navigation';
import { admin as s } from '@/components/admin';
import { Workspace } from '@/components/ui';
import { visibleRoute } from '@/server/phase-gate';
import { RecordPage } from '@/components/record-page';
import { registerAllRecords } from '@/server/records';
import { RecordNotFoundError, view } from '@/server/services/record';
import { Denied } from '@/components/denied';
import { PermissionDeniedError } from '@domain/permissions';
import { withCurrentUser } from '@/server/session';
import { AccountControls } from '@/components/admin/account-controls';
import { Flash } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { getTranslations } from 'next-intl/server';
import { can } from '@domain/permissions';
import * as coa from '@/server/services/chart-of-accounts';

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
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();
  registerAllRecords();

  const [{ code }, outcome, t] = await Promise.all([
    params,
    outcomeOf(searchParams),
    getTranslations('admin'),
  ]);

  const record = await withCurrentUser((tx, context) =>
    view(tx, context.principal, 'chart_of_account', decodeURIComponent(code)),
  ).catch((error) => {
    if (error instanceof RecordNotFoundError) notFound();
    throw error;
  });

  // Phase 1 §1 and §5 — assigning the statement line and taking the account
  // out of use. The framework's record view carries the approval actions; these
  // two are properties of the account rather than steps in its approval, so
  // they sit beneath it rather than among them.
  const account = await withCurrentUser(async (tx, context) => {
    // The record framework addresses an account by its code, which is what a
    // person knows; the service takes the id.
    const node = await coa.loadAccountByCode(tx, decodeURIComponent(code)).catch(() => null);
    return node
      ? { node, mayConfigure: can(context.principal, 'configure', 'chart_of_account') }
      : null;
  });

  return (
    <Workspace className={s.sapPage}>
      {/* An action that was refused says so. The record framework decides which
          buttons to *offer* from status and permission; whether the workflow
          will accept the decision — self-approval, for one — is only known when
          it is tried, and the person needs to read the answer. */}
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />
      <RecordPage returnTo={`/master-data/chart-of-accounts/${encodeURIComponent(code)}`} view={record} />
      {account ? (
        <AccountControls account={account.node} mayConfigure={account.mayConfigure} />
      ) : null}
    </Workspace>
  );
}
