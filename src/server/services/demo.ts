import { demoEnabled } from '@domain/demo';

/**
 * Whether this process serves the demo (accounting.qs-groups.com) — the rules are
 * `domain/demo.ts`. Read from the environment on every call, so a test can set it.
 */
let refusedOnce = false;

export function demoMode(): boolean {
  const on = demoEnabled(process.env);
  if (!on && !refusedOnce && (process.env.ERP_DEMO ?? '').trim().toLowerCase() === 'on') {
    refusedOnce = true;
    console.error('ERP_DEMO=on is ignored: DATABASE_URL names the live books (or cannot be read).');
  }
  return on;
}
