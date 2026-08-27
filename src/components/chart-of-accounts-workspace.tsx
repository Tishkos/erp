'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  BookOpen,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Download,
  Eye,
  FileText,
  Folder,
  GitBranch,
  Info,
  Landmark,
  PanelRightOpen,
  Plus,
  ReceiptText,
  Scale,
  Search as SearchIcon,
  Settings2,
  SlidersHorizontal,
  Star,
  TrendingUp,
  Upload,
  WalletCards,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

const COLUMN_ORDER = [
  'code',
  'name',
  'account_type',
  'currency_restriction',
  'status',
  'is_group',
  'is_active',
  'level',
  'control_account',
] as const;
type ColumnKey = (typeof COLUMN_ORDER)[number];

const DEFAULT_VISIBLE_COLUMNS: readonly ColumnKey[] = [
  'code',
  'name',
  'account_type',
  'currency_restriction',
  'status',
];

const ACCOUNT_TYPE_ICONS: Readonly<Record<AccountType, LucideIcon>> = {
  asset: Landmark,
  liability: Scale,
  equity: WalletCards,
  revenue: TrendingUp,
  expense: ReceiptText,
};

interface SerializableListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly columns: readonly string[];
}

export interface ChartOfAccountsWorkspaceProps {
  readonly rows: readonly Record<string, unknown>[];
  readonly query: SerializableListQuery;
  readonly total: number | null;
  readonly search: string;
}

interface AccountRow {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly status: string;
  readonly isGroup: boolean;
  readonly isActive: boolean;
  readonly level: number;
  readonly controlAccount: string;
  readonly currencyRestriction: string;
}

type PreviewDialog = 'import' | 'new' | null;

function textValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function levelValue(value: unknown): number {
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 ? Math.min(level, 12) : 0;
}

function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

function normaliseAccount(row: Record<string, unknown>, index: number): AccountRow {
  const code = textValue(row.code);
  return {
    key: textValue(row.id) || code || `account-${index}`,
    code,
    name: textValue(row.name),
    accountType: textValue(row.account_type),
    status: textValue(row.status),
    isGroup: booleanValue(row.is_group),
    isActive: booleanValue(row.is_active),
    level: levelValue(row.level),
    controlAccount: textValue(row.control_account),
    currencyRestriction: textValue(row.currency_restriction),
  };
}

function initialColumns(available: readonly ColumnKey[]): ColumnKey[] {
  const preferred = DEFAULT_VISIBLE_COLUMNS.filter((key) => available.includes(key));
  if (preferred.length > 0) return [...preferred];
  return available.slice(0, 5);
}

function safeStatusClass(status: string): string {
  const safe = status.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return safe || 'unknown';
}

export function ChartOfAccountsWorkspace({
  rows,
  query,
  total,
  search,
}: ChartOfAccountsWorkspaceProps) {
  const chart = useTranslations('chart');
  const list = useTranslations('list');
  const status = useTranslations('status');
  const column = useTranslations('column');
  const locale = useLocale();

  const accounts = useMemo(() => rows.map(normaliseAccount), [rows]);
  const availableColumns = useMemo(
    () => COLUMN_ORDER.filter((key) => query.columns.includes(key)),
    [query.columns],
  );
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [selectedKey, setSelectedKey] = useState<string | null>(() => accounts[0]?.key ?? null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(() =>
    initialColumns(availableColumns),
  );
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [structureFilter, setStructureFilter] = useState('all');
  const [activityFilter, setActivityFilter] = useState('all');
  const [currencyFilter, setCurrencyFilter] = useState('all');
  const [previewDialog, setPreviewDialog] = useState<PreviewDialog>(null);
  const [previewNotice, setPreviewNotice] = useState(false);
  const [favourite, setFavourite] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setVisibleColumns((current) => {
      const retained = current.filter((key) => availableColumns.includes(key));
      if (availableColumns.includes('code') && !retained.includes('code')) retained.unshift('code');
      return retained.length > 0 ? retained : initialColumns(availableColumns);
    });
  }, [availableColumns]);

  useEffect(() => {
    if (accounts.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!accounts.some((account) => account.key === selectedKey)) {
      setSelectedKey(accounts[0]!.key);
    }
  }, [accounts, selectedKey]);

  useEffect(() => {
    if (!previewDialog) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    const cancel = (event: Event) => {
      event.preventDefault();
      setPreviewDialog(null);
    };
    dialog.addEventListener('cancel', cancel);

    return () => {
      dialog.removeEventListener('cancel', cancel);
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, [previewDialog]);

  const currencyOptions = useMemo(
    () =>
      [...new Set(accounts.map((account) => account.currencyRestriction).filter(Boolean))].sort(
        (first, second) => first.localeCompare(second, 'en'),
      ),
    [accounts],
  );

  const parentByKey = useMemo(() => {
    const parents = new Map<string, AccountRow | null>();
    const ancestors: AccountRow[] = [];
    for (const account of accounts) {
      while (
        ancestors.length > 0 &&
        ancestors[ancestors.length - 1]!.level >= account.level
      ) {
        ancestors.pop();
      }
      parents.set(account.key, ancestors[ancestors.length - 1] ?? null);
      ancestors.push(account);
    }
    return parents;
  }, [accounts]);

  const hierarchyVisibleKeys = useMemo(() => {
    const visible = new Set<string>();
    const ancestors: AccountRow[] = [];
    for (const account of accounts) {
      while (
        ancestors.length > 0 &&
        ancestors[ancestors.length - 1]!.level >= account.level
      ) {
        ancestors.pop();
      }
      if (!ancestors.some((ancestor) => collapsed.has(ancestor.key))) visible.add(account.key);
      if (account.isGroup) ancestors.push(account);
    }
    return visible;
  }, [accounts, collapsed]);

  const shownAccounts = useMemo(
    () =>
      accounts.filter((account) => {
        if (!hierarchyVisibleKeys.has(account.key)) return false;
        if (typeFilter !== 'all' && account.accountType !== typeFilter) return false;
        if (statusFilter !== 'all' && account.status !== statusFilter) return false;
        if (structureFilter === 'group' && !account.isGroup) return false;
        if (structureFilter === 'posting' && account.isGroup) return false;
        if (activityFilter === 'active' && !account.isActive) return false;
        if (activityFilter === 'inactive' && account.isActive) return false;
        if (currencyFilter === 'unrestricted' && account.currencyRestriction) return false;
        if (
          currencyFilter !== 'all' &&
          currencyFilter !== 'unrestricted' &&
          account.currencyRestriction !== currencyFilter
        ) {
          return false;
        }
        return true;
      }),
    [
      accounts,
      activityFilter,
      currencyFilter,
      hierarchyVisibleKeys,
      statusFilter,
      structureFilter,
      typeFilter,
    ],
  );

  const selectedAccount =
    accounts.find((account) => account.key === selectedKey) ?? shownAccounts[0] ?? null;
  const selectedParent = selectedAccount ? (parentByKey.get(selectedAccount.key) ?? null) : null;
  const SelectedAccountIcon =
    selectedAccount && isAccountType(selectedAccount.accountType)
      ? ACCOUNT_TYPE_ICONS[selectedAccount.accountType]
      : FileText;

  const typeCounts = useMemo(
    () =>
      Object.fromEntries(
        ACCOUNT_TYPES.map((accountType) => [
          accountType,
          accounts.filter((account) => account.accountType === accountType).length,
        ]),
      ) as Record<AccountType, number>,
    [accounts],
  );

  // How many of each type can actually take an entry. A chart is mostly
  // headers, and "twelve asset accounts" means something quite different from
  // "twelve, of which three can be posted to".
  const postableCounts = useMemo(
    () =>
      Object.fromEntries(
        ACCOUNT_TYPES.map((accountType) => [
          accountType,
          accounts.filter((account) => account.accountType === accountType && !account.isGroup)
            .length,
        ]),
      ) as Record<AccountType, number>,
    [accounts],
  );

  const activeFilterCount = [
    typeFilter,
    statusFilter,
    structureFilter,
    activityFilter,
    currencyFilter,
  ].filter((value) => value !== 'all').length;
  const pageCount = Math.max(1, Math.ceil((total ?? accounts.length) / query.pageSize));
  const currentPage = Math.min(Math.max(query.page, 1), pageCount);
  const firstShown = accounts.length === 0 ? 0 : (currentPage - 1) * query.pageSize + 1;
  const lastShown = accounts.length === 0 ? 0 : firstShown + accounts.length - 1;

  const clearFilters = () => {
    setTypeFilter('all');
    setStatusFilter('all');
    setStructureFilter('all');
    setActivityFilter('all');
    setCurrencyFilter('all');
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleColumn = (key: ColumnKey) => {
    if (key === 'code') return;
    setVisibleColumns((current) =>
      current.includes(key) ? current.filter((columnKey) => columnKey !== key) : [...current, key],
    );
  };

  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (page > 1) params.set('page', String(page));
    const suffix = params.toString();
    return `/master-data/chart-of-accounts${suffix ? `?${suffix}` : ''}`;
  };

  const exportHref = search
    ? `/master-data/chart-of-accounts/export?q=${encodeURIComponent(search)}`
    : '/master-data/chart-of-accounts/export';

  const pageLinks = [...new Set([1, currentPage - 1, currentPage, currentPage + 1, pageCount])]
    .filter((page) => page >= 1 && page <= pageCount)
    .sort((first, second) => first - second);

  const renderCell = (account: AccountRow, key: ColumnKey): ReactNode => {
    switch (key) {
      case 'code':
        return (
          <div
            className="coa-account-code"
            style={{ '--coa-level': account.level } as CSSProperties}
          >
            {account.isGroup ? (
              <button
                className="coa-tree-toggle"
                type="button"
                aria-expanded={!collapsed.has(account.key)}
                aria-label={
                  collapsed.has(account.key)
                    ? chart('expand_account', { account: account.name || account.code })
                    : chart('collapse_account', { account: account.name || account.code })
                }
                onClick={() => toggleCollapsed(account.key)}
              >
                {collapsed.has(account.key) ? (
                  <ChevronRight className="coa-directional-icon" aria-hidden="true" />
                ) : (
                  <ChevronDown aria-hidden="true" />
                )}
              </button>
            ) : (
              <span className="coa-tree-spacer" aria-hidden="true" />
            )}
            {account.isGroup ? (
              <Folder className="coa-account-kind-icon" aria-hidden="true" />
            ) : (
              <FileText className="coa-account-kind-icon" aria-hidden="true" />
            )}
            <Link
              className="coa-account-link"
              href={`/master-data/chart-of-accounts/${encodeURIComponent(account.code)}`}
              onClick={() => setSelectedKey(account.key)}
            >
              <bdi dir="ltr">{account.code || '—'}</bdi>
            </Link>
          </div>
        );
      case 'name':
        return <span className="coa-account-name">{account.name || '—'}</span>;
      case 'account_type':
        return isAccountType(account.accountType)
          ? chart(`account_types.${account.accountType}`)
          : '—';
      case 'currency_restriction':
        return account.currencyRestriction ? (
          <bdi dir="ltr">{account.currencyRestriction}</bdi>
        ) : (
          chart('unrestricted')
        );
      case 'status':
        return account.status ? (
          <span className={`status status--${safeStatusClass(account.status)}`}>
            {status(account.status)}
          </span>
        ) : (
          '—'
        );
      case 'is_group':
        return chart(account.isGroup ? 'group_account' : 'posting_account');
      case 'is_active':
        return chart(account.isActive ? 'active' : 'inactive');
      case 'level':
        return <bdi dir="ltr">{number.format(account.level)}</bdi>;
      case 'control_account':
        return account.controlAccount
          ? chart(`control_accounts.${account.controlAccount}`)
          : chart('not_applicable');
    }
  };

  const finishPreview = () => {
    setPreviewDialog(null);
    setPreviewNotice(true);
  };

  return (
    <div className="coa-workspace">
      {previewNotice ? (
        <div className="coa-preview-toast" role="status">
          <Info aria-hidden="true" />
          <span>{chart('preview.confirmation')}</span>
          <button
            className="coa-icon-button"
            type="button"
            aria-label={chart('dismiss')}
            onClick={() => setPreviewNotice(false)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <header className="coa-page-header">
        <div className="coa-page-heading">
          <h1 className="coa-title">{chart('title')}</h1>
          <p className="coa-subtitle">{chart('subtitle')}</p>
        </div>
        <div className="coa-header-actions">
          {/* Import and New arrive with Phase 02's write path; until then the
              only action here is the one that reads — no preview dialogs. */}
          <Link className="coa-button coa-button--secondary" href={exportHref}>
            <Download aria-hidden="true" />
            {list('export')}
          </Link>
        </div>
      </header>

      <section className="coa-context-bar" aria-label={chart('workspace_context')}>
        <label className="coa-context-field" htmlFor="coa-company">
          <span className="coa-context-label">
            <Building2 aria-hidden="true" />
            {chart('company')}
          </span>
          <select id="coa-company" className="coa-select" defaultValue="current">
            <option value="current">{chart('current_company')}</option>
          </select>
        </label>
        <label className="coa-context-field" htmlFor="coa-branch">
          <span className="coa-context-label">
            <GitBranch aria-hidden="true" />
            {chart('branch')}
          </span>
          <select id="coa-branch" className="coa-select" defaultValue="current">
            <option value="current">{chart('current_branch')}</option>
          </select>
        </label>
        <label className="coa-context-field" htmlFor="coa-currency">
          <span className="coa-context-label">
            <Coins aria-hidden="true" />
            {chart('currency')}
          </span>
          <select
            id="coa-currency"
            className="coa-select"
            value={currencyFilter}
            onChange={(event) => setCurrencyFilter(event.target.value)}
          >
            <option value="all">{chart('all_currencies')}</option>
            <option value="unrestricted">{chart('unrestricted')}</option>
            {currencyOptions.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>
        <label className="coa-context-field" htmlFor="coa-fiscal-year">
          <span className="coa-context-label">
            <CalendarDays aria-hidden="true" />
            {chart('fiscal_year')}
          </span>
          <select id="coa-fiscal-year" className="coa-select" defaultValue="current">
            <option value="current">{chart('current_fiscal_year')}</option>
          </select>
        </label>

        <form className="coa-search" method="get" role="search">
          <input
            className="coa-search-input"
            type="search"
            name="q"
            defaultValue={search}
            placeholder={chart('search_placeholder')}
            aria-label={list('search')}
          />
          <button className="coa-search-submit" type="submit">
            <SearchIcon aria-hidden="true" />
            <span className="coa-sr-only">{list('search')}</span>
          </button>
        </form>
        <button
          className={`coa-button coa-button--filter${showFilters ? ' coa-button--active' : ''}`}
          type="button"
          aria-expanded={showFilters}
          aria-controls="coa-filter-panel"
          onClick={() => setShowFilters((shown) => !shown)}
        >
          <SlidersHorizontal aria-hidden="true" />
          {list('filters')}
          {activeFilterCount > 0 ? (
            <span className="coa-filter-count">
              <bdi dir="ltr">{number.format(activeFilterCount)}</bdi>
            </span>
          ) : null}
        </button>
      </section>

      {showFilters ? (
        <section className="coa-filter-panel" id="coa-filter-panel" aria-label={list('filters')}>
          <label className="coa-filter-field" htmlFor="coa-type-filter">
            <span>{column('account_type')}</span>
            <select
              id="coa-type-filter"
              className="coa-select"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="all">{chart('all_types')}</option>
              {ACCOUNT_TYPES.map((accountType) => (
                <option key={accountType} value={accountType}>
                  {chart(`account_types.${accountType}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="coa-filter-field" htmlFor="coa-status-filter">
            <span>{column('status')}</span>
            <select
              id="coa-status-filter"
              className="coa-select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">{chart('all_statuses')}</option>
              {['draft', 'submitted', 'approved', 'rejected', 'cancelled'].map((value) => (
                <option key={value} value={value}>
                  {status(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="coa-filter-field" htmlFor="coa-structure-filter">
            <span>{column('is_group')}</span>
            <select
              id="coa-structure-filter"
              className="coa-select"
              value={structureFilter}
              onChange={(event) => setStructureFilter(event.target.value)}
            >
              <option value="all">{chart('all_structures')}</option>
              <option value="group">{chart('group_account')}</option>
              <option value="posting">{chart('posting_account')}</option>
            </select>
          </label>
          <label className="coa-filter-field" htmlFor="coa-activity-filter">
            <span>{column('is_active')}</span>
            <select
              id="coa-activity-filter"
              className="coa-select"
              value={activityFilter}
              onChange={(event) => setActivityFilter(event.target.value)}
            >
              <option value="all">{chart('all_activity')}</option>
              <option value="active">{chart('active')}</option>
              <option value="inactive">{chart('inactive')}</option>
            </select>
          </label>
          <p className="coa-filter-note">
            <Info aria-hidden="true" />
            {chart('local_filter_note')}
          </p>
          <button className="coa-button coa-button--ghost" type="button" onClick={clearFilters}>
            <X aria-hidden="true" />
            {list('clear_filters')}
          </button>
        </section>
      ) : null}

      <section className="coa-kpi-grid" aria-label={chart('account_type_summary')}>
        {ACCOUNT_TYPES.map((accountType) => {
          const Icon = ACCOUNT_TYPE_ICONS[accountType];
          const active = typeFilter === accountType;
          return (
            <button
              aria-pressed={active}
              className={`coa-kpi-card coa-kpi-card--${accountType}${active ? ' coa-kpi-card--active' : ''}`}
              key={accountType}
              onClick={() => setTypeFilter(active ? 'all' : accountType)}
              type="button"
            >
              <span className="coa-kpi-icon">
                <Icon aria-hidden="true" />
              </span>
              <div className="coa-kpi-copy">
                <div className="coa-kpi-headline">
                  <strong>
                    <bdi dir="ltr">{number.format(typeCounts[accountType])}</bdi>
                  </strong>
                  <h2>{chart(`account_types.${accountType}`)}</h2>
                </div>
                <span>
                  {chart('postable_of', {
                    count: number.format(postableCounts[accountType]),
                  })}
                </span>
              </div>
            </button>
          );
        })}
      </section>

      <div className="coa-content-grid">
        <section className="coa-panel coa-accounts-panel" aria-labelledby="coa-accounts-title">
          <header className="coa-panel-header">
            <div className="coa-panel-heading-row">
              <h2 id="coa-accounts-title">{chart('accounts')}</h2>
              <span className="coa-count-badge">
                {list('row_count', { count: total ?? accounts.length })}
              </span>
            </div>
            <div className="coa-panel-actions">
              <button
                className="coa-compact-button"
                type="button"
                onClick={() => setCollapsed(new Set())}
              >
                <Eye aria-hidden="true" />
                {chart('expand_all')}
              </button>
              <button
                className="coa-compact-button"
                type="button"
                onClick={() =>
                  setCollapsed(new Set(accounts.filter((account) => account.isGroup).map((a) => a.key)))
                }
              >
                <PanelRightOpen aria-hidden="true" />
                {chart('collapse_all')}
              </button>
              <div className="coa-preferences">
                <button
                  className="coa-icon-button coa-icon-button--bordered"
                  type="button"
                  aria-label={chart('preferences')}
                  aria-expanded={showPreferences}
                  aria-controls="coa-column-preferences"
                  onClick={() => setShowPreferences((shown) => !shown)}
                >
                  <Settings2 aria-hidden="true" />
                </button>
                {showPreferences ? (
                  <div
                    className="coa-preferences-panel"
                    id="coa-column-preferences"
                    role="group"
                    aria-label={chart('choose_columns')}
                  >
                    <strong>{chart('choose_columns')}</strong>
                    {availableColumns.map((key) => (
                      <label className="coa-column-option" key={key}>
                        <input
                          type="checkbox"
                          checked={visibleColumns.includes(key)}
                          disabled={key === 'code'}
                          onChange={() => toggleColumn(key)}
                        />
                        <span>{column(key)}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <div className="table-wrap coa-table-wrap">
            <table className="list coa-table">
              <thead>
                <tr>
                  {visibleColumns.map((key) => (
                    <th className={key === 'level' ? 'numeric' : undefined} key={key} scope="col">
                      {column(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownAccounts.map((account) => (
                  <tr
                    className={selectedAccount?.key === account.key ? 'coa-row--selected' : undefined}
                    key={account.key}
                    tabIndex={0}
                    aria-selected={selectedAccount?.key === account.key}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('a, button, input, select')) return;
                      setSelectedKey(account.key);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedKey(account.key);
                      }
                    }}
                  >
                    {visibleColumns.map((key) => (
                      <td className={key === 'level' ? 'numeric' : undefined} key={key}>
                        {renderCell(account, key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {shownAccounts.length === 0 ? (
              <div className="coa-table-empty" role="status">
                <SearchIcon aria-hidden="true" />
                <strong>{list('no_rows')}</strong>
                <span>{list('no_rows_hint')}</span>
              </div>
            ) : null}
          </div>

          <footer className="coa-table-footer">
            <p>
              {chart('showing_accounts', {
                first: firstShown,
                last: lastShown,
                total: total ?? accounts.length,
              })}
            </p>
            <nav className="coa-pagination" aria-label={chart('pagination.label')}>
              {currentPage > 1 ? (
                <Link
                  className="coa-page-button"
                  href={pageHref(currentPage - 1)}
                  aria-label={chart('pagination.previous')}
                >
                  <ChevronLeft className="coa-directional-icon" aria-hidden="true" />
                </Link>
              ) : (
                <span className="coa-page-button coa-page-button--disabled" aria-hidden="true">
                  <ChevronLeft className="coa-directional-icon" />
                </span>
              )}
              {pageLinks.map((page, index) => (
                <span className="coa-page-slot" key={page}>
                  {index > 0 && pageLinks[index - 1]! < page - 1 ? (
                    <span className="coa-page-ellipsis" aria-hidden="true">
                      …
                    </span>
                  ) : null}
                  {page === currentPage ? (
                    <span className="coa-page-button coa-page-button--current" aria-current="page">
                      <bdi dir="ltr">{number.format(page)}</bdi>
                    </span>
                  ) : (
                    <Link
                      className="coa-page-button"
                      href={pageHref(page)}
                      aria-label={chart('pagination.page', { page })}
                    >
                      <bdi dir="ltr">{number.format(page)}</bdi>
                    </Link>
                  )}
                </span>
              ))}
              {currentPage < pageCount ? (
                <Link
                  className="coa-page-button"
                  href={pageHref(currentPage + 1)}
                  aria-label={chart('pagination.next')}
                >
                  <ChevronRight className="coa-directional-icon" aria-hidden="true" />
                </Link>
              ) : (
                <span className="coa-page-button coa-page-button--disabled" aria-hidden="true">
                  <ChevronRight className="coa-directional-icon" />
                </span>
              )}
            </nav>
          </footer>
        </section>

        <aside className="coa-details-column" aria-label={chart('account_details')}>
          <section className="coa-panel coa-details-panel">
            <header className="coa-panel-header">
              <h2>{chart('account_details')}</h2>
              <button
                className={`coa-icon-button${favourite ? ' coa-icon-button--active' : ''}`}
                type="button"
                aria-pressed={favourite}
                aria-label={chart(favourite ? 'remove_favourite' : 'add_favourite')}
                onClick={() => setFavourite((selected) => !selected)}
              >
                <Star aria-hidden="true" />
              </button>
            </header>

            {selectedAccount ? (
              <>
                <div className="coa-detail-hero">
                  <span className="coa-detail-icon">
                    <SelectedAccountIcon aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{selectedAccount.name || '—'}</strong>
                    <span>
                      <bdi dir="ltr">{selectedAccount.code || '—'}</bdi>
                    </span>
                  </div>
                  <Link
                    className="coa-detail-link"
                    href={`/master-data/chart-of-accounts/${encodeURIComponent(selectedAccount.code)}`}
                  >
                    {chart('view_account')}
                    <ChevronRight className="coa-directional-icon" aria-hidden="true" />
                  </Link>
                </div>

                <dl className="coa-detail-grid">
                  <div>
                    <dt>{column('code')}</dt>
                    <dd>
                      <bdi dir="ltr">{selectedAccount.code || '—'}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{column('name')}</dt>
                    <dd>{selectedAccount.name || '—'}</dd>
                  </div>
                  <div>
                    <dt>{column('account_type')}</dt>
                    <dd>
                      {isAccountType(selectedAccount.accountType)
                        ? chart(`account_types.${selectedAccount.accountType}`)
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>{chart('parent_account')}</dt>
                    <dd>
                      {selectedParent ? (
                        <>
                          <bdi dir="ltr">{selectedParent.code}</bdi>
                          <span className="coa-detail-parent-name">{selectedParent.name}</span>
                        </>
                      ) : (
                        chart('not_available')
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{column('currency_restriction')}</dt>
                    <dd>
                      {selectedAccount.currencyRestriction ? (
                        <bdi dir="ltr">{selectedAccount.currencyRestriction}</bdi>
                      ) : (
                        chart('unrestricted')
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{column('status')}</dt>
                    <dd>
                      {selectedAccount.status ? (
                        <span
                          className={`status status--${safeStatusClass(selectedAccount.status)}`}
                        >
                          {status(selectedAccount.status)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                </dl>

                <section className="coa-balance-card" aria-labelledby="coa-balance-title">
                  <header className="coa-balance-header">
                    <h3 id="coa-balance-title">{chart('balance_summary')}</h3>
                    {selectedAccount.currencyRestriction ? (
                      <bdi className="coa-currency-badge" dir="ltr">
                        {selectedAccount.currencyRestriction}
                      </bdi>
                    ) : null}
                  </header>
                  <div className="coa-balance-grid">
                    {['opening_balance', 'total_debits', 'total_credits', 'closing_balance'].map(
                      (key) => (
                        <div key={key}>
                          <span>{chart(key)}</span>
                          <strong aria-label={chart('not_available')}>
                            —
                          </strong>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="coa-unavailable-note">
                    <Info aria-hidden="true" />
                    <div>
                      <strong>{chart('balance_unavailable_title')}</strong>
                      <span>{chart('balance_unavailable_body')}</span>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <div className="coa-detail-empty">
                <Landmark aria-hidden="true" />
                <strong>{chart('no_account_selected')}</strong>
                <span>{chart('no_account_selected_hint')}</span>
              </div>
            )}
          </section>

          <section className="coa-panel coa-journals-panel" aria-labelledby="coa-journals-title">
            <header className="coa-panel-header">
              <h2 id="coa-journals-title">{chart('recent_journals')}</h2>
            </header>
            <div className="coa-journal-empty">
              <span className="coa-journal-empty-icon">
                <BookOpen aria-hidden="true" />
              </span>
              <strong>{chart('journals_unavailable_title')}</strong>
              <p>{chart('journals_unavailable_body')}</p>
              {selectedAccount ? (
                <Link
                  className="coa-inline-link"
                  href={`/master-data/chart-of-accounts/${encodeURIComponent(selectedAccount.code)}`}
                >
                  {chart('view_account')}
                  <ChevronRight className="coa-directional-icon" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </section>
        </aside>
      </div>

      <footer className="coa-workspace-footer">
        <span>{chart('footer')}</span>
        <bdi dir="ltr">{chart('version')}</bdi>
      </footer>

      {previewDialog ? (
        <dialog
          className="coa-modal"
          ref={dialogRef}
          aria-labelledby="coa-preview-dialog-title"
          aria-describedby="coa-preview-dialog-note"
        >
          <div className="coa-modal-header">
            <div>
              <span className="coa-modal-eyebrow">{chart('preview.label')}</span>
              <h2 id="coa-preview-dialog-title">
                {chart(previewDialog === 'import' ? 'preview.import_title' : 'preview.new_title')}
              </h2>
            </div>
            <button
              className="coa-icon-button"
              type="button"
              autoFocus
              aria-label={chart('dismiss')}
              onClick={() => setPreviewDialog(null)}
            >
              <X aria-hidden="true" />
            </button>
          </div>

          <div className="coa-preview-warning" id="coa-preview-dialog-note" role="note">
            <Info aria-hidden="true" />
            <p>
              <strong>{chart('preview.notice_title')}</strong>
              <span>{chart('preview.notice_body')}</span>
            </p>
          </div>

          {previewDialog === 'import' ? (
            <form className="coa-modal-form" onSubmit={(event) => event.preventDefault()}>
              <label className="coa-file-field" htmlFor="coa-import-file">
                <Upload aria-hidden="true" />
                <strong>{chart('preview.choose_file')}</strong>
                <span>{chart('preview.file_hint')}</span>
                <input id="coa-import-file" type="file" accept=".csv,text/csv" />
              </label>
              <div className="coa-modal-actions">
                <button
                  className="coa-button coa-button--secondary"
                  type="button"
                  onClick={() => setPreviewDialog(null)}
                >
                  {chart('preview.cancel')}
                </button>
                <button className="coa-button coa-button--primary" type="button" onClick={finishPreview}>
                  {chart('preview.preview_import')}
                </button>
              </div>
            </form>
          ) : (
            <form
              className="coa-modal-form"
              onSubmit={(event) => {
                event.preventDefault();
                finishPreview();
              }}
            >
              <label className="coa-modal-field" htmlFor="coa-preview-name">
                <span>{column('name')}</span>
                <input id="coa-preview-name" name="name" required />
              </label>
              <label className="coa-modal-field" htmlFor="coa-preview-type">
                <span>{column('account_type')}</span>
                <select id="coa-preview-type" name="account_type" defaultValue="asset">
                  {ACCOUNT_TYPES.map((accountType) => (
                    <option key={accountType} value={accountType}>
                      {chart(`account_types.${accountType}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="coa-modal-field" htmlFor="coa-preview-currency">
                <span>{column('currency_restriction')}</span>
                <select id="coa-preview-currency" name="currency" defaultValue="unrestricted">
                  <option value="unrestricted">{chart('unrestricted')}</option>
                  {currencyOptions.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
              <div className="coa-modal-actions">
                <button
                  className="coa-button coa-button--secondary"
                  type="button"
                  onClick={() => setPreviewDialog(null)}
                >
                  {chart('preview.cancel')}
                </button>
                <button className="coa-button coa-button--primary" type="submit">
                  {chart('preview.preview_account')}
                </button>
              </div>
            </form>
          )}
        </dialog>
      ) : null}
    </div>
  );
}
