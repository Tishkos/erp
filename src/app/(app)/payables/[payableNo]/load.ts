import type { Tx } from '@/server/db/client';
import { isNotFoundError } from '@/server/not-found';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';
import * as paymentApplications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as shipmentsService from '@/server/services/shipments';
import * as loansService from '@/server/services/loans';
import * as landedService from '@/server/services/landed-cost';
import * as finalCostService from '@/server/services/final-cost';
import * as settingsService from '@/server/services/payables-settings';
import * as contracts from '@/server/services/recurring-contracts';
import * as serviceReceipts from '@/server/services/service-receipt';
import * as users from '@/server/services/users';
import * as exchange from '@/server/services/import-exchange';
import * as advanceHold from '@/server/services/advance-hold';
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

export type PayableView = Awaited<ReturnType<typeof payables.view>>;

/**
 * The landed cost of one import — the charges, the locks, the state, what a
 * lock would do, the final cost. Read for the import's page and for the
 * landed-cost sheet alike (2026-10-06); null for a cancelled import.
 */
export async function landedFor(tx: Tx, view: PayableView, may: { readonly addCharge: boolean; readonly lock: boolean }) {
  if (view.payable.cancelledAt) return null;
  const charges = await landedService.chargesFor(tx, view.payable.id);
  const locks = await landedService.locksFor(tx, view.payable.id);
  const state = landedService.lockableState({
    allPdsWrittenOff: view.facts.allPdsWrittenOff,
    containersIn: view.facts.containerCount > 0 && view.facts.containersReceived === view.facts.containerCount,
    unlocked: charges.filter((charge) => !charge.lockId && !charge.cancelledAt).length,
    lastSequence: locks.length ? Math.max(...locks.map((l) => l.sequence)) : null,
  });
  const preview = state.unlocked > 0 ? await landedService.preview(tx, { payableId: view.payable.id }) : { models: [], total: '0' };
  const lockForm = may.lock && state.ready && state.unlocked > 0;
  const bases = lockForm ? (await landedService.bases(tx)).filter((basis) => basis.active) : [];
  const types = may.addCharge || lockForm ? (await landedService.chargeTypes(tx)).filter((type) => type.code !== 'purchase') : [];
  const finalCost = locks.length > 0 ? await finalCostService.finalCost(tx, view.payable.id) : [];
  return { charges, locks, state, preview, bases, types, finalCost };
}

export type LandedBlock = Awaited<ReturnType<typeof landedFor>>;

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
    // What waits in On Process (Without SWIFT) for the advance (2026-10-06).
    const held = isImport ? await advanceHold.heldOf(tx, view.payable.id) : [];
    // REQ-FIX-001 FX8 — an import agreed in another currency, fully paid in it:
    // what its dinars still have to close on (read only then; none for IQD).
    const exchangeResidual =
      paymentTotals?.fullyPaid && view.payable.currency !== 'IQD' ? await exchange.residualOf(tx, view.payable.id) : null;
    // §15.7 — the loans that fund it, with the commission each draw carries.
    const funding = isImport && may.viewLoans ? await loansService.forPayable(tx, view.payable.id) : [];
    // The windows that raised an application, a PD and a B/L are sheets of their own since 2026-10-06:
    // the page only says whether to offer them, and reads none of their pickers.
    const pickers = isImport && may.pay && open;
    // §16 — the PD / ASYCUDA section.
    const pds = isImport && may.viewPd ? await customs.list(tx, { payableId: view.payable.id, view: 'all' }) : [];
    const pdPickers = isImport && may.registerPd && open;
    // §17 — the Shipment & containers section.
    const shipment = isImport && may.viewShipment ? await shipmentsService.forPayable(tx, view.payable.id) : null;
    const blPorts = isImport && may.createBl && open;
    // §20.2 — the landed cost: its charges, the locks, what a lock would do.
    const landed = isImport && may.viewLanded ? await landedFor(tx, view, { addCharge: may.addCharge, lock: may.lock }) : null;
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
      held,
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
