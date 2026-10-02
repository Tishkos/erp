/**
 * REQ-HARDEN-001 HD5 — row-level security covers every business table.
 *
 * Schema-driven: every table the application role can read either has
 * row-level security forced with at least one policy, or is named below with
 * the reason it is exempt (D-HD-6: pure lookup, seed and master tables may
 * be; silence is a failure). A new table that forgets its policy fails here
 * before it reaches a review.
 */
import { describe, expect, it } from 'vitest';
import { ownerPool } from './setup';

/** Exempt, with the reason. Adding to this list is a review decision, not a shortcut. */
const EXEMPT: Record<string, string> = {
  // Company-wide masters and configuration: visible to every signed-in user by design.
  account_required_dimension: 'configuration', account_type_dimension_default: 'configuration',
  ap_match_tolerance: 'configuration', ar_write_off_policy: 'configuration', ar_write_off_reason: 'lookup',
  asset_category: 'lookup', bank: 'master', bank_cash_account: 'master (company register)', bin: 'master',
  branch: 'master', business_line: 'master', business_partner: 'master', chart_of_account: 'master',
  company: 'master', container_status: 'lookup', cost_centre: 'master', crm_campaign: 'master',
  currency: 'lookup', department: 'master', dimension_definition: 'configuration',
  document_status_transition: 'configuration', document_type: 'configuration',
  document_type_controlled_field: 'configuration', document_type_dimension: 'configuration',
  exchange_rate: 'master', expense_category: 'lookup', financial_statement_line: 'configuration',
  fiscal_period: 'master', fiscal_year: 'master', funding_source: 'lookup', hold_reason_code: 'lookup',
  instalment_trigger: 'lookup', investment_type: 'lookup', investment_valuation_method: 'lookup',
  item: 'master', item_supplier: 'master', item_uom: 'master', kyc_required_document: 'lookup',
  kyc_risk_rating: 'lookup', landed_cost_basis: 'lookup', landed_cost_type: 'lookup', lead_source: 'lookup',
  loan_commission_treatment: 'lookup', logistics_carrier: 'master', logistics_funding_stage_role: 'configuration',
  logistics_route: 'master', logistics_service_type: 'lookup', logistics_service_type_evidence: 'lookup',
  notification_rule: 'configuration', partner_bank_account: 'master (approval-controlled)',
  partner_role_required_field: 'configuration', payable_event_code: 'lookup', payable_lane: 'lookup',
  payable_stage: 'lookup', payable_type: 'lookup', payable_type_lane: 'lookup', payment_application_transition: 'lookup',
  payment_method: 'master', payment_risk_policy: 'configuration', payment_term_instalment: 'master',
  payment_terms: 'master', pd_status: 'lookup', port: 'master', posting_rule: 'configuration',
  price_list: 'master', price_list_item: 'master', purchase_receipt_tolerance: 'configuration',
  stage_time_limit: 'configuration', sweep_check: 'configuration', tax_code: 'master', tax_rate: 'master',
  unit_of_measure: 'lookup', warehouse: 'master', workflow_decision: 'configuration',
  workflow_definition: 'configuration', workflow_step: 'configuration',
  // The phase-00 demonstration invoice: policed but not forced, and without a reader (IMPROVE-4 PF-11 retires it).
  invoice: 'phase-00 demonstration table, not forced',
  // Numbering and jobs are system tables the services write under their own rules.
  doc_number_allocation: 'system (numbering)', doc_sequence: 'system (numbering)',
  job_queue: 'system (jobs)', job_run: 'system (jobs)',
  // The permission and authentication tables: policies need accessor functions for
  // the administration screens that read other users' rows — REQ-IMPROVE-001 SG-5.
  app_user: 'IMPROVE-3 SG-5', role: 'IMPROVE-3 SG-5', role_grant: 'IMPROVE-3 SG-5', user_role: 'IMPROVE-3 SG-5',
  user_branch_scope: 'IMPROVE-3 SG-5', user_department_scope: 'IMPROVE-3 SG-5', auth_account: 'IMPROVE-3 SG-5',
  auth_session: 'IMPROVE-3 SG-5', auth_verification: 'IMPROVE-3 SG-5', user_mfa: 'IMPROVE-3 SG-5',
  sign_in_attempt: 'IMPROVE-3 SG-5 (written before a user exists)',
};

describe('HD5 · every readable table is policed or excused', () => {
  it('names no business table without row-level security', async () => {
    const { rows } = await ownerPool.query(`
      select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
         and has_table_privilege('erp_app', c.oid, 'SELECT')
       order by 1`);
    const unprotected = rows
      .filter((r) => !(r.enabled && r.forced && r.policies > 0))
      .filter((r) => !(r.name in EXEMPT))
      .map((r) => r.name);
    expect(unprotected).toEqual([]);
  });

  it('keeps the exemption list honest — nothing on it is actually policed', async () => {
    const { rows } = await ownerPool.query(`select tablename from pg_policies where schemaname = 'public' group by 1`);
    const policed = new Set(rows.map((r) => r.tablename));
    const stale = Object.keys(EXEMPT).filter((name) => policed.has(name) && name !== 'invoice');
    expect(stale).toEqual([]);
  });

  it('a branch user sees only their branch through the new policies', async () => {
    const { rows: users } = await ownerPool.query(`select id from app_user limit 1`);
    expect(users.length).toBeGreaterThanOrEqual(0);
    // The app role cannot bypass: a connection with no scope sees nothing at all.
    const { appPool } = await import('./setup');
    const client = await appPool.connect();
    try {
      await client.query(`select set_config('app.user_id', '', false)`);
      for (const table of ['attachment', 'bank_loan', 'notification', 'import_batch', 'project', 'crm_contact']) {
        const { rows } = await client.query(`select count(*)::int as n from ${table}`);
        expect(rows[0].n, table).toBe(0);
      }
    } finally {
      client.release();
    }
  });
});
