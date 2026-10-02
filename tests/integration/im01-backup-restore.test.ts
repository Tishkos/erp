/**
 * REQ-IMPROVE-001 IM1 — a backup set restores on a clean database and
 * passes `verify-recovery`.
 *
 * The nightly job is `backup.sh`; the weekly drill restores its newest set
 * and runs `scripts/verify-recovery.ts` on the copy. This is that pipeline,
 * end to end, against the test database: the set is written to a temporary
 * folder with a manifest and checksums, restored into a database created
 * for the test, verified by the same script the drill calls, and dropped.
 * The restore is exact — no `--no-owner`, no `--no-acl` — because a recovery
 * that silently dropped the grants or FORCE ROW LEVEL SECURITY would start,
 * serve, and leak.
 *
 * The off-site copy and the key cannot be exercised here (rclone and age are
 * the server's); the runbook records the measured RPO/RTO from the drill.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';

const ROOT = process.cwd();
const url = new URL(process.env.DATABASE_URL_TEST!);
const PG = {
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
};
const DRILL_DB = `erp_im01_drill_${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'im01-'));

const clientMajor = Number(/\(PostgreSQL\) (\d+)/.exec(execFileSync('pg_dump', ['--version']).toString())?.[1]);
let serverVersion = 0;
let able = false;

beforeAll(async () => {
  await resetTestData();
  await seedBranch('BGW', 'Baghdad');
  serverVersion = Number(/^(\d+)/.exec((await ownerPool.query('show server_version')).rows[0].server_version)?.[1]);
  // pg_dump refuses a server newer than itself; the CI job installs a client of the service's version.
  able = clientMajor >= serverVersion;
});

afterAll(async () => {
  await ownerPool.query(`drop database if exists "${DRILL_DB}"`).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const sh = (file: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [file, ...args], { env: { ...process.env, ...PG, ...env }, encoding: 'utf8', cwd: ROOT });

describe('IM1 · backup and restore', () => {
  it('backup.sh writes a complete, checksummed nightly set', () => {
    if (!able) {
      console.warn(`skipping: pg_dump ${clientMajor} cannot dump a PostgreSQL ${serverVersion} server`);
      return;
    }
    const result = sh('scripts/ops/backup.sh', ['--local'], { BACKUP_ROOT: dir, APP: join(dir, 'app'), LOCAL_RUN: '1' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const sets = readdirSync(join(dir, 'nightly'));
    expect(sets).toHaveLength(1);
    const files = readdirSync(join(dir, 'nightly', sets[0]!));
    expect(files.some((f) => /^erp-\d{8}-\d{6}\.dump$/.test(f))).toBe(true);
    expect(files.some((f) => /^globals-.*\.sql$/.test(f))).toBe(true);
    const manifest = readFileSync(join(dir, 'nightly', sets[0]!, 'manifest.txt'), 'utf8');
    expect(manifest).toMatch(/^stamp=\d{8}-\d{6}$/m);
    expect(manifest).toMatch(/[0-9a-f]{64} {2}\.\/erp-.*\.dump/);
    // The roles travel with the set: a restore on a new host needs them first.
    const globals = readFileSync(join(dir, 'nightly', sets[0]!, files.find((f) => f.startsWith('globals-'))!), 'utf8');
    expect(globals).toContain('CREATE ROLE erp_app');
    // Not encrypted and not copied off, and the log says so rather than hiding it.
    expect(result.stdout).toContain('AGE_RECIPIENT not set');
    expect(result.stdout).toContain('RCLONE_REMOTE not set');
  }, 120_000);

  it('the set restores into a clean database exactly, and verify-recovery passes on it', async () => {
    if (!able) return;
    const set = readdirSync(join(dir, 'nightly'))[0]!;
    const dump = readdirSync(join(dir, 'nightly', set)).find((f) => f.endsWith('.dump'))!;
    expect(existsSync(join(dir, 'nightly', set, dump))).toBe(true);

    await ownerPool.query(`drop database if exists "${DRILL_DB}"`);
    await ownerPool.query(`create database "${DRILL_DB}" owner ${PG.PGUSER} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`);
    const restore = spawnSync('pg_restore', ['-d', DRILL_DB, '--exit-on-error', join(dir, 'nightly', set, dump)], {
      env: { ...process.env, ...PG },
      encoding: 'utf8',
    });
    expect(restore.status, restore.stderr).toBe(0);

    // The same checks the live drill runs, on the copy: tables, RLS, grants, migrations, balance.
    const live = await ownerPool.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
    const drillUrl = `postgres://${encodeURIComponent(PG.PGUSER)}:${encodeURIComponent(PG.PGPASSWORD)}@${PG.PGHOST}:${PG.PGPORT}/${DRILL_DB}`;
    const verify = spawnSync('npx', ['tsx', 'scripts/verify-recovery.ts', DRILL_DB], {
      env: { ...process.env, DATABASE_URL_OWNER: drillUrl },
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(verify.status, verify.stdout + verify.stderr).toBe(0);
    expect(verify.stdout).toContain('schema is at head');
    expect(verify.stdout).toContain('row-level security is enabled and forced');
    expect(verify.stdout).toContain('All checks passed');

    const { Pool } = await import('pg');
    const copy = new Pool({ connectionString: drillUrl, max: 1 });
    try {
      const tables = await copy.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
      expect(tables.rows[0].n).toBe(live.rows[0].n);
      const branch = await copy.query(`select name from branch where code = 'BGW'`);
      expect(branch.rows[0]?.name).toBe('Baghdad');
      // FORCE ROW LEVEL SECURITY survived — the thing --no-acl restores would lose.
      const forced = await copy.query(`select relforcerowsecurity from pg_class where relname = 'journal_entry'`);
      expect(forced.rows[0].relforcerowsecurity).toBe(true);
    } finally {
      await copy.end();
    }
  }, 180_000);
});
