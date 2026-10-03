import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Secret,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can, isCeo } from '@domain/permissions';
import { FLASH_COOKIE } from '@/server/admin-action';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as departments from '@/server/services/departments';
import * as employees from '@/server/services/employees';
import * as roles from '@/server/services/roles';
import * as users from '@/server/services/users';
import {
  resetUserPassword,
  setUserActive,
  setUserBranch,
  setUserDefaultBranch,
  setUserDepartment,
  setUserRole,
  updateUser,
} from '../actions';

/**
 * One account — Phase 0 requirement 4, the administrator's view.
 *
 * Left: who this is and the state of the account. Right: what they are
 * allowed to do, as three assignment cards (roles, branches, departments),
 * each with what is held and a way to add more; then the account actions.
 */
export const dynamic = 'force-dynamic';

type Action = (formData: FormData) => Promise<void>;

export default async function UserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, column, locale, context, outcome, { id }, jar, query] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
    cookies(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', users.PERMISSION_OBJECT)) {
    return <Denied object={page('users')} />;
  }
  const mayEdit = can(principal, 'configure', users.PERMISSION_OBJECT);
  const mayAssignRoles = isCeo(principal) && mayEdit;
  const mayAdminister = can(principal, 'administer', users.PERMISSION_OBJECT);
  const secret = outcome.saved ? (jar.get(FLASH_COOKIE)?.value ?? null) : null;
  const mailed = query.mailed === '1';
  const mailFailed = query.mail_failed === '1';

  const data = await withCurrentUser(async (tx) => {
    try {
      return {
        ...(await users.detail(tx, id)),
        allRoles: mayAssignRoles ? await roles.listAll(tx) : [],
        allBranches: mayEdit ? await branches.listAll(tx) : [],
        allDepartments: mayEdit ? await departments.listAll(tx) : [],
        employee: await employees.ofUser(tx, id),
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { user, allRoles, allBranches, allDepartments, sessions } = data;
  const fmt = (d: Date | null) => (d ? formatTimestamp(d.toISOString(), locale as Locale) : t('none'));
  const isSelf = user.id === principal.userId;
  const initials =
    user.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!)
      .join('')
      .toUpperCase() || '?';

  const otherRoles = allRoles.filter((r) => !data.roles.some((h) => h.code === r.code));
  const otherBranches = allBranches.filter((b) => b.active && !data.branches.some((h) => h.code === b.code));
  const otherDepartments = allDepartments.filter((d) => d.active && !data.departments.some((h) => h.code === d.code));
  const liveSessions = sessions.filter((x) => !x.revokedAt && x.expiresAt > new Date()).length;

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/administration/users', label: t('back') }}
      title={user.displayName}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      {mailed ? <Flash error={null} errorTitle="" saved savedLabel={t('users.mailed', { email: user.email })} /> : null}
      {mailFailed ? <Flash error={t('users.mail_failed')} errorTitle={t('error_title')} saved={false} savedLabel="" /> : null}
      {secret ? (
        <Secret note={t('users.temp_password_note')} title={t('users.temp_password_title')} value={secret} />
      ) : mailed ? null : (
        <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      )}

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
              <span style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <Pill label={user.isActive ? t('active') : t('inactive')} on={user.isActive} />
                {user.isSuperUser ? <Pill label={t('users.super_user')} on={true} /> : null}
                {user.mustChangePassword ? <Pill label={t('users.must_change_password')} on={null} /> : null}
              </span>
              {isSelf ? <p className={s.hint}>{t('users.self_note')}</p> : null}
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('users.sessions')}</span>
                <span>{liveSessions}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{fmt(user.createdAt)}</span>
              </li>
              <li>
                <span>{t('updated_at')}</span>
                <span>{fmt(user.updatedAt)}</span>
              </li>
              {/* REQ-FIX-001 FIX-5 — the person behind the account. */}
              <li>
                <span>{t('users.employee')}</span>
                <span>
                  {data.employee ? (
                    <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(data.employee.employeeNo)}`}>
                      <bdi dir="ltr">{data.employee.employeeNo}</bdi>
                    </Link>
                  ) : (
                    t('users.no_employee')
                  )}
                </span>
              </li>
              <li>
                <span>{column('key')}</span>
                <span className={s.mono}>{user.id.slice(0, 8)}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={t('users.reset_password')}>
              <p className={s.sectionHint}>{t('users.reset_password_hint')}</p>
              <ActionButton action={resetUserPassword} hidden={{ id: user.id }} label={t('users.reset_password')} small={false} />
            </Panel>
          ) : null}

          {mayAdminister && !isSelf ? (
            <Panel title={user.isActive ? t('users.deactivate_title') : t('reactivate')}>
              {user.isActive ? (
                <>
                  <p className={s.sectionHint}>{t('users.deactivate_hint')}</p>
                  <ReasonForm
                    action={setUserActive}
                    hidden={{ id: user.id }}
                    label={t('deactivate')}
                    reasonLabel={t('reason')}
                    reasonPlaceholder={t('reason_placeholder')}
                  />
                </>
              ) : (
                <ActionButton action={setUserActive} hidden={{ id: user.id, active: '1' }} label={t('reactivate')} small={false} tone="primary" />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          <div className={s.assignGrid}>
            <AssignCard
              add={
                mayAssignRoles && otherRoles.length > 0
                  ? {
                      action: setUserRole,
                      hidden: { id: user.id, on: '1' },
                      name: 'roleCode',
                      label: t('users.add_role'),
                      options: otherRoles.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` })),
                      submit: t('users.grant'),
                    }
                  : null
              }
              emptyLabel={t('none')}
              items={data.roles.map((r) => ({
                key: r.code,
                label: r.name,
                sub: r.code,
                remove: mayAssignRoles ? { action: setUserRole, hidden: { id: user.id, roleCode: r.code } } : null,
              }))}
              revokeLabel={t('users.revoke')}
              title={t('users.roles')}
            />
            <AssignCard
              add={
                mayEdit && otherBranches.length > 0
                  ? {
                      action: setUserBranch,
                      hidden: { id: user.id, on: '1' },
                      name: 'branchCode',
                      label: t('users.add_branch'),
                      options: otherBranches.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` })),
                      submit: t('users.grant'),
                    }
                  : null
              }
              emptyLabel={t('none')}
              items={data.branches.map((b) => ({
                key: b.code,
                label: `${b.code} · ${b.name}`,
                sub: b.isDefault ? t('users.default_branch') : null,
                extra:
                  mayEdit && !b.isDefault
                    ? { action: setUserDefaultBranch, hidden: { id: user.id, branchCode: b.code }, label: t('users.set_default') }
                    : null,
                remove: mayEdit ? { action: setUserBranch, hidden: { id: user.id, branchCode: b.code } } : null,
              }))}
              revokeLabel={t('users.revoke')}
              title={t('users.branches')}
            />
            <AssignCard
              add={
                mayEdit && otherDepartments.length > 0
                  ? {
                      action: setUserDepartment,
                      hidden: { id: user.id, on: '1' },
                      name: 'departmentCode',
                      label: t('users.add_department'),
                      options: otherDepartments.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` })),
                      submit: t('users.grant'),
                    }
                  : null
              }
              emptyLabel={t('none')}
              items={data.departments.map((d) => ({
                key: d.code,
                label: `${d.code} · ${d.name}`,
                sub: d.isManager ? t('users.manager_flag') : null,
                remove: mayEdit ? { action: setUserDepartment, hidden: { id: user.id, departmentCode: d.code } } : null,
              }))}
              revokeLabel={t('users.revoke')}
              title={t('users.departments')}
            />
          </div>

          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateUser}>
                <input name="id" type="hidden" value={user.id} />
                <Grid>
                  <Field defaultValue={user.displayName} label={t('users.display_name')} name="displayName" required requiredLabel={t('required_hint')} />
                  <Field defaultValue={user.email} label={t('users.email')} name="email_display" readOnly />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel flush title={t('users.sessions')}>
            {sessions.length === 0 ? (
              <p className="muted" style={{ padding: '1rem' }}>
                {t('users.sessions_empty')}
              </p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{t('users.session_started')}</th>
                      <th scope="col">{t('users.session_expires')}</th>
                      <th scope="col">{column('outcome')}</th>
                      <th scope="col">{column('reason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions
                      .slice(-10)
                      .reverse()
                      .map((x) => (
                        <tr key={x.id}>
                          <td>{fmt(x.createdAt)}</td>
                          <td>{fmt(x.expiresAt)}</td>
                          <td>
                            <Pill label={x.revokedAt ? t('users.session_revoked') : t('users.session_live')} on={x.revokedAt ? false : true} />
                          </td>
                          <td>{x.revokedReason ?? t('none')}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      </div>

      {/* What happened to this person is written under three objects: the
          user record, their sign-in credentials (`user`), and each department
          membership (`<id>:<code>`). One log, all of it. */}
      <RecordHistory
        objectId={user.id}
        objectType={users.PERMISSION_OBJECT}
        related={[
          { objectType: 'user', objectId: user.id },
          { objectType: 'user_department_scope', objectId: `${user.id}:%` },
        ]}
      />
    </AdminPage>
  );
}

interface AssignItem {
  readonly key: string;
  readonly label: string;
  readonly sub?: string | null;
  readonly extra?: { action: Action; hidden: Record<string, string>; label: string } | null;
  readonly remove: { action: Action; hidden: Record<string, string> } | null;
}

function AssignCard({
  title,
  items,
  emptyLabel,
  revokeLabel,
  add,
}: {
  readonly title: string;
  readonly items: readonly AssignItem[];
  readonly emptyLabel: string;
  readonly revokeLabel: string;
  readonly add: {
    action: Action;
    hidden: Record<string, string>;
    name: string;
    label: string;
    options: readonly { value: string; label: string }[];
    submit: string;
  } | null;
}) {
  return (
    <Panel title={`${title} · ${items.length}`}>
      {items.length === 0 ? (
        <p className={s.hint}>{emptyLabel}</p>
      ) : (
        <ul className={s.assignList}>
          {items.map((item) => (
            <li key={item.key}>
              <div>
                <strong>{item.label}</strong>
                {item.sub ? <small>{item.sub}</small> : null}
              </div>
              <span className={s.assignActions}>
                {item.extra ? <ActionButton action={item.extra.action} hidden={item.extra.hidden} label={item.extra.label} /> : null}
                {item.remove ? <ActionButton action={item.remove.action} hidden={item.remove.hidden} label={revokeLabel} tone="danger" /> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {add ? (
        <form action={add.action} className={s.assignAdd}>
          {Object.entries(add.hidden).map(([k, v]) => (
            <input key={k} name={k} type="hidden" value={v} />
          ))}
          <Select label={add.label} name={add.name} options={add.options} required />
          <Submit label={add.submit} small tone="secondary" />
        </form>
      ) : null}
    </Panel>
  );
}
