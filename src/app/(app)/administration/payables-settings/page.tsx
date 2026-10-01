import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Hidden,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payables from '@/server/services/payables';
import * as settings from '@/server/services/payables-settings';
import {
  saveExpenseCategory,
  saveReasonCode,
  setTimeLimit,
  setTypeActive,
  updateEventCode,
  updateStage,
} from './actions';

/**
 * Payables settings — REQ-AP-001 §21.11, the Stage-1 tabs.
 *
 * R4 on one screen: types, stages (rules shown read-only — what makes a stage
 * true is code), time limits (a change is a new dated row), reason codes,
 * expense categories, event codes. Nothing deletes; everything audits.
 */
export const dynamic = 'force-dynamic';

const TABS = ['types', 'stages', 'limits', 'reasons', 'categories', 'events'] as const;
type Tab = (typeof TABS)[number];

export default async function PayablesSettingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/administration/payables-settings')) notFound();

  const [t, page, context, outcome, query] = await Promise.all([
    getTranslations('admin.payables_settings'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', payables.SETTINGS_OBJECT)) {
    return <Denied object={page('payables_settings')} />;
  }
  const mayConfigure = can(principal, 'configure', payables.SETTINGS_OBJECT);

  const tab: Tab = TABS.includes(query.tab as Tab) ? (query.tab as Tab) : 'types';
  const config = await withCurrentUser((tx) => settings.overview(tx));
  const base = '/administration/payables-settings';

  return (
    <AdminPage
      back={{ href: '/administration/company', label: t('administration') }}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <nav aria-label={t('tabs')} className={s.sapFootActions}>
        {TABS.map((key) => (
          <Link
            aria-current={tab === key ? 'page' : undefined}
            className={`${s.button} ${s.small}${tab === key ? ` ${s.primary}` : ''}`}
            href={`${base}?tab=${key}`}
            key={key}
          >
            {t(`tab_${key}`)}
          </Link>
        ))}
      </nav>

      <section aria-labelledby="settings-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="settings-title">
            <span>{t(`tab_${tab}`)}</span>
          </h2>

          {tab === 'types' ? (
            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('code')}</th>
                    <th scope="col">{t('name')}</th>
                    <th scope="col">{t('requires_po')}</th>
                    <th scope="col">{t('requires_department')}</th>
                    <th scope="col">{t('requires_receipt')}</th>
                    <th scope="col">{t('series')}</th>
                    <th scope="col">{t('active')}</th>
                  </tr>
                </thead>
                <tbody>
                  {config.types.map((type) => (
                    <tr key={type.code}>
                      <td>
                        <bdi dir="ltr">{type.code}</bdi>
                      </td>
                      <td>{type.name}</td>
                      <td>{type.requiresPo ? '✓' : '—'}</td>
                      <td>{type.requiresDepartment ? '✓' : '—'}</td>
                      <td>{type.requiresReceipt ? '✓' : '—'}</td>
                      <td>
                        <bdi dir="ltr">{type.numberSeriesKey}</bdi>
                      </td>
                      <td>
                        {mayConfigure ? (
                          <Form action={setTypeActive}>
                            <Hidden name="code" value={type.code} />
                            <Checkbox defaultChecked={type.active} label={t('active')} name="active" />
                            <Submit label={t('save')} small tone="secondary" />
                          </Form>
                        ) : type.active ? (
                          '✓'
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === 'stages' ? (
            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('type')}</th>
                    <th scope="col">{t('sequence')}</th>
                    <th scope="col">{t('name')}</th>
                    <th scope="col">{t('rule')}</th>
                    <th scope="col">{t('active')}</th>
                    {mayConfigure ? <th scope="col">{t('edit')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {config.stages.map((stage) => (
                    <tr key={`${stage.payableTypeCode}:${stage.code}`}>
                      <td>{stage.payableTypeCode}</td>
                      <td className={s.sapNum}>{stage.sequence}</td>
                      <td>{stage.name}</td>
                      <td>
                        {/* Read-only by design: what makes a stage true is code (§6). */}
                        <bdi dir="ltr">{stage.ruleName}</bdi>
                      </td>
                      <td>{stage.active ? '✓' : '—'}</td>
                      {mayConfigure ? (
                        <td>
                          <Form action={updateStage}>
                            <Hidden name="type" value={stage.payableTypeCode} />
                            <Hidden name="code" value={stage.code} />
                            <Field
                              defaultValue={stage.name}
                              id={`st-${stage.payableTypeCode}-${stage.code}`}
                              label={t('name')}
                              name="name"
                            />
                            <Field
                              defaultValue={stage.sequence}
                              id={`sq-${stage.payableTypeCode}-${stage.code}`}
                              label={t('sequence')}
                              min={1}
                              name="sequence"
                              type="number"
                            />
                            <Checkbox defaultChecked={stage.active} label={t('active')} name="active" />
                            <Submit label={t('save')} small tone="secondary" />
                          </Form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === 'limits' ? (
            <>
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('check')}</th>
                      <th scope="col">{t('scope')}</th>
                      <th className={s.sapNum} scope="col">
                        {t('limit_days')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('escalate_days')}
                      </th>
                      <th scope="col">{t('escalate_role')}</th>
                      <th scope="col">{t('valid_from')}</th>
                      <th scope="col">{t('active')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.limits.map((limit) => (
                      <tr key={limit.id}>
                        <td>
                          <bdi dir="ltr">{limit.checkCode}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{limit.scope}</bdi>
                        </td>
                        <td className={s.sapNum}>{limit.limitDays}</td>
                        <td className={s.sapNum}>{limit.escalateAfterDays ?? '—'}</td>
                        <td>{limit.escalateToRole ?? '—'}</td>
                        <td>
                          <bdi dir="ltr">{limit.validFrom}</bdi>
                        </td>
                        <td>{limit.active ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mayConfigure ? (
                <Form action={setTimeLimit}>
                  <p className={s.sapGridCaption}>{t('new_limit')}</p>
                  <Field hint={t('check_hint')} label={t('check')} name="check" required />
                  <Field defaultValue="all" hint={t('scope_hint')} label={t('scope')} name="scope" />
                  <Field label={t('limit_days')} min={0} name="limit_days" required type="number" />
                  <Field label={t('escalate_days')} min={0} name="escalate_days" type="number" />
                  <Field label={t('escalate_role')} name="escalate_role" />
                  <Field label={t('valid_from')} name="valid_from" required type="date" />
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              ) : null}
            </>
          ) : null}

          {tab === 'reasons' ? (
            <>
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('code')}</th>
                      <th scope="col">{t('name')}</th>
                      <th scope="col">{t('lane')}</th>
                      <th scope="col">{t('default_owner_role')}</th>
                      <th scope="col">{t('requires_detail')}</th>
                      <th scope="col">{t('active')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.reasons.map((reason) => (
                      <tr key={reason.code}>
                        <td>
                          <bdi dir="ltr">{reason.code}</bdi>
                        </td>
                        <td>{reason.name}</td>
                        <td>{reason.laneHint ?? '—'}</td>
                        <td>{reason.defaultOwnerRole ?? '—'}</td>
                        <td>{reason.requiresDetail ? '✓' : '—'}</td>
                        <td>{reason.active ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mayConfigure ? (
                <Form action={saveReasonCode}>
                  <p className={s.sapGridCaption}>{t('new_reason')}</p>
                  <Field label={t('code')} name="code" required />
                  <Field label={t('name')} name="name" required />
                  <Field label={t('lane')} name="lane_hint" />
                  <Field label={t('default_owner_role')} name="default_owner_role" />
                  <Checkbox label={t('requires_detail')} name="requires_detail" />
                  <Checkbox defaultChecked label={t('active')} name="active" />
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              ) : null}
            </>
          ) : null}

          {tab === 'categories' ? (
            <>
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{t('code')}</th>
                      <th scope="col">{t('name')}</th>
                      <th scope="col">{t('requires_po')}</th>
                      <th scope="col">{t('requires_receipt')}</th>
                      <th scope="col">{t('active')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.categories.map((category) => (
                      <tr key={category.code}>
                        <td>
                          <bdi dir="ltr">{category.code}</bdi>
                        </td>
                        <td>{category.name}</td>
                        <td>{category.requiresPo ? '✓' : '—'}</td>
                        <td>{category.requiresReceipt ? '✓' : '—'}</td>
                        <td>{category.active ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mayConfigure ? (
                <Form action={saveExpenseCategory}>
                  <p className={s.sapGridCaption}>{t('new_category')}</p>
                  <Field label={t('code')} name="code" required />
                  <Field label={t('name')} name="name" required />
                  <Checkbox label={t('requires_po')} name="requires_po" />
                  <Checkbox defaultChecked label={t('requires_receipt')} name="requires_receipt" />
                  <Checkbox defaultChecked label={t('active')} name="active" />
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              ) : null}
            </>
          ) : null}

          {tab === 'events' ? (
            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('lane')}</th>
                    <th scope="col">{t('code')}</th>
                    <th scope="col">{t('name')}</th>
                    <th scope="col">{t('active')}</th>
                  </tr>
                </thead>
                <tbody>
                  {config.eventCodes.map((code) => (
                    <tr key={code.code}>
                      <td>{code.laneCode}</td>
                      <td>
                        <bdi dir="ltr">{code.code}</bdi>
                      </td>
                      <td>
                        {mayConfigure ? (
                          <Form action={updateEventCode}>
                            <Hidden name="code" value={code.code} />
                            <Field
                              defaultValue={code.name}
                              id={`ev-${code.code}`}
                              label={t('name')}
                              name="name"
                            />
                            <Checkbox defaultChecked={code.active} label={t('active')} name="active" />
                            <Submit label={t('save')} small tone="secondary" />
                          </Form>
                        ) : (
                          code.name
                        )}
                      </td>
                      <td>{code.active ? '✓' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
