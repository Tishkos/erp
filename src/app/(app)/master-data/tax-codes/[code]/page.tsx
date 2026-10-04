import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton, AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { Attachments } from '@/components/admin/attachments';
import * as attachmentsService from '@/server/services/attachments';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { AdminNotFoundError } from '@/server/services/administration';
import { businessToday } from '@/server/domain/business-date';
import { glAccountHref } from '@/server/domain/accounting-links';
import * as chart from '@/server/services/chart-of-accounts';
import * as taxCodes from '@/server/services/tax-codes';
import { addTaxRate, attachToTaxCode, setTaxCodeActive, updateTaxCode } from '../actions';

/**
 * One Tax Code — REQ-ACC-001 Part D-5.
 *
 * The record model's window: the code's boxes (treatment, recoverability,
 * its account — a link to the G/L account), its rates as the lines, newest
 * first, and at the foot what may be done: change the name, treatment or
 * account; add a rate from a date (a rate is never edited); deactivate with a
 * reason. The four doors in the title bar.
 */
export const dynamic = 'force-dynamic';

export default async function TaxCodePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/tax-codes')) notFound();
  const { code: raw } = await params;
  const code = decodeURIComponent(raw);

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.tax_codes'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', taxCodes.PERMISSION_OBJECT)) {
    return <Denied object={page('tax_codes')} />;
  }
  const mayEdit = can(principal, 'configure', taxCodes.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      return {
        row: await taxCodes.detail(tx, code),
        accounts: mayEdit ? (await chart.postableAccounts(tx)).filter((account) => !account.controlAccount) : [],
        today: await taxCodes.rateOn(tx, code, businessToday()),
        attached: (await attachmentsService.currentFor(tx, taxCodes.PERMISSION_OBJECT, code)).length,
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { row, accounts, today, attached } = found;
  const percent = (rate: string | null) => (rate === null ? '—' : `${rate.replace(/\.?0+$/, '')}%`);
  const hidden = { code: row.code };

  const fields: DocumentField[] = [
    { label: t('code'), value: <bdi dir="ltr">{row.code}</bdi> },
    { label: t('status'), value: row.active ? admin('active') : status('cancelled'), status: row.active ? 'posted' : 'cancelled' },
    { label: t('name'), value: <bdi dir="auto">{row.name}</bdi> },
    { label: t('direction'), value: t(`direction_${row.direction}`) },
    { label: t('recoverable'), value: row.isRecoverable ? t('recoverable_yes') : t('recoverable_no') },
    {
      label: t('account'),
      value: (
        <Link className={s.sapLink} href={glAccountHref(row.account.code)}>
          <bdi dir="auto">{`${row.account.code} · ${row.account.name}`}</bdi>
        </Link>
      ),
    },
    { label: t('current_rate'), value: <bdi dir="ltr">{percent(today)}</bdi> },
    { label: t('created_by'), value: <bdi dir="auto">{row.createdByName ?? '—'}</bdi> },
  ];

  return (
    <AdminPage
      back={{ href: '/master-data/tax-codes', label: page('tax_codes') }}
      tabs={<SectionTabs route="/master-data/tax-codes" />}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          mayEdit ? (
            <>
              <NewRecordDialog buttonLabel={t('add_rate')} closeLabel={admin('close')} title={t('add_rate')}>
                <p className="muted">{t('add_rate_note')}</p>
                <Form action={addTaxRate}>
                  <Hidden name="code" value={row.code} />
                  <Grid>
                    <Field hint={t('rate_hint')} label={t('rate')} name="rate" required />
                    <Field defaultValue={businessToday()} label={t('effective_from')} name="effective_from" required type="date" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('add_rate')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
              <NewRecordDialog buttonLabel={t('edit')} closeLabel={admin('close')} title={t('edit')}>
                <Form action={updateTaxCode}>
                  <Hidden name="code" value={row.code} />
                  <Grid>
                    <Field defaultValue={row.name} label={t('name')} name="name" required />
                    <Select
                      defaultValue={row.direction}
                      label={t('direction')}
                      name="direction"
                      options={taxCodes.TAX_DIRECTIONS.map((key) => ({ value: key, label: t(`direction_${key}`) }))}
                      required
                    />
                    <Select
                      defaultValue={row.isRecoverable ? 'yes' : 'no'}
                      label={t('recoverable')}
                      name="recoverable"
                      options={[
                        { value: 'yes', label: t('recoverable_yes') },
                        { value: 'no', label: t('recoverable_no') },
                      ]}
                      required
                    />
                    <Select
                      defaultValue={row.accountId}
                      label={t('account')}
                      name="account_id"
                      options={[
                        ...(accounts.some((account) => account.id === row.accountId)
                          ? []
                          : [{ value: row.account.id, label: `${row.account.code} · ${row.account.name}` }]),
                        ...accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` })),
                      ]}
                      required
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={admin('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
              {row.active ? (
                <ReasonForm action={setTaxCodeActive} hidden={hidden} label={admin('deactivate')} reasonLabel={t('deactivate_reason')} />
              ) : (
                <ActionButton action={setTaxCodeActive} hidden={{ ...hidden, active: '1' }} label={admin('reactivate')} small={false} tone="primary" />
              )}
            </>
          ) : null
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock. */}
            <ExportIcon exportKey="tax_code" id={row.code} title={`${t('document_type')} ${row.code}`} />
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attached}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToTaxCode}
                hidden={hidden}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={row.code}
                objectType={taxCodes.PERMISSION_OBJECT}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={row.code} objectType={taxCodes.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={t('document_type')}
        fields={fields}
        id="tax-code-document"
        linesCount={row.rates.length}
        linesTitle={t('rates')}
        number={row.code}
        totals={[{ label: t('current_rate'), value: percent(today) }]}
      >
        <table aria-labelledby="tax-code-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('effective_from')}</th>
              <th className={s.sapNum} scope="col">
                {t('rate')}
              </th>
              <th scope="col">{t('added_by')}</th>
              <th scope="col">{t('added_at')}</th>
            </tr>
          </thead>
          <tbody>
            {row.rates.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {t('no_rates')}
                </td>
              </tr>
            ) : null}
            {row.rates.map((rate) => (
              <tr key={rate.id}>
                <td>
                  <bdi dir="ltr">{formatBusinessDate(rate.effectiveFrom, locale as Locale)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{percent(rate.ratePercent)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{rate.createdBy ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{formatTimestamp(rate.createdAt.toISOString(), locale as Locale)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
