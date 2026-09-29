import type { ReactNode } from 'react';
import Link from 'next/link';
import admin from './admin.module.css';

/**
 * One band of the dashboard, in the window every document already wears.
 *
 * Deliberately built from the same `sap*` classes as `DocumentWindow` rather
 * than from a stylesheet of its own: the dashboard is the first screen anyone
 * sees, and a landing page drawn in a design the rest of the application does
 * not use teaches people that this screen is a different kind of thing. It is
 * not. It is a window onto documents, shaped like the documents.
 *
 * **A band with nothing in it is not rendered.** That decision belongs to the
 * caller — the page does not render `<Band>` at all when its rows are empty or
 * its permission is absent — because a heading over an empty box is worse than
 * silence: it is a promise the screen does not keep, and people learn to scroll
 * past it. This mirrors `SectionTabs`, which refuses to draw a row of one.
 */
export function Band({
  title,
  count,
  href,
  hrefLabel,
  children,
}: {
  readonly title: string;
  /** How many rows are behind it, shown as the grid count badge. */
  readonly count?: number | undefined;
  /** Where the whole band is read properly. */
  readonly href?: string | undefined;
  readonly hrefLabel?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className={admin.sapWindow}>
      <div className={admin.sapTitle}>
        <span>
          {title}
          {count === undefined ? null : <span className={admin.sapGridCount}>{count}</span>}
        </span>
        {href && hrefLabel ? (
          <span className={admin.sapTitleActions}>
            <Link className={admin.sapPlainLink} href={href}>
              {hrefLabel}
            </Link>
          </span>
        ) : null}
      </div>
      <div className={admin.sapBody}>{children}</div>
    </div>
  );
}

/**
 * A row of figures — the grid of labelled boxes a document header uses.
 *
 * `Figure` takes its value already formatted. Nothing here rounds, converts or
 * re-adds: every number on the dashboard is a figure a service returned, so it
 * cannot disagree with the report it came from.
 */
export function Figures({ children }: { readonly children: ReactNode }) {
  return <div className={admin.sapFields}>{children}</div>;
}

export function Figure({
  label,
  value,
  href,
  tone,
}: {
  readonly label: string;
  readonly value: ReactNode;
  /** Where the figure is proved. A figure nobody can check is decoration. */
  readonly href?: string | undefined;
  /** `warn` for a figure that is a problem by its nature — money overdue. */
  readonly tone?: 'warn' | undefined;
}) {
  const box = (
    <span className={tone === 'warn' ? `${admin.sapBox} ${admin.sapWarn}` : admin.sapBox}>
      <bdi dir="ltr">{value}</bdi>
    </span>
  );
  return (
    <div className={admin.sapField}>
      <span className={admin.sapLabel}>{label}</span>
      {href ? (
        <Link className={admin.sapPlainLink} href={href}>
          {box}
        </Link>
      ) : (
        box
      )}
    </div>
  );
}

/** The rows of a band, in the table every document's lines use. */
export function BandTable({
  headings,
  children,
}: {
  readonly headings: readonly (string | { readonly label: string; readonly numeric: true })[];
  readonly children: ReactNode;
}) {
  return (
    <div className={admin.sapTableWrap}>
      <table className={admin.sapTable}>
        <thead>
          <tr>
            {headings.map((heading) => {
              const label = typeof heading === 'string' ? heading : heading.label;
              return (
                <th
                  className={typeof heading === 'string' ? undefined : admin.sapNum}
                  key={label}
                  scope="col"
                >
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
