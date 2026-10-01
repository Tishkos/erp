import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Ruler } from 'lucide-react';
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
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as uom from '@/server/services/units-of-measure';
import { setUomActive, updateUom } from '../actions';

/** One unit of measure, and the items that state their quantities in it. */
export const dynamic = 'force-dynamic';

export default async function UomRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/inventory/uom')) notFound();

  const [t, page, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', uom.PERMISSION_OBJECT)) {
    return <Denied object={page('md_uom')} />;
  }
  const mayEdit = can(principal, 'configure', uom.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', uom.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await uom.get(tx, code);
      return { row, items: await uom.itemsUsing(tx, code) };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, items } = data;

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/inventory/uom', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Ruler aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('uom.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <>
                  {/* Retiring a unit that items still measure in would leave
                      those items naming a unit no picker offers. */}
                  {items.length > 0 ? (
                    <p className="muted">{t('uom.in_use_warning', { count: items.length })}</p>
                  ) : null}
                  <ReasonForm
                    action={setUomActive}
                    hidden={{ code: row.code }}
                    label={t('deactivate')}
                    reasonLabel={t('reason')}
                    reasonPlaceholder={t('reason_placeholder')}
                  />
                </>
              ) : (
                <ActionButton
                  action={setUomActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateUom}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    hint={t('uom.code_is_fixed')}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel title={t('uom.items_using', { count: items.length })}>
            {items.length === 0 ? (
              <p className="muted">{t('uom.no_items')}</p>
            ) : (
              <ul className={s.profileFacts}>
                {items.map((row2) => (
                  <li key={row2.id}>
                    <span>
                      <Link href={`/inventory/items/${encodeURIComponent(row2.code)}`}>{row2.code}</Link>
                    </span>
                    <span>{row2.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <RecordHistory objectId={row.code} objectType={uom.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
