import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as methods from '@/server/services/payment-methods';
import { createPaymentMethod } from './actions';

/**
 * Payment methods — Phase 2 requirement 8.
 *
 * The method is what a person picks ("Cheque"); the kind beneath it is the
 * rail the money moves on, and it is what later phases branch on. A cheque is
 * a method of kind `bank`: it settles through a bank account and reconciles
 * against a bank statement, which is all the system needs to know.
 */
export const dynamic = 'force-dynamic';

export default async function PaymentMethodsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/payment-methods')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', methods.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_methods')} />;
  }
  const mayCreate = can(principal, 'create', methods.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => methods.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('payment_methods.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('payment_methods.new')}
          >
            <p className="muted">{t('payment_methods.created_note')}</p>
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createPaymentMethod}>
              <Grid>
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select
                  defaultValue="bank"
                  hint={t('payment_methods.kind_hint')}
                  label={t('payment_methods.kind')}
                  name="kind"
                  options={methods.PAYMENT_METHOD_KINDS.map((kind) => ({
                    value: kind,
                    label: t(`payment_methods.kind_${kind}`),
                  }))}
                />
                <Select
                  defaultValue="transfer"
                  hint={t('payment_methods.confirmation_hint')}
                  label={t('payment_methods.confirmation')}
                  name="confirmationKind"
                  options={methods.CONFIRMATION_KINDS.map((kind) => ({
                    value: kind,
                    label: t(`payment_methods.confirmation_${kind}`),
                  }))}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/payment-methods" />}
      subtitle={t('payment_methods.subtitle')}
      title={page('payment_methods')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/master-data/payment-methods"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('code')}</th>
                <th scope="col">{column('name')}</th>
                <th scope="col">{t('payment_methods.kind')}</th>
                <th scope="col">{t('payment_methods.confirmation')}</th>
                <th scope="col">{t('payment_methods.fee')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t('payment_methods.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/payment-methods/${encodeURIComponent(row.code)}`}>
                      {row.code}
                    </Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{t(`payment_methods.kind_${row.kind}`)}</td>
                  <td>{t(`payment_methods.confirmation_${row.confirmationKind}`)}</td>
                  <td>
                    {Number(row.feePercent) === 0
                      ? t('none')
                      : `${row.feePercent}% · ${row.feeAccountCode ?? ''}`}
                  </td>
                  <td>
                    <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
