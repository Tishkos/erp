import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { eq } from 'drizzle-orm';
import mainLogo from '../../../../../../../mainLogo.png';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { can } from '@domain/permissions';
import { appUser } from '@/server/db/schema';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as companyService from '@/server/services/company';
import { MAPPING_STATEMENTS } from '@/components/admin/account-controls';
import * as coa from '@/server/services/chart-of-accounts';
import * as statementLines from '@/server/services/statement-lines';
import * as trialBalance from '@/server/services/trial-balance';
import styles from '@/components/print/print.module.css';
import { PrintButton } from '@/components/print/print-button';

/**
 * The account statement, on paper — the same shape as the journal voucher.
 *
 * What the account is (its facts), where it stands (the year's opening
 * balance, movement and closing balance), and every posting behind that
 * position this year, each with the balance it left. Black on white with the
 * letterhead, in either language (`?lang=en|ar`), and the browser's print
 * dialog is the PDF.
 */
export const dynamic = 'force-dynamic';

export default async function AccountPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();

  const [{ code: raw }, sp, context] = await Promise.all([params, searchParams, requireContext()]);
  const code = decodeURIComponent(raw);
  if (!can(context.principal, 'view', coa.PERMISSION_OBJECT)) notFound();
  if (!can(context.principal, 'print', coa.PERMISSION_OBJECT)) notFound();

  const lang: Locale = sp.lang === 'ar' ? 'ar' : 'en';
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const [t, chart, column, status, line, page] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'admin' }),
    getTranslations({ locale: lang, namespace: 'chart' }),
    getTranslations({ locale: lang, namespace: 'column' }),
    getTranslations({ locale: lang, namespace: 'status' }),
    getTranslations({ locale: lang, namespace: 'statement_line' }),
    getTranslations({ locale: lang, namespace: 'page' }),
  ]);

  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const data = await withCurrentUser(async (tx) => {
    const node = await coa.loadAccountByCode(tx, code).catch(() => null);
    if (!node) return null;
    const parent = node.parentId ? await coa.loadAccount(tx, node.parentId).catch(() => null) : null;
    const activity = node.isGroup
      ? []
      : await trialBalance.accountActivity(tx, code, {
          from: '0001-01-01',
          to: '9999-12-31',
          allPermittedBranches: true,
        });
    const [me] = await tx
      .select({ displayName: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.id, context.principal.userId))
      .limit(1);
    return {
      node,
      parent,
      activity,
      company: await companyService.current(tx),
      mapping: await statementLines.pickerLines(tx),
      me: me?.displayName ?? '',
    };
  });
  if (!data) notFound();
  const { node, parent, activity, company, mapping, me } = data;
  const mappingLabel = (code: string | null, fallback: string) =>
    code
      ? line.has(code)
        ? line(code)
        : (mapping.find((entry) => entry.code === code)?.name ?? code.replace(/_/g, ' '))
      : fallback;

  const money = (amount: string) => formatMoney(amount, 'IQD', lang);
  const dec = (value: string) => parseDecimal(value, MONEY_SCALE);
  const figure = (value: bigint) => money(toDecimalString(value, MONEY_SCALE));

  // The same arithmetic as the account page: everything before the year is
  // the opening position, the year's rows are its movement.
  let opening = 0n;
  let debits = 0n;
  let credits = 0n;
  for (const row of activity) {
    const net = dec(row.debitIqd) - dec(row.creditIqd);
    if (row.postingDate < yearStart) opening += net;
    else {
      debits += dec(row.debitIqd);
      credits += dec(row.creditIqd);
    }
  }
  const closing = opening + debits - credits;

  // This year's postings, oldest first, each with the balance it left.
  let running = opening;
  const rows = activity
    .filter((row) => row.postingDate >= yearStart)
    .map((row) => {
      running += dec(row.debitIqd) - dec(row.creditIqd);
      return { ...row, balance: running };
    });

  const printedAt = formatTimestamp(new Date().toISOString(), lang);
  const address = `/master-data/chart-of-accounts/${encodeURIComponent(code)}`;

  return (
    <div dir={dir}>
      <div className={styles.toolbar}>
        <PrintButton label={chart('print')} />
        <Link className={styles.quiet} href={`${address}/print?lang=en`}>
          English
        </Link>
        <Link className={styles.quiet} href={`${address}/print?lang=ar`}>
          العربية
        </Link>
        <Link className={styles.quiet} href={address}>
          {chart('print_back')}
        </Link>
      </div>

      <div className={styles.sheet}>
        <header className={styles.head}>
          <Image alt="" src={mainLogo} />
          <div className={styles.company}>
            <strong>{company?.legalName ?? 'Qimah Al-Safinah'}</strong>
            {company?.address ? <span>{company.address}</span> : null}
          </div>
          <div className={styles.docname}>
            <strong>{chart('print_title')}</strong>
            <span>
              {node.code} · {status(node.approvalStatus)}
            </span>
          </div>
        </header>

        <dl className={styles.facts}>
          <div>
            <dt>{column('code')}</dt>
            <dd>{node.code}</dd>
          </div>
          <div>
            <dt>{column('name')}</dt>
            <dd>{node.name}</dd>
          </div>
          <div>
            <dt>{column('account_type')}</dt>
            <dd>{chart(`account_types.${node.accountType}`)}</dd>
          </div>
          <div>
            <dt>{chart('parent_account')}</dt>
            <dd>{parent ? `${parent.code} · ${parent.name}` : chart('not_available')}</dd>
          </div>
          <div>
            <dt>{column('is_group')}</dt>
            <dd>{chart(node.isGroup ? 'group_account' : 'posting_account')}</dd>
          </div>
          <div>
            <dt>{column('is_active')}</dt>
            <dd>{chart(node.isActive ? 'active' : 'inactive')}</dd>
          </div>
          {MAPPING_STATEMENTS.map((entry) => (
            <div key={entry.statement}>
              <dt>{page(entry.page)}</dt>
              <dd>
                {mappingLabel(node.mapping[entry.statement], t('accounts.statement_line_default'))}
              </dd>
            </div>
          ))}
          <div>
            <dt>{chart('balance_summary')}</dt>
            <dd>IQD · {year}</dd>
          </div>
        </dl>

        <table className={styles.lines}>
          <thead>
            <tr>
              <th className={styles.num}>{chart('opening_balance')}</th>
              <th className={styles.num}>{chart('total_debits')}</th>
              <th className={styles.num}>{chart('total_credits')}</th>
              <th className={styles.num}>{chart('closing_balance')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={styles.num}>{figure(opening)}</td>
              <td className={styles.num}>{figure(debits)}</td>
              <td className={styles.num}>{figure(credits)}</td>
              <td className={styles.num}>{figure(closing)}</td>
            </tr>
          </tbody>
        </table>

        {node.isGroup ? null : (
          <table className={styles.lines}>
            <thead>
              <tr>
                <th>{t('journals.posting_date')}</th>
                <th>{t('reports.entry')}</th>
                <th>{t('journals.description')}</th>
                <th className={styles.num}>{t('journals.debit')}</th>
                <th className={styles.num}>{t('journals.credit')}</th>
                <th className={styles.num}>{t('reports.running_balance')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5}>{chart('opening_balance')}</td>
                <td className={styles.num}>{figure(opening)}</td>
              </tr>
              {rows.map((row, index) => (
                <tr key={`${row.entryNo}-${row.lineNo}-${index}`}>
                  <td>{formatBusinessDate(row.postingDate, lang)}</td>
                  <td>{row.entryNo}</td>
                  <td>{row.description ?? ''}</td>
                  <td className={styles.num}>{Number(row.debitIqd) === 0 ? '' : money(row.debitIqd)}</td>
                  <td className={styles.num}>{Number(row.creditIqd) === 0 ? '' : money(row.creditIqd)}</td>
                  <td className={styles.num}>{figure(row.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>{chart('closing_balance')}</td>
                <td className={styles.num}>{figure(debits)}</td>
                <td className={styles.num}>{figure(credits)}</td>
                <td className={styles.num}>{figure(closing)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        <p className={styles.provenance}>
          {t('journals.printed_line', {
            name: me,
            when: printedAt,
            branch: context.scope.branchCode || '—',
          })}
        </p>
      </div>
    </div>
  );
}
