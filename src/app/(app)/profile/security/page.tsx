import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, Flash, Form, Grid, Pill, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { requireContext, withCurrentUser } from '@/server/session';
import * as authentication from '@/server/services/authentication';
import * as company from '@/server/services/company';
import * as users from '@/server/services/users';
import { beginEnrolment, confirmEnrolment } from './actions';
import { businessDateOf } from '@/server/domain/business-date';

/**
 * REQ-HARDEN-001 HD4 — the second factor, enrolled by the account holder.
 *
 * Begin shows a secret for the authenticator app (typed in, or read from the
 * otpauth address — the app accepts either); the app's first code confirms
 * it. A privileged account inside its grace is told how long it has; past
 * the grace this is the only screen the session reaches.
 */
export const dynamic = 'force-dynamic';

export default async function SecurityPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, admin, locale, context, outcome, params] = await Promise.all([
    getTranslations('profile'),
    getTranslations('admin'),
    getLocale(),
    requireContext({ allowRestricted: true }),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { status, email, companyName } = await withCurrentUser(
    async (tx) => ({
      status: await authentication.mfaStatus(tx, context.principal.userId),
      email: (await users.get(tx, context.principal.userId)).email,
      companyName: (await company.current(tx))?.legalName ?? '',
    }),
    { allowRestricted: true },
  );
  const fmt = (d: Date | null) => (d ? formatTimestamp(d.toISOString(), locale as Locale) : admin('none'));
  const issuer = encodeURIComponent(companyName || 'QS ERP');
  const otpauth = status.pendingSecret
    ? `otpauth://totp/${issuer}:${encodeURIComponent(email)}?secret=${status.pendingSecret}&issuer=${issuer}&digits=6&period=30`
    : null;

  return (
    <AdminPage back={{ href: '/profile', label: t('title') }} title={t('security')} variant="sap">
      <Flash
        error={outcome.error}
        errorTitle={admin('error_title')}
        saved={outcome.saved && params.enrolled === '1'}
        savedLabel={t('mfa_enrolled')}
      />
      {status.required && !status.enrolled ? (
        <p className={s.sapNote} role="status">
          {status.graceExpired
            ? t('mfa_grace_over')
            : status.enrolmentDue
              ? t('mfa_grace', { date: formatBusinessDate(businessDateOf(status.enrolmentDue), locale as Locale) })
              : t('mfa_required_hint')}
        </p>
      ) : null}

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel title={t('mfa_title')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('mfa_required')}</span>
                <span>{status.required ? <Pill label={admin('yes')} on={true} /> : admin('no')}</span>
              </li>
              <li>
                <span>{t('mfa_status')}</span>
                <span>
                  <Pill label={status.enrolled ? t('mfa_on') : t('mfa_off')} on={status.enrolled} />
                </span>
              </li>
              <li>
                <span>{t('mfa_enrolled_at')}</span>
                <span>{fmt(status.enrolledAt)}</span>
              </li>
              <li>
                <span>{t('mfa_last_used')}</span>
                <span>{fmt(status.lastVerifiedAt)}</span>
              </li>
            </ul>
          </Panel>
        </div>
        <div className={s.profileStack}>
          {otpauth ? (
            <Panel title={t('mfa_confirm_title')}>
              <p className={s.sectionHint}>{t('mfa_confirm_hint')}</p>
              <ul className={s.profileFacts}>
                <li>
                  <span>{t('mfa_secret')}</span>
                  <span>
                    <code>{status.pendingSecret!.match(/.{1,4}/g)!.join(' ')}</code>
                  </span>
                </li>
                <li>
                  <span>{t('mfa_otpauth')}</span>
                  <span>
                    <code style={{ wordBreak: 'break-all' }}>{otpauth}</code>
                  </span>
                </li>
              </ul>
              <Form action={confirmEnrolment}>
                <Grid>
                  <Field
                    autoComplete="one-time-code"
                    label={t('mfa_code')}
                    name="code"
                    required
                    requiredLabel={admin('required_hint')}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('mfa_confirm')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : (
            <Panel title={status.enrolled ? t('mfa_replace_title') : t('mfa_begin_title')}>
              <p className={s.sectionHint}>{status.enrolled ? t('mfa_replace_hint') : t('mfa_begin_hint')}</p>
              <form action={beginEnrolment}>
                <SubmitRow>
                  <Submit label={status.enrolled ? t('mfa_replace') : t('mfa_begin')} />
                </SubmitRow>
              </form>
            </Panel>
          )}
        </div>
      </div>
    </AdminPage>
  );
}
