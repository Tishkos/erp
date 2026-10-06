import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { ExportIcon } from '@/components/print/export-menu';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as landedService from '@/server/services/landed-cost';
import * as payables from '@/server/services/payables';
import * as recordNotes from '@/server/services/record-notes';
import { landedFor } from '../../../payables/[payableNo]/load';
import { LandedChargesTable, LandedCostSection, landedChargesTotal } from '../../../payables/landed-cost-section';

export const dynamic = 'force-dynamic';

const LIST = '/logistics/landed-costs';

/**
 * The landed cost of one import, on a sheet of its own — by direction
 * 2026-10-06 ("Landed cost … their own sheet, same style … print, attachment,
 * notes, audit, for all four").
 *
 * Until now the landed cost had no page: it was a section of the import
 * application, and the Landed Costs register sent its reader there. This is
 * the document screen in the purchase invoice's style — the import, the
 * supplier, the charges as the lines, the state as the chip — with the four
 * doors in the standing order: the printer (the Final Cost), the paperclip
 * (the freight and clearance bills, under `payable_landed_cost`), the notes,
 * and the clock (every charge added or withdrawn and every lock, which the
 * audit trail keeps under the charge's and the lock's own ids). The preview,
 * the final cost, the locks and the windows that act are the same component
 * the import's page draws, and they come back here, not to the import.
 */
export default async function LandedCostSheetPage({ params, searchParams }: { params: Promise<{ payableNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute(LIST)) notFound();

  const { payableNo } = await params;
  const [lc, admin, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.landed_cost'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', landedService.PERMISSION_OBJECT)) {
    return <Denied object={page('landed_costs')} />;
  }
  const may = {
    addCharge: can(principal, 'create', landedService.PERMISSION_OBJECT),
    lock: can(principal, 'post', landedService.PERMISSION_OBJECT),
    withdraw: can(principal, 'reverse_cancel', landedService.PERMISSION_OBJECT),
  };

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await payables.view(tx, payableNo);
      if (view.payable.payableTypeCode !== 'import') return null;
      return {
        view,
        landed: await landedFor(tx, view, may),
        notes: await recordNotes.listNotes(tx, { object: 'payable_landed_cost', recordId: view.payable.id }),
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found || !found.landed) notFound();
  const { view, landed } = found;
  const row = view.payable;
  const route = `${LIST}/${encodeURIComponent(row.payableNo)}`;

  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) => (value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—');
  const lastLock = landed.locks.length > 0 ? landed.locks[landed.locks.length - 1]! : null;
  const state = landed.state.unlocked > 0 ? 'pending' : landed.state.locked ? 'locked' : 'open';

  const fields: DocumentField[] = [
    { label: admin('logistics.import'), value: <ProfileLink code={row.payableNo} kind="import" /> },
    {
      label: admin('payables.supplier'),
      value: <ProfileLink code={view.supplier?.code} dir="auto" kind="supplier" name={view.supplier?.name ?? null} />,
    },
    { label: column('branch'), value: <bdi dir="auto">{view.branchName}</bdi> },
    { label: lc('col_amount'), value: <bdi dir="ltr">{money(landedChargesTotal(landed), 'IQD')}</bdi> },
    {
      label: lc('col_state'),
      value: state === 'pending' ? lc('state_pending', { count: landed.state.unlocked }) : state === 'locked' ? lc('state_locked') : lc('state_open'),
      status: state === 'pending' ? 'draft' : state === 'locked' ? 'posted' : 'submitted',
    },
    { label: lc('locks_title'), value: <bdi dir="ltr">{String(landed.locks.length)}</bdi> },
    ...(lastLock
      ? [
          { label: lc('col_date'), value: <bdi dir="ltr">{day(lastLock.lockDate)}</bdi> } satisfies DocumentField,
          { label: lc('col_journal'), value: <ProfileLink code={lastLock.entryNo} kind="journal" /> } satisfies DocumentField,
        ]
      : []),
  ];

  return (
    <AdminPage
      back={{ href: LIST, label: admin('back') }}
      tabs={<SectionTabs route={LIST} />}
      title={`${page('landed_costs')} · ${row.payableNo}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the four doors in the standing order (2026-10-04). */}
            <ExportIcon exportKey="landed_cost_final" id={row.payableNo} title={lc('final_print')} />
            <RecordAttachmentsDoor mayAttach={can(principal, 'create', 'attachment')} object="payable_landed_cost" recordId={row.id} />
            <RecordNotesDoor notes={found.notes} object="payable_landed_cost" recordId={row.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory
                objectId={row.id}
                objectType={payables.PERMISSION_OBJECT}
                related={[
                  ...landed.charges.map((charge) => ({ objectType: landedService.PERMISSION_OBJECT, objectId: charge.id })),
                  ...landed.locks.map((lock) => ({ objectType: landedService.PERMISSION_OBJECT, objectId: lock.id })),
                ]}
              />
            </HistoryButton>
          </>
        }
        documentType={page('landed_costs')}
        fields={fields}
        id="landed-sheet"
        linesCount={landed.charges.length}
        linesTitle={lc('section_title')}
        number={row.payableNo}
      >
        <LandedChargesTable labelledBy="landed-sheet-lines-heading" landed={landed} locale={locale} />
      </DocumentWindow>

      {/* Stacked under the document, in the supplier-statement manner: the preview, the final cost, the locks, the actions. */}
      <LandedCostSection landed={landed} locale={locale} may={may} returnTo={route} row={{ id: row.id, payableNo: row.payableNo }} showCharges={false} />
    </AdminPage>
  );
}
