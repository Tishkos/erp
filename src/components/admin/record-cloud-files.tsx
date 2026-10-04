import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { FileText, Folder } from 'lucide-react';
import { Panel } from '@/components/ui';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { formatLinkTarget, readableSize } from '@/server/domain/cloud-files';
import { recordFolderAction, startLinkAction, unlinkFileAction } from '@/app/(app)/documents/actions';
import { registerAllRecords } from '@/server/records';
import type { Tx } from '@/server/db/client';
import type { RequestContext } from '@/server/session';
import { requireContext, withCurrentUser } from '@/server/session';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import { CloudAuthError, CloudUnreachableError } from '@/server/services/cloud-client';
import * as files from '@/server/services/cloud-files';
import { openRecord, targetOf, type RecordRef } from '@/server/services/cloud-link-targets';
import * as settings from '@/server/services/cloud-settings';
import { ActionButton, Inline, ReasonForm, admin as s } from './index';
import { CloudUploadForm } from './cloud-upload-form';

/**
 * QS Cloud Files behind a record's paperclip (Platform phase, Agent 4).
 *
 * The paperclip keeps its attachments exactly as before — files stored by the
 * ERP. Under them, in the same window, this section shows the files of the
 * cloud that are LINKED to the record: nothing is copied, a link holds the
 * cloud's file id and the name its maker saw, and each file is opened, if the
 * person may, through the ERP's route (`/documents/file?link=`), which asks the
 * cloud as them. A file the cloud does not show them is "not available to you"
 * and its name is not given.
 *
 * It draws nothing when the integration is off, when the person holds no
 * Cloud Files grant, when this kind of record has not been registered for
 * links, or when they may not open the record.
 */
export interface CloudSectionData {
  readonly ctx: ActorContext;
  readonly record: RecordRef;
  readonly links: Awaited<ReturnType<typeof files.linksOfRecord>>;
  readonly session: accounts.CloudSession;
  readonly mayCreate: boolean;
}

/** Everything the section needs from the database, read in the page's own transaction. Null: show nothing. */
export async function readCloudSection(tx: Tx, context: RequestContext, objectType: string, objectId: string): Promise<CloudSectionData | null> {
  registerAllRecords();
  if (!targetOf(objectType)) return null;
  const { principal } = context;
  if (!can(principal, 'view', files.FILES_OBJECT)) return null;
  const config = await settings.getCached(tx);
  if (!settings.isConfigured(config) || !config.baseUrl) return null;
  const record = await openRecord(tx, principal, objectType, objectId);
  if (!record) return null;
  const ctx: ActorContext = { principal, branchCode: context.scope.branchCode };
  return {
    ctx,
    record,
    links: await files.linksOfRecord(tx, ctx, config.baseUrl, objectType, record.id),
    session: await accounts.sessionFor(tx, principal.userId),
    mayCreate: can(principal, 'create', files.FILES_OBJECT),
  };
}

/**
 * The section's data for a page that has no transaction open for it: nothing at
 * all when this process knows Cloud Files is off, else one read of its own.
 */
export async function loadCloudSection(context: RequestContext, objectType: string, objectId: string): Promise<CloudSectionData | null> {
  registerAllRecords();
  if (!targetOf(objectType) || !can(context.principal, 'view', files.FILES_OBJECT)) return null;
  const known = settings.peekCached();
  if (known && !settings.isConfigured(known)) return null;
  return withCurrentUser((tx, current) => readCloudSection(tx, current, objectType, objectId));
}

export async function RecordCloudFiles({
  objectType,
  objectId,
  preloaded,
}: {
  readonly objectType: string;
  readonly objectId: string;
  readonly preloaded?: CloudSectionData | null;
}) {
  const data = preloaded !== undefined ? preloaded : await loadCloudSection(await requireContext(), objectType, objectId);
  if (!data) return null;
  const { ctx, record, links, session, mayCreate } = data;
  const [t, locale] = await Promise.all([getTranslations('cloudFiles'), getLocale()]);
  const target = formatLinkTarget(record.type, record.id);

  // Ask the cloud, as this person, what they can see of what is linked.
  let notice: 'unreachable' | 'relink' | null = null;
  let rows: Awaited<ReturnType<typeof files.verifyLinks>> = files.unverified(links);
  let serverUrl = '';
  if (session.state === 'ready') {
    serverUrl = session.account.serverUrl;
    try {
      rows = await accounts.withCloud(ctx, session.account, () => files.verifyLinks(session.client, serverUrl, links));
    } catch (error) {
      if (error instanceof CloudUnreachableError) notice = 'unreachable';
      else if (error instanceof CloudAuthError) notice = 'relink';
      else throw error;
    }
  }
  const ready = session.state === 'ready' && notice === null;
  const hasFolder = links.some((link) => link.isFolder);

  return (
    <Panel labelledBy={`cloud-files-${record.type}-${record.id}`} title={t('record_title')}>
      {session.state !== 'ready' || notice === 'relink' ? (
        <div className={s.emptyState}>
          <strong>{session.state === 'relink' || notice === 'relink' ? t('relink_title') : t('not_linked_title')}</strong>
          <p>{session.state === 'relink' || notice === 'relink' ? t('relink_body') : t('record_not_linked_body')}</p>
          <ActionButton action={startLinkAction} hidden={{ return_to: '/documents' }} label={session.state === 'relink' || notice === 'relink' ? t('relink_action') : t('not_linked_action')} small={false} tone="primary" />
        </div>
      ) : null}
      {notice === 'unreachable' ? <p className={s.sapNote}>{t('record_unreachable')}</p> : null}

      {rows.length === 0 ? (
        <div className={s.emptyState}>
          <strong>{t('record_none')}</strong>
        </div>
      ) : (
        <ul className={s.fileList}>
          {rows.map((row) => (
            <li key={row.id}>
              <span className={s.fileIcon}>{row.isFolder ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />}</span>
              <span className={s.fileBody}>
                {row.state === 'available' && row.entry ? (
                  row.isFolder ? (
                    <Link href={`/documents?path=${encodeURIComponent(row.entry.path)}&linkTo=${encodeURIComponent(target)}`}>
                      <bdi dir="auto">{row.name}</bdi>
                    </Link>
                  ) : (
                    <a href={`/documents/file?link=${row.id}`} rel="noreferrer" target="_blank">
                      <bdi dir="auto">{row.name}</bdi>
                    </a>
                  )
                ) : (
                  <span>{row.state === 'unavailable' ? t('record_unavailable') : t('record_unverified')}</span>
                )}
                <span className={s.fileMeta}>
                  {row.state === 'available' && row.entry ? (
                    <>
                      <bdi dir="ltr">{readableSize(row.entry.size)}</bdi>
                      {' · '}
                    </>
                  ) : null}
                  {row.linkedByName ? `${t('record_linked_by', { name: row.linkedByName })} · ` : ''}
                  {formatTimestamp(row.linkedAt.toISOString(), locale as Locale)}
                  {row.openUrl ? (
                    <>
                      {' · '}
                      <a href={row.openUrl} rel="noreferrer" target="_blank">
                        {t('act_open_cloud')}
                      </a>
                    </>
                  ) : null}
                </span>
                {mayCreate ? (
                  <ReasonForm action={unlinkFileAction} hidden={{ link_id: row.id }} label={t('record_unlink')} reasonLabel={t('record_unlink_reason', { name: row.state === 'available' ? row.name : t('record_unavailable') })} tone="secondary" />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayCreate && (ready || (session.state === 'ready' && notice === 'unreachable')) ? (
        <Inline>
          <Link className={`${s.button} ${s.primary}`} href={`/documents?linkTo=${encodeURIComponent(target)}`}>
            {t('record_link_file')}
          </Link>
          {!hasFolder && ready ? <ActionButton action={recordFolderAction} hidden={{ object_type: record.type, object_id: record.id }} label={t('record_make_folder')} small={false} /> : null}
        </Inline>
      ) : null}

      {mayCreate && ready ? (
        <CloudUploadForm
          endpoint={`/documents/upload?record=${encodeURIComponent(target)}`}
          labels={{
            choose: t('upload_choose'),
            start: t('upload_start'),
            retry: t('upload_retry'),
            waiting: t('upload_waiting'),
            sending: t.raw('upload_sending') as string,
            done: t('upload_done'),
            failed: t.raw('upload_failed') as string,
            hint: t('record_upload_hint'),
            network: t('upload_network'),
            finished: t('upload_finished'),
          }}
        />
      ) : null}
    </Panel>
  );
}
