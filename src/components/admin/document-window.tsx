import type { ReactNode } from 'react';
import Link from 'next/link';
import { History } from 'lucide-react';
import admin from './admin.module.css';

/**
 * The document window — the chrome a Journal Entry wears.
 *
 * A titled window with the document's type and number, its header fields in
 * boxes, a disclosed grid of lines, and a foot holding what may be done to it
 * beside what it comes to. Every operations document now wears it, by sharing
 * this rather than by six files agreeing to look alike — which they would
 * stop doing the first time one of them was edited.
 *
 * Deliberately not on `AdminPage`'s `actions`: a document's verbs belong at the
 * bottom of the document, next to its totals, where somebody arrives after
 * reading it rather than before.
 */
export interface DocumentField {
  readonly label: string;
  readonly value: ReactNode;
  /** Renders as a status chip, the way the entry's status does. */
  readonly status?: string | undefined;
  /** Spans the row, for a description or a reason. */
  readonly wide?: boolean;
}

export interface DocumentTotal {
  readonly label: string;
  readonly value: string;
}

export function DocumentWindow({
  documentType,
  number,
  fields,
  linesTitle,
  linesCount,
  children,
  actions,
  totals = [],
  auditHref,
  auditLabel,
  id = 'document',
}: {
  /** What kind of document this is — "Purchase Invoice". */
  readonly documentType: string;
  /** Its own number, shown beside the type and again in the fields. */
  readonly number: string;
  readonly fields: readonly DocumentField[];
  readonly linesTitle: string;
  readonly linesCount: number;
  /** The lines table. */
  readonly children: ReactNode;
  /** What may be done to it, at the foot. */
  readonly actions?: ReactNode;
  readonly totals?: readonly DocumentTotal[];
  readonly auditHref?: string | undefined;
  readonly auditLabel?: string | undefined;
  readonly id?: string;
}) {
  const headingId = `${id}-lines-heading`;

  return (
    <div className={admin.sapDoc} id={id}>
      <div className={admin.sapWindow}>
        <div className={admin.sapTitle}>
          <span>
            {documentType}{' '}
            <span className={admin.sapTitleMeta}>
              <bdi dir="ltr">{number}</bdi>
            </span>
          </span>
          {auditHref && auditLabel ? (
            <span className={admin.sapTitleActions}>
              <Link className={admin.sapIconButton} href={auditHref} title={auditLabel}>
                <History aria-hidden="true" />
                <span>{auditLabel}</span>
              </Link>
            </span>
          ) : null}
        </div>

        <div className={admin.sapBody}>
          <div className={admin.sapFields}>
            {fields.map((field) => (
              <div
                className={admin.sapField}
                key={field.label}
                {...(field.wide ? { style: { gridColumn: '1 / -1' } } : {})}
              >
                <span className={admin.sapLabel}>{field.label}</span>
                {field.status ? (
                  <span className={`${admin.sapBox} ${admin.sapStatus}`} data-status={field.status}>
                    {field.value}
                  </span>
                ) : (
                  <span className={admin.sapBox}>{field.value}</span>
                )}
              </div>
            ))}
          </div>

          <div className={admin.sapGridCaption} id={headingId}>
            <span aria-hidden="true" className={admin.sapDisclosure}>
              ▾
            </span>
            <strong>{linesTitle}</strong>
            <span className={admin.sapGridCount}>{linesCount}</span>
          </div>

          <div className={`${admin.sapTableWrap} ${admin.sapLineTableWrap}`}>{children}</div>
        </div>

        {actions || totals.length > 0 ? (
          <div className={admin.sapFoot}>
            <div className={admin.sapFootActions}>{actions}</div>
            {totals.length > 0 ? (
              <div className={admin.sapFootTotals}>
                {totals.map((total) => (
                  <div className={admin.sapFootTotal} key={total.label}>
                    <span>{total.label}</span>
                    <strong>
                      <bdi dir="ltr">{total.value}</bdi>
                    </strong>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
