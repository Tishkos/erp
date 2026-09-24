import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { POSTING_MAP, eventKey, mappingAccountEligible } from '@domain/posting-map';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as posting from '@/server/services/posting';
import { setPostingMappings } from './actions';

/**
 * Posting Mappings — §3.3, Appendix C.
 *
 * *"Automatic posting is driven by configurable mappings; the posting engine
 * never chooses an account on its own."* Until this screen there was no way to
 * configure one: a document reached its approval, found no account for what
 * the company now owed, and refused with a message naming a screen that did
 * not exist.
 *
 * ── The screen is the list of questions the engine asks ────────────────────
 * Not a register of rules. A register shows what somebody has already set up
 * and says nothing about what is missing — and what is missing is the whole
 * problem, because an unmapped line is invisible until a document fails on it.
 * So the rows are the lines the engine will ask for, each showing its account
 * or saying it has none, and the ones no document can post without are marked.
 *
 * ── Drawn as the entry it configures (by direction, 2026-09-24) ────────────
 * One panel per document, and inside it the document's own journal: the side
 * first, then the line, then the account it goes to. An accountant reads
 *
 *     Cr   What the company owes the supplier     L1200 · Trade Payables
 *     Dr   Goods received, not yet invoiced       A1400 · GRNI
 *
 * as a Purchase Invoice before reading a word of it, which no list of role
 * names arranged alphabetically ever achieved. The side comes from the service
 * that posts the line, not from this screen's idea of it.
 *
 * Saved once per document rather than once per line. The lines of a journal
 * are decided together, and a Save on every row turned the screen into a
 * column of buttons. All of one document's lines are written in one
 * transaction, so a refusal leaves the mapping as it was rather than half
 * changed.
 *
 * Only accounts that can be posted to are offered: a group or an unapproved
 * account is refused by the database, and offering one would be inviting the
 * refusal. A line that must hit a control account offers only accounts bearing
 * that designation, and says so on the line rather than in a note underneath.
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

  const [t, page, column, chart, map, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('chart'),
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

  const eligibleFor = (
    event: (typeof POSTING_MAP)[number],
    line: (typeof POSTING_MAP)[number]['lines'][number],
  ) => accounts.filter((account) => mappingAccountEligible(event.event, line.role, account));

  /**
   * What each row is: the mapping in force, whether it still stands, and the
   * accounts the reader may choose from. Read once here so the table renders
   * the answer rather than working it out three times per row.
   */
  const stateOf = (
    document: (typeof POSTING_MAP)[number],
    line: (typeof POSTING_MAP)[number]['lines'][number],
  ) => {
    const rule = mapped.get(`${document.event} ${line.role}`) ?? null;
    const eligible = eligibleFor(document, line);
    // A mapping written when the account was eligible and left behind when it
    // stopped being — unapproved, deactivated, or its control designation
    // taken off. The engine will refuse it, so the screen says so first.
    const stale = rule !== null && !eligible.some((account) => account.id === rule.accountId);
    return { rule, eligible, stale, ready: rule !== null && !stale };
  };

  const missing = POSTING_MAP.flatMap((document) =>
    document.lines.filter((line) => line.always && !stateOf(document, line).ready),
  ).length;

  return (
    <AdminPage
      actions={
        <span className={s.mapReadiness} data-ready={missing === 0 ? 'true' : 'false'}>
          {missing > 0
            ? t('posting_mappings.missing', { count: missing })
            : t('posting_mappings.complete')}
        </span>
      }
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

      <div className={s.mapStack}>
        {POSTING_MAP.map((document) => (
          <form action={setPostingMappings} key={document.event}>
            <input name="event_type" type="hidden" value={document.event} />
            <Panel
              actions={
                mayConfigure ? (
                  <button className={`${s.button} ${s.primary}`} type="submit">
                    {t('save')}
                  </button>
                ) : null
              }
              flush
              title={map(`event.${eventKey(document.event)}`)}
            >
              <div className="table-wrap">
                <table className={s.mapTable}>
                  <thead>
                    <tr>
                      <th className={s.mapSide} scope="col">
                        {t('posting_mappings.side')}
                      </th>
                      <th scope="col">{t('posting_mappings.line')}</th>
                      <th scope="col">{column('account')}</th>
                      <th scope="col">{column('status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {document.lines.map((line) => {
                      const { rule, eligible, stale, ready } = stateOf(document, line);
                      const label = map(`role.${line.role}`);

                      return (
                        <tr key={line.role}>
                          <td className={s.mapSide}>{t(`posting_mappings.side_${line.side}`)}</td>

                          <td>
                            <span className={s.mapLine}>
                              <span className={s.mapLineName}>{label}</span>
                              {line.always || line.controlAccount ? (
                                <span className={s.mapPills}>
                                  {line.always ? (
                                    <Pill label={t('posting_mappings.always')} on={null} />
                                  ) : null}
                                  {line.controlAccount ? (
                                    /* Why only a few accounts are offered here,
                                       said on hover rather than in a note under
                                       every row that has one. */
                                    <span
                                      title={t('posting_mappings.control_hint', {
                                        kind: chart(`control_accounts.${line.controlAccount}`),
                                      })}
                                    >
                                      <Pill
                                        label={t('posting_mappings.control_pill', {
                                          kind: chart(`control_accounts.${line.controlAccount}`),
                                        })}
                                        on={null}
                                      />
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                            </span>
                          </td>

                          <td className={s.mapAccount}>
                            {mayConfigure ? (
                              <select
                                aria-label={label}
                                defaultValue={rule?.accountId ?? ''}
                                dir="ltr"
                                name={`account_id_${line.role}`}
                              >
                                <option value="">{t('posting_mappings.not_set')}</option>
                                {/* The stale mapping, shown so the reader can see
                                    what it was rather than finding the field
                                    mysteriously blank. Disabled: re-choosing it
                                    would only be refused again. */}
                                {stale && rule ? (
                                  <option disabled value={rule.accountId}>
                                    {`${rule.accountCode} · ${rule.accountName}`}
                                  </option>
                                ) : null}
                                {eligible.map((account) => (
                                  <option key={account.id} value={account.id}>
                                    {`${account.code} · ${account.name}`}
                                  </option>
                                ))}
                              </select>
                            ) : rule ? (
                              <bdi dir="auto">{`${rule.accountCode} · ${rule.accountName}`}</bdi>
                            ) : (
                              t('none')
                            )}
                          </td>

                          <td>
                            <span className={s.mapStatus}>
                              {ready ? (
                                <>
                                  <Pill label={t('posting_mappings.ready')} on />
                                  <Link
                                    className={s.sapLink}
                                    href={`/master-data/chart-of-accounts/${encodeURIComponent(rule!.accountCode)}`}
                                  >
                                    <bdi dir="ltr">{rule!.accountCode}</bdi>
                                  </Link>
                                </>
                              ) : stale ? (
                                <span title={t('posting_mappings.not_eligible_hint')}>
                                  <Pill label={t('posting_mappings.not_eligible')} on={false} />
                                </span>
                              ) : (
                                <Pill label={t('posting_mappings.not_set')} on={line.always ? false : null} />
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </form>
        ))}
      </div>
    </AdminPage>
  );
}
