import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Form, Hidden, Submit, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/service-receipt';
import { approveReceipt, submitReceipt } from './actions';

/**
 * Service receipts — REQ-AP-001 §21.5, the department's inbox.
 *
 * "Awaiting confirmation" on top: the submitted receipts, each with its
 * approve on the row — the service refuses an approver from the wrong
 * department and the person who raised it (§5.2), so the button can be
 * offered and the rule still holds. The full list follows. A receipt posts
 * nothing; a dispute is a note and a stop on the payable, raised there.
 */
export const dynamic = 'force-dynamic';

export default async function ServiceReceiptsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/service-receipts')) notFound();

  const [t, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payables_receipts'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('service_receipts')} />;
  }
  const mayApprove = can(principal, 'approve', receipts.PERMISSION_OBJECT);
  const maySubmit = can(principal, 'submit', receipts.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => receipts.listForScreen(tx));
  const waiting = rows.filter((row) => row.status === 'submitted');

  const day = (value: string | null) =>
    value ? formatBusinessDate(value, locale as Locale) : '—';

  const table = (list: typeof rows, labelId: string, empty: string, withActions: boolean) => (
    <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
      <table aria-labelledby={labelId} className={`${s.sapTable} ${s.sapRegisterTable}`}>
        <thead>
          <tr>
            <th scope="col">{t('col_no')}</th>
            <th scope="col">{t('col_supplier')}</th>
            <th scope="col">{t('col_belongs_to')}</th>
            <th scope="col">{t('col_department')}</th>
            <th scope="col">{t('col_service_date')}</th>
            <th scope="col">{t('col_status')}</th>
            {withActions ? <th scope="col">{t('col_actions')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {list.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={withActions ? 7 : 6}>
                {empty}
              </td>
            </tr>
          ) : null}
          {list.map((row) => (
            <tr key={row.id}>
              <td>
                <bdi dir="ltr">{row.receiptNo}</bdi>
              </td>
              <td>
                <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
              </td>
              <td>
                {row.payableNo ? (
                  <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                    <bdi dir="ltr">{row.payableNo}</bdi>
                  </Link>
                ) : row.orderNo ? (
                  <Link
                    className={s.sapLink}
                    href={`/payables/purchase-orders/${encodeURIComponent(row.orderNo)}`}
                  >
                    <bdi dir="ltr">{row.orderNo}</bdi>
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td>{row.departmentCode}</td>
              <td>
                <bdi dir="ltr">{day(row.serviceDate)}</bdi>
              </td>
              <td>
                <span
                  className="status"
                  data-status={
                    row.status === 'approved'
                      ? 'approved'
                      : row.status === 'reversed'
                        ? 'cancelled'
                        : row.status
                  }
                >
                  {t(`status_${row.status}`)}
                </span>
              </td>
              {withActions ? (
                <td>
                  {row.status === 'draft' && maySubmit ? (
                    <Form action={submitReceipt}>
                      <Hidden name="receipt_id" value={row.id} />
                      <Submit label={t('submit')} small />
                    </Form>
                  ) : null}
                  {row.status === 'submitted' && mayApprove ? (
                    <Form action={approveReceipt}>
                      <Hidden name="receipt_id" value={row.id} />
                      <Submit label={t('approve')} small />
                    </Form>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <AdminPage
      back={{ href: '/payables', label: t('payables') }}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="awaiting-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="awaiting-title">
            <span>{t('awaiting')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: waiting.length })}</span>
          </h2>
          {table(waiting, 'awaiting-title', t('none_awaiting'), true)}
        </div>
      </section>

      <section aria-labelledby="receipts-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="receipts-title">
            <span>{t('all')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: rows.length })}</span>
          </h2>
          {table(rows, 'receipts-title', t('none'), false)}
        </div>
      </section>
    </AdminPage>
  );
}
