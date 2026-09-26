import { FileDown } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { exportHref, mayExport, type ExportKey } from '@/server/print/access';
import { FORMATS, type ExportFormat } from '@/server/print/model';
import type { Principal } from '@domain/permissions';
import { requireContext } from '@/server/session';
import styles from './export-menu.module.css';

/**
 * The one "Print / Export" menu every document and report carries.
 *
 * A disclosure rather than a script: the links are plain downloads, so the
 * menu works before the page hydrates and needs no client code at all. Each
 * format appears only when the reader holds its verb — `print` for the PDF,
 * `export` for Excel and Word — and a reader who holds neither gets no menu,
 * not a menu of refusals. The server checks again when the link is followed;
 * this only decides what is worth offering.
 *
 * Both languages are offered side by side: the document's language is chosen
 * per copy, independently of the reader's own.
 */
export async function ExportMenu({
  exportKey,
  id,
  query,
  label,
  principal,
}: {
  readonly exportKey: ExportKey;
  /** The document's number, or the account a per-account report is about. */
  readonly id?: string | null;
  /** The screen's filters, passed through unchanged. */
  readonly query?: Readonly<Record<string, string | string[] | undefined>> | undefined;
  /** An accessible name for a menu that sits on a row among others. */
  readonly label?: string;
  /** The reader, when the page already has it — a list of rows asks once, not per row. */
  readonly principal?: Principal;
}) {
  const [reader, t] = await Promise.all([
    principal ?? requireContext().then((context) => context.principal),
    getTranslations('print'),
  ]);
  const formats = FORMATS.filter((format) => mayExport(reader, exportKey, format));
  if (formats.length === 0) return null;

  const link = (format: ExportFormat, lang: 'en' | 'ar') => {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (name === 'format' || name === 'lang' || name === 'saved' || name === 'error') continue;
      for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(name, one);
    }
    params.set('format', format);
    params.set('lang', lang);
    return `${exportHref(exportKey, id)}?${params.toString()}`;
  };
  const names: Record<ExportFormat, string> = { pdf: t('pdf'), xlsx: t('excel'), docx: t('word') };

  return (
    <details className={styles.menu} data-export-menu={exportKey}>
      <summary aria-label={label ? `${t('menu')} — ${label}` : undefined} className={styles.trigger}>
        <FileDown aria-hidden="true" />
        <span>{t('menu')}</span>
      </summary>
      <div className={styles.panel} role="group">
        {(['en', 'ar'] as const).map((lang) => (
          <div className={styles.language} key={lang} lang={lang}>
            <span className={styles.languageName}>{lang === 'ar' ? t('arabic') : t('english')}</span>
            <span className={styles.formats}>
              {formats.map((format) => (
                <a
                  className={styles.format}
                  data-format={format}
                  data-lang={lang}
                  download
                  href={link(format, lang)}
                  key={format}
                >
                  {names[format]}
                </a>
              ))}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
