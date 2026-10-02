/**
 * REQ-IMPROVE-001 IM3 — /healthz: database down ⇒ 503, and the deploy
 * aborts on anything but 200.
 *
 * The probe is what the route, the deploy script's loop and the footer badge
 * all read. It answers "ok" only when the database answers *and* the
 * migrations are at the journal's head; a schema one migration behind is a
 * 503 the deploy must not call healthy. The daily check (OP-7, OP-8) is run
 * against a temporary backup folder in each of its states.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData } from './setup';
import { db, type Tx } from '@/server/db/client';
import { backupSets, check, probe, version } from '@/server/services/system-health';
import { GET } from '@/app/healthz/route';

const dir = mkdtempSync(join(tmpdir(), 'health-'));

function set(name: string, options: { ageHours: number; manifest?: boolean; encrypted?: boolean; offsite?: boolean }) {
  const path = join(dir, 'nightly', name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `erp-${name}.dump${options.encrypted ? '.age' : ''}`), 'x'.repeat(2048));
  if (options.manifest !== false) writeFileSync(join(path, 'manifest.txt'), `stamp=${name}\n`);
  if (options.offsite) writeFileSync(join(path, 'offsite.txt'), 'remote:nightly\n');
  const at = new Date(Date.now() - options.ageHours * 3_600_000);
  utimesSync(path, at, at);
}

beforeAll(async () => {
  await resetTestData();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('IM3 · the probe', () => {
  it('answers ok with the database up and the schema at head', async () => {
    const result = await db.transaction((tx) => probe(tx));
    expect(result.ok).toBe(true);
    expect(result.database).toBe(true);
    expect(result.migrations.atHead).toBe(true);
    expect(result.migrations.expected).toBe(result.migrations.applied);
    expect(result.version).toBe(version());
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers 503 when the database does not answer', async () => {
    const down = { execute: async () => { throw new Error('connection refused'); } } as unknown as Tx;
    const result = await probe(down);
    expect(result.ok).toBe(false);
    expect(result.database).toBe(false);
    expect(result.migrations.atHead).toBe(false);
  });

  it('answers 503 when the schema is behind the journal', async () => {
    // A transaction that answers select 1 but reports one migration fewer than the journal.
    const behind = {
      execute: async (query: { queryChunks?: unknown[] }) =>
        JSON.stringify(query.queryChunks ?? '').includes('__drizzle_migrations') ? { rows: [{ n: 1 }] } : { rows: [] },
    } as unknown as Tx;
    const result = await probe(behind);
    expect(result.database).toBe(true);
    expect(result.migrations.atHead).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('serves the route as JSON with no-store, 200 when ok', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { ok: boolean; database: boolean; build: string; revision: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.database).toBe(true);
    expect(typeof body.build).toBe('string');
    expect(typeof body.revision).toBe('string');
    // No business data and nothing secret: the keys are exactly these.
    expect(Object.keys(body).sort()).toEqual(['build', 'checkedAt', 'database', 'migrations', 'ok', 'revision', 'version']);
  });
});

describe('IM3 · the daily check (OP-7, OP-8)', () => {
  it('reports a missing, a stale, an unfinished and an unencrypted backup', async () => {
    const none = await db.transaction((tx) => check(tx, { backupRoot: join(dir, 'none'), jobStateDir: join(dir, 'nojobs') }));
    expect(none.findings.map((f) => f.code)).toContain('backup_missing');
    expect(none.checked).toEqual(['backup', 'partitions', 'fiscal', 'jobs', 'disk', 'deliveries']);

    set('20260101-010000', { ageHours: 48, manifest: false });
    const stale = await db.transaction((tx) => check(tx, { backupRoot: dir, jobStateDir: join(dir, 'nojobs') }));
    const codes = stale.findings.map((f) => f.code);
    expect(codes).toContain('backup_stale');
    expect(codes).toContain('backup_incomplete');
    expect(codes).toContain('backup_unencrypted');
    expect(stale.findings.find((f) => f.code === 'backup_stale')?.severity).toBe('stop');

    set('20260102-010000', { ageHours: 2, encrypted: true, offsite: true });
    const fresh = await db.transaction((tx) => check(tx, { backupRoot: dir, jobStateDir: join(dir, 'nojobs') }));
    expect(fresh.findings.map((f) => f.code).filter((c) => c.startsWith('backup_'))).toEqual([]);
  });

  it('lists the sets newest first with what each one has', () => {
    const { sets } = backupSets({ backupRoot: dir });
    expect(sets.map((s) => s.name)).toEqual(['20260102-010000', '20260101-010000']);
    expect(sets[0]).toMatchObject({ encrypted: true, complete: true, offsite: true });
    expect(sets[1]).toMatchObject({ encrypted: false, complete: false, offsite: false });
    expect(sets[0]!.bytes).toBeGreaterThan(2000);
  });

  it('reports a scheduled job that last failed, and only a recent one', async () => {
    const jobs = join(dir, 'jobs');
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, 'backup.last'), `${new Date().toISOString()} 1 12\n`);
    writeFileSync(join(jobs, 'due-notices.last'), `${new Date(Date.now() - 5 * 86_400_000).toISOString()} 1 3\n`);
    writeFileSync(join(jobs, 'health-check.last'), `${new Date().toISOString()} 0 1\n`);
    const report = await db.transaction((tx) => check(tx, { backupRoot: dir, jobStateDir: jobs }));
    const failed = report.findings.filter((f) => f.code === 'job_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toContain('"backup"');
    expect(failed[0]!.severity).toBe('stop');
  });

  it('knows the fiscal calendar and the partition horizon', async () => {
    // The reset leaves no fiscal calendar: nothing can post, and the check says so.
    const before = await db.transaction((tx) => check(tx, { backupRoot: dir, jobStateDir: join(dir, 'nojobs') }));
    expect(before.findings.find((f) => f.code === 'period_missing')?.severity).toBe('stop');

    const year = before.today.slice(0, 4);
    const { rows } = await ownerPool.query(
      `insert into fiscal_year (code, name, starts_on, ends_on) values ($1, $1, $2, $3) returning id`,
      [`FY${year}`, `${year}-01-01`, `${year}-12-31`],
    );
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       select $1, n, to_char(make_date($2, n, 1), 'Mon YYYY'), make_date($2, n, 1), (make_date($2, n, 1) + interval '1 month - 1 day')::date
         from generate_series(1, 12) n`,
      [rows[0].id, Number(year)],
    );
    const after = await db.transaction((tx) => check(tx, { backupRoot: dir, jobStateDir: join(dir, 'nojobs') }));
    expect(after.findings.map((f) => f.code)).not.toContain('period_missing');

    // payable_event is partitioned by year (migration 0226); the horizon is what the check watches.
    const partitions = await ownerPool.query(
      `select count(*)::int as n from pg_inherits i join pg_class p on p.oid = i.inhparent where p.relname = 'payable_event'`,
    );
    expect(partitions.rows[0].n).toBeGreaterThan(0);
    expect(after.findings.find((f) => f.code === 'partition_horizon' && f.severity === 'stop')).toBeUndefined();
  });
});
