import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  FilterRow,
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
  admin as s,
} from './index';
import { SectionTabs } from './section-tabs';
import { outcomeOf, type SearchParams } from './params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as partners from '@/server/services/partners';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';
import { partnerRegister } from '@/server/services/screen-registers';
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
  customer: '/sales/customers',
  supplier: '/payables/suppliers',
} as const;

const PAGE_KEY = { customer: 'customers', supplier: 'suppliers' } as const;

/** The lifecycle statuses a list can be narrowed to (`business_partner.status`). */
const STATUSES = ['prospect', 'active', 'on_hold', 'blocked', 'inactive'] as const;

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

  // The person's saved views of this list — and, on a bare arrival, their default one.
  const saved = await savedViewsFor(role === 'supplier' ? 'payables.suppliers' : 'sales.customers', searchParams);
  const status = saved?.current.params['status'] ?? '';

  const { shown } = await withCurrentUser(async (tx) => ({
    // The rows and filters are `partnerRegister` — the pinned count on Home asks the same function.
    ...(await partnerRegister(tx, role, { q: outcome.q, status })),
  }));

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
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createPartnerInRole}>
              <Hidden name="role" value={role} />
              <Grid>
                <Field
                  label={t('partners.legal_name')}
                  name="legalName"
                  required
                  requiredLabel={t('required_hint')}
                />
                {/* Blocks 2 and 3 ask for a name, a code, payment terms and
                    contact information. The trade name, the registration
                    number and the tax identifier are none of those; their
                    columns remain, and a partner that has them keeps them. */}
                <Field label={t('partners.email')} name="email" type="email" />
                <Field label={t('partners.phone')} name="phone" />
                {/* Neither a customer nor a supplier is asked for payment terms
                    when it is made (by direction: customers 2026-10-06, suppliers
                    2026-10-07 — "remove payment terms in supplier when making it,
                    no need"). A sale with no terms falls due on its invoice date;
                    a purchase's due date is set once the SWIFT is received. */}
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
          hidden={status ? { status } : {}}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        >
          <SavedViewsMenu state={saved} />
        </ListToolbar>
        <form className={s.filterBar} method="get">
          <FilterRow>
            <Select
              defaultValue={status}
              emptyLabel={t('partners.status_all')}
              label={column('status')}
              name="status"
              options={STATUSES.map((value) => ({ value, label: t(`partners.status_${value}`) }))}
            />
            <SubmitRow>
              <Submit label={t('partners.filter')} />
            </SubmitRow>
          </FilterRow>
        </form>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('code')}</th>
                <th scope="col">{t('partners.legal_name')}</th>
                <th scope="col">{column('status')}</th>
                <th scope="col">{t('partners.payment_terms')}</th>
                <th scope="col">{t('partners.contact')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t(`partners.none_${key}`)}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`${route}/${encodeURIComponent(row.code)}?role=${role}`}>{row.code}</Link>
                  </td>
                  <td>{row.legalName}</td>
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
