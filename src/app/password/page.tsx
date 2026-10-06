import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthError, AuthShell } from '@/components/login-form';
import { PasswordField, SignOutButton, SubmitButton } from '@/components/login-form-controls';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { requireContext } from '@/server/session';
import { replaceTemporaryPassword } from './actions';

/**
 * REQ-HARDEN-001 HD2 — the one screen a session on a temporary password may
 * use. `requireContext` sends every other screen here while the flag is set;
 * replacing the password clears it in the same statement that stores the
 * new one, and the next request is an ordinary one.
 *
 * REQ-FIX-001 FIX-2: drawn as the sign-in page is — the company's mark above
 * one centred card — because it is the second half of signing in (the
 * sponsor: "the temporary password was left, not centre; it should be a form
 * in the centre"). It sits outside the application shell for the same
 * reason: a restricted session has no menu to show, and a shell with an
 * empty menu and a form pushed into its first column read as a broken page.
 * The same frame and card as sign-in (`AuthShell`, `AuthCard`); the fields
 * are sign-in's password field under their own names. Sign out stays on the
 * page, in the card's foot.
 */
export const dynamic = 'force-dynamic';

export default async function TemporaryPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, auth, shell, context, outcome] = await Promise.all([
    getTranslations('profile'),
    getTranslations('auth'),
    getTranslations('shell'),
    requireContext({ allowRestricted: true }),
    outcomeOf(searchParams),
  ]);
  const temporary = context.restriction === 'password';
  const field = { capsLockLabel: auth('caps_lock'), hideLabel: auth('hide_password'), showLabel: auth('show_password'), placeholder: '' };

  return (
    <AuthShell>
      <AuthCard
        eyebrow={temporary ? t('temporary_password') : undefined}
        foot={
          <form action="/sign-out" method="post">
            <SignOutButton label={shell('sign_out')} />
          </form>
        }
        heading={t('change_password')}
        hint={temporary ? t('temporary_hint') : t('change_password_hint')}
      >
        <form action={replaceTemporaryPassword} className="grid gap-4">
          <PasswordField {...field} id="currentPassword" label={temporary ? t('temporary_password') : t('current_password')} name="currentPassword" />
          <PasswordField {...field} autoComplete="new-password" hint={t('new_password_hint')} id="newPassword" label={t('new_password')} name="newPassword" />
          <PasswordField {...field} autoComplete="new-password" id="confirm" label={t('confirm_password')} name="confirm" />
          {outcome.error ? <AuthError>{outcome.error}</AuthError> : null}
          <SubmitButton label={t('update_password')} pendingLabel={t('update_password')} />
        </form>
      </AuthCard>
    </AuthShell>
  );
}
