import Link from 'next/link';
import { FileText, Folder } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ActionButton,
  AdminPage,
  Checkbox,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  Hidden,
  Inline,
  ListToolbar,
  NewRecordDialog,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { CloudLinkPoller } from '@/components/admin/cloud-link-poller';
import { CloudUploadForm } from '@/components/admin/cloud-upload-form';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { Pagination, Panel } from '@/components/ui';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import {
  CloudPathError,
  SORT_KEYS,
  breadcrumbs,
  canPreview,
  formatLinkTarget,
  isEntryFilter,
  isSortKey,
  kindOf,
  openInCloudUrl,
  parseLinkTarget,
  passesFilter,
  readableSize,
  sortEntries,
  ENTRY_FILTERS,
  type EntryFilter,
  type SortKey,
} from '@/server/domain/cloud-files';
import { visibleRoute } from '@/server/delivered';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import { CloudAuthError, CloudNotFoundError, CloudUnreachableError } from '@/server/services/cloud-client';
import * as files from '@/server/services/cloud-files';
import { openRecord, targetsFor } from '@/server/services/cloud-link-targets';
import * as settings from '@/server/services/cloud-settings';
import { cancelLinkAction, checkLinkAction, linkFileAction, newFolderAction, startLinkAction, unlinkAccountAction } from './actions';

/**
 * Document Center — QS Cloud Files, as Qimah's window onto it (Platform
 * phase, Agent 4; REQ-FIX-001 FIX-6).
 *
 * The page copies the Purchase Invoices register: title, search, filters,
 * the standard table, paging — and nothing is drawn that the ERP does not
 * already draw. What it shows is not the ERP's: every row is read from the
 * cloud, as the person (their own app password), so the cloud's permissions
 * decide which files and folders appear. The ERP adds the permission to use
 * the screen, the link to the records a file belongs to, and — where a person
 * has not linked, or the integration is off, or the cloud is down — a plain
 * statement of that instead of anything made up.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const HOME = '/documents';

export default async function DocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/documents')) notFound();
  registerAllRecords();

  const [t, a, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('cloudFiles'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', files.FILES_OBJECT)) return <Denied object={page('document_centre')} />;

  const ctx: ActorContext = { principal, branchCode: context.scope.branchCode };
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const mayConfigure = can(principal, 'view', settings.PERMISSION_OBJECT);
  const mayCreate = can(principal, 'create', files.FILES_OBJECT);

  const session = await withCurrentUser((tx) => accounts.sessionFor(tx, principal.userId));
  const linkCode = one('link');

  const flash = <Flash error={outcome.error} errorTitle={a('error_title')} saved={outcome.saved} savedLabel={a('saved')} />;
  const notes = (
    <>
      {linkCode === 'waiting' ? <p className={s.sapNote}>{t('link_still_waiting')}</p> : null}
      {linkCode === 'expired' ? <p className={s.sapNote}>{t('link_expired')}</p> : null}
      {linkCode === 'revoke_failed' ? <Flash error={t('unlink_revoke_failed')} errorTitle={t('unlinked_title')} saved={false} savedLabel="" /> : null}
    </>
  );

  // ---- not configured -------------------------------------------------------
  if (session.state === 'not_configured') {
    return (
      <AdminPage back={{ href: '/', label: a('dashboard_label') }} subtitle={t('subtitle')} tabs={<SectionTabs route={HOME} />} title={page('document_centre')} variant="sap">
        {flash}
        <Panel>
          <div className={s.emptyState}>
            <strong>{t('not_configured_title')}</strong>
            <p>{mayConfigure ? t('not_configured_body_admin') : t('not_configured_body')}</p>
            {mayConfigure ? (
              <Link className={`${s.button} ${s.primary}`} href="/administration/cloud-files">
                {t('not_configured_action')}
              </Link>
            ) : null}
          </div>
        </Panel>
      </AdminPage>
    );
  }

  // ---- not linked, waiting for approval, or linked but no longer accepted ---
  if (session.state !== 'ready') {
    const pending = session.pending && !session.pending.expired ? session.pending : null;
    const relink = session.state === 'relink';
    return (
      <AdminPage back={{ href: '/', label: a('dashboard_label') }} subtitle={t('subtitle')} tabs={<SectionTabs route={HOME} />} title={page('document_centre')} variant="sap">
        {flash}
        {notes}
        <Panel>
          <div className={s.emptyState}>
            {pending ? (
              <>
                <strong>{t('link_waiting_title')}</strong>
                <p>{t('link_waiting_body')}</p>
                <p className={s.sapNote}>{t('link_expires', { time: formatTimestamp(pending.expiresAt.toISOString(), locale as Locale) })}</p>
                <div className={s.submitRow}>
                  <a className={`${s.button} ${s.primary}`} href={pending.loginUrl} rel="noreferrer" target="_blank">
                    {t('link_open_cloud')}
                  </a>
                  <ActionButton action={checkLinkAction} hidden={{ return_to: HOME }} label={t('link_check')} small={false} />
                  <ActionButton action={cancelLinkAction} hidden={{ return_to: HOME }} label={t('link_cancel')} small={false} />
                </div>
                <CloudLinkPoller endpoint="/documents/link/poll" expiresAt={pending.expiresAt.toISOString()} home={HOME} />
              </>
            ) : (
              <>
                <strong>{relink ? t('relink_title') : t('not_linked_title')}</strong>
                <p>{relink ? t('relink_body') : t('not_linked_body')}</p>
                <div className={s.submitRow}>
                  <ActionButton action={startLinkAction} hidden={{ return_to: HOME }} label={relink ? t('relink_action') : t('not_linked_action')} small={false} tone="primary" />
                  {relink ? <ActionButton action={unlinkAccountAction} hidden={{ return_to: HOME }} label={t('unlink_account')} small={false} /> : null}
                </div>
                <p className={s.sapNote}>{t('not_linked_note', { server: session.settings.baseUrl ?? '' })}</p>
              </>
            )}
          </div>
        </Panel>
      </AdminPage>
    );
  }

  // ---- linked: the folder, as the cloud shows it to this person -------------
  const { client, account, settings: config } = session;
  const requested = one('path') || config.rootPath;

  let listing: files.Listing | null = null;
  let problem: 'unreachable' | 'relink' | 'missing' | null = null;
  try {
    listing = await accounts.withCloud(ctx, account, () => files.browse(ctx, client, config, requested));
  } catch (error) {
    // A path outside the Document Center's folder is not a place: start again at its start.
    if (error instanceof CloudPathError) redirect(HOME);
    if (error instanceof CloudUnreachableError) problem = 'unreachable';
    else if (error instanceof CloudAuthError) problem = 'relink';
    else if (error instanceof CloudNotFoundError) problem = 'missing';
    else throw error;
  }

  const here = listing?.path ?? config.rootPath;
  const folderHref = (path: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams();
    if (path !== config.rootPath) query.set('path', path);
    for (const [key, value] of Object.entries(extra)) if (value) query.set(key, value);
    const text = query.toString();
    return text ? `${HOME}?${text}` : HOME;
  };

  const crumbs = breadcrumbs(config.rootPath, here);
  const folderName = (crumb: { path: string; name: string }) => (crumb.path === config.rootPath ? page('document_centre') : crumb.name);
  const trail = crumbs.slice(0, -1).map((crumb) => ({ href: folderHref(crumb.path), label: folderName(crumb) }));
  const title = folderName(crumbs[crumbs.length - 1]!);

  const kindParam = one('kind');
  const kind: EntryFilter = isEntryFilter(kindParam) ? kindParam : 'all';
  const sortParam = one('sort');
  const sort: SortKey = isSortKey(sortParam) ? sortParam : 'name';
  const descending = one('dir') === 'desc';
  const q = outcome.q.trim().toLowerCase();

  // Links in both directions: which records each file is linked to; and the record a link is being made for.
  const linkTarget = parseLinkTarget(one('linkTo') || null);
  const entries = listing?.entries ?? [];
  const { linked, linkRecord, mappings } = await withCurrentUser(async (tx) => ({
    linked: await files.recordsLinkedTo(tx, ctx, account.serverUrl, entries.flatMap((entry) => (entry.fileId ? [entry.fileId] : []))),
    linkRecord: linkTarget && mayCreate ? await openRecord(tx, principal, linkTarget.objectType, linkTarget.objectId) : null,
    mappings: listing?.rights.makeFolder ? (await files.activeMappings(tx)).filter((m) => m.active) : [],
  }));
  const linkingFile = mayCreate && !linkRecord ? (entries.find((entry) => entry.path === one('linkFile')) ?? null) : null;

  const shown = sortEntries(
    entries
      .filter((entry) => (q ? entry.name.toLowerCase().includes(q) : true))
      .filter((entry) => passesFilter(entry, kind, Boolean(entry.fileId && linked.get(entry.fileId)?.length))),
    sort,
    descending,
  );
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(outcome.page, pages);
  const visible = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const keep: Record<string, string> = {
    path: here === config.rootPath ? '' : here,
    kind: kind === 'all' ? '' : kind,
    sort: sort === 'name' ? '' : sort,
    dir: descending ? 'desc' : '',
    q: outcome.q,
    linkTo: linkRecord ? formatLinkTarget(linkRecord.type, linkRecord.id) : '',
  };
  const pageHref = (n: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(keep)) if (value) query.set(key, value);
    if (n > 1) query.set('page', String(n));
    const text = query.toString();
    return text ? `${HOME}?${text}` : HOME;
  };
  const returnHere = pageHref(current);
  const toolbarHidden = Object.fromEntries(Object.entries(keep).filter(([key, value]) => key !== 'q' && value));

  const accountName = account.displayName ?? account.cloudUser;
  const actions =
    listing && mayCreate && (listing.rights.upload || listing.rights.makeFolder) ? (
      <>
        {listing.rights.upload ? (
          <NewRecordDialog buttonLabel={t('upload')} closeLabel={a('close')} title={t('upload_title', { folder: title })}>
            <CloudUploadForm
              endpoint={`/documents/upload?dir=${encodeURIComponent(listing.path)}`}
              labels={{
                choose: t('upload_choose'),
                start: t('upload_start'),
                retry: t('upload_retry'),
                waiting: t('upload_waiting'),
                sending: t.raw('upload_sending') as string,
                done: t('upload_done'),
                failed: t.raw('upload_failed') as string,
                hint: t('upload_hint'),
                network: t('upload_network'),
                finished: t('upload_finished'),
              }}
            />
          </NewRecordDialog>
        ) : null}
        {listing.rights.makeFolder ? (
          <NewRecordDialog buttonLabel={t('new_folder')} closeLabel={a('close')} title={t('new_folder_title', { folder: title })}>
            <Form action={newFolderAction}>
              <Hidden name="parent" value={listing.path} />
              <Hidden name="return_to" value={returnHere} />
              <Grid>
                <Field label={t('folder_name')} maxLength={255} name="name" required requiredLabel={a('required_hint')} />
              </Grid>
              {mappings.length > 0 ? <Checkbox defaultChecked label={t('folder_share', { count: mappings.length })} name="share" /> : null}
              <SubmitRow>
                <Submit label={t('folder_make')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null}
      </>
    ) : null;

  const kinds = ENTRY_FILTERS.filter((value) => value !== 'all').map((value) => ({ value, label: t(`filter_${value}`) }));
  const recordTypes = targetsFor(principal).map((target) => ({ value: target.type, label: t(`record_${target.type}`) }));

  return (
    <AdminPage actions={actions} back={{ href: '/', label: a('dashboard_label') }} subtitle={t('subtitle')} tabs={<SectionTabs route={HOME} />} title={title} trail={trail} variant="sap">
      {flash}
      {notes}
      {problem === 'unreachable' ? <Flash error={t('unreachable_body')} errorTitle={t('unreachable_title')} saved={false} savedLabel="" /> : null}
      {problem === 'relink' ? <Flash error={t('relink_body')} errorTitle={t('relink_title')} saved={false} savedLabel="" /> : null}
      {problem === 'missing' ? (
        <Flash error={here === config.rootPath ? t('root_missing_body') : t('folder_missing_body')} errorTitle={t('folder_missing_title')} saved={false} savedLabel="" />
      ) : null}
      {problem === 'relink' ? <ActionButton action={startLinkAction} hidden={{ return_to: HOME }} label={t('relink_action')} small={false} tone="primary" /> : null}
      {problem === 'missing' && here !== config.rootPath ? (
        <p>
          <Link className={s.sapLink} href={HOME}>
            {t('back_to_start')}
          </Link>
        </p>
      ) : null}

      {linkRecord ? (
        <p className={s.sapNote}>
          {t('link_mode', { record: `${t(`record_${linkRecord.type}`)} ${linkRecord.label}` })}{' '}
          <Link className={s.sapLink} href={linkRecord.href}>
            {t('link_mode_back')}
          </Link>
        </p>
      ) : null}

      {linkingFile ? (
        <section aria-labelledby="link-file-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="link-file-title">
              <span>{t('link_file_title', { name: linkingFile.name })}</span>
            </h2>
            <Form action={linkFileAction} className="p-5">
              <Hidden name="path" value={linkingFile.path} />
              <Hidden name="return_to" value={folderHref(here)} />
              <Grid>
                <Select label={t('link_kind')} name="object_type" options={recordTypes} required />
                <Field hint={t('link_number_hint')} label={t('link_number')} name="object_number" required requiredLabel={a('required_hint')} />
              </Grid>
              <SubmitRow>
                <Submit label={t('link_make')} />
                <Link className={s.button} href={folderHref(here)}>
                  {a('cancel')}
                </Link>
              </SubmitRow>
            </Form>
          </div>
        </section>
      ) : null}

      {listing ? (
        <section aria-labelledby="documents-title" className={`${s.sapDoc} ${s.sapRegister}`}>
          <div className={`${s.sapWindow} mb-5`}>
            <h2 className={s.sapTitle} id="documents-title">
              <span>{title}</span>
              <span className={s.sapTitleMeta}>{a('rows_shown', { count: shown.length })}</span>
            </h2>

            <ListToolbar
              clearHref={folderHref(here)}
              clearLabel={a('clear_search')}
              countLabel={a('rows_shown', { count: shown.length })}
              hidden={toolbarHidden}
              placeholder={t('search_placeholder')}
              q={outcome.q}
              searchLabel={a('search')}
            >
              <span>{t('connected_as', { name: accountName })}</span>
              <ActionButton action={unlinkAccountAction} hidden={{ return_to: HOME }} label={t('unlink_account')} />
            </ListToolbar>

            <form className={s.filterBar} method="get">
              <FilterRow>
                {here !== config.rootPath ? <Hidden name="path" value={here} /> : null}
                {outcome.q ? <Hidden name="q" value={outcome.q} /> : null}
                {keep.linkTo ? <Hidden name="linkTo" value={keep.linkTo!} /> : null}
                <Select defaultValue={kind === 'all' ? '' : kind} emptyLabel={t('filter_all')} label={t('filter')} name="kind" options={kinds} />
                <Select defaultValue={sort} label={t('sort')} name="sort" options={SORT_KEYS.map((value) => ({ value, label: t(`sort_${value}`) }))} />
                <Select
                  defaultValue={descending ? 'desc' : 'asc'}
                  label={t('order')}
                  name="dir"
                  options={[
                    { value: 'asc', label: t('order_asc') },
                    { value: 'desc', label: t('order_desc') },
                  ]}
                />
                <SubmitRow>
                  <Submit label={t('apply')} />
                </SubmitRow>
              </FilterRow>
            </form>

            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="documents-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{column('name')}</th>
                    <th scope="col">{t('col_type')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('col_size')}
                    </th>
                    <th scope="col">{t('col_modified')}</th>
                    <th scope="col">{t('col_linked')}</th>
                    <th scope="col">{t('col_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={6}>
                        {entries.length === 0 ? (here === config.rootPath ? t('empty_root') : t('empty_folder')) : t('no_match')}
                      </td>
                    </tr>
                  ) : null}
                  {visible.map((entry) => {
                    const records = (entry.fileId ? linked.get(entry.fileId) : undefined) ?? [];
                    const fileHref = `/documents/file?path=${encodeURIComponent(entry.path)}`;
                    return (
                      <tr key={entry.path}>
                        <td>
                          {entry.isFolder ? (
                            <Link className={`${s.sapLink} inline-flex items-center gap-2`} href={folderHref(entry.path, { linkTo: keep.linkTo! })}>
                              <Folder aria-hidden="true" className="size-4 shrink-0 fill-primary-subtle text-primary-subtle-fg" />
                              <bdi dir="auto">{entry.name}</bdi>
                            </Link>
                          ) : (
                            <a className={`${s.sapLink} inline-flex items-center gap-2`} href={fileHref}>
                              <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-fg" />
                              <bdi dir="auto">{entry.name}</bdi>
                            </a>
                          )}
                        </td>
                        <td>{t(`kind_${kindOf(entry)}`)}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{readableSize(entry.size)}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{entry.modified ? formatTimestamp(entry.modified, locale as Locale) : '—'}</bdi>
                        </td>
                        <td>
                          {records.length === 0
                            ? '—'
                            : records.map((record, index) => (
                                <span key={record.linkId}>
                                  {index > 0 ? ' · ' : ''}
                                  <Link className={s.sapLink} href={record.href} title={t(`record_${record.objectType}`)}>
                                    <bdi dir="ltr">{record.label}</bdi>
                                  </Link>
                                </span>
                              ))}
                        </td>
                        <td>
                          <Inline>
                            {entry.isFolder ? null : (
                              <a className={`${s.button} ${s.small}`} download href={fileHref}>
                                {t('act_download')}
                              </a>
                            )}
                            {canPreview(entry) ? (
                              <a className={`${s.button} ${s.small}`} href={`${fileHref}&preview=1`} rel="noreferrer" target="_blank">
                                {t('act_preview')}
                              </a>
                            ) : null}
                            {entry.fileId ? (
                              <a className={`${s.button} ${s.small}`} href={openInCloudUrl(account.serverUrl, entry.fileId)} rel="noreferrer" target="_blank">
                                {t('act_open_cloud')}
                              </a>
                            ) : null}
                            {mayCreate && entry.fileId ? (
                              linkRecord ? (
                                <ActionButton
                                  action={linkFileAction}
                                  hidden={{ path: entry.path, object_type: linkRecord.type, object_id: linkRecord.id, return_to: linkRecord.href }}
                                  label={t('act_link_here')}
                                  tone="primary"
                                />
                              ) : (
                                <Link className={`${s.button} ${s.small}`} href={folderHref(here, { linkFile: entry.path, kind: keep.kind!, q: outcome.q })}>
                                  {t('act_link')}
                                </Link>
                              )
                            ) : null}
                          </Inline>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              count={pages}
              current={current}
              hrefFor={pageHref}
              labels={{ label: a('pagination'), previous: a('previous'), next: a('next'), page: (n) => a('page_n', { page: n }) }}
              locale={locale}
            />
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
