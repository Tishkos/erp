import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { POSTING_MAP, eventKey } from '@domain/posting-map';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as posting from '@/server/services/posting';
import { setPostingMapping } from './actions';

/**
 * Posting Mappings — §3.3, Appendix C.
 *
 * *"Automatic posting is driven by configurable mappings; the posting engine
 * never chooses an account on its own."* Until this screen there was no way to
 * configure one: a purchase invoice reached its approval, found no account for
 * what the company now owed, and refused with a message naming a screen that
 * did not exist. Every document in the Operations build stops at the same
 * place, which is why this arrives with them rather than with its own phase.
 *
 * ── The screen is the list of questions the engine asks ────────────────────
 * Not a register of rules. A register shows what somebody has already set up
 * and says nothing about what is missing — and what is missing is the whole
 * problem, because an unmapped line is invisible until a document fails on it.
 * So the rows are the lines the engine will ask for, each showing its account
 * or saying it has none, and the ones no document can post without are marked.
 *
 * The account is chosen on the row and saved there. Only accounts that can be
 * posted to are offered: a group or an unapproved account is refused by the
 * database, and offering one would be inviting the refusal.
 *
 * Mappings narrowed by item group, warehouse, project or branch are §3.3's
 * too, and the service that writes them is already here. They are deliberately
 * not on this screen: the first question is "does this post at all", and a
 * screen that answers it plainly is worth more than one that answers
 * everything.
 */
export const dynamic = 'force-dynamic';

export default async function PostingMappingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/finance/posting-mappings')) notFound();

  const [t, page, column, map, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    // The documents and the lines they post, named where a reader will look
    // for them rather than inside the administration block.
    getTranslations('posting_map'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', posting.PERMISSION_OBJECT)) {
    return <Denied object={page('posting_mappings')} />;
  }
  const mayConfigure = can(principal, 'configure', posting.PERMISSION_OBJECT);

  const { rules, accounts } = await withCurrentUser(async (tx) => ({
    rules: await posting.rules(tx),
    accounts: await coa.postableAccounts(tx),
  }));

  // The mapping in force for a line: the one that states no criteria, which is
  // the only kind this screen writes. A narrowed rule sits over it and is the
  // Posting Mappings service's business rather than this screen's.
  const mapped = new Map(
    rules
      .filter(
        (rule) =>
          rule.isActive &&
          !rule.itemGroup &&
          !rule.partnerGroup &&
          !rule.warehouseCode &&
          !rule.projectCode &&
          !rule.branchCode,
      )
      .map((rule) => [`${rule.eventType} ${rule.lineRole}`, rule]),
  );

  const missing = POSTING_MAP.flatMap((document) =>
    document.lines.filter((line) => line.always && !mapped.has(`${document.event} ${line.role}`)),
  ).length;

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('posting_mappings.subtitle')}
      tabs={<SectionTabs route="/finance/posting-mappings" />}
      title={page('posting_mappings')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <p className={s.sectionHint}>
        {missing > 0
          ? t('posting_mappings.missing', { count: missing })
          : t('posting_mappings.complete')}
      </p>

      {POSTING_MAP.map((document) => (
        <Panel
          key={document.event}
          flush
          title={map(`event.${eventKey(document.event)}`)}
        >
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{t('posting_mappings.line')}</th>
                  <th scope="col">{column('account')}</th>
                </tr>
              </thead>
              <tbody>
                {document.lines.map((line) => {
                  const rule = mapped.get(`${document.event} ${line.role}`);
                  const label = map(`role.${line.role}`);

                  return (
                    <tr key={line.role}>
                      <td>
                        <span>{label}</span>{' '}
                        {line.always ? (
                          <Pill label={t('posting_mappings.always')} on={null} />
                        ) : null}
                      </td>
                      <td>
                        {mayConfigure ? (
                          <form
                            action={setPostingMapping}
                            style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                          >
                            <input name="event_type" type="hidden" value={document.event} />
                            <input name="line_role" type="hidden" value={line.role} />
                            <select
                              aria-label={label}
                              defaultValue={rule?.accountId ?? ''}
                              dir="ltr"
                              name="account_id"
                            >
                              <option value="">{t('posting_mappings.not_set')}</option>
                              {accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {`${account.code} · ${account.name}`}
                                </option>
                              ))}
                            </select>
                            <button className="action" type="submit">
                              {t('save')}
                            </button>
                          </form>
                        ) : rule ? (
                          <bdi dir="auto">{`${rule.accountCode} · ${rule.accountName}`}</bdi>
                        ) : (
                          <Pill label={t('posting_mappings.not_set')} on={false} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}
    </AdminPage>
  );
}
