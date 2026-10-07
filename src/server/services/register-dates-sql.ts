/**
 * The Filter's window and order in SQL, for a register that pages
 * (`register-page.ts`): the WHERE that keeps the window, and the ORDER BY that
 * puts the newest first unless the person asked for the oldest — so the count,
 * the page and the pager all describe the same ordered set, and the order is
 * the register's, never a page's. The rule itself is `domain/register-dates.ts`.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { BUSINESS_TIME_ZONE } from '../domain/business-date';
import type { RegisterDates } from '../domain/register-dates';

type Expression = AnyColumn | SQL;

/** A timestamp column as the business day it falls on (Asia/Baghdad), for a register whose date is a moment. */
export function businessDayOf(column: Expression): SQL {
  return sql`(${column} at time zone ${BUSINESS_TIME_ZONE})::date`;
}

/** The window as a condition on the register's date (a `date` column or `businessDayOf(...)`); undefined when open. */
export function withinDates(day: Expression, dates: RegisterDates | null | undefined): SQL | undefined {
  if (!dates || (!dates.from && !dates.to)) return undefined;
  if (dates.from && dates.to) return sql`${day} between ${dates.from}::date and ${dates.to}::date`;
  if (dates.from) return sql`${day} >= ${dates.from}::date`;
  return sql`${day} <= ${dates.to}::date`;
}

/**
 * The order: the register's date, then each tie-breaker (when the row was
 * made, its number, its id), all one way — newest first, or oldest first.
 * A row without a date goes last either way.
 */
export function datesOrder(day: Expression, dates: RegisterDates | null | undefined, ...ties: Expression[]): SQL[] {
  const oldest = dates?.sort === 'oldest';
  return [
    oldest ? sql`${day} asc nulls last` : sql`${day} desc nulls last`,
    ...ties.map((tie) => (oldest ? sql`${tie} asc` : sql`${tie} desc`)),
  ];
}
