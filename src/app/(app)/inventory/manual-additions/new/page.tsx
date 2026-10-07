import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { ManualAdditionLines } from '@/components/admin/manual-addition-lines';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { IntentSelect } from '@/components/admin/intent-select';
import { IntentDateField } from '@/components/admin/intent-date-field';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as additions from '@/server/services/manual-stock-addition';
import { saveAndApproveManualAddition, saveManualAddition } from '../actions';

/**
 * The Manual Stock Addition sheet — the invoice sheet's window for stock put
 * onto the books by hand (2026-10-06, by direction: "add a button — to which
 * warehouse, quantity, stock price and unit of it, and note for audit … a
 * button like invoice sheet").
 *
 *   Header  Warehouse (the branch's main stores); Posting date (today); Offset
 *           account (optional — as configured unless Finance says otherwise);
 *           Note / reason (required, kept for the audit).
 *   Lines   Item; Unit (the item's units, its base first); Quantity; Unit
 *           price (IQD); Line value (worked out as it is typed).
 *
 * Save as draft raises it — the page mints the document's one-time id, so a
 * second press finds the first. A super user's sheet also offers Save and
 * approve: the submission and the approval recorded in one press. With
 * `?draft=<no>` the sheet is a draft opened again for editing; with
 * `?warehouse=<code>` (the Warehouses Report's button) the warehouse is chosen.
 */
export const dynamic = 'force-dynamic';

export default async function NewManualAdditionPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/manual-additions')) notFound();

  const [t, admin, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.manual_additions'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  const draftNo = typeof params.draft === 'string' ? params.draft.trim() : '';
  const verb = draftNo ? 'edit_draft' : 'create';
  if (!can(principal, verb, additions.PERMISSION_OBJECT)) {
    return <Denied object={page('manual_stock_additions')} />;
  }

  const branchCode = context.scope.branchCode;
  const { houses, items, accounts, departments, mapped, draft } = await withCurrentUser(async (tx) => ({
    houses: await additions.warehousesFor(tx, branchCode),
    items: await additions.itemsFor(tx),
    accounts: await additions.offsetAccounts(tx),
    departments: await additions.departmentsFor(tx),
    mapped: await additions.mappedOffset(tx, branchCode),
    draft: draftNo ? await additions.draftForSheet(tx, draftNo) : null,
  }));
  if (draftNo && !draft) notFound();

  const today = businessToday();
  const asked = typeof params.warehouse === 'string' ? params.warehouse.trim() : '';
  const chosenWarehouse = draft?.document.warehouseCode ?? (houses.some((house) => house.code === asked) ? asked : (houses[0]?.code ?? ''));
  const missing = [houses.length === 0 ? t('no_warehouses') : null, items.length === 0 ? t('no_items') : null].filter(
    (gap): gap is string => gap !== null,
  );

  const fields: DocumentField[] = [
    {
      label: t('warehouse'),
      control: true,
      value: (
        <IntentSelect aria-label={t('warehouse')} defaultValue={chosenWarehouse} name="warehouse_code" required>
          {houses.map((house) => (
            <option key={house.code} value={house.code}>
              {`${house.code} · ${house.name}`}
            </option>
          ))}
        </IntentSelect>
      ),
    },
    {
      label: t('posting_date'),
      control: true,
      value: (
        <IntentDateField
          aria-label={t('posting_date')}
          defaultValue={draft?.document.postingDate ?? today}
          max={today}
          name="posting_date"
          required
        />
      ),
    },
    {
      label: t('offset_account'),
      control: true,
      value: (
        <>
          <IntentSelect aria-label={t('offset_account')} defaultValue={draft?.document.offsetAccountId ?? ''} name="offset_account_id">
            <option value="">{mapped ? t('offset_default_named', { account: `${mapped.code} · ${mapped.name}` }) : t('offset_default')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.code} · ${account.name}`}
              </option>
            ))}
          </IntentSelect>
          <span className={s.sapEnteredNote}>{t('offset_hint')}</span>
        </>
      ),
    },
    {
      // The journal's analysis, for an adjustment account that asks for a department (0416), as a Stock Count's adjustment carries.
      label: t('department'),
      control: true,
      value: (
        <IntentSelect aria-label={t('department')} defaultValue={draft?.document.departmentCode ?? ''} name="department_code">
          <option value="">{t('department_none')}</option>
          {departments.map((row) => (
            <option key={row.code} value={row.code}>
              {`${row.code} · ${row.name}`}
            </option>
          ))}
        </IntentSelect>
      ),
    },
    {
      label: t('reason'),
      control: true,
      wide: true,
      value: (
        <>
          <textarea
            aria-label={t('reason')}
            defaultValue={draft?.document.reason ?? ''}
            dir="auto"
            maxLength={2000}
            name="reason"
            required
            rows={2}
          />
          <span className={s.sapEnteredNote}>{t('reason_hint')}</span>
        </>
      ),
    },
  ];

  return (
    <AdminPage
      back={{ href: draft ? `/inventory/manual-additions/${encodeURIComponent(draft.document.additionNo)}` : '/inventory/manual-additions', label: admin('back') }}
      title={draft ? t('edit_title') : t('sheet_title')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={saveManualAddition}>
          {/* The document's one-time key: a second press of this sheet finds the first. */}
          <Hidden name="document_id" value={randomUUID()} />
          {draft ? (
            <>
              <Hidden name="id" value={draft.document.id} />
              <Hidden name="addition_no" value={draft.document.additionNo} />
            </>
          ) : null}
          <DocumentWindow
            actions={
              <>
                <Submit label={draft ? t('save_changes') : t('save_draft')} tone={principal.isSuperUser ? 'secondary' : 'primary'} variant="document" />
                {/* A super user's own sheet needs no second person (0278): saved, sent and approved in one press. */}
                {principal.isSuperUser && can(principal, 'approve', additions.PERMISSION_OBJECT) && (!draft || draft.document.createdBy === principal.userId) ? (
                  <Submit formAction={saveAndApproveManualAddition} label={t('save_and_approve')} variant="document" />
                ) : null}
              </>
            }
            documentType={page('manual_stock_addition')}
            fields={fields}
            id="manual-addition"
            linesTitle={t('lines')}
            number={draft?.document.additionNo ?? ''}
          >
            <ManualAdditionLines
              initial={(draft?.lines ?? []).map((line) => ({
                itemCode: line.itemCode,
                uomCode: line.uomCode,
                quantity: line.quantity,
                unitCost: line.unitCostIqd.replace(/\.?0+$/, ''),
              }))}
              items={items}
              labels={{
                item: t('item'),
                chooseItem: t('choose_item'),
                unit: t('unit'),
                quantity: column('quantity'),
                unitPrice: t('unit_price'),
                lineValue: t('line_value'),
                remove: admin('remove_line'),
                total: t('total'),
              }}
              locale={locale}
            />
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
