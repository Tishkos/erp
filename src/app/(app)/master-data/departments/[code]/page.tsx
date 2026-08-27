import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Network } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  Inline,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as users from '@/server/services/users';
import { setDepartmentActive, setDepartmentManager, updateDepartment } from '../actions';

/**
 * One department — Phase 0 requirement 3, in the two-column record layout:
 * who and what it is on the left, the people and the editing on the right.
 */
export const dynamic = 'force-dynamic';

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, column, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', departments.PERMISSION_OBJECT)) {
    return <Denied object={page('departments')} />;
  }
  const mayEdit = can(principal, 'configure', departments.PERMISSION_OBJECT);
  const mayAssign = can(principal, 'configure', 'user_department_scope');
  const mayAdminister = can(principal, 'administer', departments.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await departments.get(tx, code);
      return {
        row,
        all: await departments.listAll(tx),
        members: await departments.members(tx, code),
        people: mayAssign ? await users.listAll(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, all, members, people } = data;
  const managers = members.filter((m) => m.isManager);
  const nonMembers = people.filter((p) => p.isActive && !members.some((m) => m.userId === p.id));

  return (
    <AdminPage
      back={{ href: '/master-data/departments', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        {/* Left: identity, facts, lifecycle */}
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Network aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <span style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
                {row.isFinance ? <Pill label={t('departments.is_finance')} on={true} /> : null}
              </span>
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('departments.parent')}</span>
                <span>{row.parentCode ?? t('none')}</span>
              </li>
              <li>
                <span>{t('departments.manager')}</span>
                <span>
                  {managers.length === 0
                    ? t('departments.no_manager')
                    : managers.map((m) => (
                        <Link href={`/administration/users/${m.userId}`} key={m.userId}>
                          {m.displayName}
                        </Link>
                      ))}
                </span>
              </li>
              <li>
                <span>{t('departments.members')}</span>
                <span>{members.length}</span>
              </li>
            </ul>
          </Panel>

          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateDepartment}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field defaultValue={row.name} label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                  <Select
                    defaultValue={row.parentCode ?? ''}
                    emptyLabel={t('departments.no_parent')}
                    label={t('departments.parent')}
                    name="parentCode"
                    options={all.filter((d) => d.code !== row.code).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                  />
                </Grid>
                <Checkbox defaultChecked={row.isFinance} label={t('departments.is_finance')} name="isFinance" />
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          {mayAdminister ? (
            <Panel title={row.active ? t('deactivate') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setDepartmentActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setDepartmentActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        {/* Right: the people */}
        <div className={s.profileStack}>
          <Panel flush title={`${t('departments.members')} · ${members.length}`}>
            {members.length === 0 ? (
              <p className="muted" style={{ padding: '1.4rem' }}>
                {t('departments.members_empty')}
              </p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{column('display_name')}</th>
                      <th scope="col">{column('manager')}</th>
                      <th scope="col">{column('active')}</th>
                      {mayAssign ? <th scope="col" /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.userId}>
                        <td>
                          <Link href={`/administration/users/${m.userId}`}>{m.displayName}</Link>
                          <span className="muted" style={{ display: 'block', fontSize: '0.72rem' }}>
                            {m.email}
                          </span>
                        </td>
                        <td>{m.isManager ? <Pill label={t('yes')} on={true} /> : t('no')}</td>
                        <td>
                          <Pill label={m.isActive ? t('active') : t('inactive')} on={m.isActive} />
                        </td>
                        {mayAssign ? (
                          <td>
                            {m.isManager ? (
                              <ActionButton
                                action={setDepartmentManager}
                                hidden={{ code: row.code, userId: m.userId }}
                                label={t('departments.remove_manager')}
                              />
                            ) : (
                              <ActionButton
                                action={setDepartmentManager}
                                hidden={{ code: row.code, userId: m.userId, isManager: '1' }}
                                label={t('departments.make_manager')}
                                tone="primary"
                              />
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {mayAssign && nonMembers.length > 0 ? (
            <Panel title={t('departments.add_member')}>
              <p className={s.sectionHint}>{t('departments.add_member_hint')}</p>
              <Form action={setDepartmentManager}>
                <input name="code" type="hidden" value={row.code} />
                <Inline>
                  <Select
                    label={t('users.title')}
                    name="userId"
                    options={nonMembers.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                    required
                  />
                  <Checkbox label={t('departments.as_manager')} name="isManager" />
                  <Submit label={t('departments.add_member')} />
                </Inline>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={departments.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
