import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import { Globe, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { db, applyScope } from '@/server/db/client';
import { createSession, verifyCredentials } from '@/server/services/authentication';
import { optionalContext, SESSION_COOKIE } from '@/server/session';
import { LoginForm } from '@/components/login-form';
import mainLogo from '../../../mainLogo.png';
import styles from './sign-in.module.css';

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
    ...(remember ? { expires: issued.expiresAt } : {}),
  });

  redirect('/');
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await optionalContext()) redirect('/');

  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const failed = (await searchParams).error !== undefined;

  return (
    <main className={styles.page}>
      {/*
        The brand panel. The grid and concentric rings are pseudo-elements on
        this section; the lockup already carries the company name and
        strapline, so the panel adds only the product tagline beneath it.
      */}
      <section className={styles.brand}>
        <div className={styles.brandHeading}>
          <Image
            alt={t('shell.logo_alt')}
            className={styles.brandLogo}
            preload
            sizes="(max-width: 52rem) 96px, 132px"
            src={mainLogo}
          />
          <p className={styles.brandStrapline}>{t('app.tagline')}</p>
        </div>

        <div className={styles.brandFooter}>
          <div>
            <p className={styles.pillarTitle}>{t('auth.pillar_one_title')}</p>
            <p className={styles.pillarBody}>{t('auth.pillar_one_body')}</p>
          </div>
          <i aria-hidden="true" />
          <div>
            <p className={styles.pillarTitle}>{t('auth.pillar_two_title')}</p>
            <p className={styles.pillarBody}>{t('auth.pillar_two_body')}</p>
          </div>
        </div>
      </section>

      <section className={styles.formSide}>
        <p className={styles.authorized}>
          <ShieldCheck aria-hidden="true" />
          <span>{t('auth.authorized')}</span>
        </p>

        <LoginForm action={signIn} className={styles.card} failed={failed} />

        <footer className={styles.pageFooter}>
          <span>
            © {new Date().getFullYear()} {t('auth.company')}
          </span>
          <span className={styles.pageFooterLang}>
            <Globe aria-hidden="true" />
            {locale === 'ar' ? t('shell.arabic') : t('shell.english')}
          </span>
        </footer>
      </section>
    </main>
  );
}
