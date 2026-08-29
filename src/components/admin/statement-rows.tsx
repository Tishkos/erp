import { getTranslations } from 'next-intl/server';
import type { StatementLineResult } from '@/server/services/financial-statements';
import { admin as s } from './index';

/**
 * One section of a statement — its heading with the section's total, then,
 * unfolded to the chosen level, the statement lines and the accounts behind
 * each one.
 *
 * Level 1 is the heading alone. Level 2 adds the statement lines; level 3
 * adds the accounts, indented beneath the line they belong to.
 */
export async function StatementSection({
  title,
  total,
  lines,
  level,
  money,
  extra,
}: {
  readonly title: string;
  readonly total: string;
  readonly lines: readonly StatementLineResult[];
  readonly level: number;
  readonly money: (amount: string) => string;
  /** A line that is not an account line — the result under Equity. */
  readonly extra?: {
    readonly title: string;
    readonly amount: string;
    readonly accounts: readonly { readonly accountCode: string; readonly accountName: string; readonly amount: string }[];
  };
}) {
  const [t, line] = await Promise.all([getTranslations('admin'), getTranslations('statement_line')]);

  return (
    <>
      <tr className={s.sapSectionRow}>
        <td>{title}</td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{money(total)}</bdi>
        </td>
      </tr>
      {level >= 2
        ? lines.map((entry) => (
            <StatementLine
              accounts={level >= 3 ? entry.accounts : []}
              amount={money(entry.amount)}
              key={entry.line.code}
              money={money}
              note={entry.line.deduction ? t('reports.deducted') : null}
              title={line(entry.line.code)}
            />
          ))
        : null}
      {level >= 2 && extra ? (
        <StatementLine
          accounts={level >= 3 ? extra.accounts : []}
          amount={money(extra.amount)}
          money={money}
          note={null}
          title={extra.title}
        />
      ) : null}
    </>
  );
}

/** One statement line, with — at the deepest level — the accounts behind it. */
function StatementLine({
  title,
  note,
  amount,
  accounts,
  money,
}: {
  readonly title: string;
  readonly note: string | null;
  readonly amount: string;
  readonly accounts: readonly { readonly accountCode: string; readonly accountName: string; readonly amount: string }[];
  readonly money: (amount: string) => string;
}) {
  return (
    <>
      <tr className={s.sapLineRow}>
        <td>
          {title}
          {note ? <span className={s.sapNote}> ({note})</span> : null}
        </td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{amount}</bdi>
        </td>
      </tr>
      {accounts.map((account) => (
        <tr className={s.sapAccountRow} key={account.accountCode}>
          <td>
            <bdi dir="ltr">{account.accountCode}</bdi> · <bdi dir="auto">{account.accountName}</bdi>
          </td>
          <td className={s.sapNum}>
            <bdi dir="ltr">{money(account.amount)}</bdi>
          </td>
        </tr>
      ))}
    </>
  );
}
