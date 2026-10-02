/**
 * The business date — REQ-HARDEN-001 HD7, D-HD-2.
 *
 * A business date is not an instant. The books are kept in Baghdad: a
 * posting made at 01:00 on the 2nd is dated the 2nd there, whatever UTC says.
 * Every stamp of "today" on a document, a sweep or a form default goes
 * through here; `new Date().toISOString().slice(0, 10)` is UTC and reads
 * yesterday for the first three hours of every Baghdad day. The zone is the
 * one the interface already formats with (`ERP_TIMEZONE`), so what the
 * person sees and what is written agree.
 */
export const BUSINESS_TIME_ZONE = process.env.ERP_TIMEZONE ?? 'Asia/Baghdad';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** `YYYY-MM-DD` of the instant in the business time zone. */
export function businessDateOf(instant: Date, zone = BUSINESS_TIME_ZONE): string {
  // en-CA formats as YYYY-MM-DD; the parts are read so a locale change elsewhere cannot alter it.
  const parts = formatterFor(zone).formatToParts(instant);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** Today, where the books are kept. The only sanctioned "today". */
export function businessToday(now: Date = new Date(), zone = BUSINESS_TIME_ZONE): string {
  return businessDateOf(now, zone);
}

/** The business date plus or minus whole days, as a date string. */
export function addBusinessDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
