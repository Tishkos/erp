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
import { Attachments, readAttachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { SectionTabs } from '@/components/admin/section-tabs';
import { ExportIcon } from '@/components/print/export-menu';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as customs from '@/server/services/customs-pd';
import * as declarations from '@/server/services/customs-declarations';
import * as views from '@/server/services/logistics-views';
import * as recordNotes from '@/server/services/record-notes';
import { declarationChip } from '@domain/import-logistics';
import { attachToPd, changePdStatus, linkPd, reRegisterPd } from '../actions';
import { pdChip } from '../status';
import { containerChip } from '../../containers/status';
import { windowTone } from '../../window-tone';
import { STATUS_CHIP, statusKey } from '../../payment-applications/status';
import { businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';

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

  const [t, pa, lg, sh, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin.payment_applications'),
    getTranslations('admin.logistics'),
    getTranslations('admin.shipments'),
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
        files: await readAttachments(tx, customs.PERMISSION_OBJECT, view.pd.id),
        notes: await recordNotes.listNotes(tx, { object: customs.PERMISSION_OBJECT, recordId: view.pd.id }),
        // REQ-LOG-001 item 7 — the import's B/Ls and containers, and the declarations against this PD.
        shipping: view.pd.payableId ? await views.shippingForImport(tx, view.pd.payableId) : [],
        declarations: await declarations.listFor(tx, { pdId: view.pd.id }),
      };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { pd, status } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);

  const today = businessToday();
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
        <ProfileLink code={found.owner.payableNo} kind="import">
          {found.owner.payableNo} · {found.owner.reference}
        </ProfileLink>
      ) : (
        t('unlinked')
      ),
    },
    {
      label: t('supplier'),
      value: found.owner ? <ProfileLink code={found.owner.supplierCode} dir="auto" kind="supplier" name={found.owner.supplierName} /> : '—',
    },
    {
      label: t('bank'),
      value: found.bank ? (
        <ProfileLink code={found.bank.code} dir="auto" kind="bank">
          {found.bank.name}
          {pd.bankSwift ? ` · ${pd.bankSwift}` : ''}
        </ProfileLink>
      ) : (
        '—'
      ),
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
        <ProfileLink code={found.supersedes.pdNo} kind="pd" qualifier={{ year: found.supersedes.year }}>
          {found.supersedes.pdNo}
        </ProfileLink>
      ) : (
        '—'
      ),
    },
    {
      label: t('superseded_by'),
      value: found.supersededBy ? (
        <ProfileLink code={found.supersededBy.pdNo} kind="pd" qualifier={{ year: found.supersededBy.year }}>
          {found.supersededBy.pdNo}
        </ProfileLink>
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
              <ProfileLink code={row.applicationNo} kind="payment_application">
                {row.applicationNo}
              </ProfileLink>{' '}
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
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the four doors in the standing order (2026-10-04). */}
            <ExportIcon exportKey="customs_pd" id={pd.pdNo} title={`PD ${pd.pdNo}`} />
            <AttachmentsButton closeLabel={admin('close')} count={found.files.rows.length} label={admin('attachments.title')} title={admin('attachments.title')}>
              <Attachments
                action={attachToPd}
                hidden={hidden}
                mayAttach={mayEdit && can(principal, 'create', 'attachment')}
                objectId={pd.id}
                objectType={customs.PERMISSION_OBJECT}
                preloaded={found.files}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={found.notes} object={customs.PERMISSION_OBJECT} recordId={pd.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={pd.id} objectType={customs.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
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
          </>
        }
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

      {/* ── REQ-LOG-001 item 7 — the import's B/Ls and containers, with customs and clearance per container ── */}
      {found.owner ? (
        <section aria-labelledby="pd-shipping-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="pd-shipping-title">
              <span>{lg('pd_shipping_title')}</span>
              <span className={s.sapTitleMeta}>
                {lg('pd_shipping_meta', {
                  bls: new Set(found.shipping.map((row) => row.blId)).size,
                  containers: found.shipping.filter((row) => row.id && !row.cancelled).length,
                })}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="pd-shipping-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{sh('bl_no')}</th>
                    <th scope="col">{sh('container_no')}</th>
                    <th scope="col">{sh('status')}</th>
                    <th scope="col">{sh('eta')}</th>
                    <th scope="col">{sh('arrived_port_on')}</th>
                    <th scope="col">{sh('customs_cleared_on')}</th>
                    <th scope="col">{sh('port_file_sent_on')}</th>
                    <th scope="col">{sh('received_on')}</th>
                    <th scope="col">{sh('warehouse')}</th>
                  </tr>
                </thead>
                <tbody>
                  {found.shipping.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={9}>
                        {lg('pd_no_shipping')}
                      </td>
                    </tr>
                  ) : null}
                  {found.shipping.map((row) => (
                    <tr key={row.id ?? row.blId}>
                      <td>
                        <ProfileLink code={row.blNo} kind="bl">
                          {row.blNo}
                        </ProfileLink>
                        {row.blCancelled ? <div className="muted">{sh('cancelled')}</div> : null}
                      </td>
                      <td>
                        {row.containerNo ? (
                          <ProfileLink code={row.containerNo} kind="container" qualifier={row.receivedOn || row.cancelled ? { id: row.id } : {}}>
                            {row.containerNo}
                          </ProfileLink>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {row.statusCode ? (
                          row.cancelled ? (
                            <span className="status status--cancelled" data-status="cancelled">
                              {sh('cancelled')}
                            </span>
                          ) : (
                            <span className={`status status--${containerChip({ statusCode: row.statusCode })}`} data-status={containerChip({ statusCode: row.statusCode })}>
                              {locale !== 'en' && sh.has(`cs.${row.statusCode}`) ? sh(`cs.${row.statusCode}`) : row.statusName}
                            </span>
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.eta ?? row.blEta)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.arrivedPortOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.customsClearedOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.portFileSentOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.receivedOn)}</bdi>
                      </td>
                      <td>
                        <ProfileLink code={row.warehouseCode} kind="warehouse">
                          {row.warehouseCode ?? '—'}
                        </ProfileLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── The declarations lodged against this PD (REQ-LOG-001 item 8) ── */}
      <section aria-labelledby="pd-declarations-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pd-declarations-title">
            <span>{lg('pd_declarations_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: found.declarations.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="pd-declarations-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{lg('declaration_no')}</th>
                  <th scope="col">{lg('customs_ref')}</th>
                  <th scope="col">{lg('declaration_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {lg('declared_value')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {lg('declared_duty')}
                  </th>
                  <th scope="col">{lg('status')}</th>
                </tr>
              </thead>
              <tbody>
                {found.declarations.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {lg('none_declarations')}
                    </td>
                  </tr>
                ) : null}
                {found.declarations.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/logistics/customs-declarations/${encodeURIComponent(row.declarationNo)}`}>
                        <bdi dir="ltr">{row.declarationNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.customsRef ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.declarationDate)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.declaredValue, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.declaredDuty, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${declarationChip(row.status)}`} data-status={declarationChip(row.status)}>
                        {lg.has(`ds.${row.status}`) ? lg(`ds.${row.status}`) : row.status}
                      </span>
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
