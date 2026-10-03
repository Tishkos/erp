import { getTranslations } from 'next-intl/server';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import admin from '@/components/admin/admin.module.css';
import styles from '@/app/sign-in/sign-in.module.css';
import {
  CodeField,
  EmailField,
  PasswordField,
  RememberMe,
  SubmitButton,
} from '@/components/login-form-controls';

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
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  readonly action: (formData: FormData) => Promise<void>;
  /** The refusal to show: credentials, lockout, an expired temporary password — or none. */
  readonly failed: 'credentials' | 'locked' | 'expired' | 'code' | null;
  /** HD4 — the account needs its authenticator code: show the field. */
  readonly mfa: boolean;
}) {
  const t = await getTranslations('auth');

  return (
    <div className={cn(className)} {...props}>
      <div className={cn(admin.sapWindow, styles.window)}>
        <div className={admin.sapTitle}>{t('eyebrow')}</div>

        <div className={styles.body}>
          <h1 className={styles.heading}>{t('welcome')}</h1>
          <p className={styles.hint}>{t('welcome_hint')}</p>

          <form action={action} className={styles.form}>
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
              <p
                className={styles.error}
                role="alert"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  {failed === 'locked'
                    ? t('locked')
                    : failed === 'expired'
                      ? t('temporary_expired')
                      : failed === 'code'
                        ? t('code_required')
                        : t('failed')}
                </span>
              </p>
            ) : null}

            <RememberMe label={t('remember_me')} />

            <SubmitButton label={t('sign_in')} pendingLabel={t('signing_in')} />
          </form>

          <p className={styles.support}>{t('need_access')}</p>
        </div>
      </div>
    </div>
  );
}
