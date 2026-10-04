import type { ReconciliationStage } from '@/server/services/bank-reconciliation';

/** Which existing status chip each stage of a statement wears. */
export const STAGE_CHIP: Readonly<Record<ReconciliationStage, string>> = {
  statement: 'draft',
  ready: 'submitted',
  reconciling: 'partially_executed',
  reconciled: 'settled',
  cancelled: 'cancelled',
};
