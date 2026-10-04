import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { Attachments, readAttachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ExportIcon } from '@/components/print/export-menu';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { declarationChip } from '@domain/import-logistics';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as declarations from '@/server/services/customs-declarations';
import * as rates from '@/server/services/exchange-rates';
import * as recordNotes from '@/server/services/record-notes';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';
import { windowTone } from '../../../payables/window-tone';
import { attachToDeclaration, moveDeclaration, updateDeclaration } from '../actions';

/**
 * One customs declaration — REQ-LOG-001 item 8. The Purchase Invoice's
 * window: the declaration in boxes (what was declared, in its currency), its
 * four doors in the title bar from the draft on, and the next step at its
 * foot. Under the window, declared beside charged: the customs cost actually
 * booked on the import, which is the money — this record never is.
 */
export const dynamic = 'force-dynamic';

export default async function CustomsDeclarationPage({
  params,
  searchParams,
}: {
  params: Promise<{ declarationNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/logistics/customs-declarations')) notFound();
  const { declarationNo: raw } = await params;
  const declarationNo = decodeURIComponent(raw);
  const [t, pdT, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', declarations.PERMISSION_OBJECT)) {
    return <Denied object={page('customs_declarations')} />;
  }
  const mayEdit = can(principal, 'edit_draft', declarations.PERMISSION_OBJECT);
  const maySubmit = can(principal, 'submit', declarations.PERMISSION_OBJECT);
  const mayEnd = can(principal, 'reverse_cancel', declarations.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await declarations.viewByNo(tx, declarationNo);
      return {
        ...view,
        files: await readAttachments(tx, declarations.PERMISSION_OBJECT, view.declaration.id),
        notes: await recordNotes.listNotes(tx, { object: declarations.PERMISSION_OBJECT, recordId: view.declaration.id }),
        // Currencies and Rates' own list; a currency retired since the draft was written stays on offer for it.
        currencies: mayEdit
          ? (await rates.currencies(tx)).filter((row) => row.isActive || row.code === view.declaration.currency)
          : [],
      };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error) || (error as { code?: string }).code === 'CUSTOMS_DECLARATION_NOT_FOUND') return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { declaration, owner, pd, charged } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const amount = (value: string, currency = declaration.currency) => formatMoney(value, currency, locale as Locale);
  const ds = (status: string) => (t.has(`ds.${status}`) ? t(`ds.${status}`) : status);
  const ps = (code: string, name: string) => (locale !== 'en' && pdT.has(`ps.${code}`) ? pdT(`ps.${code}`) : name);
  const today = businessToday();
  const hidden = { declaration_no: declaration.declarationNo };
  const chip = declarationChip(declaration.status);
  const isDraft = declaration.status === 'draft';
  const difference = found.comparable
    ? toDecimalString(parseDecimal(found.declaredChargesTotal, MONEY_SCALE) - parseDecimal(charged.totalIqd, MONEY_SCALE), MONEY_SCALE)
    : null;
  // A form's default as typed: the stored decimal without its trailing zeros (never through a float).
  const plain = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

  const fields: DocumentField[] = [
    { label: t('declaration_no'), value: <bdi dir="ltr">{declaration.declarationNo}</bdi> },
    { label: t('status'), value: `${ds(declaration.status)} · ${day(declaration.statusDate)}`, status: windowTone(chip) },
    { label: t('customs_ref'), value: <bdi dir="ltr">{declaration.customsRef ?? '—'}</bdi> },
    { label: t('declaration_date'), value: <bdi dir="ltr">{day(declaration.declarationDate)}</bdi> },
    {
      label: t('import'),
      value: (
        <ProfileLink code={owner.payableNo} kind="import">
          {owner.payableNo}
          {owner.reference ? ` · ${owner.reference}` : ''}
        </ProfileLink>
      ),
    },
    { label: t('supplier'), value: <ProfileLink code={owner.supplierCode} kind="supplier" name={owner.supplierName} /> },
    {
      label: t('pd'),
      value: pd ? (
        <>
          <ProfileLink code={pd.pdNo} kind="pd" qualifier={{ year: pd.year }}>
            {pd.pdNo}
          </ProfileLink>{' '}
          <span className="muted">
            {ps(pd.statusCode, pd.statusName)} · {day(pd.statusDate)}
          </span>
        </>
      ) : (
        pdT('unlinked')
      ),
    },
    { label: t('hs_code'), value: <bdi dir="ltr">{declaration.hsCode ?? '—'}</bdi> },
    { label: t('currency'), value: <bdi dir="ltr">{declaration.currency}</bdi> },
    { label: t('declared_value'), value: <bdi dir="ltr">{amount(declaration.declaredValue)}</bdi> },
    { label: t('declared_duty'), value: <bdi dir="ltr">{amount(declaration.declaredDuty)}</bdi> },
    { label: t('declared_taxes'), value: <bdi dir="ltr">{amount(declaration.declaredTaxes)}</bdi> },
    { label: t('declared_fees'), value: <bdi dir="ltr">{amount(declaration.declaredFees)}</bdi> },
    { label: t('declared_total'), value: <bdi dir="ltr">{amount(found.declaredChargesTotal)}</bdi> },
    { label: t('raised_by'), value: <bdi dir="auto">{found.createdByName ?? '—'}</bdi> },
    ...(declaration.reason ? [{ label: t('reason'), value: <bdi dir="auto">{declaration.reason}</bdi>, status: 'rejected', wide: true }] : []),
    ...(declaration.note ? [{ label: t('note'), value: <bdi dir="auto">{declaration.note}</bdi>, wide: true }] : []),
  ];

  const moveForm = (to: string, label: string, options: { ref?: boolean; reason?: boolean } = {}) => (
    <NewRecordDialog buttonLabel={label} closeLabel={admin('close')} key={to} title={label}>
      <Form action={moveDeclaration}>
        <Hidden name="declaration_no" value={declaration.declarationNo} />
        <Hidden name="to" value={to} />
        <Grid>
          <Field defaultValue={today} id={`move-${to}-on`} label={t('on_date')} name="on" required type="date" />
          {options.ref ? (
            <Field defaultValue={declaration.customsRef ?? ''} hint={t('customs_ref_hint')} id={`move-${to}-ref`} label={t('customs_ref')} name="customs_ref" required={!declaration.customsRef} />
          ) : null}
        </Grid>
        {options.reason ? <Field id={`move-${to}-reason`} label={t('reason')} name="reason" required wide /> : null}
        <Field id={`move-${to}-note`} label={t('note')} name="note" wide />
        <SubmitRow>
          <Submit label={label} tone={options.reason ? 'danger' : 'primary'} />
        </SubmitRow>
      </Form>
    </NewRecordDialog>
  );

  return (
    <AdminPage
      back={{ href: '/logistics/customs-declarations', label: page('customs_declarations') }}
      tabs={<SectionTabs route="/logistics/customs-declarations" />}
      title={declaration.declarationNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {found.isFinal ? <p className={s.sapNote}>{t('final_note', { status: ds(declaration.status) })}</p> : null}

      <DocumentWindow
        titleActions={
          <>
            <ExportIcon exportKey="customs_declaration" id={declaration.declarationNo} title={`${t('document_type')} ${declaration.declarationNo}`} />
            <AttachmentsButton closeLabel={admin('close')} count={found.files.rows.length} label={admin('attachments.title')} title={admin('attachments.title')}>
              <Attachments
                action={attachToDeclaration}
                hidden={hidden}
                mayAttach={mayEdit && can(principal, 'create', 'attachment')}
                objectId={declaration.id}
                objectType={declarations.PERMISSION_OBJECT}
                preloaded={found.files}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={found.notes} object={declarations.PERMISSION_OBJECT} recordId={declaration.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={declaration.id} objectType={declarations.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        actions={
          <>
            {maySubmit && found.next.includes('submitted') ? moveForm('submitted', t('move_submitted')) : null}
            {maySubmit && found.next.includes('accepted') ? moveForm('accepted', t('move_accepted'), { ref: true }) : null}
            {maySubmit && found.next.includes('assessed') ? moveForm('assessed', t('move_assessed')) : null}
            {maySubmit && found.next.includes('cleared') ? moveForm('cleared', t('move_cleared')) : null}
            {mayEdit && isDraft ? (
              <NewRecordDialog buttonLabel={t('edit')} closeLabel={admin('close')} title={t('edit_title', { declarationNo: declaration.declarationNo })}>
                <Form action={updateDeclaration}>
                  <Hidden name="declaration_no" value={declaration.declarationNo} />
                  <Grid>
                    <Select
                      defaultValue={declaration.pdId ?? ''}
                      emptyLabel={t('pd_choice_none')}
                      label={t('pd')}
                      name="pd_id"
                      options={found.pdChoices.map((row) => ({ value: row.id, label: `${row.pdNo}${row.year ? ` / ${row.year}` : ''} · ${ps(row.statusCode, row.statusCode)}` }))}
                    />
                    <Field defaultValue={declaration.declarationDate} id="edit-date" label={t('declaration_date')} name="declaration_date" required type="date" />
                    <Field defaultValue={declaration.customsRef ?? ''} id="edit-ref" label={t('customs_ref')} name="customs_ref" />
                    <Field defaultValue={declaration.hsCode ?? ''} id="edit-hs" label={t('hs_code')} name="hs_code" />
                    <Select
                      defaultValue={declaration.currency}
                      label={t('currency')}
                      name="currency"
                      options={found.currencies.map((row) => ({ value: row.code, label: `${row.code} · ${row.name}` }))}
                      required
                    />
                    <Field defaultValue={plain(declaration.declaredValue)} id="edit-value" label={t('declared_value')} name="declared_value" />
                    <Field defaultValue={plain(declaration.declaredDuty)} id="edit-duty" label={t('declared_duty')} name="declared_duty" />
                    <Field defaultValue={plain(declaration.declaredTaxes)} id="edit-taxes" label={t('declared_taxes')} name="declared_taxes" />
                    <Field defaultValue={plain(declaration.declaredFees)} id="edit-fees" label={t('declared_fees')} name="declared_fees" />
                  </Grid>
                  <Field defaultValue={declaration.note ?? ''} id="edit-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEnd && found.next.includes('rejected') ? (
              <ReasonForm action={moveDeclaration} hidden={{ ...hidden, to: 'rejected' }} label={t('move_rejected')} reasonLabel={t('reason')} />
            ) : null}
            {mayEnd && found.next.includes('cancelled') ? (
              <ReasonForm action={moveDeclaration} hidden={{ ...hidden, to: 'cancelled' }} label={t('move_cancelled')} reasonLabel={t('move_cancelled')} />
            ) : null}
            <Link className="action" href={`/payables/${encodeURIComponent(owner.payableNo)}`}>
              {t('open_import')}
            </Link>
          </>
        }
        documentType={t('document_type')}
        fields={fields}
        id="declaration-document"
        linesCount={charged.rows.length}
        linesTitle={t('charged_title')}
        number={declaration.declarationNo}
        totals={[
          { label: t('declared_total'), value: amount(found.declaredChargesTotal) },
          { label: t('charged_total'), value: amount(charged.totalIqd, 'IQD') },
          ...(difference !== null ? [{ label: t('difference'), value: amount(difference, 'IQD') }] : []),
        ]}
      >
        <p className={s.sapNote}>{found.comparable ? t('charged_note') : t('not_comparable', { currency: declaration.currency })}</p>
        <table aria-labelledby="declaration-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('col_source')}</th>
              <th scope="col">{t('col_charged_on')}</th>
              <th className={s.sapNum} scope="col">
                {t('col_amount_iqd')}
              </th>
              <th scope="col">{t('col_state')}</th>
              <th scope="col">{t('note')}</th>
            </tr>
          </thead>
          <tbody>
            {charged.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {t('no_charges')}
                </td>
              </tr>
            ) : null}
            {charged.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <bdi dir="ltr">
                    {row.sourceType} {row.sourceNo ?? ''}
                  </bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(businessDateOf(row.createdAt))}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(row.amountIqd, 'IQD')}</bdi>
                </td>
                <td>
                  <span className={`status status--${row.lockId ? 'settled' : 'submitted'}`} data-status={row.lockId ? 'settled' : 'submitted'}>
                    {row.lockId ? t('state_locked') : t('state_unlocked')}
                  </span>
                </td>
                <td>
                  <bdi dir="auto">{row.note ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
