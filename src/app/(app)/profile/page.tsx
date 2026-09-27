import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { requireContext, withCurrentUser } from '@/server/session';
import * as users from '@/server/services/users';
import { ACCENTS, PALETTES, accentOrDefault, paletteOrDefault } from '@domain/appearance';
import { changePassword, saveAvatar, saveMyAppearance, saveProfile } from './actions';

/**
 * My profile — the signed-in person's own account.
 *
 * Two columns: who you are on the left (picture, name, role, the facts of the
 * account), what you can change on the right (name, password). No
 * administration grant is needed: the page only ever shows and edits the
 * caller's own row, and the password form asks for the current password
 * before accepting a new one.
 */
export const dynamic = 'force-dynamic';

export default async function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  const [t, admin, locale, context, outcome, params] = await Promise.all([
    getTranslations('profile'),
    getTranslations('admin'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const passwordChanged = outcome.saved && params.password === '1';

  const { user, roles, branches, departments, sessions } = await withCurrentUser((tx) =>
    users.detail(tx, context.principal.userId),
  );
  const own = { palette: paletteOrDefault(user.uiPalette), accent: accentOrDefault(user.uiAccent) };
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
            <div className={s.profileCard}>
              {user.image ? (
                <img alt="" className={`${s.avatarLarge} ${s.profileAvatar}`} src={user.image} />
              ) : (
                <span className={`${s.avatarLarge} ${s.profileAvatar}`}>{initials}</span>
              )}
              <h2>{user.displayName}</h2>
              <p>{user.email}</p>
              <Pill label={roleLabel} on={true} />

              <form action={saveAvatar} className={s.profileActions} encType="multipart/form-data">
                <label className={s.label} htmlFor="f-avatar">
                  {t('avatar_choose')}
                </label>
                <input accept="image/png,image/jpeg,image/webp" id="f-avatar" name="avatar" type="file" />
                <span className={s.hint}>{t('avatar_hint')}</span>
                <Submit label={t('avatar_upload')} />
              </form>
              {user.image ? (
                <form action={saveAvatar} style={{ inlineSize: '100%' }}>
                  <input name="remove" type="hidden" value="1" />
                  <button
                    className={`${s.button} ${s.danger} ${s.small}`}
                    style={{ inlineSize: '100%', justifyContent: 'center' }}
                    type="submit"
                  >
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
        </div>

        <div className={s.profileStack}>
          {/* The look is personal — the person staring at this screen all day
              chooses it. 'company' stores null: follow the default, and move
              when the company moves. The swatches carry their own data-palette
              so each is painted by the tokens it would apply; the company one
              carries none and shows the look now in force. */}
          <Panel title={admin('company.appearance')}>
            <p className={s.sectionHint}>{admin('company.appearance_profile_hint')}</p>
            <Form action={saveMyAppearance}>
              <div className={s.paletteChoices}>
                {PALETTES.map((name) => (
                  <label className={s.paletteChoice} key={name}>
                    <input
                      defaultChecked={name === own.palette}
                      name="uiPalette"
                      type="radio"
                      value={name}
                    />
                    <span
                      className={s.paletteSwatch}
                      data-palette={name}
                    >
                      <span className={s.paletteSwatchBar} />
                      <span className={s.paletteSwatchBody}>
                        <span className={s.paletteSwatchRow} />
                        <span className={s.paletteSwatchRow} />
                        <span className={s.paletteSwatchButton} />
                      </span>
                    </span>
                    <span className={s.paletteName}>
                      {admin(`company.palette_${name}`)}
                    </span>
                  </label>
                ))}
              </div>
              <p className={s.sectionHint} style={{ marginBlockStart: '0.8rem' }}>
                {admin('company.accent_hint')}
              </p>
              <div className={s.accentChoices}>
                {['company', ...ACCENTS].map((name) => (
                  <label
                    key={name}
                    className={s.accentChoice}
                    data-accent={name === 'company' ? undefined : name}
                  >
                    <input
                      defaultChecked={name === own.accent}
                      name="uiAccent"
                      type="radio"
                      value={name}
                    />
                    <span className={s.accentDot} />
                    <span className={s.paletteName}>
                      {name === 'company'
                        ? admin('company.company_default')
                        : admin(`company.accent_${name}`)}
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
