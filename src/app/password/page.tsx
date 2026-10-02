import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import { Globe, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Submit } from '@/components/admin';
import admin from '@/components/admin/admin.module.css';
import { PasswordField, SubmitButton } from '@/components/login-form-controls';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { DEFAULT_ACCENT, DEFAULT_PALETTE } from '@domain/appearance';
import { requireContext } from '@/server/session';
import { cn } from '@/lib/utils';
import mainLogo from '../../../mainLogo.png';
import styles from '../sign-in/sign-in.module.css';
import { replaceTemporaryPassword } from './actions';

/**
 * REQ-HARDEN-001 HD2 — the one screen a session on a temporary password may
 * use. `requireContext` sends every other screen here while the flag is set;
 * replacing the password clears it in the same statement that stores the
 * new one, and the next request is an ordinary one.
 *
 * REQ-FIX-001 FIX-2: drawn as the sign-in page is — the brand beside one
 * centred card — because it is the second half of signing in (the sponsor:
 * "the temporary password was left, not centre; it should be a form in the
 * centre"). It sits outside the application shell for the same reason: a
 * restricted session has no menu to show, and a shell with an empty menu
 * and a form pushed into its first column read as a broken page. The same
 * classes as sign-in, nothing new; the fields are sign-in's password field
 * under their own names. Sign out stays on the page.
 */
export const dynamic = 'force-dynamic';

export default async function TemporaryPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, auth, shell, app, locale, context, outcome] = await Promise.all([
    getTranslations('profile'),
    getTranslations('auth'),
    getTranslations('shell'),
    getTranslations('app'),
    getLocale(),
    requireContext({ allowRestricted: true }),
    outcomeOf(searchParams),
  ]);
  const temporary = context.restriction === 'password';
  const field = { capsLockLabel: auth('caps_lock'), hideLabel: auth('hide_password'), showLabel: auth('show_password'), placeholder: '' };

  return (
    <main className={`erp-root ${styles.page}`} data-accent={DEFAULT_ACCENT} data-palette={DEFAULT_PALETTE}>
      <section className={styles.brand}>
        <div className={styles.brandHeading}>
          <Image alt={shell('logo_alt')} className={styles.brandLogo} preload sizes="72px" src={mainLogo} />
          <p className={styles.brandStrapline}>{app('tagline')}</p>
        </div>
      </section>

      <section className={styles.formSide}>
        <p className={styles.authorized}>
          <ShieldCheck aria-hidden="true" />
          <span>{auth('authorized')}</span>
        </p>

        <div className={styles.card}>
          <div className={cn(admin.sapWindow, styles.window)}>
            <div className={admin.sapTitle}>{temporary ? t('temporary_password') : t('change_password')}</div>
            <div className={styles.body}>
              <h1 className={styles.heading}>{t('change_password')}</h1>
              <p className={styles.hint}>{temporary ? t('temporary_hint') : t('change_password_hint')}</p>

              <form action={replaceTemporaryPassword} className={styles.form}>
                <PasswordField {...field} id="currentPassword" label={temporary ? t('temporary_password') : t('current_password')} name="currentPassword" />
                <PasswordField {...field} autoComplete="new-password" hint={t('new_password_hint')} id="newPassword" label={t('new_password')} name="newPassword" />
                <PasswordField {...field} autoComplete="new-password" id="confirm" label={t('confirm_password')} name="confirm" />
                {outcome.error ? (
                  <p className={styles.error} role="alert">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>{outcome.error}</span>
                  </p>
                ) : null}
                <SubmitButton label={t('update_password')} pendingLabel={t('update_password')} />
              </form>

              <form action="/sign-out" className={styles.support} method="post">
                <Submit label={shell('sign_out')} tone="secondary" variant="document" />
              </form>
            </div>
          </div>
        </div>

        <footer className={styles.pageFooter}>
          <span>
            © {new Date().getFullYear()} {auth('company')}
          </span>
          <span className={styles.pageFooterLang}>
            <Globe aria-hidden="true" />
            {locale === 'ar' ? shell('arabic') : shell('english')}
          </span>
        </footer>
      </section>
    </main>
  );
}
