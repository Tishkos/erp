import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, Flash, Form, Grid, Hidden, Pill, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { SETTING_KEYS } from '@/server/domain/whatsapp';
import { requireContext, withCurrentUser } from '@/server/session';
import * as users from '@/server/services/users';
import * as whatsapp from '@/server/services/whatsapp';
import { clearPairing, saveContact, saveSetting, setContactActive, setRuleWhatsapp } from './actions';

/**
 * WhatsApp — REQ-WA-001 §6. Copies the Payables Settings screen: stacked
 * windows — the bridge, the allow-list, the rules that reach a phone, the
 * settings, and the message log (W-R4 made readable). Nothing deletes; a
 * contact is deactivated.
 */
export const dynamic = 'force-dynamic';

export default async function WhatsappPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/administration/whatsapp')) notFound();
  const [t, admin, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.whatsapp'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', whatsapp.PERMISSION_OBJECT)) {
    return <Denied object={page('whatsapp')} />;
  }
  const mayConfigure = can(principal, 'configure', whatsapp.PERMISSION_OBJECT);

  const { status, contacts, people, rules, settingRows, log } = await withCurrentUser(async (tx) => ({
    status: await whatsapp.bridgeStatus(tx),
    contacts: await whatsapp.contacts(tx),
    people: await users.listAll(tx),
    rules: await whatsapp.rules(tx),
    settingRows: await whatsapp.settingRows(tx),
    log: await whatsapp.log(tx, { limit: 100 }),
  }));
  const when = (value: Date | null) =>
    value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : '—';
  const yes = (on: boolean) => <Pill label={on ? admin('yes') : admin('no')} on={on} />;
  const settingLabel = (key: string) => ((SETTING_KEYS as readonly string[]).includes(key) ? t(`setting_${key}`) : key);
  const order = SETTING_KEYS as readonly string[];
  const knobs = settingRows.filter((row) => order.includes(row.key)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/administration/whatsapp" />}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="wa-bridge-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wa-bridge-title">
            <span>{t('bridge')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('paired')}</th>
                  <th scope="col">{t('bot_number')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('last_seen')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('pending_deliveries')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('failed_deliveries')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{yes(status.paired)}</td>
                  <td>
                    <bdi dir="ltr">{status.me ?? '—'}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{status.state ?? t('never_started')}</bdi>
                  </td>
                  <td>{when(status.lastSeenAt)}</td>
                  <td className={s.sapNum}>{status.pendingDeliveries}</td>
                  <td className={s.sapNum}>{status.failedDeliveries}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={s.sapNote}>{t('bridge_note')}</p>
          {mayConfigure && status.paired ? (
            <Form action={clearPairing}>
              <p className={s.sapGridCaption}>{t('forget_pairing')}</p>
              <Grid>
                <Field hint={t('forget_pairing_hint')} label={admin('reason')} name="reason" required />
              </Grid>
              <SubmitRow>
                <Submit label={t('forget_pairing')} tone="secondary" />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="wa-contacts-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wa-contacts-title">
            <span>{t('contacts')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('user')}</th>
                  <th scope="col">{t('number')}</th>
                  <th scope="col">{t('allow_notifications')}</th>
                  <th scope="col">{t('allow_queries')}</th>
                  <th scope="col">{t('allow_digest')}</th>
                  <th scope="col">{t('ceo_role')}</th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {contacts.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('no_contacts')}
                    </td>
                  </tr>
                ) : null}
                {contacts.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="auto">{row.displayName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.e164}</bdi>
                    </td>
                    <td>{yes(row.allowNotifications)}</td>
                    <td>{yes(row.allowQueries)}</td>
                    <td>{yes(row.allowDigest)}</td>
                    <td>{yes(row.isCeo)}</td>
                    <td>
                      {mayConfigure ? (
                        <Form action={setContactActive}>
                          <Hidden name="id" value={row.id} />
                          <Hidden name="active" value={row.active ? '0' : '1'} />
                          {row.active ? <input aria-label={admin('reason')} name="reason" placeholder={admin('reason')} required type="text" /> : null}
                          <Submit label={row.active ? t('deactivate') : t('activate')} small tone="secondary" />
                        </Form>
                      ) : row.active ? (
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
          {mayConfigure ? (
            <Form action={saveContact}>
              <p className={s.sapGridCaption}>{t('new_contact')}</p>
              <Grid>
                <Select label={column('user')} name="user_id" options={people.filter((p) => p.isActive).map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))} required />
                <Field hint={t('number_hint')} label={t('number')} name="e164" placeholder="+9647xxxxxxxxx" required />
              </Grid>
              <Checkbox defaultChecked label={t('allow_notifications')} name="allow_notifications" />
              <Checkbox label={t('allow_queries')} name="allow_queries" />
              <Checkbox label={t('allow_digest')} name="allow_digest" />
              <p className={s.sapNote}>{t('queries_note')}</p>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="wa-rules-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wa-rules-title">
            <span>{t('rules')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{t('event')}</th>
                  <th scope="col">{t('recipient_role')}</th>
                  <th scope="col">{t('channels')}</th>
                  <th scope="col">{t('whatsapp')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.code}>
                    <td>
                      <bdi dir="ltr">{rule.code}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{rule.eventType}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{rule.recipientRole}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{rule.channels.join(', ')}</bdi>
                    </td>
                    <td>
                      {mayConfigure ? (
                        <Form action={setRuleWhatsapp}>
                          <Hidden name="code" value={rule.code} />
                          <Hidden name="on" value={rule.whatsapp ? '0' : '1'} />
                          <Submit label={rule.whatsapp ? t('turn_off') : t('turn_on')} small tone="secondary" />
                        </Form>
                      ) : (
                        yes(rule.whatsapp)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.sapNote}>{t('rules_note')}</p>
        </div>
      </section>

      <section aria-labelledby="wa-settings-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wa-settings-title">
            <span>{t('settings')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('setting')}</th>
                  <th scope="col">{column('value')}</th>
                  <th scope="col">{t('updated')}</th>
                </tr>
              </thead>
              <tbody>
                {knobs.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <bdi dir="auto">{settingLabel(row.key)}</bdi>
                    </td>
                    <td>
                      {mayConfigure ? (
                        <Form action={saveSetting}>
                          <Hidden name="key" value={row.key} />
                          <input aria-label={settingLabel(row.key)} defaultValue={row.value} dir="ltr" name="value" required type="text" />
                          <Submit label={t('save')} small tone="secondary" />
                        </Form>
                      ) : (
                        <bdi dir="ltr">{row.value}</bdi>
                      )}
                    </td>
                    <td>{when(row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.sapNote}>{t('settings_note')}</p>
        </div>
      </section>

      <section aria-labelledby="wa-log-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wa-log-title">
            <span>{t('log')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{t('direction')}</th>
                  <th scope="col">{t('number')}</th>
                  <th scope="col">{column('user')}</th>
                  <th scope="col">{t('intent')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('message')}</th>
                  <th scope="col">{t('attachment')}</th>
                </tr>
              </thead>
              <tbody>
                {log.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('no_messages')}
                    </td>
                  </tr>
                ) : null}
                {log.map((row) => (
                  <tr key={row.id.toString()}>
                    <td>{when(row.createdAt)}</td>
                    <td>{row.direction === 'in' ? t('inbound') : t('outbound')}</td>
                    <td>
                      <bdi dir="ltr">{row.e164}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.userName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.intent ?? '—'}</bdi>
                    </td>
                    <td>
                      <Pill
                        label={t(`message_status_${row.status}`)}
                        on={row.status === 'sent' || row.status === 'answered' ? true : row.status === 'failed' || row.status === 'refused' ? false : null}
                      />
                    </td>
                    <td>
                      <bdi dir="auto">{row.redactedAt ? t('redacted') : row.body ? (row.body.length > 160 ? `${row.body.slice(0, 160)}…` : row.body) : '—'}</bdi>
                      {row.errorMessage ? <bdi dir="auto"> — {row.errorMessage}</bdi> : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{row.attachmentName ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
