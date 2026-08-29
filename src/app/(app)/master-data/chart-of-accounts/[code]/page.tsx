import { notFound } from 'next/navigation';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { visibleRoute } from '@/server/phase-gate';
import { RecordPage } from '@/components/record-page';
import { registerAllRecords } from '@/server/records';
import { RecordNotFoundError, view } from '@/server/services/record';
import { PermissionDeniedError } from '@domain/permissions';
import { withCurrentUser } from '@/server/session';
import { AccountControls } from '@/components/admin/account-controls';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { getTranslations } from 'next-intl/server';
import { can } from '@domain/permissions';
import * as coa from '@/server/services/chart-of-accounts';

/**
 * One account — Phase 01.12's first screen on the record framework, drawn
 * in the same window as the chart it was opened from.
 *
 * `services/record.ts` returns the nine facts Appendix A requires along with
 * the actions this reader may take in this status, and the component renders
 * them. Beneath sit the account's own properties: the statement line it
 * reports on, whether it may hold sub-accounts, and taking it out of use.
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

  const [{ code: raw }, outcome, t] = await Promise.all([params, outcomeOf(searchParams), getTranslations('admin')]);
  const code = decodeURIComponent(raw);

  const record = await withCurrentUser((tx, context) =>
    view(tx, context.principal, 'chart_of_account', code),
  ).catch((error) => {
    if (error instanceof RecordNotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  });
  if (!record) notFound();

  const account = await withCurrentUser(async (tx, context) => {
    // The record framework addresses an account by its code, which is what a
    // person knows; the service takes the id.
    const node = await coa.loadAccountByCode(tx, code).catch(() => null);
    return node ? { node, mayConfigure: can(context.principal, 'configure', 'chart_of_account') } : null;
  });

  return (
    <AdminPage
      back={{ href: '/master-data/chart-of-accounts', label: t('back') }}
      title={account ? `${account.node.code} · ${account.node.name}` : code}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      {/* An action that was refused says so. The record framework decides which
          buttons to *offer* from status and permission; whether the workflow
          will accept the decision — self-approval, for one — is only known when
          it is tried, and the person needs to read the answer. */}
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      <div className={s.sapDoc}>
        <RecordPage hideTitle returnTo={`/master-data/chart-of-accounts/${encodeURIComponent(code)}`} view={record} />
        {account ? <AccountControls account={account.node} mayConfigure={account.mayConfigure} /> : null}
      </div>
    </AdminPage>
  );
}
