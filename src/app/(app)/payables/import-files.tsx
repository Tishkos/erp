import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  Anchor,
  BookText,
  Container,
  FileSearch,
  FileText,
  HandCoins,
  Landmark,
  Receipt,
  ScrollText,
  Stamp,
  Undo2,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { admin as s } from '@/components/admin';
import { FileViews } from '@/components/admin/file-views';
import { ProfileLink } from '@/components/admin/profile-link';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { visibleRoute } from '@/server/delivered';
import type { ImportFileLink, ImportFileSource, ImportFileSourceKind } from '@/server/services/import-attachments';

/**
 * What comes back to one block of the import's page from the records related
 * to it (2026-10-07, by direction: "their attachment should come back to their
 * blocks") — drawn under the block's own files inside its paperclip, grouped by
 * the record each file is kept on: the record's kind, its number as a link,
 * how many files. Two drawings, one choice per person (`FileViews`): Blocks —
 * a card per record, side by side — and List — one row per file.
 *
 * Every file opens through `/attachments/<id>`, which asks the record's own
 * access rule again on the way past.
 */
const ICON: Readonly<Record<ImportFileSourceKind, LucideIcon>> = {
  purchase_invoice: Receipt,
  goods_return: Undo2,
  payment_application: Landmark,
  supplier_advance: HandCoins,
  supplier_payment: Wallet,
  customs_pd: Stamp,
  asycuda_run: FileSearch,
  customs_declaration: ScrollText,
  bill_of_lading: Anchor,
  shipment_container: Container,
  charge_invoice: Receipt,
  charge_journal: BookText,
};

/** Bytes as a person reads them. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function SourceLink({ link, no }: { readonly link: ImportFileLink | null; readonly no: string }) {
  if (link && 'profile' in link) return <ProfileLink code={link.key} kind={link.profile} {...(link.qualifier ? { qualifier: link.qualifier } : {})} />;
  if (link && 'href' in link) {
    const route = link.href.split('/').slice(0, 3).join('/');
    if (visibleRoute(route)) {
      return (
        <Link className={s.sapLink} href={link.href}>
          <bdi dir="ltr">{no}</bdi>
        </Link>
      );
    }
  }
  return <bdi dir="ltr">{no}</bdi>;
}

export async function GatheredFiles({ sources, userId }: { readonly sources: readonly ImportFileSource[]; readonly userId: string }) {
  if (sources.length === 0) return null;
  const [t, pa, locale] = await Promise.all([getTranslations('admin.payables'), getTranslations('admin.payment_applications'), getLocale()]);
  const kindOf = (kind: ImportFileSourceKind) => (t.has(`files_source_${kind}`) ? t(`files_source_${kind}`) : kind);
  const paperOf = (kind: string | null) => (kind && pa.has(`paper_${kind}`) ? pa(`paper_${kind}`) : null);
  const when = (iso: string) => formatTimestamp(iso, locale as Locale);
  const total = sources.reduce((sum, source) => sum + source.files.length, 0);

  const blocks = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-files-blocks="">
      {sources.map((source) => {
        const Icon = ICON[source.kind];
        return (
          <article
            className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-overlay p-3 shadow-xs"
            data-source-kind={source.kind}
            data-source-no={source.no}
            key={`${source.objectType}|${source.objectId}`}
          >
            <header className="flex items-center gap-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-subtle text-primary-subtle-fg">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs text-muted-fg">{kindOf(source.kind)}</span>
                <span className="truncate text-sm font-medium">
                  <SourceLink link={source.link} no={source.no} />
                </span>
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-fg tabular-nums">{source.files.length}</span>
            </header>
            <ul className="flex flex-col divide-y divide-border">
              {source.files.map((file) => (
                <li className="flex items-start gap-2 py-1.5" data-file-id={file.id} key={file.id}>
                  <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-fg" />
                  <span className="flex min-w-0 flex-col">
                    <a className={`${s.sapLink} break-all`} href={`/attachments/${file.id}`} rel="noreferrer" target="_blank">
                      <bdi dir="auto">{file.fileName}</bdi>
                    </a>
                    <span className="text-xs text-muted-fg">
                      {sizeOf(file.sizeBytes)}
                      {file.uploadedBy ? ` · ${file.uploadedBy}` : ''}
                      {' · '}
                      <bdi dir="ltr">{when(file.createdAt)}</bdi>
                    </span>
                    {paperOf(file.paperKind) ? (
                      <span className="mt-1 w-fit rounded-md bg-info-subtle px-1.5 py-0.5 text-xs text-info-subtle-fg">{paperOf(file.paperKind)}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </div>
  );

  const list = (
    <div className={s.sapTableWrap} data-files-list="">
      <table className={s.sapTable}>
        <thead>
          <tr>
            <th scope="col">{t('files_col_source')}</th>
            <th scope="col">{t('files_col_file')}</th>
            <th scope="col">{t('files_col_by')}</th>
            <th scope="col">{t('files_col_at')}</th>
            <th className={s.sapNum} scope="col">
              {t('files_col_size')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sources.flatMap((source) =>
            source.files.map((file) => (
              <tr data-file-id={file.id} data-source-kind={source.kind} data-source-no={source.no} key={file.id}>
                <td>
                  <span className="block text-xs text-muted-fg">{kindOf(source.kind)}</span>
                  <SourceLink link={source.link} no={source.no} />
                </td>
                <td>
                  <a className={`${s.sapLink} break-all`} href={`/attachments/${file.id}`} rel="noreferrer" target="_blank">
                    <bdi dir="auto">{file.fileName}</bdi>
                  </a>
                  {paperOf(file.paperKind) ? <span className="block text-xs text-muted-fg">{paperOf(file.paperKind)}</span> : null}
                </td>
                <td>
                  <bdi dir="auto">{file.uploadedBy ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{when(file.createdAt)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{sizeOf(file.sizeBytes)}</bdi>
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <FileViews
      blocks={blocks}
      labels={{ group: t('files_view_label'), blocks: t('files_view_blocks'), list: t('files_view_list') }}
      list={list}
      meta={t('files_related_count', { count: total })}
      title={t('files_related_title')}
      userId={userId}
    />
  );
}
