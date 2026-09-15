import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as sr from '@/server/services/sales-return';
import * as warehouses from '@/server/services/warehouses';
import { acceptReturn, receiveReturn, rejectReturn } from '../actions';

/**
 * One Sales Return — Operations build, block 9.
 *
 *   Journal   Sales Return Dr. / Accounts Receivable or Bank Cr. /
 *             Inventory Dr. / COGS Cr.
 *   Cost      The Inventory and COGS amounts for each returned item are taken
 *             from the original Sales Invoice item cost.
 *
 * Appendix B's order, and it is not the obvious one: the goods are received and
 * inspected *before* anybody accepts the return. Accepting first would be
 * agreeing to credit a customer for goods nobody has looked at.
 *
 * So the buttons appear one at a time, in that order, and only for the person
 * who holds the verb. Rejecting is available wherever accepting is, because
 * they are the two ends of one decision.
 */
export const dynamic = 'force-dynamic';

export default async function SalesReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ returnNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/sales-returns')) notFound();

  const [t, page, column, status, locale, context, outcome, { returnNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', sr.PERMISSION_OBJECT)) {
    return <Denied object={page('sales_returns')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await sr.viewByNo(tx, decodeURIComponent(returnNo));
    if (!document) return null;
    return { document, houses: await warehouses.listActive(tx) };
  });

  if (!found) notFound();
  const { lines, ...returnDoc } = found.document;

  const today = new Date().toISOString().slice(0, 10);
  const mayReceive = returnDoc.status === 'submitted' && can(principal, 'execute', sr.PERMISSION_OBJECT);
  const mayDecide =
    ['partially_executed', 'executed'].includes(returnDoc.status) &&
    can(principal, 'approve', sr.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
          {mayReceive ? (
            <form action={receiveReturn}>
              <input name="id" type="hidden" value={returnDoc.id} />
              <input name="return_no" type="hidden" value={returnDoc.returnNo} />
              <input name="received_on" type="hidden" value={today} />
              <button className="action action--primary" type="submit">
                {t('sales_returns.receive')}
              </button>
            </form>
          ) : null}
          {mayDecide ? (
            <>
              <form action={acceptReturn}>
                <input name="id" type="hidden" value={returnDoc.id} />
                <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                <input
                  name="warehouse_code"
                  type="hidden"
                  value={found.houses[0]?.code ?? ''}
                />
                <button className="action action--primary" type="submit">
                  {t('sales_returns.accept')}
                </button>
              </form>
              <form action={rejectReturn}>
                <input name="id" type="hidden" value={returnDoc.id} />
                <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                <input name="reason" type="hidden" value={returnDoc.reason} />
                <button className="action" type="submit">
                  {t('sales_returns.reject')}
                </button>
              </form>
            </>
          ) : null}
        </>
      }
      back={{ href: '/sales/sales-returns', label: t('sales_returns.title') }}
      tabs={<SectionTabs route="/sales/sales-returns" />}
      subtitle={t('sales_returns.subtitle')}
      title={returnDoc.returnNo}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <dl className={s.inboxFacts}>
        <div>
          <dt>{column('status')}</dt>
          <dd>
            <span className={`status status--${returnDoc.status}`} data-status={returnDoc.status}>
              {status(returnDoc.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{column('posting_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(returnDoc.requestedOn, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('sales_returns.offset')}</dt>
          <dd>
            {returnDoc.offsetKind === 'bank'
              ? t('sales_returns.offset_bank')
              : t('sales_returns.offset_receivable')}
          </dd>
        </div>
        <div>
          <dt>{t('sales_returns.reason')}</dt>
          <dd>
            <bdi dir="auto">{returnDoc.reason}</bdi>
          </dd>
        </div>
      </dl>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th className={s.sapNum} scope="col">
                {t('sales_returns.return_quantity')}
              </th>
              <th scope="col">{column('warehouse_code')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <bdi dir="ltr">{line.itemCode}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">
                    {String(Number(line.acceptedQuantity ?? line.requestedQuantity))}
                  </bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.destinationWarehouseCode ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminPage>
  );
}
