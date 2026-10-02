import type { Tx } from '@/server/db/client';
import { isNotFoundError } from '@/server/not-found';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';
import * as paymentApplications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as banksService from '@/server/services/banks';
import * as shipmentsService from '@/server/services/shipments';
import * as loansService from '@/server/services/loans';
import * as landedService from '@/server/services/landed-cost';
import * as settingsService from '@/server/services/payables-settings';
import * as contracts from '@/server/services/recurring-contracts';
import * as serviceReceipts from '@/server/services/service-receipt';
import * as users from '@/server/services/users';
import * as exchange from '@/server/services/import-exchange';
import { readAttachments } from '@/components/admin/attachments';
import { readHistory } from '@/components/admin/history';

/**
 * Everything the payable record reads — REQ-HARDEN-001 G1–G3, HD14.
 *
 * One transaction for the whole page: the attachments and the history used
 * to open a session each (three per view); they are read here and handed to
 * their components. Each read is the one the page draws, and only when the
 * reader will see it: the stop reasons and the owners only when the reader
 * may stop the payable (the eight settings tables and every user with their
 * credentials were read before); the landed-cost preview only while
 * something is unlocked, its bases only for the lock form, its charge types
 * only for the charge form. Sequential, because a transaction is one
 * connection — the cost is the number of statements, which
 * `tests/integration/hd14-payable-record.test.ts` counts.
 */
export interface PayableRecordInput {
  readonly payableNo: string;
  readonly laneFilter: string | null;
  readonly logSearch: string | null;
  readonly logPage: number;
  readonly may: {
    readonly edit: boolean;
    readonly pay: boolean;
    readonly viewPd: boolean;
    readonly registerPd: boolean;
    readonly viewShipment: boolean;
    readonly createBl: boolean;
    readonly viewLoans: boolean;
    readonly viewLanded: boolean;
    readonly addCharge: boolean;
    readonly lock: boolean;
  };
}

export async function loadPayableRecord(tx: Tx, input: PayableRecordInput) {
  const { may } = input;
  try {
    const view = await payables.view(tx, input.payableNo);
    const open = !view.payable.cancelledAt && !view.payable.closedAt;
    const log = await events.logFor(tx, view.payable.id, { laneCode: input.laneFilter, search: input.logSearch, page: input.logPage });
    // G2, G3 — the stop form's two lists, and only for somebody who may stop it.
    const reasons = may.edit && open ? await settingsService.activeHoldReasons(tx) : [];
    const people = may.edit && open ? await users.pickable(tx) : [];
    // §21.3 — the service lane: the confirmations this payable owns, and
    // the contract it answers to when it is a generated period.
    const receipts = await serviceReceipts.listForPayable(tx, view.payable.id);
    const contract = view.payable.recurringContractId ? await contracts.load(tx, view.payable.recurringContractId) : null;
    // §15 — the Payments section: the plan, the applications, the totals.
    const isImport = view.payable.payableTypeCode === 'import';
    const instalments = isImport ? await paymentApplications.instalmentsFor(tx, view.payable.id) : [];
    const applied = isImport ? await paymentApplications.list(tx, { payableId: view.payable.id }) : [];
    const paymentTotals = isImport ? await paymentApplications.totalsFor(tx, view.payable.id) : null;
    // REQ-FIX-001 FX8 — an import agreed in another currency, fully paid in it:
    // what its dinars still have to close on (read only then; none for IQD).
    const exchangeResidual =
      paymentTotals?.fullyPaid && view.payable.currency !== 'IQD' ? await exchange.residualOf(tx, view.payable.id) : null;
    // §15.7 — the loans that fund it, with the commission each draw carries.
    const funding = isImport && may.viewLoans ? await loansService.forPayable(tx, view.payable.id) : [];
    const pickers = isImport && may.pay && open ? await paymentApplications.pickersFor(tx, view.payable.id) : null;
    // §16 — the PD / ASYCUDA section.
    const pds = isImport && may.viewPd ? await customs.list(tx, { payableId: view.payable.id, view: 'all' }) : [];
    const pdPickers = isImport && may.registerPd && open ? { banks: await banksService.listActive(tx), statuses: await customs.statuses(tx) } : null;
    // §17 — the Shipment & containers section.
    const shipment = isImport && may.viewShipment ? await shipmentsService.forPayable(tx, view.payable.id) : null;
    const blPorts = isImport && may.createBl && open ? await shipmentsService.ports(tx) : null;
    // §20.2 — the landed cost: its charges, the locks, what a lock would do.
    let landed = null;
    if (isImport && may.viewLanded && !view.payable.cancelledAt) {
      const charges = await landedService.chargesFor(tx, view.payable.id);
      const locks = await landedService.locksFor(tx, view.payable.id);
      // The stage facts the view already read, the charges and the locks just read: no second pass.
      const state = landedService.lockableState({
        allPdsWrittenOff: view.facts.allPdsWrittenOff,
        unlocked: charges.filter((charge) => !charge.lockId && !charge.cancelledAt).length,
        lastSequence: locks.length ? Math.max(...locks.map((l) => l.sequence)) : null,
      });
      // G3 — the preview only while something is unlocked; the lists only for the forms that use them.
      const preview = state.unlocked > 0 ? await landedService.preview(tx, { payableId: view.payable.id }) : { models: [], total: '0' };
      const lockForm = may.lock && state.pdsWrittenOff && state.unlocked > 0;
      const bases = lockForm ? (await landedService.bases(tx)).filter((basis) => basis.active) : [];
      const types = may.addCharge || lockForm ? (await landedService.chargeTypes(tx)).filter((type) => type.code !== 'purchase') : [];
      landed = { charges, locks, state, preview, bases, types };
    }
    // G3 — the attachments and the history, in this same transaction.
    const attachments = await readAttachments(tx, payables.PERMISSION_OBJECT, view.payable.id);
    const history = await readHistory(tx, payables.PERMISSION_OBJECT, view.payable.id);
    return {
      ...view,
      landed,
      shipment,
      blPorts,
      log,
      reasons,
      people,
      receipts,
      contract,
      instalments,
      applied,
      paymentTotals,
      exchangeOpen: exchangeResidual !== null && exchange.isOpen(view.payable.currency, exchangeResidual) ? exchangeResidual : null,
      funding,
      pickers,
      pds,
      pdPickers,
      attachments,
      history,
    };
  } catch (error) {
    // E1 — a missing record is a 404; anything else reaches the error boundary.
    if (isNotFoundError(error)) return null;
    throw error;
  }
}
