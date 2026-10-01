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
import { DUE_DATE_BASIS } from '@domain/payment-terms';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as terms from '@/server/services/payment-terms';
import { createPaymentTerm } from './actions';

/** Payment terms — Phase 2 requirement 7. */
export const dynamic = 'force-dynamic';

export default async function PaymentTermsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/payment-terms')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', terms.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_terms')} />;
  }
  const mayCreate = can(principal, 'create', terms.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => terms.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const basisOptions = DUE_DATE_BASIS.map((basis) => ({
    value: basis,
    label: t(`payment_terms.basis_${basis}`),
  }));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('payment_terms.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('payment_terms.new')}
          >
            <p className="muted">{t('payment_terms.created_note')}</p>
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createPaymentTerm}>
              <Grid>
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select
                  defaultValue="document_date"
                  hint={t('payment_terms.basis_hint')}
                  label={t('payment_terms.basis')}
                  name="basis"
                  options={basisOptions}
                />
                <Field
                  defaultValue="0"
                  hint={t('payment_terms.due_days_hint')}
                  label={t('payment_terms.due_days')}
                  min={0}
                  name="dueDays"
                  type="number"
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
      tabs={<SectionTabs route="/master-data/payment-terms" />}
      subtitle={t('payment_terms.subtitle')}
      title={page('payment_terms')}
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
          clearHref="/master-data/payment-terms"
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
                <th scope="col">{t('payment_terms.basis')}</th>
                <th scope="col">{t('payment_terms.due_days')}</th>
                <th scope="col">{t('payment_terms.discount')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t('payment_terms.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/payment-terms/${encodeURIComponent(row.code)}`}>
                      {row.code}
                    </Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{t(`payment_terms.basis_${row.basis}`)}</td>
                  <td>{row.dueDays}</td>
                  <td>
                    {row.discountPercent
                      ? t('payment_terms.discount_summary', {
                          percent: row.discountPercent,
                          days: row.discountDays ?? 0,
                        })
                      : t('none')}
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
