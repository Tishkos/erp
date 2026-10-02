/**
 * REQ-IMPROVE-001 IM5 — two overlapping runs of a job: one runs, one exits.
 *
 * `run-job.sh` is the wrapper every crontab line goes through. It is run here
 * twice at once with a command that sleeps: the first takes the lock and
 * finishes with the command's exit code; the second finds the lock held and
 * leaves with 3, without running the command. Then the crontab itself: every
 * line goes through the wrapper, with a timeout, naming a script that exists.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCrontab, parseLastRun } from '../../src/server/domain/scheduled-jobs';

const ROOT = process.cwd();
const RUN = join(ROOT, 'scripts/ops/run-job.sh');
const dir = mkdtempSync(join(tmpdir(), 'run-job-'));

function run(name: string, ...command: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [RUN, name, '30', ...command], {
      env: { ...process.env, APP: dir, LOG: join(dir, 'log') },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve({ code }));
  });
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('IM5 · run-job.sh', () => {
  it('lets one of two overlapping runs through and turns the other away', async () => {
    const [first, second] = await Promise.all([run('im05', 'sleep', '2'), new Promise<{ code: number | null }>((r) => setTimeout(() => run('im05', 'sleep', '2').then(r), 300))]);
    expect([first.code, second.code].sort()).toEqual([0, 3]);
    const last = parseLastRun(readFileSync(join(dir, 'var/jobs/im05.last'), 'utf8'));
    expect(last?.exit).toBe(0);
    expect(last?.seconds).toBeGreaterThanOrEqual(1);
    const log = readFileSync(join(dir, 'log/im05.log'), 'utf8');
    expect(log).toContain('another run of im05 is still going');
    expect(log).toMatch(/end im05 exit=0 after \ds/);
  }, 20_000);

  it('records a failing command as a failure', async () => {
    const { code } = await run('im05-fail', 'bash', '-c', 'exit 7');
    expect(code).toBe(7);
    expect(parseLastRun(readFileSync(join(dir, 'var/jobs/im05-fail.last'), 'utf8'))?.exit).toBe(7);
  });
});

describe('IM5 · crontab.erp', () => {
  const jobs = parseCrontab(readFileSync(join(ROOT, 'scripts/ops/crontab.erp'), 'utf8'));

  it('schedules the six jobs the requirement names and the delivery job (WA-1), each through the wrapper with a timeout', () => {
    expect(jobs.map((j) => j.name).sort()).toEqual(['backup', 'deliver-notifications', 'due-notices', 'health-check', 'inventory-integrity', 'payables-sweep', 'restore-drill']);
    for (const job of jobs) expect(job.timeoutSeconds, job.name).toBeGreaterThan(0);
  });

  it('names only scripts that exist', () => {
    for (const job of jobs) {
      const script = job.command.split(/\s+/).find((word) => word.startsWith('scripts/'));
      expect(script, job.name).toBeDefined();
      expect(existsSync(join(ROOT, script!)), `${job.name}: ${script}`).toBe(true);
    }
  });

  it('runs every line through run-job.sh, never a bare command', () => {
    const lines = readFileSync(join(ROOT, 'scripts/ops/crontab.erp'), 'utf8')
      .split('\n')
      .filter((line) => /^\s*[\d*]/.test(line));
    expect(lines.length).toBe(jobs.length);
    for (const line of lines) expect(line).toContain('$RUN');
  });
});
