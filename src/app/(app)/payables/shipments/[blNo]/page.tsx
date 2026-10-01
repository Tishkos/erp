import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as shipments from '@/server/services/shipments';
import { addContainersAction, blStatusAction } from '../actions';
import { containerChip } from '../../containers/status';

/**
 * One B/L — REQ-AP-001 §17.1, §21.9. The Purchase Invoice's window: the B/L
 * in boxes, its containers as the grid ("X of Y received" in the foot), and
 * at the foot the two things done to a whole B/L — add containers, and move
 * every container still at sea to the stage the vessel reached.
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
  const mayMove = can(principal, 'edit_draft', shipments.CONTAINER_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      return { ...(await shipments.viewBl(tx, blNo)), statuses: await shipments.statuses(tx) };
    } catch {
      return null;
    }
  });
  if (!found) notFound();
  const { bl, owner, containers, progress } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const today = new Date().toISOString().slice(0, 10);
  const cs = (code: string, name: string) => (locale !== 'en' && t.has(`cs.${code}`) ? t(`cs.${code}`) : name);
  const statusName = (code: string) => cs(code, found.statuses.find((row) => row.code === code)?.name ?? code);

  const fields: DocumentField[] = [
    { label: t('bl_no'), value: <bdi dir="ltr">{bl.blNo}</bdi> },
    {
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
  ];

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
        actions={
          <>
            {mayMove && !bl.cancelledAt ? (
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
            {mayEdit && !bl.cancelledAt ? (
              <NewRecordDialog buttonLabel={t('add_containers')} closeLabel={admin('close')} title={t('add_containers')}>
                <Form action={addContainersAction}>
                  <Hidden name="bl_no" value={bl.blNo} />
                  <Field hint={t('containers_hint')} label={t('containers')} name="containers" required type="textarea" wide />
                  <Field hint={t('size_type_hint')} label={t('size_type')} name="size_type" />
                  <SubmitRow>
                    <Submit label={t('add_containers')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            <Link className="action" href={`/payables/${encodeURIComponent(owner.payableNo)}`}>
              {t('import_tracking')}
            </Link>
          </>
        }
        auditHref="#audit-log"
        auditLabel={admin('history')}
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
              <th scope="col">{t('eta')}</th>
              <th className={s.sapNum} scope="col">
                {t('planned')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('received')}
              </th>
              <th scope="col">{t('warehouse')}</th>
              <th scope="col">{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {containers.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={7}>
                  {t('no_containers')}
                </td>
              </tr>
            ) : null}
            {containers.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link className={s.sapLink} href={`/payables/containers/${encodeURIComponent(row.containerNo)}`}>
                    <bdi dir="ltr">{row.containerNo}</bdi>
                  </Link>
                </td>
                <td>{row.sizeType ?? '—'}</td>
                <td>
                  <bdi dir="ltr">{day(row.eta)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{formatQuantity(row.planned, locale as Locale)}</bdi>
                  {row.linesEstimated ? <div className="muted">{t('estimated')}</div> : null}
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.receivedOn ? formatQuantity(row.received, locale as Locale) : '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.warehouseCode ?? '—'}</bdi>
                </td>
                <td>
                  <span className={`status status--${containerChip(row)}`} data-status={containerChip(row)}>
                    {cs(row.statusCode, row.statusName)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
      <RecordHistory objectId={bl.id} objectType={shipments.BL_OBJECT} />
    </AdminPage>
  );
}
