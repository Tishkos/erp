/**
 * REQ-IMPROVE-001 IM2 — a request in flight during a deploy gets a
 * maintenance response, never a 404 or a 500.
 *
 * The two pieces that make that true are files, and this holds them to what
 * the runbook promises: deploy.sh builds beside the running application and
 * swaps the finished build in (so the site is never served from a half-empty
 * .next), keeps the previous build for a rollback, and stops the process only
 * for the migration; nginx answers that window from the maintenance page with
 * 503 and Retry-After, and every limit the two configurations share agrees.
 * The live behaviour is checked by hand at each deploy (RUNBOOK-host-build.md
 * "Deploy and roll back").
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

describe('IM2 · deploy.sh', () => {
  const deploy = read('scripts/ops/deploy.sh');

  it('builds in a sibling directory, not over the running .next', () => {
    expect(deploy).toMatch(/BUILD_DIR="\\\$APP-build"/);
    expect(deploy).toContain('( cd "\\$BUILD_DIR" && npm run build )');
    // The old build is only moved aside once the new one is complete and the migration has passed.
    expect(deploy.indexOf('npm run build')).toBeLessThan(deploy.indexOf('mv "\\$APP/.next" "\\$APP/.next-prev"'));
    expect(deploy.indexOf('npm run db:migrate')).toBeLessThan(deploy.indexOf('mv "\\$APP/.next" "\\$APP/.next-prev"'));
  });

  it('keeps the previous build and prints the rollback', () => {
    expect(deploy).toContain('.next-prev');
    expect(deploy).toMatch(/Rollback: .*mv \.next-prev \.next/);
  });

  it('restarts the previous build itself when the migration fails', () => {
    expect(deploy).toMatch(/if ! npm run db:migrate; then[\s\S]*pm2 restart/);
  });

  it('carries the deployment id into the build and checks /healthz, not /sign-in', () => {
    expect(deploy).toContain('export DEPLOYMENT_ID=');
    expect(deploy).toContain('/healthz');
    expect(deploy).not.toMatch(/curl[^\n]*\/sign-in[^\n]*200/);
  });

  it('ships only what is on origin/main unless the exception is recorded', () => {
    expect(deploy).toContain('git merge-base --is-ancestor HEAD origin/main');
    expect(deploy).toContain('DEPLOY_ANY_BRANCH');
  });
});

describe('IM2 · nginx and the maintenance page', () => {
  const nginx = read('deploy/nginx.example.conf');
  const page = read('deploy/maintenance.html');
  const next = read('next.config.ts');

  it('answers an upstream that is down with the maintenance page as 503', () => {
    expect(nginx).toMatch(/error_page 502 503 504 =503 \/maintenance\.html/);
    expect(nginx).toContain('proxy_intercept_errors on');
    expect(nginx).toMatch(/add_header Retry-After \d+ always/);
  });

  it('serves a page that needs nothing running and refreshes itself', () => {
    expect(page).toContain('<meta http-equiv="refresh"');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/src="\//);
    expect(page).toContain('QS ERP');
    // Both languages, since the shell is bilingual.
    expect(page).toContain('dir="rtl"');
  });

  it('passes the request id and the real address the application reads', () => {
    expect(nginx).toContain('X-Request-ID      $request_id');
    expect(nginx).toContain('X-Real-IP         $remote_addr');
  });

  it('agrees with next.config.ts on the body limit, above the 25 MB attachment limit', () => {
    const nginxLimit = Number(/client_max_body_size (\d+)m/.exec(nginx)?.[1]);
    const nextLimit = Number(/bodySizeLimit: '(\d+)mb'/.exec(next)?.[1]);
    expect(nginxLimit).toBe(nextLimit);
    expect(nextLimit).toBeGreaterThan(25);
  });

  it('gives every build its deployment id', () => {
    expect(next).toContain('deploymentId: process.env.DEPLOYMENT_ID');
  });
});
