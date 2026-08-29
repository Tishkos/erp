import { getTranslations } from 'next-intl/server';
import type { StatementLineResult } from '@/server/services/financial-statements';
import { admin as s } from './index';

/**
 * The lines of one statement section, unfolded to the chosen level.
 *
 * Level 1 is the section alone, so nothing here is drawn. Level 2 adds the
 * statement lines; level 3 adds the accounts behind each one, indented
 * beneath it.
 */
export async function StatementRows({
  lines,
  level,
  money,
}: {
  readonly lines: readonly StatementLineResult[];
  readonly level: number;
  readonly money: (amount: string) => string;
}) {
  const [t, line] = await Promise.all([getTranslations('admin'), getTranslations('statement_line')]);
  if (level < 2) return null;

  return (
    <>
      {lines.map((entry) => (
        <StatementLine
          accounts={level >= 3 ? entry.accounts : []}
          amount={money(entry.amount)}
          key={entry.line.code}
          money={money}
          note={entry.line.deduction ? t('reports.deducted') : null}
          title={line(entry.line.code)}
        />
      ))}
    </>
  );
}

/** One statement line, with — at the deepest level — the accounts behind it. */
export function StatementLine({
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
      <tr>
        <th className={s.statementLine} scope="row">
          {title}
          {note ? <span className="muted"> ({note})</span> : null}
        </th>
        <td className={`numeric ${s.totalCell}`}>{amount}</td>
      </tr>
      {accounts.map((account) => (
        <tr key={account.accountCode}>
          <td className={s.statementAccount}>
            <span className={s.mono}>{account.accountCode}</span> · {account.accountName}
          </td>
          <td className="numeric">{money(account.amount)}</td>
        </tr>
      ))}
    </>
  );
}
