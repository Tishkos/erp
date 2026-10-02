import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Hidden,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as customs from '@/server/services/customs-pd';
import { addPdNote, attachToPd, changePdStatus, linkPd, reRegisterPd } from '../actions';
import { pdChip } from '../status';
import { windowTone } from '../../window-tone';
import { STATUS_CHIP, statusKey } from '../../payment-applications/status';

/**
 * One PD — REQ-AP-001 §21.8. The Purchase Invoice's window: the registration
 * in boxes, the status history as its grid (every status it has had, when,
 * from where), and the next move at its foot — change status, note, or, for a
 * rejected or expired PD, re-register.
 */
export const dynamic = 'force-dynamic';

export default async function PdPage({
  params,
  searchParams,
}: {
  params: Promise<{ pdNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/pd')) notFound();
  const { pdNo: raw } = await params;
  const pdNo = decodeURIComponent(raw);
  const query = await searchParams;
  const year = Number(typeof query.year === 'string' ? query.year : '') || null;

  const [t, pa, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin.payment_applications'),
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
  const mayEdit = can(principal, 'edit_draft', customs.PERMISSION_OBJECT);
  const mayCreate = can(principal, 'create', customs.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await customs.viewByNo(tx, pdNo, year);
      return {
        ...view,
        statuses: await customs.statuses(tx),
        bankRows: await banks.listActive(tx),
        imports: !view.owner && mayEdit ? await customs.importChoices(tx) : [],
      };
    } catch {
      return null;
    }
  });
  if (!found) notFound();
  const { pd, status } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);

  const today = new Date().toISOString().slice(0, 10);
  const hidden = { pd_no: pd.pdNo, year: String(pd.registrationYear ?? '') };
  const chip = pdChip({ ...status, statusCode: pd.statusCode });
  const recordHref = (no: string, y: number | null) =>
    `/payables/pd/${encodeURIComponent(no)}${y ? `?year=${y}` : ''}`;

  const fields: DocumentField[] = [
    { label: t('pd_no'), value: <bdi dir="ltr">{pd.pdNo}</bdi> },
    { label: t('status'), value: `${ps(pd.statusCode, status.name)} · ${day(pd.statusDate)}`, status: windowTone(chip) },
    {
      label: t('import'),
      value: found.owner ? (
        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(found.owner.payableNo)}`}>
          <bdi dir="ltr">
            {found.owner.payableNo} · {found.owner.reference}
          </bdi>
        </Link>
      ) : (
        t('unlinked')
      ),
    },
    {
      label: t('supplier'),
      value: <bdi dir="auto">{found.owner ? `${found.owner.supplierName} (${found.owner.supplierCode})` : '—'}</bdi>,
    },
    {
      label: t('bank'),
      value: <bdi dir="auto">{found.bank ? `${found.bank.name}${pd.bankSwift ? ` · ${pd.bankSwift}` : ''}` : '—'}</bdi>,
    },
    { label: t('registered'), value: <bdi dir="ltr">{day(pd.registrationDate)}</bdi> },
    { label: t('expires'), value: <bdi dir="ltr">{day(pd.expiryDate)}</bdi> },
    {
      label: t('days_left'),
      value: status.isTerminal ? '—' : String(found.daysLeft),
      ...(!status.isTerminal && found.daysLeft <= 45 ? { status: 'rejected' } : {}),
    },
    {
      label: t('pays'),
      value: status.allowsPayment && found.daysLeft >= 0 ? t('pays_yes') : t('pays_no'),
      status: status.allowsPayment && found.daysLeft >= 0 ? 'approved' : 'draft',
    },
    {
      label: t('supersedes'),
      value: found.supersedes ? (
        <Link className={s.sapLink} href={recordHref(found.supersedes.pdNo, found.supersedes.year)}>
          <bdi dir="ltr">{found.supersedes.pdNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    {
      label: t('superseded_by'),
      value: found.supersededBy ? (
        <Link className={s.sapLink} href={recordHref(found.supersededBy.pdNo, found.supersededBy.year)}>
          <bdi dir="ltr">{found.supersededBy.pdNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    {
      label: t('paid_against'),
      value: found.paidAgainst.length ? (
        <>
          {found.paidAgainst.map((row, index) => (
            <span key={row.applicationNo}>
              {index > 0 ? ' · ' : ''}
              <Link className={s.sapLink} href={`/payables/payment-applications/${encodeURIComponent(row.applicationNo)}`}>
                <bdi dir="ltr">{row.applicationNo}</bdi>
              </Link>{' '}
              <span className={`status status--${STATUS_CHIP[row.status] ?? 'draft'}`} data-status={STATUS_CHIP[row.status] ?? 'draft'}>
                {pa(statusKey(row.status, ''))}
              </span>{' '}
              <bdi dir="ltr">{formatMoney(row.amountTxn, row.currency, locale as Locale)}</bdi>
            </span>
          ))}
        </>
      ) : (
        '—'
      ),
      wide: true,
    },
    ...(pd.lastNote ? [{ label: t('note'), value: <bdi dir="auto">{pd.lastNote}</bdi>, wide: true }] : []),
  ];

  const nextStatuses = found.statuses.filter((row) => row.active && row.code !== pd.statusCode);

  return (
    <AdminPage
      back={{ href: '/payables/pd', label: page('pds') }}
      tabs={<SectionTabs route="/payables/pd" />}
      title={`PD ${pd.pdNo}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {found.otherYears.length > 0 ? (
        <p className={s.sapNote}>
          {t('other_years')}{' '}
          {found.otherYears.map((y) => (
            <Link className={s.sapLink} href={recordHref(pd.pdNo, y)} key={y}>
              {y}{' '}
            </Link>
          ))}
        </p>
      ) : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit && !status.isTerminal ? (
              <NewRecordDialog buttonLabel={t('change_status')} closeLabel={admin('close')} title={t('change_status')}>
                <Form action={changePdStatus}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Grid>
                    <Select
                      label={t('new_status')}
                      name="status_code"
                      options={nextStatuses.map((row) => ({ value: row.code, label: ps(row.code, row.name) }))}
                      required
                    />
                    <Field defaultValue={today} label={t('effective_date')} name="effective_date" required type="date" />
                    <Select
                      defaultValue="user"
                      label={t('source')}
                      name="source"
                      options={[
                        { value: 'user', label: t('source_user') },
                        { value: 'asycuda_screenshot', label: t('source_asycuda_screenshot') },
                      ]}
                    />
                  </Grid>
                  <Field id="pd-status-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('change_status')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayCreate && found.mayReRegister ? (
              <NewRecordDialog buttonLabel={t('reregister')} closeLabel={admin('close')} title={t('reregister')}>
                <p className="muted">{t('reregister_note', { pdNo: pd.pdNo })}</p>
                <Form action={reRegisterPd}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Grid>
                    <Field label={t('pd_no')} name="new_pd_no" required />
                    <Field defaultValue={today} label={t('registered')} name="registration_date" required type="date" />
                    <Field label={t('expires')} name="expiry_date" required type="date" />
                    <Select
                      defaultValue={pd.bankCode ?? ''}
                      emptyLabel="—"
                      label={t('bank')}
                      name="bank_code"
                      options={found.bankRows.map((b) => ({ value: b.code, label: b.name }))}
                    />
                  </Grid>
                  <Field id="pd-reregister-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('reregister')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {!found.owner && mayEdit ? (
              <NewRecordDialog buttonLabel={t('link')} closeLabel={admin('close')} title={t('link')}>
                <p className="muted">{t('link_note', { pdNo: pd.pdNo })}</p>
                <Form action={linkPd}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Grid>
                    <Select
                      label={t('import')}
                      name="payable_id"
                      options={found.imports.map((row) => ({
                        value: row.id,
                        label: `${row.payableNo} · ${row.reference} · ${row.supplierName}`,
                      }))}
                      required
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('link')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {found.owner ? (
              <Link className="action" href={`/payables/${encodeURIComponent(found.owner.payableNo)}`}>
                {pa('import_tracking')}
              </Link>
            ) : null}
            {mayEdit ? (
              <form action={addPdNote} className={s.inline}>
                {Object.entries(hidden).map(([name, value]) => (
                  <Hidden key={name} name={name} value={value} />
                ))}
                <Field id="pd-note" label={t('add_note')} name="note" required />
                <Submit label={t('add_note')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={admin('history')}
        documentType={t('document_type')}
        fields={fields}
        id="pd-document"
        linesCount={found.history.length}
        linesTitle={t('history')}
        number={pd.pdNo}
      >
        <table aria-labelledby="pd-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('status')}</th>
              <th scope="col">{t('effective_date')}</th>
              <th scope="col">{t('source')}</th>
              <th scope="col">{t('note')}</th>
              <th scope="col">{t('recorded_by')}</th>
            </tr>
          </thead>
          <tbody>
            {found.history.map((row) => (
              <tr key={row.id}>
                <td>{ps(row.statusCode, found.statusName(row.statusCode))}</td>
                <td>
                  <bdi dir="ltr">{day(row.effectiveDate)}</bdi>
                </td>
                <td>{t(`source_${row.source}`)}</td>
                <td>
                  <bdi dir="auto">{row.note ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{row.recordedBy ?? t('source_sweep')}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-label={t('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToPd}
            hidden={hidden}
            mayAttach={mayEdit}
            objectId={pd.id}
            objectType={customs.PERMISSION_OBJECT}
          />
        </div>
      </section>
      <RecordHistory objectId={pd.id} objectType={customs.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
