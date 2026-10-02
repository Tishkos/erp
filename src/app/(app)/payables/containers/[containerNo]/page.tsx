import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { CONTAINER_PATH } from '@domain/shipments';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as shipments from '@/server/services/shipments';
import {
  attachToContainer,
  containerEtaAction,
  containerLinesAction,
  containerStatusAction,
  portFileAction,
  receiveContainerAction,
} from '../../shipments/actions';
import { containerChip } from '../status';
import { windowTone } from '../../window-tone';
import { businessToday } from '@/server/domain/business-date';

/**
 * One container — REQ-AP-001 §17.2, §18. The Purchase Invoice's window: the
 * container's dates in boxes (one per stage, all kept), what it carries as the
 * grid, and at the foot what is done to it next — the stage, the ETA, the port
 * file, its plan, and Receive container. The receive form carries a one-time
 * document id, so pressing it twice receives the container once.
 */
export const dynamic = 'force-dynamic';

export default async function ContainerPage({
  params,
  searchParams,
}: {
  params: Promise<{ containerNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/containers')) notFound();
  const { containerNo: raw } = await params;
  const containerNo = decodeURIComponent(raw);
  const query = await searchParams;
  const id = typeof query.id === 'string' ? query.id : null;

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', shipments.CONTAINER_OBJECT)) {
    return <Denied object={page('containers')} />;
  }
  const mayEdit = can(principal, 'edit_draft', shipments.CONTAINER_OBJECT);
  const mayReceive = can(principal, 'execute', shipments.CONTAINER_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      return { ...(await shipments.viewContainer(tx, containerNo, id)), statuses: await shipments.statuses(tx) };
    } catch {
      return null;
    }
  });
  if (!found) notFound();
  const { container, bl, owner, status, lines } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const amount = (value: string | null) => (value === null ? '—' : formatQuantity(value, locale as Locale));
  const today = businessToday();
  const hidden = { container_no: container.containerNo, container_id: container.id };
  const open = !container.receivedOn && !container.cancelledAt;
  const chip = containerChip(container);
  const cs = (code: string, name: string) => (locale !== 'en' && t.has(`cs.${code}`) ? t(`cs.${code}`) : name);
  const statusName = (code: string) => cs(code, found.statuses.find((row) => row.code === code)?.name ?? code);
  const pathIndex = container.statusCode === 'late' ? 1 : CONTAINER_PATH.indexOf(container.statusCode as (typeof CONTAINER_PATH)[number]);
  const nextStages = CONTAINER_PATH.filter((_, index) => index > pathIndex);
  const documentId = randomUUID();

  const fields: DocumentField[] = [
    { label: t('container_no'), value: <bdi dir="ltr">{container.containerNo}</bdi> },
    { label: t('status'), value: `${cs(container.statusCode, status.name)}${container.statusDate ? ` · ${day(container.statusDate)}` : ''}`, status: windowTone(chip) },
    {
      label: t('bl_no'),
      value: (
        <Link className={s.sapLink} href={`/payables/shipments/${encodeURIComponent(bl.blNo)}`}>
          <bdi dir="ltr">{bl.blNo}</bdi>
        </Link>
      ),
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
    { label: t('supplier'), value: <bdi dir="auto">{found.supplier?.name ?? '—'}</bdi> },
    { label: t('size_type'), value: container.sizeType ?? '—' },
    { label: t('eta'), value: <bdi dir="ltr">{day(container.eta)}</bdi> },
    { label: t('departed_on'), value: <bdi dir="ltr">{day(container.departedOn)}</bdi> },
    { label: t('arrived_port_on'), value: <bdi dir="ltr">{day(container.arrivedPortOn)}</bdi> },
    { label: t('customs_cleared_on'), value: <bdi dir="ltr">{day(container.customsClearedOn)}</bdi> },
    { label: t('port_file_sent_on'), value: <bdi dir="ltr">{day(container.portFileSentOn)}</bdi> },
    { label: t('received_on'), value: <bdi dir="ltr">{day(container.receivedOn)}</bdi> },
    { label: t('warehouse'), value: <bdi dir="ltr">{container.warehouseCode ?? '—'}</bdi> },
    { label: t('receipt_no'), value: <bdi dir="ltr">{found.receipt?.receiptNo ?? '—'}</bdi> },
    ...(found.receipt?.varianceReason
      ? [{ label: t('variance_reason'), value: <bdi dir="auto">{found.receipt.varianceReason}</bdi>, status: 'rejected', wide: true }]
      : []),
    ...(container.linesEstimated
      ? [{ label: t('plan'), value: t('estimated_note'), status: 'submitted', wide: true }]
      : []),
  ];

  const planRows = [0, 1, 2, 3, 4, 5];
  const itemChoices = found.orderLines
    .filter((line) => line.itemCode)
    .map((line) => ({ value: line.itemCode!, label: `${line.itemCode} · ${line.description}` }));

  return (
    <AdminPage
      back={{ href: '/payables/containers', label: page('containers') }}
      tabs={<SectionTabs route="/payables/containers" />}
      title={container.containerNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {found.others.length > 0 ? (
        <p className={s.sapNote}>
          {t('other_trips')}{' '}
          {found.others.map((other) => (
            <Link
              className={s.sapLink}
              href={`/payables/containers/${encodeURIComponent(container.containerNo)}?id=${other.id}`}
              key={other.id}
            >
              {other.receivedOn ? day(other.receivedOn) : t('in_transit')}{' '}
            </Link>
          ))}
        </p>
      ) : null}

      <DocumentWindow
        actions={
          <>
            {mayReceive && open ? (
              <NewRecordDialog
                buttonLabel={t('receive')}
                closeLabel={admin('close')}
                openOnLoad={Boolean(outcome.error) && query.receive === '1'}
                title={t('receive_title', { containerNo: container.containerNo })}
                wide
              >
                <p className="muted">{t('receive_note')}</p>
                <Form action={receiveContainerAction}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Hidden name="document_id" value={documentId} />
                  <Hidden name="row_count" value={String(lines.length)} />
                  <Grid>
                    <Select
                      defaultValue={found.houses[0]?.code}
                      label={t('warehouse')}
                      name="warehouse_code"
                      options={found.houses.map((house) => ({ value: house.code, label: `${house.code} · ${house.name}` }))}
                      required
                    />
                    <Field defaultValue={today} label={t('received_on')} name="receipt_date" required type="date" />
                  </Grid>
                  <div className={s.sapTableWrap}>
                    <table className={s.sapTable}>
                      <thead>
                        <tr>
                          <th scope="col">{t('model')}</th>
                          <th className={s.sapNum} scope="col">
                            {t('planned')}
                          </th>
                          <th scope="col">{t('received')}</th>
                          <th scope="col">{t('damaged')}</th>
                          <th scope="col">{t('short')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((line, index) => (
                          <tr key={line.id}>
                            <td>
                              <Hidden name={`line_${index}`} value={line.id} />
                              <bdi dir="ltr">{line.itemCode ?? '—'}</bdi> {line.description}
                            </td>
                            <td className={s.sapNum}>
                              <bdi dir="ltr">{amount(line.plannedQty)}</bdi>
                            </td>
                            <td>
                              <input
                                aria-label={`${t('received')} ${index + 1}`}
                                className={s.input}
                                defaultValue={Number(line.plannedQty).toString()}
                                inputMode="decimal"
                                name={`received_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('damaged')} ${index + 1}`}
                                className={s.input}
                                defaultValue="0"
                                inputMode="decimal"
                                name={`damaged_${index}`}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`${t('short')} ${index + 1}`}
                                className={s.input}
                                defaultValue="0"
                                inputMode="decimal"
                                name={`short_${index}`}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Field hint={t('variance_hint')} id="receive-variance" label={t('variance_reason')} name="variance_reason" wide />
                  <Field id="receive-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('receive')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && open && nextStages.length > 0 ? (
              <NewRecordDialog buttonLabel={t('change_stage')} closeLabel={admin('close')} title={t('change_stage')}>
                <Form action={containerStatusAction}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Grid>
                    <Select
                      label={t('stage')}
                      name="status_code"
                      options={nextStages.map((code) => ({ value: code, label: statusName(code) }))}
                      required
                    />
                    <Field defaultValue={today} label={t('stage_date')} name="status_date" required type="date" />
                  </Grid>
                  <Field id="stage-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('change_stage')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && open ? (
              <NewRecordDialog buttonLabel={t('change_eta')} closeLabel={admin('close')} title={t('change_eta')}>
                <Form action={containerEtaAction}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Field defaultValue={container.eta ?? ''} label={t('eta')} name="eta" required type="date" />
                  <Field id="eta-note" label={t('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={t('change_eta')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && container.customsClearedOn && !container.portFileSentOn ? (
              <form action={portFileAction} className={s.inline}>
                {Object.entries(hidden).map(([name, value]) => (
                  <Hidden key={name} name={name} value={value} />
                ))}
                <Field defaultValue={today} id="port-file-date" label={t('port_file_sent_on')} name="sent_on" required type="date" />
                <Submit label={t('port_file_sent')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayEdit && open ? (
              <NewRecordDialog buttonLabel={t('load_plan')} closeLabel={admin('close')} title={t('load_plan')} wide>
                <p className="muted">{t('load_plan_note')}</p>
                <Form action={containerLinesAction}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <Hidden key={name} name={name} value={value} />
                  ))}
                  <Hidden name="row_count" value={String(planRows.length)} />
                  <div className={s.sapTableWrap}>
                    <table className={s.sapTable}>
                      <thead>
                        <tr>
                          <th scope="col">{t('model')}</th>
                          <th scope="col">{t('description')}</th>
                          <th scope="col">{t('planned')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planRows.map((index) => {
                          const line = lines[index];
                          return (
                            <tr key={index}>
                              <td>
                                <select
                                  aria-label={`${t('model')} ${index + 1}`}
                                  className={s.select}
                                  defaultValue={line?.itemCode ?? ''}
                                  name={`item_${index}`}
                                >
                                  <option value="">—</option>
                                  {itemChoices.map((choice) => (
                                    <option key={choice.value} value={choice.value}>
                                      {choice.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  aria-label={`${t('description')} ${index + 1}`}
                                  className={s.input}
                                  defaultValue={line?.description ?? ''}
                                  name={`description_${index}`}
                                />
                              </td>
                              <td>
                                <input
                                  aria-label={`${t('planned')} ${index + 1}`}
                                  className={s.input}
                                  defaultValue={line ? Number(line.plannedQty).toString() : ''}
                                  inputMode="decimal"
                                  name={`planned_${index}`}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <SubmitRow>
                    <Submit label={t('save_plan')} />
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
        documentType={t('container')}
        fields={fields}
        id="container-document"
        linesCount={lines.length}
        linesTitle={t('carries')}
        number={container.containerNo}
      >
        <table aria-labelledby="container-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('model')}</th>
              <th scope="col">{t('description')}</th>
              <th className={s.sapNum} scope="col">
                {t('planned')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('received')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('damaged')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('short')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={7}>
                  {t('no_plan')}
                </td>
              </tr>
            ) : null}
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  <bdi dir="ltr">{line.itemCode ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(line.plannedQty)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(line.receivedQty)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(line.damagedQty)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{amount(line.shortQty)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* ── Every stage it has passed, dated (§17.2 — all kept) ───────── */}
      <section aria-labelledby="container-history-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="container-history-title">
            <span>{t('stage_history')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: found.history.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="container-history-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('stage_date')}</th>
                  <th scope="col">{t('note')}</th>
                  <th scope="col">{t('recorded_by')}</th>
                </tr>
              </thead>
              <tbody>
                {found.history.map((row) => (
                  <tr key={row.id}>
                    <td>{cs(row.statusCode, row.statusName)}</td>
                    <td>
                      <bdi dir="ltr">{day(row.effectiveDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.note ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.recordedBy ?? t(`source_${row.source}`)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-label={t('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToContainer}
            hidden={hidden}
            mayAttach={mayEdit}
            objectId={container.id}
            objectType={shipments.CONTAINER_OBJECT}
          />
        </div>
      </section>
      <RecordHistory objectId={container.id} objectType={shipments.CONTAINER_OBJECT} />
    </AdminPage>
  );
}
