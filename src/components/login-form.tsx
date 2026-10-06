import type { ReactNode } from 'react';
import Image from 'next/image';
import { getLocale, getTranslations } from 'next-intl/server';
import { Blocks, ShieldCheck, TrendingUp } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { Note } from '@/components/intent/note';
import { DEFAULT_ACCENT, DEFAULT_PALETTE } from '@domain/appearance';
// The palettes' `--w-*` tokens (and the checkbox) live there; the Intent theme reads them.
import '@/components/admin/admin.module.css';
import styles from '@/app/sign-in/sign-in.module.css';
import mainLogo from '../../mainLogo.png';
import {
  CodeField,
  EmailField,
  LanguageSwitch,
  PasswordField,
  RememberMe,
  SubmitButton,
} from '@/components/login-form-controls';

/**
 * The page around signing in — the sign-in form and the password screen that
 * finishes it (REQ-FIX-001 FIX-2: "a form in the centre").
 *
 * Drawn as an Intent UI authentication page (the redesign, 2026-10-06): the
 * palette's calm canvas, the company's mark above one centred card, the
 * language switch and "authorised users only" along the top. It sits outside
 * the application shell: a visitor who has not signed in, or a session on a
 * temporary password, has no menu to show. It wears the default palette and
 * accent; nobody's own appearance is known yet.
 */
export async function AuthShell({
  children,
  pillars = false,
}: {
  readonly children: ReactNode;
  /** Sign-in says what the system is; the password screen does not repeat it. */
  readonly pillars?: boolean;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);

  return (
    <main
      className={cn('erp-root', styles.page, 'flex min-h-dvh flex-col bg-[var(--w-canvas)] text-fg')}
      data-accent={DEFAULT_ACCENT}
      data-palette={DEFAULT_PALETTE}
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
        <p className="m-0 inline-flex min-w-0 items-center gap-1.5 text-xs/5 text-muted-fg">
          <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{t('auth.authorized')}</span>
        </p>
        <LanguageSwitch
          arabic={t('print.arabic')}
          current={locale === 'ar' ? 'ar' : 'en'}
          english={t('print.english')}
          label={t('shell.language')}
        />
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 pt-2 pb-10 sm:pt-4 sm:pb-14">
        <div className="flex w-full max-w-[26rem] flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            {/* Deep blue on transparent; on a dark palette it is knocked out to white. */}
            <Image
              alt={t('shell.logo_alt')}
              className="h-auto w-[4.5rem] dark:brightness-0 dark:invert"
              preload
              sizes="72px"
              src={mainLogo}
            />
            <p className="m-0 text-sm/6 text-muted-fg">{t('app.tagline')}</p>
          </div>

          {children}
        </div>

        {pillars ? (
          <ul className="m-0 hidden w-full max-w-[38rem] list-none gap-x-8 gap-y-4 p-0 sm:grid sm:grid-cols-2">
            {(
              [
                ['pillar_one', Blocks],
                ['pillar_two', TrendingUp],
              ] as const
            ).map(([pillar, Icon]) => (
              <li className="flex items-start gap-3" key={pillar}>
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-overlay text-primary-subtle-fg shadow-xs"
                >
                  <Icon className="size-4" />
                </span>
                <span className="grid min-w-0 content-start gap-0.5">
                  <span className="text-sm/6 font-medium text-fg">{t(`auth.${pillar}_title`)}</span>
                  <span className="text-xs/5 text-muted-fg">{t(`auth.${pillar}_body`)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <footer className="px-4 py-4 text-center text-xs/5 text-muted-fg sm:px-6">
        © {new Date().getFullYear()} {t('auth.company')}
      </footer>
    </main>
  );
}

/**
 * The card both screens draw: an eyebrow, the heading and its hint, the form,
 * and a quiet foot.
 */
export function AuthCard({
  eyebrow,
  heading,
  hint,
  children,
  foot,
  className,
}: {
  /** A word above the heading; left out where it would only repeat it. */
  readonly eyebrow?: string | undefined;
  readonly heading: string;
  readonly hint: string;
  readonly children: ReactNode;
  readonly foot?: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-overlay text-overlay-fg shadow-sm', className)}>
      <div className="px-5 pt-6 pb-6 sm:px-8 sm:pt-8">
        <div className="mb-6 text-center">
          {eyebrow ? <p className="m-0 mb-1 text-sm/6 font-medium text-primary-subtle-fg">{eyebrow}</p> : null}
          <h1 className="m-0 text-xl/7 font-semibold tracking-tight text-fg rtl:tracking-normal">{heading}</h1>
          <p className="m-0 mt-1.5 text-sm/6 text-muted-fg">{hint}</p>
        </div>
        {children}
      </div>
      {foot ? <div className="border-t border-border bg-muted/60 px-5 py-4 text-center text-xs/5 text-muted-fg sm:px-8">{foot}</div> : null}
    </div>
  );
}

/** A refusal, said as Intent UI's danger note. Inside the form: the tests and screen readers find it there. */
export function AuthError({ children }: { readonly children: ReactNode }) {
  return (
    <Note className="p-3 sm:text-sm/6" intent="danger" role="alert">
      {children}
    </Note>
  );
}

/**
 * The sign-in form — begun from shadcn/ui's `login-01` block and made this
 * application's.
 *
 * What changed from the block as shipped: the form posts to the server action
 * the page hands in (credentials never enter a client bundle — see
 * `sign-in/page.tsx`); every string comes from the message catalogue so the
 * Arabic page reads in Arabic; the inputs carry their icons, the password can
 * be revealed and warns about Caps Lock; the button shows the request in
 * flight; and the social sign-in, "forgot password" and "sign up" affordances
 * are gone, because accounts here are issued by an administrator, not
 * self-registered (§25). "Remember me" decides whether the session cookie
 * outlives the browser window; the session's own expiry is the server's.
 */
export async function LoginForm({
  action,
  failed,
  mfa,
  className,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  /** The refusal to show: credentials, lockout, an expired temporary password — or none. */
  readonly failed: 'credentials' | 'locked' | 'expired' | 'code' | null;
  /** HD4 — the account needs its authenticator code: show the field. */
  readonly mfa: boolean;
  readonly className?: string;
}) {
  const t = await getTranslations('auth');

  return (
    <AuthCard className={className} eyebrow={t('eyebrow')} foot={t('need_access')} heading={t('welcome')} hint={t('welcome_hint')}>
      <form action={action} className="grid gap-4">
        <EmailField id="email" label={t('email')} placeholder={t('email_placeholder')} />
        <PasswordField
          capsLockLabel={t('caps_lock')}
          hideLabel={t('hide_password')}
          id="password"
          label={t('password')}
          placeholder={t('password_placeholder')}
          showLabel={t('show_password')}
        />

        {mfa ? <CodeField id="code" label={t('code')} placeholder={t('code_placeholder')} /> : null}

        {/*
          One message for every credential reason. Saying which half was
          wrong turns the form into a way of discovering who holds an
          account. The lockout and the expired temporary password say what
          they are: both apply whether or not the account exists.
        */}
        {failed ? (
          <AuthError>
            {failed === 'locked'
              ? t('locked')
              : failed === 'expired'
                ? t('temporary_expired')
                : failed === 'code'
                  ? t('code_required')
                  : t('failed')}
          </AuthError>
        ) : null}

        <RememberMe label={t('remember_me')} />

        <SubmitButton label={t('sign_in')} pendingLabel={t('signing_in')} />
      </form>
    </AuthCard>
  );
}
