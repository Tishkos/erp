import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CreditCard } from 'lucide-react';
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
  Select,
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
import * as coa from '@/server/services/chart-of-accounts';
import * as methods from '@/server/services/payment-methods';
import { setPaymentMethodActive, updatePaymentMethod } from '../actions';

/** One payment method — Phase 2 requirement 8. */
export const dynamic = 'force-dynamic';

export default async function PaymentMethodPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/payment-methods')) notFound();

  const [t, page, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', methods.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_methods')} />;
  }
  const mayEdit = can(principal, 'configure', methods.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', methods.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await methods.detail(tx, code);
      // A fee has to land somewhere; only posting accounts can receive it.
      const accounts = mayEdit ? await coa.postableAccounts(tx) : [];
      return { row, accounts };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, accounts } = data;

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/payment-methods', label: t('back') }}
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
                <CreditCard aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('payment_methods.kind')}</span>
                <span>{t(`payment_methods.kind_${row.kind}`)}</span>
              </li>
              <li>
                <span>{t('payment_methods.confirmation')}</span>
                <span>{t(`payment_methods.confirmation_${row.confirmationKind}`)}</span>
              </li>
              <li>
                <span>{t('payment_methods.fee')}</span>
                <span>{Number(row.feePercent) === 0 ? t('none') : `${row.feePercent}%`}</span>
              </li>
              <li>
                <span>{t('payment_methods.fee_account')}</span>
                <span>{row.feeAccount ?? t('none')}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('payment_methods.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setPaymentMethodActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setPaymentMethodActive}
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
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updatePaymentMethod}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Select
                    defaultValue={row.kind}
                    hint={t('payment_methods.kind_hint')}
                    label={t('payment_methods.kind')}
                    name="kind"
                    options={methods.PAYMENT_METHOD_KINDS.map((kind) => ({
                      value: kind,
                      label: t(`payment_methods.kind_${kind}`),
                    }))}
                  />
                  <Select
                    defaultValue={row.confirmationKind}
                    hint={t('payment_methods.confirmation_hint')}
                    label={t('payment_methods.confirmation')}
                    name="confirmationKind"
                    options={methods.CONFIRMATION_KINDS.map((kind) => ({
                      value: kind,
                      label: t(`payment_methods.confirmation_${kind}`),
                    }))}
                  />
                  <Field
                    defaultValue={Number(row.feePercent) === 0 ? '' : row.feePercent}
                    hint={t('payment_methods.fee_hint')}
                    label={t('payment_methods.fee')}
                    min={0}
                    name="feePercent"
                    step="0.000001"
                    type="number"
                  />
                  <Select
                    defaultValue={row.feeAccountId ?? ''}
                    emptyLabel={t('payment_methods.no_fee_account')}
                    hint={t('payment_methods.fee_account_hint')}
                    label={t('payment_methods.fee_account')}
                    name="feeAccountId"
                    options={accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={methods.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
