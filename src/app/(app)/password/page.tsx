import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { requireContext } from '@/server/session';
import { replaceTemporaryPassword } from './actions';

/**
 * REQ-HARDEN-001 HD2 — the one screen a session on a temporary password may
 * use. `requireContext` sends every other screen here while the flag is set;
 * replacing the password clears it in the same statement that stores the
 * new one, and the next request is an ordinary one.
 *
 * The form is the profile page's password form, on its own.
 */
export const dynamic = 'force-dynamic';

export default async function TemporaryPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, admin, context, outcome] = await Promise.all([
    getTranslations('profile'),
    getTranslations('admin'),
    requireContext({ allowRestricted: true }),
    outcomeOf(searchParams),
  ]);
  const temporary = context.restriction === 'password';

  return (
    <AdminPage title={t('change_password')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel title={t('change_password')}>
            <p className={s.sectionHint}>{temporary ? t('temporary_hint') : t('change_password_hint')}</p>
            <Form action={replaceTemporaryPassword}>
              <Grid>
                <Field
                  autoComplete="current-password"
                  label={temporary ? t('temporary_password') : t('current_password')}
                  name="currentPassword"
                  required
                  requiredLabel={admin('required_hint')}
                  type="password"
                  wide
                />
                <Field
                  autoComplete="new-password"
                  hint={t('new_password_hint')}
                  label={t('new_password')}
                  name="newPassword"
                  required
                  requiredLabel={admin('required_hint')}
                  type="password"
                />
                <Field
                  autoComplete="new-password"
                  label={t('confirm_password')}
                  name="confirm"
                  required
                  requiredLabel={admin('required_hint')}
                  type="password"
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('update_password')} />
              </SubmitRow>
            </Form>
          </Panel>
        </div>
      </div>
    </AdminPage>
  );
}
