import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CalendarClock } from 'lucide-react';
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
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { DUE_DATE_BASIS } from '@domain/payment-terms';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as terms from '@/server/services/payment-terms';
import { setPaymentTermActive, updatePaymentTerm } from '../actions';

/**
 * One payment term — Phase 2 requirement 7.
 *
 * The worked example is the point of the page. "30 days, end of month" is a
 * sentence two people read differently; a date computed from a real document
 * date is not, and it is computed by the function the invoice will use.
 */
export const dynamic = 'force-dynamic';

/** Spare rows so a schedule can be extended without an "add row" button. */
const SPARE_INSTALMENTS = 2;

export default async function PaymentTermPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/payment-terms')) notFound();

  const [t, page, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', terms.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_terms')} />;
  }
  const mayEdit = can(principal, 'configure', terms.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', terms.PERMISSION_OBJECT);

  // The example runs from a date the reader can change, defaulting to today.
  const query = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const exampleDate = typeof query.on === 'string' ? query.on : today;

  const row = await withCurrentUser(async (tx) => {
    try {
      return await terms.detail(tx, code, exampleDate);
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!row) notFound();

  const rows = [
    ...row.instalments,
    ...Array.from({ length: SPARE_INSTALMENTS }, () => null),
  ];

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/payment-terms', label: t('back') }}
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
                <CalendarClock aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          {/* What the term actually does, on a date the reader picks. */}
          <Panel title={t('payment_terms.example')}>
            <form className={s.sapFilterBar} method="get">
              <label className={s.sapFilterField}>
                <span className={s.sapLabel}>{t('payment_terms.example_date')}</span>
                <input defaultValue={exampleDate} name="on" required type="date" />
              </label>
              <button className={`${s.button} ${s.primary}`} type="submit">
                {t('reports.run')}
              </button>
            </form>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('payment_terms.invoice_dated')}</span>
                <span>{formatBusinessDate(row.exampleDate, locale as Locale)}</span>
              </li>
              <li>
                <span>{t('payment_terms.falls_due')}</span>
                <span>
                  <strong>{formatBusinessDate(row.dueDate, locale as Locale)}</strong>
                </span>
              </li>
            </ul>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('payment_terms.basis')}</span>
                <span>{t(`payment_terms.basis_${row.basis}`)}</span>
              </li>
              <li>
                <span>{t('payment_terms.due_days')}</span>
                <span>{row.dueDays}</span>
              </li>
              <li>
                <span>{t('payment_terms.discount')}</span>
                <span>
                  {row.discountPercent
                    ? t('payment_terms.discount_summary', {
                        percent: row.discountPercent,
                        days: row.discountDays ?? 0,
                      })
                    : t('none')}
                </span>
              </li>
              <li>
                <span>{t('payment_terms.instalment_count')}</span>
                <span>{row.instalments.length === 0 ? t('payment_terms.single_payment') : row.instalments.length}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('payment_terms.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setPaymentTermActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setPaymentTermActive}
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
              <Form action={updatePaymentTerm}>
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
                    defaultValue={row.basis}
                    hint={t('payment_terms.basis_hint')}
                    label={t('payment_terms.basis')}
                    name="basis"
                    options={DUE_DATE_BASIS.map((basis) => ({
                      value: basis,
                      label: t(`payment_terms.basis_${basis}`),
                    }))}
                  />
                  <Field
                    defaultValue={String(row.dueDays)}
                    hint={t('payment_terms.due_days_hint')}
                    label={t('payment_terms.due_days')}
                    min={0}
                    name="dueDays"
                    type="number"
                  />
                  <Field
                    defaultValue={row.discountPercent ?? ''}
                    hint={t('payment_terms.discount_hint')}
                    label={t('payment_terms.discount_percent')}
                    min={0}
                    name="discountPercent"
                    step="0.0001"
                    type="number"
                  />
                  <Field
                    defaultValue={row.discountDays === null ? '' : String(row.discountDays)}
                    label={t('payment_terms.discount_days')}
                    min={0}
                    name="discountDays"
                    type="number"
                  />
                </Grid>

                {/* §16 — a term may fall due in parts, and the parts must add
                    to the whole invoice. Leave every row blank for a term that
                    falls due once. */}
                <h3>{t('payment_terms.instalments')}</h3>
                <p className={s.sectionHint}>{t('payment_terms.instalments_hint')}</p>
                <div className="table-wrap">
                  <table className="list">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">{t('payment_terms.days_after')}</th>
                        <th scope="col">{t('payment_terms.percentage')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((instalment, index) => (
                        <tr key={index}>
                          <td>{index + 1}</td>
                          <td>
                            <input
                              className={s.input}
                              defaultValue={instalment ? String(instalment.daysAfter) : ''}
                              min={0}
                              name="daysAfter"
                              type="number"
                            />
                          </td>
                          <td>
                            <input
                              className={s.input}
                              defaultValue={instalment ? instalment.percentage : ''}
                              min={0}
                              name="percentage"
                              step="0.01"
                              type="number"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel title={t('payment_terms.partners_using', { count: row.partners.length })}>
            {row.partners.length === 0 ? (
              <p className="muted">{t('payment_terms.no_partners')}</p>
            ) : (
              <ul className={s.profileFacts}>
                {row.partners.map((partner) => {
                  const role = partner.isSupplier && !partner.isCustomer ? 'supplier' : 'customer';
                  const route = role === 'supplier' ? '/purchasing/suppliers' : '/sales/customers';
                  return (
                    <li key={partner.code}>
                      <span>
                        <Link href={`${route}/${encodeURIComponent(partner.code)}?role=${role}`}>
                          {partner.code}
                        </Link>
                      </span>
                      <span>{partner.name}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <RecordHistory objectId={row.code} objectType={terms.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
