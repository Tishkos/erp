import { getTranslations } from 'next-intl/server';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
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
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  readonly action: (formData: FormData) => Promise<void>;
  readonly failed: boolean;
}) {
  const t = await getTranslations('auth');

  return (
    <div className={cn('flex flex-col gap-5', className)} {...props}>
      <div className="relative overflow-hidden rounded-[28px] border border-border/80 bg-card shadow-[0_1px_2px_rgb(0_0_0_/_10%),0_40px_80px_-30px_rgb(0_0_0_/_55%)]">
        <div className="px-8 pt-8 pb-2">
          <p className="m-0 text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
            {t('eyebrow')}
          </p>
          <h1 className="m-0 mt-1.5 text-[26px] leading-tight font-semibold tracking-tight text-foreground">
            {t('welcome')}
          </h1>
        </div>

        <div className="px-8 pt-3 pb-8">
          <p className="m-0 mb-6 text-sm text-muted-foreground">{t('welcome_hint')}</p>

          <form action={action} className="grid gap-5">
            <EmailField id="email" label={t('email')} placeholder={t('email_placeholder')} />
            <PasswordField
              capsLockLabel={t('caps_lock')}
              hideLabel={t('hide_password')}
              id="password"
              label={t('password')}
              placeholder={t('password_placeholder')}
              showLabel={t('show_password')}
            />

            {/*
              One message for every reason. Saying which half was wrong turns
              the form into a way of discovering who holds an account.
            */}
            {failed ? (
              <p
                className="m-0 flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-3 text-[13px] leading-snug text-destructive"
                role="alert"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t('failed')}</span>
              </p>
            ) : null}

            <RememberMe label={t('remember_me')} />

            <SubmitButton label={t('sign_in')} pendingLabel={t('signing_in')} />
          </form>

          <p className="m-0 mt-6 text-center text-xs text-muted-foreground">{t('need_access')}</p>
        </div>
      </div>
    </div>
  );
}
