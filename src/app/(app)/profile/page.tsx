import Link from 'next/link';
import { Check } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { cn } from '@/components/intent/cn';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  LinkButton,
  Pill,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { LanguageChoice } from '@/components/language-choice';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { OwnAvatar } from '@/components/chat/chat-avatar';
import { requireContext, withCurrentUser } from '@/server/session';
import * as authentication from '@/server/services/authentication';
import * as users from '@/server/services/users';
import { listRouteViews } from '@/server/services/saved-views';
import { ACCENTS, PALETTES } from '@domain/appearance';
import * as companyService from '@/server/services/company';
import { changePassword, saveAvatar, saveMyAppearance, saveProfile } from './actions';

/**
 * My profile — the signed-in person's own account.
 *
 * Two columns: who you are on the left (picture, name, role, the facts of the
 * account, the authenticator and the way to its screen, /profile/security),
 * what you can change on the right (name, password). No
 * administration grant is needed: the page only ever shows and edits the
 * caller's own row, and the password form asks for the current password
 * before accepting a new one.
 */
export const dynamic = 'force-dynamic';

/** A choice on the appearance panel: an Intent card that rings when it is the one chosen (by more than colour — a tick too). */
const CHOICE =
  'group relative cursor-pointer border border-border bg-overlay shadow-xs transition-[border-color,box-shadow] hover:border-input has-[:checked]:ring-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring';
/** The person's picture or initials, round. */
const AVATAR = 'size-20 rounded-full border-0 bg-primary-subtle text-2xl font-semibold text-primary-subtle-fg';

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const [t, sv, admin, shell, locale, context, outcome, params] = await Promise.all([
    getTranslations('profile'),
    getTranslations('savedViews'),
    getTranslations('admin'),
    getTranslations('shell'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const passwordChanged = outcome.saved && params.password === '1';

  const { user, roles, branches, departments, sessions } = await withCurrentUser((tx) =>
    users.detail(tx, context.principal.userId),
  );
  // The person's own saved views of screens (/profile/views): how many, and the way in;
  // and where their second factor stands, for the Security panel.
  const { viewCount, mfa } = await withCurrentUser(async (tx, c) => ({
    viewCount: (await listRouteViews(tx, c.principal)).length,
    mfa: await authentication.mfaStatus(tx, c.principal.userId),
  }));
  // What the person sees: their own choice, else everyone's default (0419), else Sand and Gold.
  const own = await withCurrentUser((tx) => companyService.appearanceFor(tx, context.principal.userId));
  const fmt = (d: Date | null) => (d ? formatTimestamp(d.toISOString(), locale as Locale) : admin('none'));
  const live = sessions.filter((x) => !x.revokedAt && x.expiresAt > new Date()).length;
  const roleLabel = context.principal.isSuperUser
    ? admin('users.super_user')
    : roles.map((r) => r.name).join(' · ') || admin('none');
  const initials =
    user.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!)
      .join('')
      .toUpperCase() || '?';

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} title={t('title')} variant="sap">
      <Flash
        error={outcome.error}
        errorTitle={admin('error_title')}
        saved={outcome.saved}
        savedLabel={passwordChanged ? t('password_changed') : admin('saved')}
      />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            {/* The panel is the card; the identity inside it is not a second one. */}
            <div className={cn(s.profileCard, 'gap-1.5 border-0 bg-transparent px-1 pb-1 pt-2 shadow-none')}>
              {/* With the dot of the status chosen in the account menu (2026-10-06). */}
              <OwnAvatar
                className={cn(s.avatarLarge, s.profileAvatar, AVATAR, 'grid place-items-center overflow-hidden [&_img]:size-full [&_img]:object-cover')}
                dotClassName="bottom-1 end-1 size-4 ring-[3px]"
                image={user.image}
                initials={initials}
              />
              <h2 className="mt-2 text-lg font-semibold text-fg">{user.displayName}</h2>
              <p className="text-sm text-muted-fg">{user.email}</p>
              <Pill label={roleLabel} on={true} />

              <form action={saveAvatar} className={cn(s.profileActions, 'mt-4 gap-2 border-border pt-4 text-start')}>
                <label className={s.label} htmlFor="f-avatar">
                  {t('avatar_choose')}
                </label>
                <input
                  accept="image/png,image/jpeg,image/webp"
                  className="w-full min-w-0 text-sm text-muted-fg file:me-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-solid file:border-input file:bg-overlay file:px-3 file:text-sm file:font-medium file:text-fg file:shadow-xs hover:file:bg-secondary"
                  id="f-avatar"
                  name="avatar"
                  type="file"
                />
                <span className={s.hint}>{t('avatar_hint')}</span>
                <Submit label={t('avatar_upload')} />
              </form>
              {user.image ? (
                <form action={saveAvatar} className="w-full">
                  <input name="remove" type="hidden" value="1" />
                  <button className={cn(s.button, s.danger, s.small, 'w-full justify-center')} type="submit">
                    {t('avatar_remove')}
                  </button>
                </form>
              ) : null}
            </div>
          </Panel>

          <Panel title={t('account')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('roles')}</span>
                <span>
                  {roles.length === 0 ? admin('none') : roles.map((r) => <Pill key={r.code} label={r.name} on={true} />)}
                </span>
              </li>
              <li>
                <span>{t('branches')}</span>
                <span>
                  {branches.length === 0
                    ? admin('none')
                    : branches.map((b) => <Pill key={b.code} label={`${b.code}${b.isDefault ? ' ★' : ''}`} on={null} />)}
                </span>
              </li>
              <li>
                <span>{t('departments')}</span>
                <span>
                  {departments.length === 0
                    ? admin('none')
                    : departments.map((d) => (
                        <Pill key={d.code} label={`${d.code}${d.isManager ? ` · ${admin('users.manager_flag')}` : ''}`} on={null} />
                      ))}
                </span>
              </li>
              <li>
                <span>{sv('profile_link')}</span>
                <span>
                  <Link href="/profile/views">{sv('profile_count', { count: viewCount })}</Link>
                </span>
              </li>
              <li>
                <span>{t('live_sessions')}</span>
                <span>{live}</span>
              </li>
              <li>
                <span>{t('password_changed_at')}</span>
                <span>{fmt(user.passwordChangedAt)}</span>
              </li>
              <li>
                <span>{admin('created_at')}</span>
                <span>{fmt(user.createdAt)}</span>
              </li>
            </ul>
          </Panel>

          {/* The second step of signing in, and the way to its screen (2026-10-11, by direction:
              "security also available in profile settings"). */}
          <Panel
            actions={
              <LinkButton
                href="/profile/security"
                label={mfa.enrolled ? t('security_manage') : t('security_set_up')}
                small
                tone={mfa.required && !mfa.enrolled ? 'primary' : 'secondary'}
              />
            }
            title={t('security')}
          >
            <ul className={s.profileFacts}>
              <li>
                <span>{t('mfa_status')}</span>
                <span>
                  <Pill label={mfa.enrolled ? t('mfa_on') : t('mfa_off')} on={mfa.enrolled} />
                </span>
              </li>
              <li>
                <span>{t('mfa_required')}</span>
                <span>{mfa.required ? <Pill label={admin('yes')} on={true} /> : admin('no')}</span>
              </li>
              <li>
                <span>{t('mfa_last_used')}</span>
                <span>{fmt(mfa.lastVerifiedAt)}</span>
              </li>
            </ul>
          </Panel>
        </div>

        <div className={s.profileStack}>
          {/* The interface language (by direction, 2026-10-06: "the language selection should be in profile
              settings"), the same switch as the account menu's: this device's choice, applied at once. */}
          <Panel title={shell('language')}>
            <p className={s.sectionHint}>{shell('language_hint')}</p>
            <LanguageChoice className="erp-user-panel__choices erp-profile-language" current={locale === 'ar' ? 'ar' : 'en'} />
          </Panel>

          {/* Each account saves its own palette and accent, independently of
              other users and of the company record. */}
          <Panel title={admin('company.appearance')}>
            <p className={s.sectionHint}>{admin('company.appearance_profile_hint')}</p>
            <Form action={saveMyAppearance}>
              {/* Each choice is a small preview of the screen it picks — the bar, a card with two rows and its
                  primary button — painted by the swatch's own data-palette, so it is the real palette's tokens. A
                  palette resets the accent to its own gold, so the button is the accent in use, carried in from outside. */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] sm:gap-3 [--swatch-primary:var(--w-primary)]">
                {PALETTES.map((name) => (
                  <label
                    className={cn(
                      s.paletteChoice,
                      CHOICE,
                      'grid justify-items-stretch gap-2 rounded-xl p-2 has-[:checked]:border-primary has-[:checked]:ring-primary/30',
                    )}
                    key={name}
                  >
                    <input
                      defaultChecked={name === own.palette}
                      name="uiPalette"
                      type="radio"
                      value={name}
                    />
                    <span
                      className="block overflow-hidden rounded-lg border border-[var(--w-line-strong)] bg-[var(--w-canvas)]"
                      data-palette={name}
                    >
                      <span className="flex h-4 items-center gap-1 border-b border-[var(--w-line)] bg-[var(--w-chrome-a)] px-1.5">
                        <span className="size-1.5 rounded-full bg-[var(--swatch-primary)]" />
                        <span className="h-1 w-6 rounded-full bg-[var(--w-muted)] opacity-50" />
                        <span className="ms-auto size-2 rounded-full bg-[var(--w-head-strong)]" />
                      </span>
                      <span className="m-1.5 grid gap-1 rounded-md border border-[var(--w-line)] bg-[var(--w-paper)] p-1.5 shadow-xs">
                        <span className="block h-1.5 rounded-sm bg-[var(--w-head-strong)]" />
                        <span className="block h-1.5 w-4/5 rounded-sm bg-[var(--w-head)]" />
                        <span className="mt-0.5 block h-2.5 w-1/2 rounded-[0.2rem] bg-[var(--swatch-primary)]" />
                      </span>
                    </span>
                    <span className={cn(s.paletteName, 'text-center text-xs font-medium text-fg')}>
                      {admin(`company.palette_${name}`)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute end-1 top-1 grid size-5 scale-0 place-items-center rounded-full bg-primary text-primary-fg shadow-sm transition-transform group-has-[:checked]:scale-100"
                    >
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  </label>
                ))}
              </div>
              <p className={cn(s.sectionHint, 'mt-5')}>{admin('company.accent_hint')}</p>
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((name) => (
                  <label
                    key={name}
                    className={cn(
                      s.accentChoice,
                      CHOICE,
                      'inline-flex h-9 items-center gap-2 rounded-full pe-3.5 ps-1.5 has-[:checked]:border-[color:var(--w-primary)] has-[:checked]:ring-[color:color-mix(in_oklab,var(--w-primary)_28%,transparent)]',
                    )}
                    data-accent={name}
                  >
                    <input
                      defaultChecked={name === own.accent}
                      name="uiAccent"
                      type="radio"
                      value={name}
                    />
                    {/* The dot is the accent itself (the label carries its data-accent); the tick shows on the chosen one. */}
                    <span className="grid size-6 place-items-center rounded-full bg-[var(--w-primary)] text-[var(--w-primary-ink)] shadow-xs ring-1 ring-black/10">
                      <Check aria-hidden="true" className="size-3.5 scale-0 transition-transform group-has-[:checked]:scale-100" strokeWidth={3} />
                    </span>
                    <span className={cn(s.paletteName, 'text-sm font-medium text-fg')}>
                      {admin(`company.accent_${name}`)}
                    </span>
                  </label>
                ))}
              </div>
              <SubmitRow>
                <Submit label={admin('update')} />
              </SubmitRow>
            </Form>
          </Panel>

          <Panel title={t('edit_profile')}>
            <Form action={saveProfile}>
              <Grid>
                <Field
                  autoComplete="name"
                  defaultValue={user.displayName}
                  label={t('display_name')}
                  name="displayName"
                  required
                  requiredLabel={admin('required_hint')}
                />
                <Field defaultValue={user.email} label={admin('users.email')} name="email" readOnly />
              </Grid>
              <SubmitRow>
                <Submit label={admin('save')} />
              </SubmitRow>
            </Form>
          </Panel>

          <Panel title={t('change_password')}>
            <p className={s.sectionHint}>{t('change_password_hint')}</p>
            <Form action={changePassword}>
              <Grid>
                <Field
                  autoComplete="current-password"
                  label={t('current_password')}
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

      <RecordHistory objectId={user.id} objectType={users.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
