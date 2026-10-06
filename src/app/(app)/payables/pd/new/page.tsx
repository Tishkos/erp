import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as customs from '@/server/services/customs-pd';
import { registerPd } from '../actions';

export const dynamic = 'force-dynamic';

const LIST = '/payables/pd';

/**
 * Registering a PD on a sheet of its own — by direction 2026-10-06 ("register
 * PD … their own sheet, not switch us back to the import application").
 *
 * The registration used to be a window on the import's page and on the PD
 * list. It is a document page now, in the purchase invoice's style: the
 * import first (preselected when the page was opened from the import's own
 * page, `?import=`), then the PD's number, dates, bank and status. Register
 * opens the PD's own record, where its papers, notes and history live.
 */
export default async function NewPdPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute(LIST)) notFound();

  const [t, admin, page, locale, context, outcome, query] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'create', customs.PERMISSION_OBJECT)) {
    return <Denied object={page('pds')} />;
  }
  const chosen = typeof query.import === 'string' ? query.import.trim() : '';
  const today = businessToday();

  const { imports, bankRows, statuses } = await withCurrentUser(async (tx) => ({
    imports: await customs.importChoices(tx),
    bankRows: await banks.listWeBankWith(tx),
    statuses: await customs.statuses(tx),
  }));
  const preselected = imports.find((row) => row.payableNo === chosen)?.id ?? '';
  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);

  const fields: DocumentField[] = [
    {
      label: t('import'),
      control: true,
      value: (
        <select aria-label={t('import')} defaultValue={preselected} name="payable_id" required>
          <option value="" />
          {imports.map((row) => (
            <option key={row.id} value={row.id}>
              {`${row.payableNo} · ${row.reference} · ${row.supplierName}`}
            </option>
          ))}
        </select>
      ),
    },
    {
      label: t('pd_no'),
      control: true,
      value: (
        <>
          <input aria-label={t('pd_no')} autoComplete="off" dir="ltr" name="new_pd_no" required type="text" />
          <span className={s.sapEnteredNote}>{t('pd_no_hint')}</span>
        </>
      ),
    },
    {
      label: t('registered'),
      control: true,
      value: <input aria-label={t('registered')} defaultValue={today} name="registration_date" required type="date" />,
    },
    {
      label: t('expires'),
      control: true,
      value: (
        <>
          <input aria-label={t('expires')} name="expiry_date" required type="date" />
          <span className={s.sapEnteredNote}>{t('expiry_hint')}</span>
        </>
      ),
    },
    {
      label: t('bank'),
      control: true,
      value: (
        <select aria-label={t('bank')} defaultValue="" name="bank_code">
          <option value="">—</option>
          {bankRows.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.swiftBic ? `${bank.name} · ${bank.swiftBic}` : bank.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      label: t('status'),
      control: true,
      value: (
        <select aria-label={t('status')} defaultValue="submitted" name="status_code">
          {statuses
            .filter((status) => status.active && !status.isTerminal)
            .map((status) => (
              <option key={status.code} value={status.code}>
                {ps(status.code, status.name)}
              </option>
            ))}
        </select>
      ),
    },
  ];

  return (
    <AdminPage
      back={{ href: LIST, label: admin('back') }}
      tabs={<SectionTabs route={LIST} />}
      title={chosen ? t('register_for', { payableNo: chosen }) : t('register')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      <form action={registerPd}>
        <DocumentWindow
          actions={<Submit label={t('register')} variant="document" />}
          documentType={page('pds')}
          fields={fields}
          fieldsAfterLines={[
            {
              label: t('note'),
              control: true,
              wide: true,
              value: <input aria-label={t('note')} name="note" type="text" />,
            },
          ]}
          id="pd-new"
          linesTitle={t('register')}
          number=""
        >
          <table aria-labelledby="pd-new-lines-heading" className={s.sapTable}>
            <tbody>
              <tr>
                <td>{t('register_note')}</td>
              </tr>
            </tbody>
          </table>
        </DocumentWindow>
      </form>
    </AdminPage>
  );
}
