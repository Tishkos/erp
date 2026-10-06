import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Submit, SubmitRow, admin as s } from '@/components/admin';
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
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ports from '@/server/services/ports';
import * as shipments from '@/server/services/shipments';
import * as recordNotes from '@/server/services/record-notes';
import { isNotFoundError } from '@/server/not-found';
import { containerChip } from '../../../payables/containers/status';
import { attachToPort } from '../attach';
import { reactivatePort, renamePort, retirePort } from '../actions';

/**
 * One port — its profile (REQ-LOG-001 item 15; `profileHref('port', code)`).
 * The Purchase Invoice's window: the port in boxes, the B/Ls that discharge
 * there as the grid, the four doors in the title bar, and at the foot what
 * is done to it: rename, retire with a reason, bring back. Under it, the
 * containers still on the way to it.
 */
export const dynamic = 'force-dynamic';

export default async function PortPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/ports')) notFound();
  const { code: raw } = await params;
  const code = decodeURIComponent(raw);
  const [t, sh, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ports.PERMISSION_OBJECT)) {
    return <Denied object={page('ports_routes')} />;
  }
  const mayConfigure = can(principal, 'configure', ports.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await ports.viewByCode(tx, code);
      return {
        ...view,
        inbound: await ports.inboundContainers(tx, view.port.code),
        statuses: await shipments.statuses(tx),
        files: await readAttachments(tx, ports.PERMISSION_OBJECT, view.port.code),
        notes: await recordNotes.listNotes(tx, { object: ports.PERMISSION_OBJECT, recordId: view.port.code }),
      };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { port, bls } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const cs = (code: string) => (locale !== 'en' && sh.has(`cs.${code}`) ? sh(`cs.${code}`) : (found.statuses.find((row) => row.code === code)?.name ?? code));
  const hidden = { code: port.code };

  const fields: DocumentField[] = [
    { label: t('port_code'), value: <bdi dir="ltr">{port.code}</bdi> },
    { label: t('status'), value: port.active ? t('active') : t('retired'), status: port.active ? 'approved' : 'cancelled' },
    { label: t('port_name'), value: <bdi dir="auto">{port.name}</bdi> },
    { label: t('locode'), value: <bdi dir="ltr">{port.locode ?? '—'}</bdi> },
    { label: t('country'), value: <bdi dir="ltr">{port.country ?? '—'}</bdi> },
    { label: t('col_bls'), value: String(port.blCount) },
    { label: t('col_inbound'), value: String(port.openContainers) },
    { label: t('col_last_used'), value: <bdi dir="ltr">{day(port.lastBlDate)}</bdi> },
  ];

  return (
    <AdminPage
      back={{ href: '/logistics/ports', label: page('ports_routes') }}
      tabs={<SectionTabs route="/logistics/ports" />}
      title={`${port.code} · ${port.name}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {!port.active ? <p className={`${s.sapNote} mb-4`}>{t('port_not_served')}</p> : null}

      <DocumentWindow
        titleActions={
          <>
            <ExportIcon exportKey="port" id={port.code} title={`${t('port_document_type')} ${port.code}`} />
            <AttachmentsButton closeLabel={admin('close')} count={found.files.rows.length} label={admin('attachments.title')} title={admin('attachments.title')}>
              <Attachments
                action={attachToPort}
                hidden={hidden}
                mayAttach={mayConfigure && can(principal, 'create', 'attachment')}
                objectId={port.code}
                objectType={ports.PERMISSION_OBJECT}
                preloaded={found.files}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={found.notes} object={ports.PERMISSION_OBJECT} recordId={port.code} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={port.code} objectType={ports.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        actions={
          <>
            {mayConfigure ? (
              <NewRecordDialog buttonLabel={t('edit_port')} closeLabel={admin('close')} title={t('edit_port_title', { name: port.name })}>
                <Form action={renamePort}>
                  <Hidden name="code" value={port.code} />
                  <Grid>
                    <Field defaultValue={port.name} id="port-edit-name" label={t('port_name')} name="name" required />
                    <Field defaultValue={port.locode ?? ''} id="port-edit-locode" label={t('locode')} maxLength={5} name="locode" />
                    <Field defaultValue={port.country ?? ''} id="port-edit-country" label={t('country')} maxLength={2} name="country" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayConfigure && port.active ? <ReasonForm action={retirePort} hidden={hidden} label={t('retire_port')} reasonLabel={t('retire_reason')} /> : null}
            {mayConfigure && !port.active ? (
              <ReasonForm action={reactivatePort} hidden={hidden} label={t('reactivate_port')} reasonLabel={t('reactivate_reason')} tone="secondary" />
            ) : null}
          </>
        }
        documentType={t('port_document_type')}
        fields={fields}
        id="port-document"
        linesCount={bls.length}
        linesTitle={t('port_bls_title')}
        number={port.code}
      >
        <table aria-labelledby="port-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{sh('bl_no')}</th>
              <th scope="col">{sh('bl_date')}</th>
              <th scope="col">{sh('eta')}</th>
              <th scope="col">{t('import')}</th>
              <th scope="col">{t('supplier')}</th>
              <th scope="col">{t('col_from')}</th>
              <th className={s.sapNum} scope="col">
                {sh('containers')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('col_open')}
              </th>
            </tr>
          </thead>
          <tbody>
            {bls.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
                  {sh('no_bls')}
                </td>
              </tr>
            ) : null}
            {bls.map((row) => (
              <tr key={row.id}>
                <td>
                  <ProfileLink code={row.blNo} kind="bl">
                    {row.blNo}
                  </ProfileLink>
                  {row.cancelledAt ? <div className="muted">{sh('cancelled')}</div> : null}
                </td>
                <td>
                  <bdi dir="ltr">{day(row.blDate)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(row.eta)}</bdi>
                </td>
                <td>
                  <ProfileLink code={row.payableNo} kind="import">
                    {row.payableNo}
                  </ProfileLink>
                </td>
                <td>
                  <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                    {row.supplierName}
                  </ProfileLink>
                </td>
                <td>
                  <bdi dir="auto">{row.portOfLoading ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>{row.containers}</td>
                <td className={s.sapNum}>{row.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* ── Containers still bound for this port ───────────────────────── */}
      <section aria-labelledby="port-inbound-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="port-inbound-title">
            <span>{t('inbound_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: found.inbound.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="port-inbound-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{sh('container_no')}</th>
                  <th scope="col">{sh('bl_no')}</th>
                  <th scope="col">{sh('eta')}</th>
                  <th scope="col">{sh('status')}</th>
                </tr>
              </thead>
              <tbody>
                {found.inbound.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {sh('no_containers')}
                    </td>
                  </tr>
                ) : null}
                {found.inbound.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <ProfileLink code={row.containerNo} kind="container">
                        {row.containerNo}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.blNo} kind="bl">
                        {row.blNo}
                      </ProfileLink>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.eta)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${containerChip(row)}`} data-status={containerChip(row)}>
                        {cs(row.statusCode)}
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
