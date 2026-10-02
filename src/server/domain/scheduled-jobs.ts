/**
 * The scheduled jobs' two text formats, as data — REQ-IMPROVE-001 OP-7.
 *
 * Pure, so the unit tests can read the crontab the server is installed from
 * and the record run-job.sh leaves, without a database.
 */
export interface CrontabJob {
  readonly name: string;
  /** The five cron fields as written. */
  readonly schedule: string;
  readonly timeoutSeconds: number;
  readonly command: string;
}

const CRON_LINE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\$RUN\s+(\S+)\s+(\d+)\s+(.+)$/;

/** The crontab's job lines, as data. Exported for the test. */
export function parseCrontab(source: string): readonly CrontabJob[] {
  const jobs: CrontabJob[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = CRON_LINE.exec(line.replace(/\s+/g, ' '));
    if (!match) continue;
    jobs.push({
      schedule: match[1]!,
      name: match[2]!,
      timeoutSeconds: Number(match[3]),
      command: match[4]!.replace(/\$APP\//g, '').trim(),
    });
  }
  return jobs;
}

/** The record run-job.sh leaves: "<iso> <exit> [<seconds>]". Exported for the test. */
export function parseLastRun(text: string): { at: string; exit: number; seconds: number | null } | null {
  const [at, code, seconds] = text.trim().split(/\s+/);
  if (!at || code === undefined || Number.isNaN(Number(code))) return null;
  return { at, exit: Number(code), seconds: seconds === undefined ? null : Number(seconds) };
}
