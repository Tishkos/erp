import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { LiveRefresh } from '@/components/admin/live-refresh';
import { type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { INITIATION_KINDS, guideNumber, isInitiationKind, stagesOf, type InitiationKind } from '@domain/project-initiation';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as initiation from '@/server/services/project-initiation';

/**
 * Pipeline Board (2026-10-21, by direction: "live updates tracking from each,
 * contains own code") — every client as a card with its own number, in the
 * column where it stands: Leads, Opportunities, Projects (converted in the
 * last thirty days) and Lost; with a road chosen, one column per stage of that
 * road. The board redraws itself when anything on it moves (`LiveRefresh`),
 * so the team watches clients go from lead to project. It reads; every change
 * is made on the record.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/projects/pipeline';

interface Column {
  readonly key: string;
  readonly title: string;
  readonly cards: readonly initiation.BoardCard[];
}

export default async function PipelineBoardPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute(ROUTE)) notFound();
  const [t, x, page, locale, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.project_initiation'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', initiation.PERMISSION_OBJECT)) {
    return <Denied object={page('project_board')} />;
  }
  const params = await searchParams;
  const one = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const kind: InitiationKind | null = isInitiationKind(one('kind')) ? (one('kind') as InitiationKind) : null;
  const mine = one('owner') === 'me';

  const { board, version } = await withCurrentUser(async (tx) => ({
    board: await initiation.board(tx, { kind, ownerUserId: mine ? principal.userId : null }),
    version: await initiation.liveVersion(tx),
  }));

  const open = board.cards.filter((card) => card.status === 'open');
  const won = board.cards.filter((card) => card.status === 'converted');
  const lost = board.cards.filter((card) => card.status === 'lost');
  const columns: Column[] = kind
    ? [
        ...stagesOf(kind).map((stage) => ({
          key: stage,
          title: `${guideNumber(stage)} · ${x(`stage.${stage}`)}`,
          cards: open.filter((card) => card.stage === stage),
        })),
        { key: 'project', title: x('board_column.project'), cards: won },
        { key: 'lost', title: x('board_column.lost'), cards: lost },
      ]
    : [
        { key: 'lead', title: x('board_column.lead'), cards: open.filter((card) => card.phase === 'lead') },
        { key: 'opportunity', title: x('board_column.opportunity'), cards: open.filter((card) => card.phase === 'opportunity') },
        { key: 'project', title: x('board_column.project'), cards: won },
        { key: 'lost', title: x('board_column.lost'), cards: lost },
      ];

  const money = (value: string | null) => (value ? formatMoney(value, 'IQD', locale as Locale) : null);

  return (
    <AdminPage
      actions={<LiveRefresh endpoint="/projects/pipeline/version" label={x('live')} version={version} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x('board_subtitle')}
      tabs={<SectionTabs route={ROUTE} />}
      title={page('project_board')}
      variant="sap"
    >
      <section aria-labelledby="pipeline-board-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pipeline-board-title">
            <span>{page('project_board')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: board.cards.length })}</span>
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={kind ?? ''} emptyLabel={x('kind_all')} label={x('kind')} name="kind" options={INITIATION_KINDS.map((value) => ({ value, label: x(`kind_option.${value}`) }))} />
              <Select
                defaultValue={mine ? 'me' : ''}
                emptyLabel={x('owner_everyone')}
                label={x('owner')}
                name="owner"
                options={[{ value: 'me', label: x('owner_me') }]}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {board.truncated ? <p className={`${s.sapNote} mx-4 mb-2`}>{x('board_truncated')}</p> : null}

          {/* Columns side by side on a wide screen, scrolled within the board; stacked on a phone. */}
          <div className="grid grid-cols-1 gap-3 p-4 md:auto-cols-[minmax(15rem,1fr)] md:grid-flow-col md:grid-cols-none md:overflow-x-auto" data-pipeline-board="">
            {columns.map((column) => (
              <section aria-labelledby={`board-${column.key}`} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-muted/40 p-2" data-board-column={column.key} key={column.key}>
                <h3 className="flex items-center justify-between gap-2 px-1 text-sm font-semibold" id={`board-${column.key}`}>
                  <span className="[overflow-wrap:anywhere]">{column.title}</span>
                  <span className="rounded-md bg-overlay px-1.5 py-0.5 text-xs text-muted-fg tabular-nums">{column.cards.length}</span>
                </h3>
                {column.cards.length === 0 ? <p className="px-1 py-2 text-xs text-muted-fg">{x('board_empty')}</p> : null}
                <ul className="flex flex-col gap-2">
                  {column.cards.map((card) => {
                    const value = money(card.valueIqd);
                    return (
                      <li className="rounded-md border border-border bg-overlay p-2.5 text-sm shadow-xs" data-board-card={card.initiationNo} key={card.initiationNo}>
                        <div className="flex items-center justify-between gap-2">
                          <Link className={`${s.sapLink} font-medium`} href={`/projects/initiation/${encodeURIComponent(card.initiationNo)}`}>
                            <bdi dir="ltr">{card.initiationNo}</bdi>
                          </Link>
                          <span className="text-xs text-muted-fg">{x(`kind_option.${card.kind}`)}</span>
                        </div>
                        <p className="mt-1 font-medium [overflow-wrap:anywhere]">
                          <bdi dir="auto">{card.title}</bdi>
                        </p>
                        <p className="text-muted-fg [overflow-wrap:anywhere]">
                          <bdi dir="auto">{[card.customerName, card.customerCity].filter(Boolean).join(' · ')}</bdi>
                        </p>
                        {kind ? null : (
                          <p className="mt-1 text-xs">
                            <bdi dir="auto">{`${guideNumber(card.stage)} · ${x(`stage.${card.stage}`)}`}</bdi>
                          </p>
                        )}
                        {card.projectCode ? (
                          <p className="mt-1 text-xs">
                            <Link className={s.sapLink} href={`/projects/${encodeURIComponent(card.projectCode)}`}>
                              <bdi dir="ltr">{card.projectCode}</bdi>
                            </Link>
                          </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-fg">
                          <bdi dir="auto">{card.ownerName ?? '—'}</bdi>
                          {value ? <bdi dir="ltr">{value}</bdi> : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-fg" title={x('last_update')}>
                          <bdi dir="ltr">{formatTimestamp(card.updatedAt.toISOString(), locale as Locale)}</bdi>
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
