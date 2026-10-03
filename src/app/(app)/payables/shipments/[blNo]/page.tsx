import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Attachments, readAttachments } from '@/components/admin/attachments';
import { ContainerRowsGrid } from '@/components/admin/container-rows-grid';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ExportIcon } from '@/components/print/export-menu';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as shipments from '@/server/services/shipments';
import { SIZE_TYPES } from '@/server/domain/shipments';
import { addContainersAction, attachToBl, blStatusAction, cancelBlAction, updateBlAction } from '../actions';
import { containerChip } from '../../containers/status';
import { businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';

/**
 * One B/L — REQ-AP-001 §17.1, §21.9, rewritten with IMPROVEMENT-002.
 *
 * The Purchase Invoice's window: the B/L in boxes, its containers as the grid
 * (size/type and seal of each, what each plans and received, "X of Y" in the
 * foot). The paperwork, the history and the copies are the three doors in the
 * title bar, as on the Import Application. At the foot, what is done to the
 * whole B/L: add containers (a row each, what each carries of every model),
 * move every container still at sea to a stage, correct the B/L's boxes, or
 * cancel it with a reason while nothing on it has been received.
 */
export const dynamic = 'force-dynamic';

const BULK = ['on_sea', 'at_port', 'customs_cleared'] as const;

export default async function BlPage({
  params,
  searchParams,
}: {
  params: Promise<{ blNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/shipments')) notFound();
  const { blNo: raw } = await params;
  const blNo = decodeURIComponent(raw);
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', shipments.BL_OBJECT)) {
    return <Denied object={page('shipments')} />;
  }
  const mayEdit = can(principal, 'edit_draft', shipments.BL_OBJECT);
  const mayCancel = can(principal, 'reverse_cancel', shipments.BL_OBJECT);
  const mayMove = can(principal, 'edit_draft', shipments.CONTAINER_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await shipments.viewBl(tx, blNo);
      const open = !view.bl.cancelledAt && !view.owner.cancelledAt && !view.owner.closedAt;
      return {
        ...view,
        statuses: await shipments.statuses(tx),
        files: await readAttachments(tx, shipments.BL_OBJECT, view.bl.id),
        models: mayEdit && open ? await shipments.modelsToShip(tx, view.owner.id) : [],
        ports: mayEdit && open ? await shipments.ports(tx) : [],
      };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { bl, owner, containers, progress } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const today = businessToday();
  const cs = (code: string, name: string) => (locale !== 'en' && t.has(`cs.${code}`) ? t(`cs.${code}`) : name);
  const statusName = (code: string) => cs(code, found.statuses.find((row) => row.code === code)?.name ?? code);
  const open = !bl.cancelledAt && !owner.cancelledAt && !owner.closedAt;
  const anyReceived = containers.some((row) => Boolean(row.receivedOn));
  const amount = (value: string) => formatQuantity(value, locale as Locale);

  const fields: DocumentField[] = [
    { label: t('bl_no'), value: <bdi dir="ltr">{bl.blNo}</bdi> },
    bl.cancelledAt
      ? { label: t('status'), value: t('cancelled'), status: 'cancelled' }
      : {
          label: t('received_x_of_y'),
          value: t('x_of_y', { received: progress.received, total: progress.total }),
          status: progress.all ? 'posted' : progress.received > 0 ? 'submitted' : 'draft',
        },
    {
      label: t('import'),
      value: (
        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(owner.payableNo)}`}>
          <bdi dir="ltr">
            {owner.payableNo} · {owner.supplierReference}
          </bdi>
        </Link>
      ),
    },
    { label: t('supplier'), value: <bdi dir="auto">{found.supplier ? `${found.supplier.name} (${found.supplier.code})` : '—'}</bdi> },
    { label: t('bl_date'), value: <bdi dir="ltr">{day(bl.blDate)}</bdi> },
    { label: t('eta'), value: <bdi dir="ltr">{day(bl.eta)}</bdi> },
    { label: t('vessel'), value: <bdi dir="auto">{[bl.vessel, bl.voyage].filter(Boolean).join(' / ') || '—'}</bdi> },
    { label: t('shipping_line'), value: <bdi dir="auto">{bl.shippingLine ?? '—'}</bdi> },
    { label: t('port_of_loading'), value: <bdi dir="auto">{bl.portOfLoading ?? '—'}</bdi> },
    { label: t('port_of_discharge'), value: <bdi dir="auto">{found.port?.name ?? '—'}</bdi> },
    ...(bl.cancelledAt ? [{ label: t('cancel_reason'), value: <bdi dir="auto">{bl.cancelReason ?? '—'}</bdi> }] : []),
  ];

  const gridLabels = {
    containerNo: t('container_no'),
    sizeType: t('size_type'),
    sealNo: t('seal_no'),
    remove: t('remove_container'),
    left: t('grid_left'),
    typed: t('grid_typed'),
    divided: t('grid_divided'),
    tooMany: t('grid_too_many', { left: '{left}' }),
    notANumber: t('grid_not_a_number'),
    checkDigit: t('grid_check_digit', { digit: '{digit}' }),
  };

  return (
    <AdminPage
      back={{ href: '/payables/shipments', label: page('shipments') }}
      tabs={<SectionTabs route="/payables/shipments" />}
      title={`B/L ${bl.blNo}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        titleActions={
          <>
            <AttachmentsButton closeLabel={admin('close')} count={found.files.rows.length} label={admin('attachments.title')} title={admin('attachments.title')}>
              <Attachments
                action={attachToBl}
                hidden={{ bl_no: bl.blNo }}
                mayAttach={mayEdit && can(principal, 'create', 'attachment')}
                objectId={bl.id}
                objectType={shipments.BL_OBJECT}
                preloaded={found.files}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={bl.id} objectType={shipments.BL_OBJECT} />
            </HistoryButton>
            <ExportIcon exportKey="bill_of_lading" id={bl.blNo} title={`B/L ${bl.blNo}`} />
          </>
        }
        actions={
          <>
            {mayMove && open ? (
              <NewRecordDialog buttonLabel={t('move_all')} closeLabel={admin('close')} title={t('move_all')}>
                <p className="muted">{t('move_all_note')}</p>
                <Form action={blStatusAction}>
                  <Hidden name="bl_no" value={bl.blNo} />
                  <Grid>
                    <Select
                      label={t('stage')}
                      name="status_code"
                      options={BULK.map((code) => ({ value: code, label: statusName(code) }))}
                      required
                    />
                    <Field defaultValue={today} label={t('stage_date')} name="status_date" required type="date" />
                  </Grid>
                  <Field id="bl-status-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('move_all')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && open ? (
              <NewRecordDialog buttonLabel={t('add_containers')} closeLabel={admin('close')} title={t('add_containers')} wide>
                <Form action={addContainersAction}>
                  <Hidden name="bl_no" value={bl.blNo} />
                  <p className={s.sapGridCaption}>{t('containers_caption')}</p>
                  <ContainerRowsGrid
                    labels={gridLabels}
                    models={found.models.map((model) => ({ key: model.key, label: model.itemCode ?? model.description, unit: model.uomCode, left: model.left }))}
                    sizeTypes={SIZE_TYPES.map((type) => ({ code: type.code, label: `${type.code} (${type.iso})` }))}
                  />
                  <SubmitRow>
                    <Submit label={t('add_containers')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && open && !anyReceived ? (
              <NewRecordDialog buttonLabel={t('edit_bl')} closeLabel={admin('close')} title={t('edit_bl_title', { blNo: bl.blNo })}>
                <Form action={updateBlAction}>
                  <Hidden name="bl_no" value={bl.blNo} />
                  <Grid>
                    <Field defaultValue={bl.blNo} id="bl-edit-no" label={t('bl_no')} name="new_bl_no" required />
                    <Field defaultValue={bl.blDate} id="bl-edit-date" label={t('bl_date')} name="bl_date" required type="date" />
                    <Field defaultValue={bl.eta ?? ''} hint={t('eta_hint')} id="bl-edit-eta" label={t('eta')} name="eta" required type="date" />
                    <Field defaultValue={bl.vessel ?? ''} id="bl-edit-vessel" label={t('vessel')} name="vessel" />
                    <Field defaultValue={bl.voyage ?? ''} id="bl-edit-voyage" label={t('voyage')} name="voyage" />
                    <Field defaultValue={bl.shippingLine ?? ''} id="bl-edit-line" label={t('shipping_line')} name="shipping_line" />
                    <Field defaultValue={bl.portOfLoading ?? ''} id="bl-edit-pol" label={t('port_of_loading')} name="port_of_loading" />
                    <Select
                      defaultValue={bl.portOfDischargeCode ?? ''}
                      emptyLabel="—"
                      label={t('port_of_discharge')}
                      name="port_of_discharge"
                      options={found.ports.map((port) => ({ value: port.code, label: port.name }))}
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save_bl')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayCancel && open && !anyReceived ? (
              <ReasonForm action={cancelBlAction} hidden={{ bl_no: bl.blNo }} label={t('cancel_bl')} reasonLabel={t('cancel_bl_reason')} />
            ) : null}
            <Link className="action" href={`/payables/${encodeURIComponent(owner.payableNo)}`}>
              {t('import_tracking')}
            </Link>
          </>
        }
        documentType={t('bl')}
        fields={fields}
        id="bl-document"
        linesCount={containers.length}
        linesTitle={t('containers')}
        number={bl.blNo}
        totals={[{ label: t('received_x_of_y'), value: t('x_of_y', { received: progress.received, total: progress.total }) }]}
      >
        <table aria-labelledby="bl-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('container_no')}</th>
              <th scope="col">{t('size_type')}</th>
              <th scope="col">{t('seal_no')}</th>
              <th scope="col">{t('eta')}</th>
              <th className={s.sapNum} scope="col">
                {t('planned')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('received')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('short')}
              </th>
              <th scope="col">{t('warehouse')}</th>
              <th scope="col">{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {containers.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={9}>
                  {t('no_containers')}
                </td>
              </tr>
            ) : null}
            {containers.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link className={s.sapLink} href={`/payables/containers/${encodeURIComponent(row.containerNo)}${row.receivedOn || row.cancelledAt ? `?id=${row.id}` : ''}`}>
                    <bdi dir="ltr">{row.containerNo}</bdi>
                  </Link>
                </td>
                <td>
                  <bdi dir="ltr">{row.sizeType ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.sealNo ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(row.eta)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(row.planned)}</bdi>
                  {row.linesEstimated ? <div className="muted">{t('estimated')}</div> : null}
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.receivedOn ? amount(row.received) : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.receivedOn ? amount(row.short) : '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.warehouseCode ?? '—'}</bdi>
                </td>
                <td>
                  {row.cancelledAt ? (
                    <span className="status status--cancelled" data-status="cancelled">
                      {t('cancelled')}
                    </span>
                  ) : (
                    <span className={`status status--${containerChip(row)}`} data-status={containerChip(row)}>
                      {cs(row.statusCode, row.statusName)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
