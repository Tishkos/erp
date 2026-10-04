/**
 * The detector registry — platform phase, Agent 7. One runner per entry of
 * `domain/exceptions.DETECTORS`; `tests/unit/ex01-exceptions.test.ts` holds the
 * two lists equal. A runner returns what is wrong now; it writes nothing.
 */
import * as accounting from './accounting';
import * as inventory from './inventory';
import * as logistics from './logistics';
import * as parties from './parties';
import * as platform from './platform';
import type { Runner } from './shared';
import * as work from './work';

export type { DetectContext, Runner } from './shared';

export const RUNNERS: Readonly<Record<string, Runner>> = Object.freeze({
  'accounting.bank_reconciliation_difference': accounting.bankReconciliationDifference,
  'accounting.control_account_difference': accounting.controlAccountDifference,
  'accounting.gl_integrity': accounting.glIntegrity,
  'accounting.posting_role_unmapped': accounting.postingRoleUnmapped,
  'accounting.posting_failed': accounting.postingFailed,
  'accounting.period_close_blocked': accounting.periodCloseBlocked,
  'receivables.overdue_exposure': parties.receivablesOverdueExposure,
  'receivables.ledger_inconsistency': parties.receivablesLedgerInconsistency,
  'payables.overdue_exposure': parties.payablesOverdueExposure,
  'payables.ledger_inconsistency': parties.payablesLedgerInconsistency,
  'payables.supplier_credit_inconsistency': parties.supplierCreditInconsistency,
  'inventory.negative_stock': inventory.negativeStock,
  'inventory.layer_mismatch': inventory.layerMismatch,
  'inventory.document_ledger_mismatch': inventory.documentLedgerMismatch,
  'inventory.gl_difference': inventory.glDifference,
  'inventory.transit_mismatch': inventory.transitMismatch,
  'logistics.container_delayed': logistics.containerDelayed,
  'logistics.shipment_update_stale': logistics.shipmentUpdateStale,
  'logistics.customs_issue': logistics.customsIssue,
  'logistics.landed_cost_blocked': logistics.landedCostBlocked,
  'tasks.overdue': work.tasksOverdue,
  'tasks.blocked': work.tasksBlocked,
  'approvals.waiting_too_long': work.approvalWaiting,
  'platform.system_health': platform.systemHealth,
});
