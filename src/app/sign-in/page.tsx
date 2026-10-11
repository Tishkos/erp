import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { db, applyScope } from '@/server/db/client';
import { signIn as authenticate } from '@/server/services/authentication';
import { optionalContext, RESTRICTION_ROUTE, SESSION_COOKIE } from '@/server/session';
import { AuthShell, LoginForm } from '@/components/login-form';
import { recaptchaSiteKey, verifyRecaptcha } from '@/server/services/recaptcha';

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
  // Unticked, the cookie is dropped when the browser closes; ticked, it lasts
  // as long as the session the server issued. Neither extends the session.
  const remember = formData.get('remember') === '1';

  const code = String(formData.get('code') ?? '').trim() || null;

  if (!email || !password) redirect('/sign-in?error=1');

  const headerList = await headers();
  // HD3 — the address the lockout counts. nginx sets X-Real-IP from the
  // connection; X-Forwarded-For is what a client can write, so it is only
  // the fallback when nothing better is there.
  const ipAddress =
    headerList.get('x-real-ip')?.trim() || headerList.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  // The captcha, before the credentials are looked at: a form Google does not
  // vouch for is not a sign-in attempt and is not counted as one. Where the
  // server has no site key there is no box and nothing to check.
  if (recaptchaSiteKey()) {
    const human = await verifyRecaptcha({ response: String(formData.get('g-recaptcha-response') ?? ''), remoteIp: ipAddress });
    if (!human.ok) {
      console.warn(`sign-in captcha refused: ${human.reason}`);
      redirect(`/sign-in?error=captcha${formData.get('code') !== null ? '&mfa=1' : ''}`);
    }
  }
  // The refusal is a value, not a throw, so the attempt and its audit row
  // commit with it (HD3). A database failure is the one thing still thrown,
  // and reads as a refusal to the visitor.
  const issued = await db
    .transaction(async (tx) => {
      // Authentication runs before there is a principal, so the scope is the
      // user being authenticated and nothing else.
      await applyScope(tx, { userId: '00000000-0000-0000-0000-000000000000', branchCode: '' });
      return authenticate(tx, {
        email,
        password,
        code,
        ipAddress: ipAddress && /^[0-9a-f.:]+$/i.test(ipAddress) ? ipAddress : null,
        userAgent: headerList.get('user-agent'),
      });
    })
    .catch((error: unknown) => {
      console.error('sign-in failed', error);
      return { ok: false, refusal: 'credentials' } as const;
    });

  if (!issued.ok) {
    switch (issued.refusal) {
      case 'second_factor_required':
        redirect('/sign-in?mfa=1');
      case 'second_factor_wrong':
        redirect('/sign-in?mfa=1&error=code');
      case 'locked':
        redirect('/sign-in?error=locked');
      case 'temporary_expired':
        redirect('/sign-in?error=expired');
      default:
        redirect('/sign-in?error=1');
    }
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, issued.session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    ...(remember ? { expires: issued.session.expiresAt } : {}),
  });

  // HD2 / HD4 — a restricted session goes to the one screen it may use. An
  // account inside its enrolment grace lands home and finds the reminder in
  // the bell (written by the service, once a day).
  if (issued.restriction) redirect(RESTRICTION_ROUTE[issued.restriction]);
  redirect('/');
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await optionalContext()) redirect('/');

  const params = await searchParams;
  const failed =
    params.error === 'locked'
      ? 'locked'
      : params.error === 'expired'
        ? 'expired'
        : params.error === 'code'
          ? 'code'
          : params.error === 'captcha'
            ? 'captcha'
            : params.error !== undefined
              ? 'credentials'
              : null;
  const mfa = params.mfa === '1';

  // The page around the form — the company's mark, the language switch, what
  // the system is — is `AuthShell`'s; the password screen wears the same.
  return (
    <AuthShell pillars>
      <LoginForm action={signIn} captcha={recaptchaSiteKey()} failed={failed} mfa={mfa} />
    </AuthShell>
  );
}
