'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder,
  PanelRightOpen,
  Search as SearchIcon,
} from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';

/**
 * The Chart of Accounts — one table, and nothing beside it.
 *
 * By direction (2026-08-29): no context row, no filters, no type tiles, no
 * details pane, no recent journals. The chart is the tree of accounts; an
 * account's details are inside the account, opened by pressing it.
 */

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

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
  readonly level: number;
}

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
    level: levelValue(row.level),
  };
}

function safeStatusClass(status: string): string {
  const safe = status.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return safe || 'unknown';
}

export function ChartOfAccountsWorkspace({ rows, query, total, search }: ChartOfAccountsWorkspaceProps) {
  const chart = useTranslations('chart');
  const list = useTranslations('list');
  const status = useTranslations('status');
  const column = useTranslations('column');
  const locale = useLocale();

  const accounts = useMemo(() => rows.map(normaliseAccount), [rows]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // A collapsed header hides everything beneath it, at any depth.
  const shownAccounts = useMemo(() => {
    const visible: AccountRow[] = [];
    const ancestors: AccountRow[] = [];
    for (const account of accounts) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= account.level) {
        ancestors.pop();
      }
      if (!ancestors.some((ancestor) => collapsed.has(ancestor.key))) visible.push(account);
      if (account.isGroup) ancestors.push(account);
    }
    return visible;
  }, [accounts, collapsed]);

  const pageCount = Math.max(1, Math.ceil((total ?? accounts.length) / query.pageSize));
  const currentPage = Math.min(Math.max(query.page, 1), pageCount);
  const firstShown = accounts.length === 0 ? 0 : (currentPage - 1) * query.pageSize + 1;
  const lastShown = accounts.length === 0 ? 0 : firstShown + accounts.length - 1;

  const toggleCollapsed = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  return (
    <div className="coa-workspace">
      <header className="coa-page-header">
        <div className="coa-page-heading">
          <h1 className="coa-title">{chart('title')}</h1>
          <p className="coa-subtitle">{chart('subtitle')}</p>
        </div>
        <div className="coa-header-actions">
          <form className="coa-search" method="get" role="search">
            <input
              aria-label={list('search')}
              className="coa-search-input"
              defaultValue={search}
              name="q"
              placeholder={chart('search_placeholder')}
              type="search"
            />
            <button className="coa-search-submit" type="submit">
              <SearchIcon aria-hidden="true" />
              <span className="coa-sr-only">{list('search')}</span>
            </button>
          </form>
          <Link className="coa-button coa-button--secondary" href={exportHref}>
            <Download aria-hidden="true" />
            {list('export')}
          </Link>
        </div>
      </header>

      <section className="coa-panel coa-accounts-panel" aria-labelledby="coa-accounts-title">
        <header className="coa-panel-header">
          <div className="coa-panel-heading-row">
            <h2 id="coa-accounts-title">{chart('accounts')}</h2>
            <span className="coa-count-badge">{list('row_count', { count: total ?? accounts.length })}</span>
          </div>
          <div className="coa-panel-actions">
            <button className="coa-compact-button" onClick={() => setCollapsed(new Set())} type="button">
              <Eye aria-hidden="true" />
              {chart('expand_all')}
            </button>
            <button
              className="coa-compact-button"
              onClick={() => setCollapsed(new Set(accounts.filter((a) => a.isGroup).map((a) => a.key)))}
              type="button"
            >
              <PanelRightOpen aria-hidden="true" />
              {chart('collapse_all')}
            </button>
          </div>
        </header>

        <div className="table-wrap coa-table-wrap">
          <table className="list coa-table">
            <thead>
              <tr>
                <th scope="col">{column('code')}</th>
                <th scope="col">{column('name')}</th>
                <th scope="col">{column('account_type')}</th>
                <th scope="col">{column('status')}</th>
              </tr>
            </thead>
            <tbody>
              {shownAccounts.map((account) => (
                <tr key={account.key}>
                  <td>
                    <div className="coa-account-code" style={{ '--coa-level': account.level } as CSSProperties}>
                      {account.isGroup ? (
                        <button
                          aria-expanded={!collapsed.has(account.key)}
                          aria-label={
                            collapsed.has(account.key)
                              ? chart('expand_account', { account: account.name || account.code })
                              : chart('collapse_account', { account: account.name || account.code })
                          }
                          className="coa-tree-toggle"
                          onClick={() => toggleCollapsed(account.key)}
                          type="button"
                        >
                          {collapsed.has(account.key) ? (
                            <ChevronRight aria-hidden="true" className="coa-directional-icon" />
                          ) : (
                            <ChevronDown aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        <span aria-hidden="true" className="coa-tree-spacer" />
                      )}
                      {account.isGroup ? (
                        <Folder aria-hidden="true" className="coa-account-kind-icon" />
                      ) : (
                        <FileText aria-hidden="true" className="coa-account-kind-icon" />
                      )}
                      <Link
                        className="coa-account-link"
                        href={`/master-data/chart-of-accounts/${encodeURIComponent(account.code)}`}
                      >
                        <bdi dir="ltr">{account.code || '—'}</bdi>
                      </Link>
                    </div>
                  </td>
                  <td>
                    <Link
                      className="coa-account-name"
                      href={`/master-data/chart-of-accounts/${encodeURIComponent(account.code)}`}
                    >
                      {account.name || '—'}
                    </Link>
                  </td>
                  <td>{isAccountType(account.accountType) ? chart(`account_types.${account.accountType}`) : '—'}</td>
                  <td>
                    {account.status ? (
                      <span className={`status status--${safeStatusClass(account.status)}`}>{status(account.status)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
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
          <p>{chart('showing_accounts', { first: firstShown, last: lastShown, total: total ?? accounts.length })}</p>
          <nav aria-label={chart('pagination.label')} className="coa-pagination">
            {currentPage > 1 ? (
              <Link aria-label={chart('pagination.previous')} className="coa-page-button" href={pageHref(currentPage - 1)}>
                <ChevronLeft aria-hidden="true" className="coa-directional-icon" />
              </Link>
            ) : (
              <span aria-hidden="true" className="coa-page-button coa-page-button--disabled">
                <ChevronLeft className="coa-directional-icon" />
              </span>
            )}
            {pageLinks.map((page, index) => (
              <span className="coa-page-slot" key={page}>
                {index > 0 && pageLinks[index - 1]! < page - 1 ? (
                  <span aria-hidden="true" className="coa-page-ellipsis">
                    …
                  </span>
                ) : null}
                {page === currentPage ? (
                  <span aria-current="page" className="coa-page-button coa-page-button--current">
                    <bdi dir="ltr">{number.format(page)}</bdi>
                  </span>
                ) : (
                  <Link aria-label={chart('pagination.page', { page })} className="coa-page-button" href={pageHref(page)}>
                    <bdi dir="ltr">{number.format(page)}</bdi>
                  </Link>
                )}
              </span>
            ))}
            {currentPage < pageCount ? (
              <Link aria-label={chart('pagination.next')} className="coa-page-button" href={pageHref(currentPage + 1)}>
                <ChevronRight aria-hidden="true" className="coa-directional-icon" />
              </Link>
            ) : (
              <span aria-hidden="true" className="coa-page-button coa-page-button--disabled">
                <ChevronRight className="coa-directional-icon" />
              </span>
            )}
          </nav>
        </footer>
      </section>
    </div>
  );
}
