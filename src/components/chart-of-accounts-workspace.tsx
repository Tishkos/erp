'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, Folder, FolderOpen } from 'lucide-react';
import styles from '@/components/admin/admin.module.css';
import { cn } from '@/components/intent/cn';
import { toneBadge, toneOf } from '@/components/chart-of-accounts-tones';

/**
 * The Chart of Accounts — the tree of accounts, in the same ruled grid the
 * journal register uses, and nothing beside it.
 *
 * By direction (2026-08-29): no context row, no filters, no type tiles, no
 * details pane, no recent journals. An account's details are inside the
 * account, opened by pressing it. A header folds and unfolds with the small
 * mark before its code; the rest is the chart.
 *
 * Drawn in Intent UI's terms (2026-10-06): a chevron folds a header, a folder
 * or a leaf marks what the row is, the type is a tinted badge
 * (`chart-of-accounts-tones.ts`), and the row the keyboard is on is tinted
 * with the accent along its start edge. The markup the tests read — the
 * table named by `chart-title`, one row per account, the code as the first
 * cell's only link — is as it was.
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
  readonly isActive: boolean;
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
    isActive: booleanValue(row.is_active),
    level: levelValue(row.level),
  };
}

export function ChartOfAccountsWorkspace({ rows, query, total, search }: ChartOfAccountsWorkspaceProps) {
  const chart = useTranslations('chart');
  const status = useTranslations('status');
  const column = useTranslations('column');
  const list = useTranslations('list');
  const locale = useLocale();

  const accounts = useMemo(() => rows.map(normaliseAccount), [rows]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // A collapsed header hides everything beneath it, at any depth.
  const shown = useMemo(() => {
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

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (page > 1) params.set('page', String(page));
    const suffix = params.toString();
    return `/master-data/chart-of-accounts${suffix ? `?${suffix}` : ''}`;
  };
  const href = (code: string) => `/master-data/chart-of-accounts/${encodeURIComponent(code)}`;

  return (
    <>
      <div className={cn(styles.sapEntryBar, styles.sapBarEnd, 'gap-2 px-5 py-2.5')}>
        <button className={`${styles.button} ${styles.small}`} onClick={() => setCollapsed(new Set())} type="button">
          <ChevronsUpDown aria-hidden="true" />
          {chart('expand_all')}
        </button>
        <button
          className={`${styles.button} ${styles.small}`}
          onClick={() => setCollapsed(new Set(accounts.filter((a) => a.isGroup).map((a) => a.key)))}
          type="button"
        >
          <ChevronsDownUp aria-hidden="true" />
          {chart('collapse_all')}
        </button>
      </div>

      <div className={`${styles.sapTableWrap} ${styles.sapRegisterTableWrap}`}>
        <table aria-labelledby="chart-title" className={`${styles.sapTable} ${styles.sapRegisterTable}`}>
          <thead>
            <tr>
              <th scope="col">{column('code')}</th>
              <th scope="col">{column('name')}</th>
              <th scope="col">{column('account_type')}</th>
              <th scope="col">{column('is_group')}</th>
              <th scope="col">{column('status')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className={cn(styles.sapEmptyRow, 'py-10 text-center text-sm text-muted-fg')} colSpan={5}>
                  <strong className="font-semibold text-fg">{list('no_rows')}</strong>
                  <br />
                  {list('no_rows_hint')}
                </td>
              </tr>
            ) : null}
            {shown.map((account) => {
              const folded = collapsed.has(account.key);
              const Mark = account.isGroup ? (folded ? Folder : FolderOpen) : FileText;
              return (
                <tr
                  className={cn(
                    'group/row',
                    account.isGroup && styles.sapLevelRow,
                    // A header is a heading row of the tree: semibold, on a light muted
                    // band (light enough that the type badge on it keeps 4.5:1).
                    account.isGroup && '[&>td]:bg-muted/45 [&>td]:font-semibold [&>td]:text-fg [&:hover>td]:bg-muted/75',
                    // The row the keyboard is on reads as selected.
                    '[&:focus-within>td]:bg-primary-subtle',
                  )}
                  key={account.key}
                >
                  <td
                    className="border-s-2 border-s-transparent group-focus-within/row:border-s-primary"
                    style={{ paddingInlineStart: `${0.5 + account.level * 1.25}rem` }}
                  >
                    <span className={cn(styles.sapTreeCell, 'flex gap-1.5')}>
                      {account.isGroup ? (
                        <button
                          aria-expanded={!folded}
                          aria-label={
                            folded
                              ? chart('expand_account', { account: account.name || account.code })
                              : chart('collapse_account', { account: account.name || account.code })
                          }
                          className={cn(
                            styles.sapTreeToggle,
                            'size-6 min-h-6 min-w-6 rounded-md text-muted-fg transition-colors hover:bg-secondary hover:text-fg',
                            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                          )}
                          onClick={() => toggle(account.key)}
                          type="button"
                        >
                          {folded ? (
                            <ChevronRight aria-hidden="true" className="size-4 rtl:-scale-x-100" />
                          ) : (
                            <ChevronDown aria-hidden="true" className="size-4" />
                          )}
                        </button>
                      ) : (
                        <span aria-hidden="true" className={cn(styles.sapTreeToggle, 'size-6 min-h-6 min-w-6')} />
                      )}
                      <Mark
                        aria-hidden="true"
                        className={cn('size-4 shrink-0', account.isGroup ? 'text-primary-subtle-fg' : 'text-muted-fg')}
                      />
                      <Link className={cn(styles.sapLink, 'tabular-nums')} href={href(account.code)}>
                        <bdi dir="ltr">{account.code || '—'}</bdi>
                      </Link>
                    </span>
                  </td>
                  <td>
                    <Link className={styles.sapPlainLink} href={href(account.code)}>
                      <bdi dir="auto">{account.name || '—'}</bdi>
                    </Link>
                  </td>
                  <td>
                    {isAccountType(account.accountType) ? (
                      <span className={toneBadge(toneOf(account.accountType))}>
                        {chart(`account_types.${account.accountType}`)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={account.isGroup ? undefined : 'text-muted-fg'}>
                    {chart(account.isGroup ? 'group_account' : 'posting_account')}
                  </td>
                  <td>
                    {account.status ? (
                      <span
                        className={`status status--${account.status} ${styles.sapRegisterStatus}`}
                        data-status={account.status}
                      >
                        {status(account.status)}
                      </span>
                    ) : (
                      '—'
                    )}
                    {account.status === 'approved' && !account.isActive ? (
                      <span className={styles.sapNote}> · {chart('inactive')}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.sapFoot}>
        <div className={styles.sapFootActions}>
          {currentPage > 1 ? (
            <Link className={cn(styles.button, styles.small)} href={pageHref(currentPage - 1)}>
              <ChevronLeft aria-hidden="true" className="rtl:-scale-x-100" />
              {chart('pagination.previous')}
            </Link>
          ) : null}
          {currentPage < pageCount ? (
            <Link className={cn(styles.button, styles.small)} href={pageHref(currentPage + 1)}>
              {chart('pagination.next')}
              <ChevronRight aria-hidden="true" className="rtl:-scale-x-100" />
            </Link>
          ) : null}
        </div>
        <div className={styles.sapFootTotals}>
          <span className={styles.sapNote}>
            {chart('showing_accounts', {
              first: number.format(firstShown),
              last: number.format(lastShown),
              total: number.format(total ?? accounts.length),
            })}
          </span>
        </div>
      </div>
    </>
  );
}
