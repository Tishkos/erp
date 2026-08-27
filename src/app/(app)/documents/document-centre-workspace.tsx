'use client';

import Link from 'next/link';
import {
  Archive,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FilePlus2,
  Files,
  FileText,
  FolderOpen,
  Inbox,
  LayoutTemplate,
  ListChecks,
  Search,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import styles from './document-centre-workspace.module.css';

export interface DocumentWorkspaceItem {
  readonly key: string;
  readonly label: string;
  readonly href: string | null;
  readonly phase: string;
  readonly phaseHint: string;
}

export interface DocumentCentreLabels {
  readonly module: string;
  readonly title: string;
  readonly subtitle: string;
  readonly upload: string;
  readonly newDocument: string;
  readonly previewBadge: string;
  readonly previewNotice: string;
  readonly workspaces: string;
  readonly workspacesHint: string;
  readonly recent: string;
  readonly recentEmpty: string;
  readonly recentEmptyHint: string;
  readonly openWorkspace: string;
  readonly all: string;
  readonly available: string;
  readonly planned: string;
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly filters: string;
  readonly clearSearch: string;
  readonly noResults: string;
  readonly noResultsHint: string;
  readonly pending: string;
  readonly phaseExplanation: string;
  readonly noAccessTitle: string;
  readonly noAccessDescription: string;
  readonly close: string;
}

interface DocumentCentreWorkspaceProps {
  readonly items: readonly DocumentWorkspaceItem[];
  readonly labels: DocumentCentreLabels;
  readonly locale: string;
}

type WorkspaceFilter = 'all' | 'available' | 'planned';

const ICONS: Readonly<Record<string, LucideIcon>> = {
  document_centre: FolderOpen,
  templates: LayoutTemplate,
  checklists: ListChecks,
  expiring_documents: CalendarClock,
  tasks: ClipboardCheck,
  notes: StickyNote,
  retention: Archive,
  document_audit: ShieldCheck,
};

function cardTone(key: string): string {
  switch (key) {
    case 'templates':
    case 'notes':
      return styles.tonePurple!;
    case 'checklists':
    case 'document_audit':
      return styles.toneGreen!;
    case 'expiring_documents':
    case 'retention':
      return styles.toneOrange!;
    case 'tasks':
      return styles.toneTeal!;
    default:
      return styles.toneBlue!;
  }
}

function WorkspaceCard({
  item,
  labels,
}: {
  readonly item: DocumentWorkspaceItem;
  readonly labels: DocumentCentreLabels;
}) {
  const Icon = ICONS[item.key] ?? FileText;
  const available = item.href !== null;
  const content: ReactNode = (
    <>
      <div className={styles.cardTopline}>
        <span className={styles.cardIcon}>
          <Icon aria-hidden="true" />
        </span>
        <span className={`${styles.statusBadge} ${available ? styles.available : styles.planned}`}>
          {available ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
          {available ? labels.available : labels.planned}
        </span>
      </div>
      <div className={styles.cardCopy}>
        <h3>{item.label}</h3>
        <p>{available ? labels.workspacesHint : item.phaseHint}</p>
      </div>
      <span className={styles.cardFooter}>
        {available ? (
          <>
            <span>{labels.openWorkspace}</span>
            <ArrowRight className={styles.directionalIcon} aria-hidden="true" />
          </>
        ) : (
          <>
            <span>{labels.pending}</span>
          </>
        )}
      </span>
    </>
  );

  const cardClassName = `${styles.workspaceCard} ${cardTone(item.key)} ${
    available ? styles.workspaceCardLink : styles.workspaceCardPending
  }`;

  if (item.href) {
    return (
      <Link
        className={cardClassName}
        href={item.href}
        aria-current={item.href === '/documents' ? 'page' : undefined}
      >
        {content}
      </Link>
    );
  }

  return <article className={cardClassName}>{content}</article>;
}

export function DocumentCentreWorkspace({
  items,
  labels,
  locale,
}: DocumentCentreWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<WorkspaceFilter>('all');
  const [showPreviewNotice, setShowPreviewNotice] = useState(false);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const availableCount = items.filter((item) => item.href !== null).length;
  const plannedCount = items.length - availableCount;

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return items.filter((item) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'available' && item.href !== null) ||
        (filter === 'planned' && item.href === null);
      const matchesQuery =
        needle.length === 0 || item.label.toLocaleLowerCase(locale).includes(needle);
      return matchesFilter && matchesQuery;
    });
  }, [filter, items, locale, query]);

  const filters: readonly {
    readonly key: WorkspaceFilter;
    readonly label: string;
    readonly count: number;
  }[] = [
    { key: 'all', label: labels.all, count: items.length },
    { key: 'available', label: labels.available, count: availableCount },
    { key: 'planned', label: labels.planned, count: plannedCount },
  ];

  const revealPreviewNotice = () => setShowPreviewNotice(true);

  return (
    <div className={styles.workspace}>
      <section className={styles.hero} aria-labelledby="document-centre-title">
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>
            <span>
              <Files aria-hidden="true" />
              {labels.module}
            </span>
          </div>
          <h1 id="document-centre-title">{labels.title}</h1>
          <p>{labels.subtitle}</p>
        </div>
      </section>


      {items.length > 0 ? (
        <section className={styles.controlPanel} aria-label={labels.filters}>
          <form className={styles.controlBar} role="search" onSubmit={(event) => event.preventDefault()}>
            <label className={styles.searchField}>
              <span className={styles.srOnly}>{labels.search}</span>
              <Search aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={labels.searchPlaceholder}
                aria-label={labels.search}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={labels.clearSearch}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className={styles.filterGroup} role="group" aria-label={labels.filters}>
              {filters.map((option) => (
                <button
                  className={filter === option.key ? styles.activeFilter : undefined}
                  key={option.key}
                  type="button"
                  aria-pressed={filter === option.key}
                  onClick={() => setFilter(option.key)}
                >
                  <span>{option.label}</span>
                  <bdi dir="ltr">{number.format(option.count)}</bdi>
                </button>
              ))}
            </div>
          </form>
        </section>
      ) : null}

      <section className={styles.workspacesSection} aria-labelledby="document-workspaces-title">
        <header className={styles.sectionHeader}>
          <div>
            <span className={styles.sectionIcon}>
              <FolderOpen aria-hidden="true" />
            </span>
            <div>
              <h2 id="document-workspaces-title">{labels.workspaces}</h2>
              <p>{labels.workspacesHint}</p>
            </div>
          </div>
          {items.length > 0 ? (
            <span className={styles.resultCount} aria-live="polite">
              <bdi dir="ltr">{number.format(filteredItems.length)}</bdi>
              <span aria-hidden="true">/</span>
              <bdi dir="ltr">{number.format(items.length)}</bdi>
            </span>
          ) : null}
        </header>

        {items.length === 0 ? (
          <div className={styles.accessState} role="status">
            <span className={styles.emptyIcon}>
              <ShieldAlert aria-hidden="true" />
            </span>
            <h3>{labels.noAccessTitle}</h3>
            <p>{labels.noAccessDescription}</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className={styles.accessState} role="status">
            <span className={styles.emptyIcon}>
              <SearchX aria-hidden="true" />
            </span>
            <h3>{labels.noResults}</h3>
            <p>{labels.noResultsHint}</p>
          </div>
        ) : (
          <div className={styles.cardGrid}>
            {filteredItems.map((item) => (
              <WorkspaceCard item={item} labels={labels} key={item.key} />
            ))}
          </div>
        )}

        {items.some((item) => item.href === null) ? (
          <aside className={styles.roadmapNote}>
            <Clock3 aria-hidden="true" />
            <p>{labels.phaseExplanation}</p>
          </aside>
        ) : null}
      </section>

      <section className={styles.recentPanel} aria-labelledby="recent-documents-title">
        <header className={styles.sectionHeader}>
          <div>
            <span className={styles.sectionIcon}>
              <Clock3 aria-hidden="true" />
            </span>
            <h2 id="recent-documents-title">{labels.recent}</h2>
          </div>
        </header>
        <div className={styles.recentEmpty}>
          <span className={styles.documentStack} aria-hidden="true">
            <FileText />
            <Inbox />
          </span>
          <div>
            <h3>{labels.recentEmpty}</h3>
            <p>{labels.recentEmptyHint}</p>
          </div>
        </div>
      </section>

    </div>
  );
}
