import { getLocale, getTranslations } from 'next-intl/server';
import { FileText, Paperclip, Upload } from 'lucide-react';
import { inArray } from 'drizzle-orm';
import { Panel } from '@/components/ui';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { appUser } from '@/server/db/schema';
import { withCurrentUser } from '@/server/session';
import * as attachments from '@/server/services/attachments';
import { Submit, admin as s } from './index';

/**
 * The documents stapled to a record — §21.
 *
 * Every file shows what it is, who attached it and when, and links to itself
 * through the download route, which asks the parent's module for permission
 * again on the way past. Superseded and quarantined files are not listed:
 * `currentFor` decides that, not this component.
 */
export async function Attachments({
  objectType,
  objectId,
  action,
  mayAttach,
  hidden = {},
}: {
  readonly objectType: string;
  readonly objectId: string;
  readonly action: (formData: FormData) => Promise<void>;
  readonly mayAttach: boolean;
  readonly hidden?: Readonly<Record<string, string>>;
}) {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);

  const files = await withCurrentUser(async (tx) => {
    const rows = await attachments.currentFor(tx, objectType, objectId);
    const uploaderIds = [...new Set(rows.map((r) => r.uploadedBy).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (uploaderIds.length > 0) {
      const people = await tx
        .select({ id: appUser.id, displayName: appUser.displayName })
        .from(appUser)
        .where(inArray(appUser.id, uploaderIds));
      for (const person of people) names.set(person.id, person.displayName);
    }
    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      sizeLabel: readableSize(row.sizeBytes),
      version: row.version,
      uploadedBy: row.uploadedBy ? (names.get(row.uploadedBy) ?? null) : null,
      uploadedAt: formatTimestamp(row.createdAt.toISOString(), locale as Locale),
    }));
  });

  return (
    <Panel
      labelledBy={`attachments-${objectType}-${objectId}`}
      title={t('attachments.title')}
    >
      {files.length === 0 ? (
        <div className={s.emptyState}>
          <Paperclip aria-hidden="true" />
          <strong>{t('attachments.none')}</strong>
        </div>
      ) : (
        <ul className={s.fileList}>
          {files.map((file) => (
            <li key={file.id}>
              <span className={s.fileIcon}>
                <FileText aria-hidden="true" />
              </span>
              <span className={s.fileBody}>
                <a href={`/attachments/${file.id}`} rel="noreferrer" target="_blank">
                  {file.fileName}
                </a>
                <span className={s.fileMeta}>
                  {file.sizeLabel}
                  {file.uploadedBy ? ` · ${t('attachments.by', { name: file.uploadedBy })}` : ''}
                  {` · ${file.uploadedAt}`}
                  {file.version > 1 ? ` · ${t('attachments.version', { version: file.version })}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {mayAttach ? (
        <form action={action} className={s.uploadForm}>
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} name={k} type="hidden" value={v} />
          ))}
          <label className={s.uploadPicker}>
            <Upload aria-hidden="true" />
            <span>{t('attachments.choose')}</span>
            <input name="file" required type="file" />
          </label>
          <Submit label={t('attachments.attach')} />
          <p className={s.uploadHint}>{t('attachments.hint')}</p>
        </form>
      ) : null}
    </Panel>
  );
}

/** Bytes as a person reads them. */
function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
