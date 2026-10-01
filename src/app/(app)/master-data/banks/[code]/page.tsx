import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Landmark } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import { setBankActive, updateBank } from '../actions';

/** One bank — REQ-AP-001 §15.1. Drawn as one payment method is. */
export const dynamic = 'force-dynamic';

export default async function BankPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/banks')) notFound();

  const [t, page, column, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', banks.PERMISSION_OBJECT)) {
    return <Denied object={page('banks')} />;
  }
  const mayEdit = can(principal, 'configure', banks.PERMISSION_OBJECT);

  const row = await withCurrentUser(async (tx) => {
    try {
      return await banks.detail(tx, code);
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!row) notFound();

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/banks', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Landmark aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>
                <bdi dir="auto">{row.name}</bdi>
              </h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('banks.swift')}</span>
                <span>
                  <bdi dir="ltr">{row.swiftBic ?? t('none')}</bdi>
                </span>
              </li>
              <li>
                <span>{t('banks.country')}</span>
                <span>{row.country}</span>
              </li>
            </ul>
          </Panel>

          {mayEdit ? (
            <Panel title={row.active ? t('banks.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setBankActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setBankActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          <Panel title={t('banks.accounts')}>
            <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{column('code')}</th>
                    <th scope="col">{column('name')}</th>
                    <th scope="col">{t('bank_accounts.account_number')}</th>
                    <th scope="col">{t('accounts_shared.currency')}</th>
                    <th scope="col">{column('active')}</th>
                  </tr>
                </thead>
                <tbody>
                  {row.accounts.length === 0 ? (
                    <tr>
                      <td colSpan={5}>{t('banks.no_accounts')}</td>
                    </tr>
                  ) : null}
                  {row.accounts.map((account) => (
                    <tr key={account.code}>
                      <td>
                        <Link href={`/master-data/bank-accounts/${encodeURIComponent(account.code)}`}>
                          {account.code}
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{account.name}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{account.accountNumber ?? t('none')}</bdi>
                      </td>
                      <td>{account.currency}</td>
                      <td>
                        <Pill label={account.active ? t('active') : t('inactive')} on={account.active} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateBank}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Field
                    defaultValue={row.swiftBic ?? ''}
                    hint={t('banks.swift_hint')}
                    label={t('banks.swift')}
                    name="swiftBic"
                  />
                  <Field
                    defaultValue={row.country}
                    hint={t('banks.country_hint')}
                    label={t('banks.country')}
                    name="country"
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={banks.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
