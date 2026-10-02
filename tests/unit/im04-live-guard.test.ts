/**
 * REQ-IMPROVE-001 IM4 — every script under scripts/ that can write refuses
 * with the live marker present.
 *
 * Two halves. The guard itself: with `var/LIVE` under the working directory
 * `refuseOnLive` exits 1 and names the marker; without it, nothing happens;
 * with the marker and the recorded exception flag, the scripts that have a
 * live use carry on. And the coverage: every script that writes to the
 * database either calls the guard or is on the list below of scripts whose
 * *purpose* is the live database — each with the reason — so a new script
 * that writes and forgets the guard fails this test rather than a live
 * database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = process.cwd();

/** Scripts whose job is the live database, and why the marker must not stop them. */
const LIVE_USE: Readonly<Record<string, string>> = {
  'scripts/ops/backup.sh': 'reads the database and writes files; the nightly job',
  'scripts/ops/restore-drill.sh': 'restores into a scratch database it creates and drops; refuses a target named like the live one',
  'scripts/ops/deploy.sh': 'the deploy applies migrations on purpose, after a dump',
  'scripts/ops/format-live-database.sh': 'carries its own refusal while var/LIVE exists (INCIDENTS 2026-09-27)',
  'scripts/ops/remove-orphan-stock-documents.sh': 'a live repair, --yes, refuses documents with movements, audits each removal',
  'scripts/ops/link-balance-sheet-to-cash-flow.ts': 'a live configuration fix, dry-run by default, --apply to write',
  'scripts/ops/payables-sweep.ts': 'a scheduled job on the live books (REQ-AP-001 §19.3)',
  'scripts/ops/due-notices.ts': 'a scheduled job on the live books',
  'scripts/ops/hr-sweep.ts': 'a scheduled job; writes only notifications (REQ-HR-001 HR-2)',
  'scripts/ops/inventory-integrity-check.ts': 'a scheduled job; writes only notifications',
  'scripts/ops/health-check.ts': 'a scheduled job; writes only notifications',
  'scripts/ops/deliver-notifications.ts': 'a scheduled job; writes only delivery status (REQ-WA-001 WA-1)',
  'scripts/ops/closing-checks.ts': 'a scheduled job; writes only notifications (REQ-IMPROVE-001 FC-4)',
  'scripts/ops/whatsapp-bridge.ts': 'the live bridge; writes only its own session, the message log and delivery status (REQ-WA-001)',
  'scripts/ops/ensure-stage-warehouses.ts': 'creates the stage warehouses a live install needs; idempotent',
  'scripts/ops/ensure-user-employees.ts': 'makes the employee behind each active user (REQ-FIX-001 FX14); idempotent, dry run unless --apply, run by the deploy',
  'scripts/ops/install-cron.sh': 'writes the crontab, not the database',
  'scripts/ops/make-staging-copy.sh': 'writes only a database that is not the live one; refuses the live name',
  'scripts/verify-recovery.ts': 'reads a restored database',
  'scripts/ops/account-statement-check.ts': 'reads',
  'scripts/ops/statement-coverage.ts': 'reads',
  'scripts/ops/stock-movement-trace.ts': 'reads',
  'scripts/ops/run-job.sh': 'runs another script; the guard is theirs',
  'scripts/ops/prepare-legacy-import.ts':
    'the configuration the legacy import asks for, on the install that is being loaded — idempotent, and every row it writes is editable on its own screen',
  'scripts/ops/legacy-books-import.ts':
    'loads the old books onto the live install at the cut-over; dry run by default, --apply to write, and the same service the screen calls',
  'scripts/ops/create-first-user.ts':
    'the first sign-in on an install that has nobody — which is a live install by the time it is needed; it refuses the moment any user exists, so it cannot add a second way in',
};

const WRITE = /\b(insert into|update\s+[a-z_"]+\s+set|delete from|truncate|drop database|create database|pg_restore)\b|\.(insert|update|delete)\(/i;
const GUARD = /refuseOnLive\(|refuse_on_live|var\/LIVE/;

function scripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      // Forward slashes, whatever the platform: the list below is written the
      // way the repository spells its paths, and on Windows `join` produces
      // backslashes — so every lookup missed and the test failed on the
      // developer's machine while passing in CI.
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|sh)$/.test(entry.name) && !rel.startsWith('scripts/lib/') && !rel.startsWith('scripts/sql/')) out.push(rel);
    }
  };
  walk('scripts');
  return out.sort();
}

describe('IM4 · the live marker guards every writing script', () => {
  it('every script that writes either calls the guard or is listed with its live reason', () => {
    const unguarded = scripts().filter((file) => {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (!WRITE.test(source)) return false;
      if (GUARD.test(source)) return false;
      return !(file in LIVE_USE);
    });
    expect(unguarded).toEqual([]);
  });

  it('lists no script that does not exist, so the list cannot rot', () => {
    const present = new Set(scripts());
    expect(Object.keys(LIVE_USE).filter((file) => !present.has(file))).toEqual([]);
  });

  it('the fixture writers call the guard', () => {
    for (const file of ['scripts/db-reset.ts', 'scripts/seed-dev.ts', 'scripts/ops/ensure-ceo-user.ts', 'scripts/ops/new-company-setup.sh', 'scripts/ops/reset-statement-mapping.sh']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(GUARD);
    }
  });
});

describe('IM4 · refuseOnLive', () => {
  let dir: string;
  const cwd = process.cwd();

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    process.argv = process.argv.filter((a) => a !== '--i-know-this-is-live');
  });

  async function guard() {
    vi.resetModules();
    return (await import('../../scripts/lib/live-guard')) as typeof import('../../scripts/lib/live-guard');
  }

  it('does nothing without the marker', async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-guard-'));
    process.chdir(dir);
    const { refuseOnLive, liveMarker } = await guard();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    refuseOnLive('reset the database');
    expect(exit).not.toHaveBeenCalled();
    // The server's own marker, if this test ever runs on the server.
    expect(liveMarker() === null || liveMarker() === '/opt/qs-erp-next/var/LIVE').toBe(true);
  });

  it('exits 1 and names the marker when var/LIVE exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-guard-'));
    mkdirSync(join(dir, 'var'));
    writeFileSync(join(dir, 'var', 'LIVE'), 'live since 2026-09-27');
    process.chdir(dir);
    const { refuseOnLive } = await guard();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseOnLive('reset the database');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('Refusing to reset the database');
    expect(String(error.mock.calls[0]?.[0])).toContain(join(dir, 'var', 'LIVE'));
    expect(String(error.mock.calls[0]?.[0])).toContain('live since 2026-09-27');
  });

  it('lets a script with a live use through only with the recorded flag', async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-guard-'));
    mkdirSync(join(dir, 'var'));
    writeFileSync(join(dir, 'var', 'LIVE'), '');
    process.chdir(dir);
    const { refuseOnLive } = await guard();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseOnLive('create the CEO', { allowFlag: true });
    expect(exit).toHaveBeenCalledTimes(1);
    process.argv.push('--i-know-this-is-live');
    refuseOnLive('create the CEO', { allowFlag: true });
    expect(exit).toHaveBeenCalledTimes(1);
    // The flag is not honoured by a script that did not ask for it.
    refuseOnLive('reset the database');
    expect(exit).toHaveBeenCalledTimes(2);
  });
});
