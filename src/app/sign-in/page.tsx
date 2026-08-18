import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { db, applyScope } from '@/server/db/client';
import { createSession, verifyCredentials } from '@/server/services/authentication';
import { optionalContext, SESSION_COOKIE } from '@/server/session';

/**
 * Sign-in — Phase 01.1's authentication, given a screen in Phase 01.12.
 *
 * A server action rather than a client-side fetch: the credentials never enter
 * a JavaScript bundle, and the session cookie is set by the server that issued
 * it. The cookie is `httpOnly` and `sameSite=lax` so it cannot be read by a
 * script or sent from another origin.
 *
 * The failure message is deliberately the same whether the account does not
 * exist, the password is wrong, or the account is deactivated. Distinguishing
 * them turns the sign-in form into a way of discovering who has an account.
 */
export const dynamic = 'force-dynamic';

async function signIn(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) redirect('/sign-in?error=1');

  const headerList = await headers();
  const issued = await db
    .transaction(async (tx) => {
      // Authentication runs before there is a principal, so the scope is the
      // user being authenticated and nothing else.
      await applyScope(tx, { userId: '00000000-0000-0000-0000-000000000000', branchCode: '' });
      const user = await verifyCredentials(tx, email, password);
      return createSession(tx, user.id, {
        ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: headerList.get('user-agent'),
      });
    })
    .catch(() => null);

  if (!issued) redirect('/sign-in?error=1');

  const jar = await cookies();
  jar.set(SESSION_COOKIE, issued.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: issued.expiresAt,
  });

  redirect('/');
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await optionalContext()) redirect('/');

  const t = await getTranslations();
  const failed = (await searchParams).error !== undefined;

  return (
    <main
      style={{
        maxInlineSize: '22rem',
        marginInline: 'auto',
        marginBlockStart: '6rem',
        padding: 'var(--space-4)',
      }}
    >
      <h1 className="page__title" style={{ marginBlockEnd: 'var(--space-4)' }}>
        {t('app.name')}
      </h1>

      <form action={signIn}>
        <label htmlFor="email" className="nav__heading" style={{ paddingInline: 0 }}>
          {t('auth.email')}
        </label>
        <input
          className="list__search"
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          style={{ inlineSize: '100%', marginBlockEnd: 'var(--space-3)' }}
        />

        <label htmlFor="password" className="nav__heading" style={{ paddingInline: 0 }}>
          {t('auth.password')}
        </label>
        <input
          className="list__search"
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          style={{ inlineSize: '100%', marginBlockEnd: 'var(--space-4)' }}
        />

        {failed && (
          <p role="alert" style={{ color: 'var(--status-rejected)' }}>
            {t('auth.failed')}
          </p>
        )}

        <button className="action action--primary" type="submit" style={{ inlineSize: '100%' }}>
          {t('auth.sign_in')}
        </button>
      </form>
    </main>
  );
}
