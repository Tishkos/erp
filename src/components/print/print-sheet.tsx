import Image from 'next/image';
import localFont from 'next/font/local';
import mainLogo from '../../../mainLogo.png';
import { display, heading, printedAt } from '@/server/print/format';
import { isNumeric, type Letterhead, type PrintModel, type Table } from '@/server/print/model';
import styles from './print.module.css';

/**
 * The embedded face the PDF and the Word file use, so the browser's print
 * shows Arabic shaped by the same font on any machine — never a system
 * substitute, never a box.
 */
const printFont = localFont({
  src: [
    { path: '../../server/print/assets/IBMPlexSansArabic-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../server/print/assets/IBMPlexSansArabic-Bold.ttf', weight: '700', style: 'normal' },
  ],
  display: 'block',
});

/**
 * The document on paper, for the browser's own print (Ctrl+P).
 *
 * Rendered on the record page but shown only when printing: the print
 * stylesheet hides the whole application around it and lets this sheet take
 * the page. It is the same model the PDF, the workbook and the Word file are
 * drawn from, so what the browser prints is what the PDF says — letterhead,
 * title and number, the screen's fields and columns, totals, signatures, and
 * the DRAFT / NOT POSTED mark on every page of an unposted document.
 *
 * The browser repeats a table's heading at the top of each page by itself and
 * keeps a row whole where the stylesheet asks it to; the page count sits in
 * the page's own margin.
 */
export function PrintSheet({ model, head }: { readonly model: PrintModel; readonly head: Letterhead }) {
  const dir = head.locale === 'ar' ? 'rtl' : 'ltr';
  const draft = model.kind === 'document' && model.posted === false;
  const names = head.locale === 'ar' ? [head.companyAr, head.companyEn] : [head.companyEn, head.companyAr];

  return (
    <div
      className={`${styles.printOnly} ${printFont.className} ${model.orientation === 'landscape' ? styles.landscape : ''}`}
      data-print-sheet={model.kind}
      dir={dir}
      lang={head.locale}
    >
      {draft ? (
        <div aria-hidden="true" className={styles.watermark}>
          {head.labels.watermark}
        </div>
      ) : null}
      <div className={styles.sheet}>
        <header className={styles.head}>
          <Image alt="" loading="eager" src={mainLogo} />
          <div className={styles.company}>
            <strong>{names[0]}</strong>
            <span>{names[1]}</span>
          </div>
          <div className={styles.provenanceBlock}>
            <span>{`${head.labels.branch}: ${head.branch}`}</span>
            <span>{`${head.labels.printedAt}: ${printedAt(head.printedAt, head.locale)}`}</span>
            <span>{`${head.labels.printedBy}: ${head.printedBy}`}</span>
          </div>
        </header>

        <div className={styles.titleRow}>
          <h1 className={styles.title}>{model.title}</h1>
          {model.number ? (
            <bdi className={styles.number} dir="ltr">
              {model.number}
            </bdi>
          ) : null}
        </div>

        {model.fields.length > 0 ? <Facts facts={model.fields} /> : null}
        {model.filters.length > 0 ? (
          <>
            <h2 className={styles.subTitle}>{head.labels.filters}</h2>
            <Facts facts={model.filters} />
          </>
        ) : null}

        {model.tables.map((table, index) => (
          <SheetTable head={head} key={index} model={model} table={table} />
        ))}

        {model.summary.length > 0 ? (
          <dl className={styles.summary}>
            {model.summary.map((fact, index) => (
              <div key={`${index}:${fact.label}`}>
                <dt>{fact.label}</dt>
                <dd>{fact.ltr ? <bdi dir="ltr">{fact.value}</bdi> : fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {model.signatures ? (
          <div className={styles.signatureBoxes}>
            <span>{head.labels.preparedBy}</span>
            <span>{head.labels.approvedBy}</span>
            <span>{head.labels.receivedBy}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Facts({ facts }: { readonly facts: PrintModel['fields'] }) {
  return (
    <dl className={styles.facts}>
      {facts.map((fact, index) => (
        <div key={`${index}:${fact.label}`}>
          <dt>{fact.label}</dt>
          <dd>{fact.ltr ? <bdi dir="ltr">{fact.value || '—'}</bdi> : <bdi dir="auto">{fact.value || '—'}</bdi>}</dd>
        </div>
      ))}
    </dl>
  );
}

function SheetTable({
  model,
  table,
  head,
}: {
  readonly model: PrintModel;
  readonly table: Table;
  readonly head: Letterhead;
}) {
  const totals = table.totals;
  const first = totals ? table.columns.findIndex((column) => (totals.cells[column.key] ?? null) !== null) : -1;
  const span = first <= 0 ? 1 : first;
  return (
    <>
      {table.title ? <h2 className={styles.subTitle}>{table.title}</h2> : null}
      <table className={styles.lines}>
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th className={isNumeric(column) ? styles.num : undefined} key={column.key} scope="col">
                {heading(column, model)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td colSpan={table.columns.length}>{table.empty}</td>
            </tr>
          ) : null}
          {table.rows.map((row, index) => (
            <tr data-tone={row.tone ?? 'line'} key={index}>
              {table.columns.map((column, i) => {
                const text = display(column, row.cells[column.key] ?? null, model, head.locale);
                return (
                  <td
                    className={isNumeric(column) ? styles.num : undefined}
                    key={column.key}
                    style={i === 0 && row.depth ? { paddingInlineStart: `${2 + row.depth * 3}mm` } : undefined}
                  >
                    {column.kind === 'text' ? <bdi dir="auto">{text}</bdi> : <bdi dir="ltr">{text}</bdi>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {totals ? (
          <tfoot>
            <tr>
              <td colSpan={span}>{totals.label}</td>
              {table.columns.slice(span).map((column) => (
                <td className={isNumeric(column) ? styles.num : undefined} key={column.key}>
                  <bdi dir="ltr">{display(column, totals.cells[column.key] ?? null, model, head.locale)}</bdi>
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </>
  );
}
