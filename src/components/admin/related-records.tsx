import { Fragment } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { cn } from '@/components/intent/cn';
import { Panel } from '@/components/ui';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { relationshipsHref, stepKey, toneOf, type RelGraph, type RelNode, type RelStep } from '@/server/domain/relationships';
import { formatFacts } from '@/server/services/exception-text';

/**
 * Related records — platform phase, Agent 9: the chain of real records around an import, a supplier, a
 * customer or an item, drawn in the Home import journey's own language (a row of numbered status chips, one
 * per step, toned by whether the step has records) with the records beneath as a register.
 *
 * Two dressings of one thing, each copying the screen it sits on:
 *   * `window` — a stacked `sapDoc` section, the way the import page and the supplier statement stack theirs;
 *   * `panel`  — a flush `Panel` with the list table, the way the partner and item profiles stack theirs.
 *
 * The graph arrives already filtered for the viewer (`services/relationships.graphFor`): a step they may not
 * open is not in it, so nothing here decides who sees what. This file only words and draws. Existing classes
 * only; no client code.
 */
/** A note inside the card keeps the card's inset instead of touching its edges. */
const HINT = 'mx-5 mt-4';

export async function RelatedRecords({
  graph,
  variant,
  linkToChain = true,
}: {
  readonly graph: RelGraph;
  readonly variant: 'window' | 'panel';
  /** The page of the whole chain is the one that already shows it all. */
  readonly linkToChain?: boolean;
}) {
  const [r, status, stock, locale] = await Promise.all([
    getTranslations('admin.relationships'),
    getTranslations('status'),
    getTranslations('admin.stock_movements'),
    getLocale(),
  ]);
  const place = locale as Locale;
  const { root } = graph;
  const chainHref = relationshipsHref(root.kind, root.key);

  // The chain as a stepper (the Intent UI redesign): the numbered status chips with a chevron between each
  // step and the next, on the same inset as the rest of the card.
  const chips = (
    <span className={cn(s.inlineRow, 'flex flex-wrap items-center gap-1.5 px-5 py-3')}>
      {graph.steps.map((step, index) => {
        const tone = step.state === 'present' ? 'approved' : step.state === 'pending' ? 'draft' : 'submitted';
        const count = step.nodes.length + step.more;
        return (
          <Fragment key={step.code}>
            {index > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-fg rtl:-scale-x-100" /> : null}
            <span
              className={`status status--${tone}`}
              data-status={tone}
              title={step.state === 'present' ? r('chip_present') : step.state === 'pending' ? r('not_yet') : r('unavailable')}
            >
              <bdi dir="auto">{`${index + 1}. ${r(`step.${stepKey(step.code)}`)}`}</bdi>
              {step.state === 'present' ? (
                <>
                  {' · '}
                  <bdi className="tabular-nums" dir="ltr">{`${count}${step.truncated ? '+' : ''}`}</bdi>
                </>
              ) : null}
            </span>
          </Fragment>
        );
      })}
    </span>
  );

  const wording = (node: RelNode): string => {
    if (node.label) return node.label;
    return r.has(`node.${node.kind}`) ? r(`node.${node.kind}`) : '—';
  };

  const noteText = (node: RelNode): string => {
    if (!node.note) return '';
    const key = `note.${node.note.key}`;
    if (!r.has(key)) return '';
    const params: Record<string, string | number> = { ...node.note.params };
    // A movement's type is worded by the Stock Movement page's own words.
    if (typeof params.movementType === 'string') {
      params.movementType = stock.has(`type.${params.movementType}`) ? stock(`type.${params.movementType}`) : '';
    }
    return r(key, formatFacts(params, place));
  };

  const statusText = (node: RelNode): string | null => {
    if (node.statusName) return node.statusName;
    if (!node.status) return null;
    if (status.has(node.status)) return status(node.status);
    return r.has(`status.${node.status}`) ? r(`status.${node.status}`) : null;
  };

  const figureText = (node: RelNode): string => {
    if (!node.figure) return '—';
    if (node.figure.kind === 'amountIqd') return formatMoney(node.figure.value, 'IQD', place);
    if (node.figure.kind === 'quantity') return formatQuantity(node.figure.value, place);
    return node.figure.value;
  };

  // The register spans the card edge to edge (no box of its own inside the card), rows divided, no column rules.
  const tableWrap = cn(variant === 'window' ? s.sapTableWrap : 'table-wrap', 'rounded-none border-x-0');
  const tableClass = cn(variant === 'window' ? s.sapTable : 'list', '[&_td+td]:border-s-0 [&_th+th]:border-s-0');
  const numeric = variant === 'window' ? s.sapNum : 'numeric';

  const columns = 6;
  const row = (step: RelStep, node: RelNode) => {
    const text = statusText(node);
    const tone = toneOf(node.status);
    return (
      <tr key={`${step.code}|${node.key}`}>
        <td>
          <bdi dir="auto">{r(`step.${stepKey(step.code)}`)}</bdi>
        </td>
        <td>
          {node.href ? (
            <Link className={s.sapLink} href={node.href}>
              <bdi dir="auto">{wording(node)}</bdi>
            </Link>
          ) : (
            <bdi dir="auto">{wording(node)}</bdi>
          )}
          {noteText(node) ? (
            <>
              <br />
              <span className="muted text-xs">
                <bdi dir="auto">{noteText(node)}</bdi>
              </span>
            </>
          ) : null}
        </td>
        <td>
          <bdi dir="auto">{node.from ?? '—'}</bdi>
        </td>
        <td>
          <bdi dir="ltr">{node.date ? formatBusinessDate(node.date, place) : '—'}</bdi>
        </td>
        <td>
          {text ? (
            <span className={`status status--${tone} ${variant === 'window' ? s.sapRegisterStatus : ''}`.trim()} data-status={tone}>
              {text}
            </span>
          ) : (
            '—'
          )}
        </td>
        <td className={numeric}>
          <bdi dir="ltr">{figureText(node)}</bdi>
        </td>
      </tr>
    );
  };

  const body = (
    <>
      <p className={cn(s.sectionHint, HINT, 'mb-0')}>
        <bdi dir="auto">{r('root_line', { kind: r(`kind.${root.kind}`), label: root.label, name: root.name ?? '' })}</bdi>
      </p>
      {graph.steps.length === 0 ? (
        <p className={cn(s.sectionHint, HINT, 'mb-0')}>{r('none')}</p>
      ) : (
        <>
          {chips}
          <div className={tableWrap}>
            <table aria-label={r('title')} className={tableClass}>
              <thead>
                <tr>
                  <th scope="col">{r('col_step')}</th>
                  <th scope="col">{r('col_record')}</th>
                  <th scope="col">{r('col_from')}</th>
                  <th scope="col">{r('col_date')}</th>
                  <th scope="col">{r('col_status')}</th>
                  <th className={numeric} scope="col">
                    {r('col_figure')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {graph.steps.map((step) => {
                  if (step.state === 'pending' || step.state === 'unavailable') {
                    return (
                      <tr key={step.code}>
                        <td>
                          <bdi dir="auto">{r(`step.${stepKey(step.code)}`)}</bdi>
                        </td>
                        <td colSpan={columns - 1}>{step.state === 'pending' ? r('not_yet') : r('unavailable')}</td>
                      </tr>
                    );
                  }
                  return [
                    ...step.nodes.map((node) => row(step, node)),
                    step.more > 0 || step.truncated ? (
                      <tr key={`${step.code}|more`}>
                        <td />
                        <td colSpan={columns - 1}>
                          <span className="muted">{step.truncated ? r('more_unknown') : r('more', { count: step.more })}</span>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className={cn(s.sectionHint, HINT, 'mb-4')}>{r('scope_hint')}</p>
    </>
  );

  if (variant === 'panel') {
    return (
      <Panel flush title={r('title')}>
        {body}
        {linkToChain ? (
          <p className={cn(s.sectionHint, HINT, 'mb-4 mt-0')}>
            <Link className={s.sapPlainLink} href={chainHref}>
              {r('open_chain')}
            </Link>
          </p>
        ) : null}
      </Panel>
    );
  }

  return (
    <section aria-labelledby="related-records-title" className={s.sapDoc} id="related-records">
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="related-records-title">
          <span>{r('title')}</span>
          <span className={s.sapTitleMeta}>
            {linkToChain ? (
              <Link className={s.sapLink} href={chainHref}>
                {r('open_chain')}
              </Link>
            ) : (
              r('steps_shown', { count: graph.steps.length })
            )}
          </span>
        </h2>
        {body}
      </div>
    </section>
  );
}
