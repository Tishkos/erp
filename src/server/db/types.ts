/**
 * Driver-level type handling — TECHSTACK A10.
 *
 * §24: "All dates distinguish document date, posting date, due date, tax date
 * if required, and system timestamps."
 *
 * node-postgres parses a PostgreSQL `date` into a JavaScript `Date`, which is
 * an instant, in the **local** timezone. On a machine at UTC+3 the posting date
 * 2026-02-01 comes back as 2026-01-31T21:00:00Z, and a report grouped by month
 * puts it in January. Nothing warns you; the figures are simply wrong for one
 * day either side of every month end, and only on machines whose offset differs
 * from the server's.
 *
 * A business date has no timezone because it is not an instant. It is left as
 * the string PostgreSQL sent, and compared as one — ISO dates sort and compare
 * correctly as text, which is why the domain layer works in strings throughout.
 *
 * System timestamps (`timestamptz`) keep their default parsing: those really
 * are instants.
 */
import pg from 'pg';

/** PostgreSQL type OIDs. */
const DATE_OID = 1082;
/** `numeric` — parsed to `string`, never to a float. */
const NUMERIC_OID = 1700;
const INT8_OID = 20;

let configured = false;

/**
 * Applies the parsers. Safe to call more than once; `pg`'s type registry is
 * global to the process, so the first caller wins and the rest are no-ops.
 *
 * Must run before any pool is created.
 */
export function configurePgTypes(): void {
  if (configured) return;
  configured = true;

  // A calendar date stays a calendar date.
  pg.types.setTypeParser(DATE_OID, (value) => value);

  // numeric → string. The default is already string, but stating it here means
  // a future driver default cannot quietly turn money into a float (A4).
  pg.types.setTypeParser(NUMERIC_OID, (value) => value);

  // bigint → string, so a value beyond Number.MAX_SAFE_INTEGER survives the
  // trip. Callers convert with BigInt() where they need arithmetic.
  pg.types.setTypeParser(INT8_OID, (value) => value);
}
