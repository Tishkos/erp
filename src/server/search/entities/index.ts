/**
 * The record types the search knows today, and the one call that registers them.
 *
 * A module that adds records people look for (the Task Center, the Document
 * Center, a later stage) declares them in its own file here — a `SearchTableType`
 * or a `SearchCustomType` (`../types.ts`) — and adds the export to `BUILT_IN`.
 * Nothing else changes: the grant, the row policy, the ranking, the group
 * heading (`search.types.<key>`) and "see all" follow from the declaration.
 */
import { registerSearchType, searchType } from '../registry';
import type { SearchType } from '../types';
import {
  apInvoice,
  arInvoice,
  bankLoan,
  customerReceipt,
  goodsReceipt,
  journalEntry,
  paymentApplication,
  purchaseOrder,
  salesReturn,
  supplierPayment,
} from './documents';
import { attachmentFiles } from './files';
import { billOfLading, customsDeclaration, customsPd, payable, shipmentContainer } from './logistics';
import {
  bankCashAccount,
  chartOfAccount,
  customer,
  employee,
  item,
  project,
  supplier,
  warehouse,
} from './masters';
import { task } from './tasks';

export const BUILT_IN: readonly SearchType[] = [
  // Master records
  customer,
  supplier,
  employee,
  item,
  warehouse,
  bankCashAccount,
  chartOfAccount,
  project,
  // Documents
  apInvoice,
  arInvoice,
  supplierPayment,
  customerReceipt,
  paymentApplication,
  purchaseOrder,
  goodsReceipt,
  salesReturn,
  journalEntry,
  bankLoan,
  // Work
  task,
  // Imports and shipping
  payable,
  billOfLading,
  shipmentContainer,
  customsPd,
  customsDeclaration,
  // Files
  attachmentFiles,
];

/** Idempotent; called by the search service before it reads the registry. A key already registered is left as it is. */
export function registerBuiltInSearchTypes(): void {
  for (const type of BUILT_IN) {
    if (!searchType(type.key)) registerSearchType(type);
  }
}
