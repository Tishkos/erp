import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as customs from '@/server/services/customs-pd';
import { registerPd } from './actions';
import { pdChip } from './status';

/**
 * PDs — REQ-AP-001 §21.8 (REQ-APP-001 S4).
 *
 * The customs pre-declarations, the soonest to expire first: the sheet's PD
 * and Pending tabs in one register. Days left turns red inside the warning
 * window. Drawn as Purchase Invoices is — the module's tabs, one register
 * window, the search box and one filter.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['live', 'expiring', 'final', 'holding', 'all'] as const;

export default async function PdListPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/pd')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', customs.PERMISSION_OBJECT)) {
    return <Denied object={page('pds')} />;
  }
  const mayCreate = can(principal, 'create', customs.PERMISSION_OBJECT);
  const mayImport = can(principal, 'import', customs.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'live';
  const applied = typeof params.applied === 'string' ? params.applied : null;
  const today = new Date().toISOString().slice(0, 10);

  const { rows, warning, imports, bankRows, statuses } = await withCurrentUser(async (tx) => ({
    rows: await customs.list(tx, { view }),
    warning: await customs.warningDays(tx),
    imports: mayCreate ? await customs.importChoices(tx) : [],
    bankRows: mayCreate ? await banks.listActive(tx) : [],
    statuses: mayCreate ? await customs.statuses(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);


  return (
    <AdminPage
      actions={
        <>
          {mayCreate ? (
            <NewRecordDialog
              buttonLabel={t('register')}
              closeLabel={admin('close')}
              openOnLoad={Boolean(outcome.error) && !applied}
              title={t('register')}
            >
              <p className="muted">{t('register_note')}</p>
              <Form action={registerPd}>
                <Grid>
                  <Select
                    label={t('import')}
                    name="payable_id"
                    options={imports.map((row) => ({
                      value: row.id,
                      label: `${row.payableNo} · ${row.reference} · ${row.supplierName}`,
                    }))}
                    required
                  />
                  <Field hint={t('pd_no_hint')} label={t('pd_no')} name="new_pd_no" required />
                  <Field defaultValue={today} label={t('registered')} name="registration_date" required type="date" />
                  <Field hint={t('expiry_hint')} label={t('expires')} name="expiry_date" required type="date" />
                  <Select
                    emptyLabel="—"
                    label={t('bank')}
                    name="bank_code"
                    options={bankRows.map((b) => ({ value: b.code, label: b.swiftBic ? `${b.name} · ${b.swiftBic}` : b.name }))}
                  />
                  <Select
                    defaultValue="submitted"
                    label={t('status')}
                    name="status_code"
                    options={statuses
                      .filter((row) => row.active && !row.isTerminal)
                      .map((row) => ({ value: row.code, label: row.name }))}
                  />
                </Grid>
                <Field label={t('note')} name="note" wide />
                <SubmitRow>
                  <Submit label={t('register')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          ) : null}
          {mayImport ? (
            <Link className="action" href="/payables/pd/asycuda">
              {t('asycuda')}
            </Link>
          ) : null}
        </>
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/pd" />}
      subtitle={t('subtitle')}
      title={page('pds')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={admin('error_title')}
        saved={outcome.saved && applied === null ? outcome.saved : false}
        savedLabel={admin('saved')}
      />
      {applied !== null && outcome.saved ? (
        <p className={s.sapNote} role="status">
          {t('applied_n', { count: Number(applied) })}
        </p>
      ) : null}

      <section aria-labelledby="pd-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pd-list-title">
            <span>{page('pds')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/pd"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={t('view')}
                name="view"
                options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`, { days: warning }) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="pd-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('pd_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('bank')}</th>
                  <th scope="col">{t('registered')}</th>
                  <th scope="col">{t('expires')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('days_left')}
                  </th>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('note')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/pd/${encodeURIComponent(row.pdNo)}?year=${row.registrationYear}`}
                      >
                        <bdi dir="ltr">{row.pdNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      {row.payableNo ? (
                        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                          <bdi dir="ltr">{row.payableNo}</bdi>
                        </Link>
                      ) : (
                        <span className="status status--rejected" data-status="rejected">
                          {t('unlinked')}
                        </span>
                      )}
                      {row.reference ? (
                        <div className="muted">
                          <bdi dir="ltr">{row.reference}</bdi>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.bankName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.registrationDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.expiryDate, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {row.isTerminal || row.superseded ? (
                        '—'
                      ) : row.daysLeft <= warning ? (
                        <span className="status status--rejected" data-status="rejected">
                          {row.daysLeft}
                        </span>
                      ) : (
                        row.daysLeft
                      )}
                    </td>
                    <td>
                      <span
                        className={`status status--${pdChip(row)} ${s.sapRegisterStatus}`}
                        data-status={pdChip(row)}
                      >
                        {ps(row.statusCode, row.statusName)}
                      </span>
                      {row.superseded ? <div className="muted">{t('superseded')}</div> : null}
                    </td>
                    <td>
                      <bdi dir="auto">{row.lastNote ?? ''}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
