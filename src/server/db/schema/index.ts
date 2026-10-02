/**
 * Drizzle schema barrel.
 *
 * Tables are declared in TypeScript and `npm run db:generate` produces the
 * migration. Constraint SQL that Drizzle cannot express — append-only triggers,
 * RLS policies, REVOKEs, numbering functions — is appended to the generated
 * file by hand and reviewed as part of the release record required by
 * blueprint §25.
 *
 * The Phase 00 validation spike (migrations/0000_phase00_spike.sql) is
 * hand-authored SQL and is not represented here; it is dropped in Phase 02,
 * once the real money and posting tables have taken over what it proves.
 *
 * Ordering follows the phase plan:
 *   Phase 01  users, roles, permissions, audit, sequences, statuses, workflow
 *   Phase 02  chart of accounts, periods, currencies, dimensions, journals
 *   Phase 03  organisation, business partners, items, warehouses, banks
 *   …
 */

export * from './platform';
export * from './workflow';
export * from './invoice';
export * from './invoice-line';
export * from './accounting';
export * from './fiscal';
export * from './dimensions';
export * from './journal';
export * from './posting';
export * from './subledger';
export * from './organisation';
export * from './item';
export * from './pricing';
export * from './import';
export * from './auth';
export * from './jobs';
export * from './notifications';
export * from './attachments';
export * from './ui';
export * from './inventory';
export * from './transfer';
export * from './opening-stock';
export * from './statement-mapping';
export * from './stock-count';
export * from './purchase-order';
export * from './goods-receipt';
export * from './service-receipt';
export * from './ap-invoice';
export * from './supplier-advance';
export * from './goods-return';
export * from './supplier-payment';
export * from './sales-order';
export * from './pick-list';
export * from './delivery-note';
export * from './ar-invoice';
export * from './warranty';
export * from './customer-receipt';
export * from './sales-return';
export * from './ar-collections';
export * from './treasury';
export * from './payment-run';
export * from './bank-statement';
export * from './cash-advance';
export * from './bank-reconciliation';
export * from './other-receipt';
export * from './money-transfer-client';
export * from './client-import';
export * from './money-transfer';
export * from './bank-execution-batch';
export * from './logistics';
export * from './crm';
export * from './projects';
export * from './fixed-assets';
export * from './investments';
export * from './stock-operations';
export * from './payables';
export * from './payables-contracts';
export * from './payments';
export * from './customs';
export * from './shipments';
export * from './loans';
export * from './landed-cost';
export * from './legacy';
export * from './hr';
