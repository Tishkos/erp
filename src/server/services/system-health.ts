/**
 * System health — REQ-IMPROVE-001 OP-4 / OP-7 / OP-8 (IM3).
 *
 * Two readings of the same questions:
 *
 *   `probe`   — what /healthz answers in a few milliseconds, for the deploy
 *               script and an external monitor: can the database be reached,
 *               are the migrations at head, which build is this.
 *   `check`   — what the daily job asks and the administration screen shows:
 *               is the newest backup fresh, do the payable_event partitions
 *               and the fiscal calendar reach far enough ahead, did a
 *               scheduled job fail, is there disk, is the delivery outbox
 *               moving. Each finding is a sentence a person can act on.
 *
 * Nothing here is cached: a health answer that was true an hour ago is the
 * kind of answer that made the footer badge green while the backups stopped.
 */
import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';

export interface Probe {
  readonly ok: boolean;
  readonly database: boolean;
  readonly migrations: { readonly applied: number; readonly expected: number | null; readonly atHead: boolean };
  readonly build: string;
  readonly revision: string;
  readonly version: string;
  readonly checkedAt: string;
}

/** The journal the migrator reads; absent in a build that does not ship the source tree. */
function journalCount(): number | null {
  for (const candidate of ['src/server/db/migrations/meta/_journal.json', '../src/server/db/migrations/meta/_journal.json']) {
    const path = join(process.cwd(), candidate);
    if (existsSync(path)) {
      try {
        return (JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] }).entries.length;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function revision(): string {
  for (const candidate of ['REVISION', '../REVISION', '../../REVISION']) {
    const path = join(process.cwd(), candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  }
  return process.env.GIT_REVISION ?? 'unknown';
}

/**
 * The deploy's id — `DEPLOYMENT_ID` exported by deploy.sh, which next.config
 * turns into `deploymentId`; Next inlines NEXT_DEPLOYMENT_ID as `false` when
 * none was set, so anything that is not a non-empty string is "dev".
 */
export function buildId(): string {
  for (const value of [process.env.NEXT_DEPLOYMENT_ID, process.env.DEPLOYMENT_ID]) {
    if (typeof value === 'string' && value.length > 0 && value !== 'false') return value;
  }
  return 'dev';
}

/** The Node the server runs on, for the start-up line. */
export function nodeVersion(): string {
  return process.version;
}

/** The release in package.json — OP-11: the footer shows the version that runs, not a string. */
export function version(): string {
  for (const candidate of ['package.json', '../package.json', '../../package.json']) {
    const path = join(process.cwd(), candidate);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // fall through
      }
    }
  }
  return '0.0.0';
}

export async function probe(tx: Tx): Promise<Probe> {
  let database = false;
  let applied = 0;
  try {
    await tx.execute(sql`select 1`);
    database = true;
    const rows = (await tx.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows as { n: number }[];
    applied = rows[0]?.n ?? 0;
  } catch {
    database = false;
  }
  const expected = journalCount();
  const atHead = database && (expected === null || applied >= expected);
  return {
    ok: database && atHead,
    database,
    migrations: { applied, expected, atHead },
    build: buildId(),
    revision: revision(),
    version: version(),
    checkedAt: new Date().toISOString(),
  };
}

export type Severity = 'stop' | 'warn';
export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
}

export interface HealthReport {
  readonly today: string;
  readonly findings: readonly Finding[];
  readonly checked: readonly string[];
}

export interface CheckOptions {
  /** Where backup.sh writes; the live default is /root/erp-backups. */
  readonly backupRoot?: string;
  /** Where run-job.sh leaves each job's last exit; the live default is <app>/var/jobs. */
  readonly jobStateDir?: string;
  /** The data mount to measure; the live default is the backup root's. */
  readonly diskPath?: string;
  readonly now?: Date;
}

const HOURS = 3_600_000;

export async function check(tx: Tx, options: CheckOptions = {}): Promise<HealthReport> {
  const now = options.now ?? new Date();
  const today = businessToday(now);
  const findings: Finding[] = [];
  const checked: string[] = [];

  // 1. The newest backup set, and whether anything left the server.
  const backupRoot = options.backupRoot ?? process.env.BACKUP_ROOT ?? '/root/erp-backups';
  const nightly = join(backupRoot, 'nightly');
  checked.push('backup');
  if (!existsSync(nightly)) {
    findings.push({ code: 'backup_missing', severity: 'stop', message: `No nightly backup has ever been written under ${nightly}. Install the crontab (scripts/ops/install-cron.sh).` });
  } else {
    const sets = readdirSync(nightly).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
    const newest = sets.at(-1);
    if (!newest) {
      findings.push({ code: 'backup_missing', severity: 'stop', message: `No nightly backup set under ${nightly}.` });
    } else {
      const at = statSync(join(nightly, newest)).mtime;
      const ageHours = (now.getTime() - at.getTime()) / HOURS;
      if (ageHours > 26) {
        findings.push({ code: 'backup_stale', severity: 'stop', message: `The newest backup (${newest}) is ${Math.round(ageHours)} hours old; the nightly job has not run.` });
      }
      const manifest = join(nightly, newest, 'manifest.txt');
      if (!existsSync(manifest)) {
        findings.push({ code: 'backup_incomplete', severity: 'stop', message: `Backup set ${newest} has no manifest — it did not finish.` });
      }
      const files = readdirSync(join(nightly, newest));
      if (!files.some((f) => f.endsWith('.age'))) {
        findings.push({ code: 'backup_unencrypted', severity: 'warn', message: `Backup set ${newest} is not encrypted: AGE_RECIPIENT is not set in /etc/qs-erp/backup.env.` });
      }
    }
  }

  // 2. payable_event partitions — twelve months ahead or every payable write fails on the first day without one.
  checked.push('partitions');
  const partitions = (await tx.execute(sql`
    select c.relname as name
      from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
     where p.relname = 'payable_event' order by 1`)).rows as { name: string }[];
  const years = partitions.map((p) => Number(p.name.replace(/\D/g, '').slice(-4))).filter((y) => y > 2000);
  const horizon = years.length ? Math.max(...years) : 0;
  const needed = Number(today.slice(0, 4)) + 1;
  if (horizon < needed) {
    findings.push({ code: 'partition_horizon', severity: horizon <= Number(today.slice(0, 4)) ? 'stop' : 'warn', message: `payable_event has partitions to ${horizon || 'none'}; from ${horizon + 1}-01-01 every payable change will fail. The payables sweep creates next year's — check it is running.` });
  }

  // 3. The fiscal calendar: this month open, next year present by November.
  checked.push('fiscal');
  const periods = (await tx.execute(sql`
    select p.status, y.name as year from fiscal_period p join fiscal_year y on y.id = p.fiscal_year_id
     where ${today}::date between p.starts_on and p.ends_on`)).rows as { status: string; year: string }[];
  if (periods.length === 0) {
    findings.push({ code: 'period_missing', severity: 'stop', message: `No fiscal period covers ${today}; nothing can post. Open the year on Finance → Periods.` });
  } else if (periods.some((p) => p.status === 'closed')) {
    findings.push({ code: 'period_closed', severity: 'warn', message: `The period covering ${today} is closed.` });
  }
  const month = Number(today.slice(5, 7));
  if (month >= 11) {
    const next = Number(today.slice(0, 4)) + 1;
    const nextYear = (await tx.execute(sql`select 1 from fiscal_year where ${`${next}-01-01`}::date between starts_on and ends_on limit 1`)).rows;
    if (nextYear.length === 0) {
      findings.push({ code: 'next_year_missing', severity: 'warn', message: `The fiscal year ${next} is not open yet; from ${next}-01-01 nothing can post until it is (Finance → Periods).` });
    }
  }

  // 4. Scheduled jobs that last failed.
  checked.push('jobs');
  const jobs = options.jobStateDir ?? process.env.JOB_STATE_DIR ?? join(process.cwd(), 'var', 'jobs');
  if (existsSync(jobs)) {
    for (const file of readdirSync(jobs).filter((f) => f.endsWith('.last'))) {
      const [at, code] = readFileSync(join(jobs, file), 'utf8').trim().split(/\s+/);
      const name = file.replace(/\.last$/, '');
      if (code && code !== '0' && at && now.getTime() - Date.parse(at) < 36 * HOURS) {
        findings.push({ code: 'job_failed', severity: name === 'backup' || name === 'restore-drill' ? 'stop' : 'warn', message: `The scheduled job "${name}" last exited with ${code} at ${at}; read /var/log/qs-erp/${name}.log.` });
      }
    }
  }

  // 5. Disk.
  checked.push('disk');
  try {
    const target = options.diskPath ?? (existsSync(backupRoot) ? backupRoot : process.cwd());
    const fs = statfsSync(target);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const total = Number(fs.blocks) * Number(fs.bsize);
    const pct = total > 0 ? Math.round((free / total) * 100) : 100;
    if (pct < 10) {
      findings.push({ code: 'disk_low', severity: 'stop', message: `${pct}% of the disk holding ${target} is free (${Math.round(free / 1e9)} GB). Rotate backups or grow the volume before the database stops.` });
    } else if (pct < 20) {
      findings.push({ code: 'disk_low', severity: 'warn', message: `${pct}% of the disk holding ${target} is free.` });
    }
  } catch {
    // A platform without statfs — nothing to say.
  }

  // 6. The delivery outbox: pending rows older than a day mean no runner.
  checked.push('deliveries');
  const stuck = (await tx.execute(sql`
    select count(*)::int as n from notification_delivery
     where status = 'pending' and last_attempt_at is null
       and exists (select 1 from notification n where n.id = notification_id and n.created_at < now() - interval '1 day')`)).rows as { n: number }[];
  if ((stuck[0]?.n ?? 0) > 0) {
    findings.push({ code: 'deliveries_stuck', severity: 'warn', message: `${stuck[0]!.n} notification deliveries have waited more than a day: the delivery job is not running (REQ-HARDEN-001 F2).` });
  }

  // 7. Bank/cash accounts whose ledger account is gone — the restore drill
  // fails on exactly this foreign key (REQ-HARDEN-001 F5, CASH-ACCOUNTANT_ERBIL).
  checked.push('bank_accounts');
  const dangling = (await tx.execute(sql`
    select b.code from bank_cash_account b
     where b.active and not exists (select 1 from chart_of_account a where a.id = b.gl_account_id and a.is_active)
     order by b.code`)).rows as { code: string }[];
  if (dangling.length > 0) {
    findings.push({ code: 'bank_account_unlinked', severity: 'stop', message: `${dangling.map((d) => d.code).join(', ')}: the ledger account behind this bank/cash account is missing or inactive. Re-link it on Master Data → Bank/Cash Accounts; until then the restore drill and the statements fail on it.` });
  }

  return { today, findings, checked };
}

/** Tells every accounting manager and super user once a day, in the bell. */
export async function notify(tx: Tx, report: HealthReport): Promise<number> {
  if (report.findings.length === 0) return 0;
  const recipients = (await tx.execute(sql`
    select distinct u.id as user_id from app_user u left join user_role r on r.user_id = u.id
     where u.is_active and (u.is_super_user or r.role_code in ('accounting_manager', 'system_administrator'))`)).rows as { user_id: string }[];
  const body = report.findings.map((f) => `${f.severity === 'stop' ? '⛔' : '⚠'} ${f.message}`).join('\n');
  const stops = report.findings.filter((f) => f.severity === 'stop').length;
  let notified = 0;
  for (const { user_id } of recipients) {
    const inserted = (await tx.execute(sql`
      select app_notify(null, 'system.health', 'system_health', ${report.today}, ${user_id}::uuid,
                        ${`System health: ${report.findings.length} finding(s)${stops ? `, ${stops} serious` : ''}`},
                        ${body}, ${JSON.stringify({ day: report.today, codes: report.findings.map((f) => f.code) })}::jsonb,
                        ${`system-health:${report.today}:${report.findings.map((f) => f.code).sort().join(',')}:${user_id}`}, null) as id`)).rows as { id: string | null }[];
    if (inserted[0]?.id) notified += 1;
  }
  return notified;
}

export const PERMISSION_OBJECT = 'system_health';

export interface BackupSet {
  readonly name: string;
  readonly writtenAt: string;
  readonly bytes: number;
  readonly encrypted: boolean;
  readonly complete: boolean;
  /** backup.sh writes `offsite.txt` into the set once rclone has copied it. */
  readonly offsite: boolean;
}

/** The nightly sets on disk, newest first — what the Backup and Health screen lists. */
export function backupSets(options: { backupRoot?: string; limit?: number } = {}): { root: string; sets: readonly BackupSet[] } {
  const backupRoot = options.backupRoot ?? process.env.BACKUP_ROOT ?? '/root/erp-backups';
  const nightly = join(backupRoot, 'nightly');
  if (!existsSync(nightly)) return { root: nightly, sets: [] };
  const names = readdirSync(nightly).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort().reverse().slice(0, options.limit ?? 14);
  return {
    root: nightly,
    sets: names.map((name) => {
      const dir = join(nightly, name);
      const files = readdirSync(dir);
      const bytes = files.reduce((n, f) => {
        try {
          return n + statSync(join(dir, f)).size;
        } catch {
          return n;
        }
      }, 0);
      return {
        name,
        writtenAt: statSync(dir).mtime.toISOString(),
        bytes,
        encrypted: files.some((f) => f.endsWith('.age')),
        complete: files.includes('manifest.txt'),
        offsite: files.includes('offsite.txt'),
      };
    }),
  };
}
