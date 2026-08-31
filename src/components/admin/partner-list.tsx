import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Hidden,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  matches,
} from './index';
import { AutoCode } from './auto-code';
import { SectionTabs } from './section-tabs';
import { outcomeOf, type SearchParams } from './params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as partners from '@/server/services/partners';
import * as terms from '@/server/services/payment-terms';
import { createPartnerInRole } from '@/app/(app)/master-data/business-partners/actions';

/**
 * Customers and suppliers — Phase 2 requirements 2 and 3.
 *
 * Two lists over one record. §6 is explicit that one record serves every
 * module, and §3.1 requires one authoritative record per party, so a company
 * that both buys and sells appears on both lists — and the row says so.
 *
 * Adding a company from the Customers screen that already exists as a supplier
 * grants that partner the customer role. It does not make a second record,
 * because a second record for one legal person makes their balances
 * unnettable and lets the two halves disagree about their own address.
 */

const ROUTES = {
  customer: '/master-data/customers',
  supplier: '/master-data/suppliers',
} as const;

const PAGE_KEY = { customer: 'customers', supplier: 'suppliers' } as const;

/** Both screens open a partner at the same address: one record, one page. */
const RECORD = '/master-data/business-partners';

export async function PartnerList({
  role,
  searchParams,
}: {
  /** Which role this screen is about. A partner is always created in one. */
  readonly role: partners.PartnerRole;
  readonly searchParams: SearchParams;
}) {
  const key = role;
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', partners.PERMISSION_OBJECT)) {
    return <Denied object={page(PAGE_KEY[key])} />;
  }
  const mayCreate = can(principal, 'create', partners.PERMISSION_OBJECT);
  const route = ROUTES[key];

  const { rows, paymentTerms } = await withCurrentUser(async (tx) => ({
    rows: await partners.listByRole(tx, role),
    paymentTerms: mayCreate ? await terms.listActive(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t(`partners.new_${role}`)}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t(`partners.new_${role}`)}
          >
            <p className="muted">{t(`partners.created_note_${role}`)}</p>
            <AutoCode codeId="f-code" mode="upper" nameId="f-legalName" />
            <Form action={createPartnerInRole}>
              <Hidden name="role" value={role} />
              <Grid>
                <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                <Field
                  label={t('partners.legal_name')}
                  name="legalName"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field hint={t('partners.trade_name_hint')} label={t('partners.trade_name')} name="tradeName" />
                <Field label={t('partners.email')} name="email" type="email" />
                <Field label={t('partners.phone')} name="phone" />
                <Field label={t('partners.registration_no')} name="registrationNo" />
                <Field label={t('partners.tax_identifier')} name="taxIdentifier" />
                <Select
                  emptyLabel={t('partners.no_terms')}
                  hint={t('partners.terms_hint')}
                  label={t('partners.payment_terms')}
                  name="paymentTermsCode"
                  options={paymentTerms.map((term) => ({
                    value: term.code,
                    label: `${term.code} · ${term.name}`,
                  }))}
                />
                {role === 'customer' ? (
                  <Field
                    hint={t('partners.credit_limit_hint')}
                    label={t('partners.credit_limit')}
                    min={0}
                    name="creditLimitIqd"
                    step="0.0001"
                    type="number"
                  />
                ) : null}
                <Field label={t('partners.address')} name="address" type="textarea" wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route={route} />}
      subtitle={t(`partners.subtitle_${key}`)}
      title={page(PAGE_KEY[key])}
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
          clearHref={route}
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
                <th scope="col">{t('partners.legal_name')}</th>
                <th scope="col">{t('partners.roles')}</th>
                <th scope="col">{column('status')}</th>
                <th scope="col">{t('partners.payment_terms')}</th>
                <th scope="col">{t('partners.contact')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={7}>{t(`partners.none_${key}`)}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`${RECORD}/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>
                    {row.legalName}
                    {row.tradeName ? <span className="muted"> · {row.tradeName}</span> : null}
                  </td>
                  {/* One record, both roles — said plainly rather than implied. */}
                  <td>
                    {[
                      row.isCustomer ? t('partners.role_customer') : null,
                      row.isSupplier ? t('partners.role_supplier') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </td>
                  <td>{t(`partners.status_${row.status}`)}</td>
                  <td>{row.paymentTermsCode ?? t('none')}</td>
                  <td>{row.email ?? row.phone ?? t('none')}</td>
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
