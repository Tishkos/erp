/**
 * Cash-forecast bucketing — Phase 07.8, §17.
 *
 * > §17: *"Cash-flow forecast by day/week/month and scenario."*
 *
 * The whole of the day/week/month question is *"which box does this date fall
 * in?"*, and it is worth having in one pure function because the three views
 * have to agree. They agree by construction here: the same movements, sorted
 * into different-sized boxes, so the total across the range is the same figure
 * in all three.
 *
 * Pure, and ISO dates throughout — TECHSTACK A10 keeps business dates away from
 * `Date` arithmetic that has a timezone in it.
 */

export const FORECAST_BUCKETS = ['day', 'week', 'month'] as const;
export type ForecastBucket = (typeof FORECAST_BUCKETS)[number];

/**
 * The first day of the bucket a date falls in.
 *
 * Weeks start on **Monday**. That is a choice and it should be a visible one:
 * Iraq's working week runs Sunday to Thursday, so a Monday start splits it. It
 * is used because ISO-8601 says Monday and because a forecast is read alongside
 * bank statements, which follow the same convention — but if Treasury wants the
 * week to start on Sunday, this is the one line that changes.
 */
export function startOfBucket(isoDate: string, bucket: ForecastBucket): string {
  if (bucket === 'day') return isoDate;

  const [year, month, day] = isoDate.split('-').map(Number);

  if (bucket === 'month') {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  }

  const utc = Date.UTC(year!, month! - 1, day!);
  // getUTCDay: 0 is Sunday, so a Monday-based offset is (weekday + 6) % 7.
  const offset = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - offset * 86_400_000).toISOString().slice(0, 10);
}
