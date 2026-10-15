/**
 * The demo instance — accounting.qs-groups.com (2026-10-16, by direction: "replace
 * accounting with a demo version … logins with admin and admin … one user, a
 * different new database").
 *
 * Demo mode is `ERP_DEMO=on` on a database that is not the live books. It changes
 * three things and nothing else:
 *
 *   * the sign-in takes a bare user name — `admin` is `admin@demo.qs-groups.com`
 *     (`app_user.email` must hold an `@`, so the account keeps a real address);
 *   * nobody is asked for a second factor — the demo's one account is shared by
 *     name, and an authenticator on one visitor's phone cannot be;
 *   * the demo's own accounts keep their passwords — a visitor who changed it
 *     would lock out the next one.
 *
 * The live books are the database `erp`: a demo flag that finds itself on them is
 * ignored, so a copied `.env` line cannot switch the live system's second factor
 * off. An address that cannot be read counts as not a demo, for the same reason.
 */
export const DEMO_DOMAIN = 'demo.qs-groups.com';

/** The live database's name (RUNBOOK-host-build.md § 2). */
export const LIVE_DATABASE = 'erp';

/** The database a connection string names, or null when it cannot be read. */
export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/** Whether this process is the demo: the flag, on a database that is not the live one. */
export function demoEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  if ((env.ERP_DEMO ?? '').trim().toLowerCase() !== 'on') return false;
  const name = databaseNameOf(env.DATABASE_URL);
  return name !== null && name.toLowerCase() !== LIVE_DATABASE;
}

/** What was typed in the sign-in box, as the e-mail it stands for: `admin` → `admin@demo.qs-groups.com`. */
export function demoSignInEmail(typed: string): string {
  const value = typed.trim();
  return value === '' || value.includes('@') ? value : `${value}@${DEMO_DOMAIN}`;
}

/** An account of the demo's own — the ones whose password stays as issued. */
export function isDemoAccount(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${DEMO_DOMAIN}`);
}
