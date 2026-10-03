/**
 * Integration test setup — Phase 00.5.
 *
 * Runs migrations against the test database before the suite, and exposes two
 * pools mirroring production role separation:
 *
 *   ownerPool  erp_owner — owns the schema, BYPASSES RLS.
 *              Used only to arrange fixtures and to prove that FORCE ROW LEVEL
 *              SECURITY closes the owner-bypass hole.
 *
 *   appPool    erp_app  — owns nothing. Every assertion about what the
 *              application can and cannot do runs through this pool.
 *
 * If these tests ran as the owner, every authorisation assertion would pass for
 * the wrong reason. That is the specific trap recorded in TECHSTACK.md B2.
 */
import 'dotenv/config';
import { afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { configurePgTypes } from '../../src/server/db/types';

// The same parsers the application runs with, applied before the pools below
// are created. Without this the raw pools would read a business date as an
// instant and the tests would disagree with production about what day it is.
configurePgTypes();

const ownerUrl = process.env.DATABASE_URL_TEST;

if (!ownerUrl) {
  throw new Error(
    'DATABASE_URL_TEST is not set. Copy .env.example to .env and run `npm run db:up`.',
  );
}

const appUrl = ownerUrl
  .replace('erp_owner', 'erp_app')
  .replace('owner_dev_password', 'app_dev_password');

// Point the application's own client at the test database, as the app role.
// Set before any test imports src/server/db/client.ts, which reads this at
// module load. Without it the service layer under test would connect to the
// development database — the tests would pass and prove nothing about the
// schema they just migrated.
process.env.DATABASE_URL = appUrl;

export const ownerPool = new Pool({ connectionString: ownerUrl, max: 4 });
export const appPool = new Pool({ connectionString: appUrl, max: 8 });

beforeAll(async () => {
  // Fail loudly and early if the database is not up — a confusing connection
  // error inside a test is far harder to diagnose than this.
  try {
    await ownerPool.query('select 1');
  } catch (cause) {
    throw new Error(
      'Cannot reach the test database. Run `npm run db:up` first.\n' +
        `Tried: ${ownerUrl.replace(/:[^:@]*@/, ':***@')}`,
      { cause },
    );
  }

  // Serialised across workers with a session-level advisory lock.
  //
  // `migrate` runs every pending migration in one transaction. Two of them
  // starting together against an *empty* database both try to create the same
  // types and one dies on `pg_type_typname_nsp_index` — a failure that only
  // appears the first time a database is created, which is exactly when it is
  // hardest to recognise. Against an already-migrated database both are no-ops
  // and the race is invisible, so this cannot be left to luck.
  const gate = await ownerPool.connect();
  try {
    await gate.query('select pg_advisory_lock(hashtext($1))', ['erp-test-migrate']);
    await migrate(drizzle(ownerPool), { migrationsFolder: './src/server/db/migrations' });
  } finally {
    await gate.query('select pg_advisory_unlock(hashtext($1))', ['erp-test-migrate']);
    gate.release();
  }
});

afterAll(async () => {
  // Imported dynamically: a static import would load the client before the line
  // above rewrites DATABASE_URL, and the pool would point at the wrong database.
  const { pool } = await import('../../src/server/db/client');
  await Promise.all([ownerPool.end(), appPool.end(), pool.end()]);
});

/**
 * Awaits a promise that must reject, and returns every message in the cause
 * chain joined together.
 *
 * Drizzle wraps a driver error in one of its own ("Failed query: insert into…"),
 * so a plain `.rejects.toThrow(/duplicate key/)` matches the wrapper and misses
 * the constraint that actually fired. Asserting on the chain keeps the test
 * pointed at the database guarantee rather than at the ORM's phrasing.
 */
export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join('\n');
  }
  throw new Error('Expected the operation to be rejected, but it succeeded.');
}

/** Creates a branch, its default warehouse and an independent fixture bank account. */
export async function seedBranch(code: string, name: string): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');

    await client.query(`insert into branch (code, name) values ($1, $2)`, [code, name]);

    await client.query(
      `insert into warehouse (code, name, branch_code, warehouse_type)
       values ($1, $2, $3, 'main')`,
      [`WH-${code}`, `${name} Main Warehouse`, code],
    );

    const { rows: roots } = await client.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const { rows: account } = await client.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1, $2, 'asset', $3, false, true, 'approved', 1, 'IQD') returning id`,
      [`CASH-${code}`, `${name} Cash at Bank`, roots[0].id],
    );

    await client.query(
      `insert into bank_cash_account
         (code, name, account_type, bank_name, account_number, gl_account_id)
       values ($1, $2, 'bank', 'Seed Bank', $3, $4)`,
      [`CASH-${code}`, `${name} Cash Account`, `ACC-${code}`, account[0].id],
    );

    await client.query(`update branch set default_warehouse_code = $1 where code = $2`, [
      `WH-${code}`,
      code,
    ]);

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Returns the database to the state the migrations leave it in.
 *
 * Not a truncate: the migrations seed things the system needs to work at all —
 * the five account roots, the accounting roles, the Chart of Account approval
 * route, the account-code counters. Wiping those would leave later tests
 * testing a system that could never exist in production.
 *
 * So this removes what tests create and leaves what migrations installed.
 * Runs as the owner with `session_replication_role = replica`, so the guards
 * the application lives under are lifted for the length of the reset. Those
 * guards are controls on the *application*, and this is not the application —
 * each of them is asserted in its own test.
 */
export async function resetTestData(): Promise<void> {
  // One connection for the whole reset, and every production guard lifted in
  // a single statement.
  //
  // `session_replication_role = replica` is what a logical-replication apply
  // worker runs as: user triggers and foreign-key triggers do not fire. It
  // replaces thirty-six `ALTER TABLE … DISABLE TRIGGER` pairs, each of which
  // took an ACCESS EXCLUSIVE lock and invalidated cached plans — seventy-two
  // DDL statements before every one of eight hundred tests.
  //
  // It is a *session* setting, so the whole reset runs on one checked-out
  // client rather than on whichever of the pool's four connections comes to
  // hand. And it is restored in the `finally`: a connection returned to the
  // pool still in `replica` would silently disable every guard for whatever
  // ran next, which is the one failure mode worth being careful about.
  const client = await ownerPool.connect();
  try {
    await client.query("set session_replication_role = replica");

    await client.query(`
      truncate audit_event, workflow_decision, workflow_instance restart identity cascade
    `);

    // Journals first: they reference accounts, periods and rate rows, and a
    // posted one is protected from deletion by the triggers §14.4 requires. The
    // The guarantees they carry are asserted elsewhere, and a fixture must not
    // be able to defeat them in production.
    // Three statements, not one block: deleting a line retotals its header, which
    // queues the DEFERRED balance constraint, and PostgreSQL refuses to ALTER a
    // table that has pending trigger events. Each statement commits on its own so
    // the deferred events resolve between them.
    // Attachments and their access log are append-only in production; TRUNCATE
    // does not fire row triggers, which is why it is used here and nowhere else.
    await client.query('truncate attachment_access, attachment restart identity cascade');

    // Notifications reference users and rules; the rules themselves are seeded by
    // a migration and are restored rather than wiped.
    await client.query('truncate notification_delivery, notification restart identity cascade');

    // Operations block 8. Both point at users and invoices that the lines
    // below remove, and the reset runs with foreign keys disabled — so a
    // watcher left behind here would outlive the user it names and break the
    // next test that notifies anybody.
    await client.query('truncate shipment_watcher, supplier_shipment cascade');
    await client.query(`
      update notification_rule
         set active = true,
             channels = case code
               when 'chart_account_awaiting_approval' then ARRAY['in_app']
               when 'journal_rejected'                then ARRAY['in_app']
               else ARRAY['in_app','email'] end
    `);

    // Job runs and outbox rows are append-only in production; TRUNCATE does not
    // fire row triggers, which is why it is used here and nowhere else. Queue
    // policies are seeded by a migration, so they are restored rather than wiped.
    await client.query('truncate job_run, job_outbox restart identity');
    await client.query(`
      update job_queue
         set retry_limit = case name when 'document.expiry_reminder' then 3 else 5 end,
             retry_delay_seconds = case name
               when 'posting.posted' then 30
               when 'notification.deliver' then 60
               else 3600 end,
             retry_backoff = true,
             target_seconds = case name
               when 'posting.posted' then 300
               when 'notification.deliver' then 900
               else 86400 end,
             active = true
    `);

    // The posting log and failure queue reference journals, so they go first.
    // Both are append-only in production — TRUNCATE does not fire row triggers,
    // which is exactly why it is used here and nowhere in the application.
    await client.query('truncate posting_log, posting_failure restart identity');

    // The retotal trigger is off too: with it, deleting a line would requeue the
    // deferred balance check and trip the posted-immutable rule on the way out.
    await client.query(`
    `);
    // Subledger entries point at both, and are append-only in production —
    // TRUNCATE does not fire row triggers, which is why it is used here only.
    await client.query('truncate subledger_entry restart identity');
    // Transfers reference items and the movements they produced, so they go
    // before both. A transfer is a document and is never deleted in production
    // (§1.1) — only cancelled — so this is a test-harness affordance.
    //
    // Goods returns and credit memos before the invoices and receipts they
    // answer to. A shipped return is final in production (blueprint 3.2); the
    // guard is lifted here only.
    // Sales orders before the items, customers and reservations they name. A
  // submitted order's lines are fixed in production (blueprint 7.4) because the
  // reservation and delivery are matched against them.
  // §11.4's stage mapping ships empty and stays empty between tests. It is the
  // one piece of configuration Phase 10 deliberately does not seed — Finance
  // decides which stage credits which clearing role (open question Q10-1) — so a
  // row left behind by one test would let the next one post funding without
  // anybody having made that decision.
  await client.query('delete from logistics_funding_stage_role');

  // Phase 13 — investments. Children first, then the register, then the proposal
  // it rests on. The two catalogues go too: they ship **empty** because §13
  // leaves the categories and valuation methods to Finance (D2), and a type left
  // behind by one test would let the next one record an investment under a
  // category nobody defined — which is the whole thing this phase is built to
  // make impossible.
  await client.query('delete from investment_capital_call');
  await client.query('delete from investment_disposal');
  await client.query('delete from investment_impairment');
  await client.query('delete from investment_valuation');
  await client.query('delete from investment_income');
  await client.query('delete from investment_funding');
  await client.query('delete from investment');
  await client.query('delete from investment_proposal');
  await client.query('delete from investment_valuation_method');
  await client.query('delete from investment_type');

  // Phase 12 — fixed assets. Before the journals recognition and depreciation
  // point at, and before the branches, departments and cost centres they carry.
  await client.query('delete from asset_verification');
  await client.query('delete from asset_impairment');
  await client.query('delete from asset_transfer');
  await client.query('delete from asset_depreciation');
  await client.query('delete from fixed_asset');
  await client.query('delete from asset_category');

  // Phase 11 — projects. Before the journals its costs point at, and before the
  // project dimension row every one of them hangs off. Children first.
  // REQ-PM-001 PM-5 — the plan lines name their certificates; recognition
  // names its journals; the ETC rows their elements; the policy is put back
  // to unratified (D-PM-1) and lets go of the user who ratified it.
  await client.query('delete from project_billing_plan_line');
  await client.query('delete from project_recognition');
  await client.query('delete from project_etc');
  await client.query(`update project_recognition_policy set ratified_by = null, ratified_at = null, ratified_note = null`);
  await client.query('delete from project_balance_movement');
  await client.query('delete from project_certificate');
  await client.query('delete from project_progress');
  // REQ-PM-001 PM-4 — the trend rows are append-only (TRUNCATE skips the
  // row trigger); the activities and their links go with them.
  await client.query('truncate project_milestone_history');
  await client.query('delete from project_activity_dependency');
  await client.query('delete from project_activity');
  // REQ-PM-001 PM-3 — the material issues name their movements and cost rows.
  await client.query('delete from project_material_issue_line');
  await client.query('delete from project_material_issue');
  // REQ-PM-001 PM-6 — the hours name their runs; the cost rows name their settlement.
  await client.query('delete from project_timesheet');
  await client.query('delete from project_timesheet_run');
  await client.query('delete from project_cost');
  await client.query('delete from project_settlement');
  await client.query('delete from project_commitment');
  // REQ-PM-001 PM-2 — the plan, the budget documents and the change orders' lines.
  await client.query('delete from project_plan_line');
  await client.query('delete from project_plan_version');
  await client.query('delete from project_budget_document_line');
  await client.query('delete from project_budget_document');
  await client.query('delete from project_variation_line');
  await client.query('delete from project_variation');
  await client.query('delete from project_budget_line');
  await client.query('delete from project_wbs');
  // REQ-PM-001 — the configuration a test added goes; the seeded rows stay active.
  await client.query('delete from project_type where created_by is not null');
  await client.query('delete from project_tolerance_profile where created_by is not null');
  await client.query('delete from project_cost_code where created_by is not null');
  await client.query('update project_type set active = true where created_by is null');
  await client.query('update project_tolerance_profile set active = true where created_by is null');
  await client.query('update project_cost_code set active = true where created_by is null');

  // Phase 08 — CRM. Before the sales orders an opportunity converted into and
  // before the partners everything here points at. Nothing in this block posts,
  // so nothing here has to go before the journals — it goes before the partners.
  await client.query('delete from crm_activity');
  await client.query('delete from crm_case');
  await client.query('delete from crm_contact');
  await client.query('delete from opportunity_item');
  await client.query('delete from opportunity');
  await client.query('delete from lead');
  await client.query('delete from crm_campaign');
  await client.query('delete from lead_source');

  // Phase 10 — Logistics, before the journals its postings point at and before
  // the partners, branches and departments its jobs reference. Inside-out: a
  // settlement is referenced by the charges it billed, and a job cascades to its
  // legs, charges and evidence.
  //
  // In production none of these is deleted — a billed charge is what the G/L was
  // told (§11.4), a resolved claim is the record of a decision (§5.4), and a
  // master is deactivated rather than removed (§4.4). The session is already in
  // `replica`, so those guards do not fire and there is nothing to disable.
  await client.query('delete from logistics_delivery_evidence');
  await client.query('delete from logistics_claim');
  await client.query('delete from logistics_job_cost');
  await client.query('delete from logistics_client_charge');
  await client.query('delete from logistics_client_funding');
  await client.query('delete from logistics_job_settlement');
  await client.query('delete from logistics_job_leg');
  await client.query('delete from logistics_job');
  // D16 — one register. The reference table survives the merge under its own
  // name; the file itself is deleted with the Phase 09 block below.
  await client.query('delete from client_import_file_reference');
  await client.query('delete from logistics_service_type_evidence');
  await client.query('delete from logistics_service_type');
  await client.query('delete from logistics_route');
  await client.query('delete from logistics_carrier');

  // Phase 09 — Money Transfer. Every one of these references a journal, so they
  // go before the journals do; the order within the block is child-first.
  //
  // In production none of them carries a DELETE grant: a transfer is corrected
  // by reversal and a new transaction (§12.3), a client deposit is a record of
  // money arriving, and a KYC record is the evidence a regulated transfer rested
  // on. The guards are lifted here only, and by the same means as everything
  // else in this function — the session is already in `replica`, so the
  // append-only triggers do not fire and there is nothing to disable by hand.
  await client.query('delete from bank_execution_batch_line');
  await client.query('delete from bank_execution_batch');
  await client.query('delete from money_transfer_expense');
  await client.query('delete from money_transfer_deposit_usage');
  await client.query('delete from money_transfer');
  await client.query('delete from client_goods_delivery');
  await client.query('delete from client_import_payment');
  await client.query('delete from client_import_file');
  await client.query('delete from money_transfer_deposit');
  await client.query('delete from money_transfer_client_account');
  await client.query('delete from client_kyc_document');
  await client.query('delete from client_kyc_record');
  await client.query('delete from kyc_required_document');
  await client.query('delete from kyc_risk_rating');

  // Other receipts before the accounts they arrived in.
  await client.query('delete from other_receipt');

  // Reconciliations before the statements and journals they match together.
  await client.query('delete from bank_reconciliation_match_line');
  await client.query('delete from bank_reconciliation_match');
  await client.query('delete from bank_reconciliation');

  // Bank statements are evidence rather than transactions, so nothing depends
  // on them — but they hold the unique import keys, and a key left behind would
  // make the next test's import look like a duplicate.
  await client.query('delete from bank_statement_rejected_line');
  await client.query('delete from bank_statement_line');
  await client.query('delete from bank_statement');

  // Petty cash advances before the floats they came out of.
  await client.query('delete from cash_advance_settlement');
  await client.query('delete from cash_advance');

  // Treasury documents before the accounts they move money between. The batch
  // and its proposal go before the supplier payments the batch created, and
  // before the invoices those payments settled.
  await client.query('delete from payment_batch_line');
  await client.query('delete from payment_batch');
  await client.query('delete from payment_proposal_item');
  await client.query('delete from payment_proposal');
  await client.query('delete from bank_transfer');
  await client.query('delete from cash_count');

  // Collections and write-offs before the invoices they hang off. The activity
  // log is append-only in production (blueprint 5.4); the guard is lifted here.
  await client.query('delete from collection_activity');
  await client.query('delete from promise_to_pay');
  await client.query('delete from ar_write_off');

  // Credit memos and returns before the invoices they answer to.
  await client.query('delete from customer_credit_memo_line');
  await client.query('delete from customer_credit_memo');
  await client.query('delete from sales_return_line');
  await client.query('delete from sales_return');

  // Receipts and their allocations before the invoices they settle. Both are
  // append-only in production (blueprint 5.4); the guard is lifted here only.
  await client.query('delete from customer_receipt_allocation');
  await client.query('delete from customer_receipt');

  // The warranty register before the invoice lines it hangs off. Append-only in
  // production (blueprint 5.4); the guard is lifted here only.
  await client.query('delete from warranty_registration');

  // A/R invoices before the deliveries they bill.
  await client.query('delete from ar_invoice_line');
  await client.query('delete from ar_invoice');

  // Delivery notes before the pick lists and order lines they answer to, and
  // the proof of delivery before the note it proves. Both are append-only in
  // production (blueprint 5.4); the guard is lifted here only.
  await client.query('delete from proof_of_delivery_photo');
  await client.query('delete from proof_of_delivery');
  await client.query('delete from delivery_note_line_unit');
  await client.query('delete from delivery_note_line');
  await client.query('delete from delivery_note');

  // Pick lists before the order lines they draw down, and their unit selections
  // before the lines those hang off.
  await client.query('delete from pick_list_line_unit');
  await client.query('delete from pick_list_line');
  await client.query('delete from pick_list');

  await client.query('delete from sales_order_line');
  await client.query('delete from sales_order');

  // Supplier payments before the invoices they settle.
  await client.query('delete from supplier_payment_allocation');
  await client.query('delete from supplier_payment');

  await client.query('delete from supplier_credit_memo');
    await client.query(`
      delete from goods_return_line;
      delete from goods_return;
    `);

    // REQ-AP-001 — payables. The log and the hold thread are append-only in
    // production (TRUNCATE does not fire row triggers; the partitioned parent
    // truncates its partitions). Masters are seeded by migration: fixture rows
    // record who created them and are removed; seed rows (created_by NULL) are
    // restored to their seeded active state.
    await client.query('truncate payable_event');
    // Stage 8 (0237) — the sheet import's runs and their sign-off.
    await client.query('delete from payables_migration_run');
    // REQ-LEGACY-001 — the old books' history and the runs that wrote it.
    await client.query('delete from legacy_document');
    await client.query('delete from legacy_import_run');
    // REQ-AP-001 §21.8 — each reading of the ASYCUDA document list (0257).
    await client.query('delete from asycuda_run');
    // REQ-WA-001 — the bridge's log, allow-list and pairing; the seeded
    // settings are restored, the bridge's heartbeat keys go.
    await client.query('truncate whatsapp_message, whatsapp_contact restart identity cascade');
    await client.query('delete from whatsapp_session');
    await client.query(`delete from whatsapp_setting where key like 'bridge_%'`);
    /*
     * Every seeded key, not some of them.
     *
     * This `case` listed the keys 0242 seeded and ended `else value end`, so
     * the group settings added by 0245/0246 kept whatever the last test had
     * written. `wa05-group-and-actions` registers a group, and from then on
     * `group_jid` stayed set in the database for the rest of the run and for
     * every run after it — which posts a group copy of every notification
     * (WA-5), so `wa01-bridge` counted two sends where it expects one and
     * `wa02-intents` answered in a group nobody had registered. Two tests
     * failing for a behaviour that is working exactly as designed, in a file
     * that had not been touched.
     *
     * A key added to `whatsapp_setting` by a migration from here on belongs in
     * this list, and `else value end` is the trap: it reads like a safe
     * default and is how the leak got in.
     *
     * And nobody's name on them: a test's administrator is deleted below, and a
     * dangling `updated_by` fails the IM1 restore on its foreign key.
     */
    await client.query(`
      update whatsapp_setting set updated_by = null, value = case key
        when 'router_model' then 'claude-haiku-4-5-20251001'
        when 'agent_model' then 'claude-opus-5-5'
        when 'inline_rows' then '15'
        when 'export_rows_cap' then '5000'
        when 'throttle_per_minute' then '60'
        when 'retention_days' then '90'
        when 'digest_hour' then '08'
        when 'digest_locale' then 'ar'
        when 'group_jid' then ''
        when 'group_subject' then ''
        when 'group_queries' then 'on'
        when 'group_notifications' then 'on'
        when 'group_digest' then 'on'
        when 'group_only' then 'on'
        else value end`);
    await client.query(`delete from whatsapp_setting where key = 'digest_last_sent_day'`);
    // REQ-HR-001 — people and their dated rows; the seeded masters stay, a
    // test's own masters (created_by set) go.
    // REQ-HR-001 HR-2 — leave, balances and the day sheet hang off the person;
    // the limits go back to their seeds.
    // REQ-HR-001 HR-3 — the runs name their journals; their lines and payments
    // hang off them; a person's own component figures are dated rows like pay.
    // REQ-HR-001 HR-4 — the recoveries name the runs and the advances; the equipment the people.
    await client.query('delete from employee_advance_recovery');
    await client.query('delete from employee_advance');
    await client.query('delete from employee_asset');
    await client.query('delete from payroll_line_component');
    await client.query('delete from payroll_line');
    await client.query('delete from payroll_payment');
    await client.query('delete from payroll_run');
    await client.query('delete from employee_pay_component');
    await client.query('delete from leave_request');
    await client.query('delete from leave_balance_entry');
    await client.query('delete from attendance_day');
    await client.query(`update hr_parameter set updated_by = null, value = case key
        when 'contract_expiry_warning_days' then 30
        when 'leave_pending_reminder_days' then 3
        when 'leave_lapse_warning_days' then 45
        else value end`);
    await client.query('delete from employee_compensation');
    await client.query('delete from employee_history');
    await client.query('delete from employee');
    await client.query('delete from position');
    // REQ-PM-001 PM-4 — a project may count in a test's calendar.
    await client.query('update project set calendar_code = null where calendar_code is not null');
    await client.query('delete from working_calendar_holiday where calendar_code in (select code from working_calendar where created_by is not null)');
    await client.query('delete from working_calendar where created_by is not null');
    await client.query('delete from leave_type where created_by is not null');
    await client.query('delete from pay_component where created_by is not null');
    // REQ-HR-001 HR-3 — the seeded components back to their seeds: no accounts
    // of their own (a test's accounts go), active, the D-HR-3 rates.
    await client.query(`update pay_component set expense_account_id = null, liability_account_id = null, active = true, taxable = code in ('BASE', 'HOUSING', 'TRANSPORT', 'OVERTIME'),
        default_value = case code when 'SS_EMPLOYEE' then 5 when 'SS_EMPLOYER' then 12 else 0 end`);
    // Stage 6 (0235) — what the loans funded, their schedules, the loans.
    await client.query('delete from bank_loan_allocation');
    await client.query('delete from bank_loan_instalment');
    await client.query('delete from bank_loan');
    await client.query('delete from loan_commission_treatment where created_by is not null');
    await client.query('update loan_commission_treatment set active = true where created_by is null');
    // Stage 3 (0232) — applications and the plan they pay; fixture banks.
    await client.query('delete from payment_application');
    await client.query('delete from payable_instalment');
    // Stage 5 (0234) — B/Ls, containers and their receipts (append-only in
    // production: a receipt is the record of what arrived).
    await client.query('delete from container_receipt_line');
    await client.query('delete from container_receipt');
    await client.query('delete from shipment_container_line');
    await client.query('truncate shipment_container_status_history');
    await client.query('delete from shipment_container');
    await client.query('delete from bill_of_lading');
    await client.query('delete from port where created_by is not null');
    await client.query('delete from container_status where created_by is not null');
    await client.query('update container_status set active = true where created_by is null');
    // Stage 4 (0233) — the PDs and their history (append-only in production).
    await client.query('truncate customs_pd_status_history');
    await client.query('delete from customs_pd');
    await client.query('delete from pd_status where created_by is not null');
    await client.query('update pd_status set active = true where created_by is null');
    await client.query('delete from bank where created_by is not null');
    // Stage 6 (0235) opened `loan`; every seeded source is active again.
    await client.query('update funding_source set active = true where created_by is null');
    await client.query('delete from funding_source where created_by is not null');
    await client.query('delete from instalment_trigger where created_by is not null');
    await client.query('update payment_application_transition set active = true');
    await client.query('truncate recurring_contract_amendment');
    // Stage 7 (0236) — the locks and what they did to each layer (append-
    // only in production); the charges name their lock, so they go between.
    await client.query('delete from landed_cost_layer_adjustment');
    await client.query('delete from landed_cost_charge');
    await client.query('delete from landed_cost_lock');
    await client.query('delete from landed_cost_basis where created_by is not null');
    await client.query('update landed_cost_basis set active = (code not in (\'by_weight\', \'by_volume\')) where created_by is null');
    await client.query('delete from landed_cost_type where created_by is not null');
    // REQ-FIX-001 FX8 (0253) — the exchange differences an import closed on.
    await client.query('delete from payable_exchange_difference');
    await client.query('truncate payable_hold_update');
    await client.query('delete from payable_hold');
    await client.query('delete from payable_order_line');
    await client.query('delete from payable');
    await client.query('delete from recurring_contract');
    await client.query('delete from stage_time_limit where created_by is not null');
    await client.query('delete from payable_stage where created_by is not null');
    await client.query('delete from payable_type_lane where payable_type_code in (select code from payable_type where created_by is not null)');
    await client.query('delete from payable_type where created_by is not null');
    await client.query('delete from hold_reason_code where created_by is not null');
    await client.query('delete from expense_category where created_by is not null');
    await client.query('delete from sweep_check where created_by is not null');
    await client.query('delete from payable_event_code where created_by is not null');
    await client.query('update payable_type set active = true where created_by is null');
    await client.query('update payable_stage set active = true where created_by is null');
    await client.query('update hold_reason_code set active = true where created_by is null');
    await client.query('update sweep_check set active = true where created_by is null');
    await client.query('update stage_time_limit set active = true where created_by is null');

    // Supplier advances before the invoices they settle and the orders they
    // answer to. A settlement is a record in production (Appendix C calls it the
    // settlement history) and carries no DELETE grant; the reset is the only
    // place it is removed.
    await client.query('delete from supplier_advance_settlement');
    await client.query('delete from supplier_advance');

    // A/P invoices before the receipts and orders they match against. A posted
    // invoice is final in production (§3.2) because it moved the supplier ledger
    // and the G/L; the guards are lifted here only. Exceptions carry no DELETE
    // grant in production either — they are resolved, never removed.
    await client.query(`
      delete from ap_match_exception;
      delete from ap_invoice_note;
      delete from ap_invoice_line;
      delete from ap_invoice;
    `);

    // The match tolerance is configuration (§8.4). Supplier rows are fixtures;
    // the company default is seeded by migration 0036 and restored to zero, since
    // a missing default would silently change what the next test is judged
    // against.
    await client.query(`delete from ap_match_tolerance where supplier_id is not null`);
    await client.query(`
      update ap_match_tolerance
         set quantity_percent = 0, price_percent = 0, value_percent = 0, updated_by = null
       where supplier_id is null
    `);

    // Service confirmations before the orders they answer to. An approved
    // confirmation is evidence in production (§8.6) and is withdrawn by reversal
    // rather than deleted; the guards are lifted here only.
    await client.query(`
      delete from service_receipt_line;
      delete from service_receipt;
    `);

    // Goods receipts before the orders they answer to, and before the movements
    // they created. A posted receipt is final in production (§3.2) because stock
    // moved and the ledger recorded it; the guard is lifted here only.
    await client.query(`
      delete from goods_receipt_line;
      delete from goods_receipt;
    `);

    // The receipt tolerance is configuration (§8.4). Item-level rows are test
    // fixtures; the company default is seeded by migration 0033 and is restored
    // to zero rather than deleted, because a missing default would silently
    // change what the next test is judged against.
    await client.query(`delete from purchase_receipt_tolerance where item_code is not null`);
    await client.query(`
      update purchase_receipt_tolerance
         set over_receipt_percent = 0, updated_by = null
       where item_code is null
    `);

    // Purchase orders before the items and partners they reference. A submitted
    // order's lines are fixed in production (§8.3) because the receipt is matched
    // against them; the guard is lifted here only.
    await client.query(`
      delete from purchase_order_line;
      delete from purchase_order;
    `);

    // Stock counts before the items and movements they reference. An adjusted
    // count is final in production (§9.6) because its movements exist; the guard
    // is lifted here only.
    await client.query(`
      delete from stock_count_line;
      delete from stock_count;
    `);

    await client.query('delete from warehouse_transfer_line');
    await client.query('delete from warehouse_transfer');
    // Operations block 7's transfer and reconciliation records (migration
    // 0207). Append-only in production; lifted here only.
    await client.query('delete from stock_transfer');
    await client.query('delete from stock_adjustment');

    // Opening stock likewise: an approved document is immutable in production
    // (§1.1) because its lines are the FIFO layers every margin rests on. The
    // guard is lifted here only.
    await client.query(`
      delete from opening_stock_line;
      delete from opening_stock;
    `);

    // Inventory next: a movement references the journal that posted it, and the
    // ledger is append-only in production (§9.9), so the guards are lifted here
    // only — exactly as they are for the journal and the audit trail.
    await client.query(`
      delete from cost_layer_consumption;
      delete from cost_layer;
      delete from stock_reservation;
      delete from inventory_movement;
    `);

    await client.query('delete from journal_line; delete from journal_entry;');
    await client.query(`
    `);

    // After the journals, because their lines point at the rule that chose each
    // account — that reference is the traceability §24 asks for.
    await client.query('delete from posting_rule');

    // Items and cash accounts point at G/L accounts, so they go before the chart
    // is cleared. Both carry the "deactivate, never delete" trigger §4.4 asks
    // for, lifted here and put straight back.
    await client.query(`
    `);
    // Prices point at items; tax codes and payment methods point at G/L accounts.
    // All three go before the things they reference.
    await client.query('delete from price_list_item');
    await client.query('delete from tax_rate');
    await client.query(`
      delete from tax_code;
    `);
    await client.query('delete from payment_method');

    await client.query('delete from item_uom');
    await client.query('delete from item_supplier');
    await client.query('delete from item');
    await client.query('delete from bank_cash_account');
    await client.query(`
    `);

    await client.query('delete from account_required_dimension');
    // Document-type dimension overrides are configured per test; the §4.2
    // account-type defaults seeded by migration 0005 stay. The one row the
    // migrations seed here is restored, because §4.2 makes Branch mandatory on
    // every operational transaction and a test run must not quietly drop that.
    await client.query('delete from document_type_dimension');
    await client.query(`
      insert into document_type_dimension (document_type_code, dimension, requirement)
      values ('journal_entry', 'branch', 'mandatory'),
             -- Phase 1, migration 0166: Business Line is mandatory on revenue
             -- and expense accounts by §4.2, and its master does not exist
             -- until a later phase. Restored here for the same reason Branch
             -- is — a test run must not quietly differ from production.
             ('journal_entry', 'business_line', 'optional'),
             -- Migration 0201: the invoices ask for no dimension, because
             -- their headers carry none (block 4 and block 5, by direction).
             ('ar_invoice', 'business_line', 'optional'),
             ('ar_invoice', 'department',    'optional'),
             ('ap_invoice', 'business_line', 'optional'),
             ('ap_invoice', 'department',    'optional')
      on conflict do nothing
    `);

    // §4.2's own defaults, restored rather than assumed. A test that alters them
    // would otherwise poison every file that runs after it, and the failure would
    // appear far from its cause.
    /*
     * Master data outlives the reset by design — and a suite that borrows a
     * business line leaves it for whoever runs next, which is how Phase 03's
     * count of §2.2's six names came to fail depending on file order. Twice,
     * from two different files. So the reset states the set rather than
     * trusting each suite to put its own back; migration 0010 seeds these and
     * phase03-master-data asserts them.
     */
    await client.query(`
      delete from business_line
       where code not in ('CONTRACTING','INVESTMENTS','LOGISTICS','MONEY_TRANSFER',
                          'PRODUCT_SALES','PROJECTS')
    `);

    await client.query('delete from account_type_dimension_default');
    await client.query(`
      insert into account_type_dimension_default (account_type, dimension)
      values ('expense', 'department')
    `);
    // Migration 0202: Business Line is never required — of an account type, of
    // an account, or of a document type. Restored *as removed*, because a
    // fixture that puts back a rule production has dropped is a test run
    // proving something nobody will ever see.
    await client.query(
      `delete from account_type_dimension_default where dimension = 'business_line'`,
    );
    await client.query(`delete from account_required_dimension where dimension = 'business_line'`);

    // Accounts are deleted leaves-first: parent_id is RESTRICT, and an approved
    // account is protected by a trigger that production must keep and a test
    // fixture must not be defeated by.
    await client.query(`
      do $$
      begin
        loop
          delete from chart_of_account c
           where not c.is_system
             and not exists (select 1 from chart_of_account d where d.parent_id = c.id);
          exit when not found;
        end loop;
      end $$;
    `);

    // Finance-owned statement lines can be removed once the accounts that
    // referenced either of their two mappings are gone. The system defaults
    // remain as the clean starting layout for every test.
    await client.query('delete from financial_statement_line where not is_system');

    // Keep the allocations that gave the five roots their codes; drop the rest.
    // The append-only trigger refuses this even to the owner — which is the
    // guarantee tests assert elsewhere — so it is lifted for the length of the
    // statement and put straight back.
    await client.query(`
      do $$
      begin
        delete from doc_number_allocation
         where document_no not in (select code from chart_of_account where is_system);
        -- A root re-allocated by a test names that test's user, who is about
        -- to go; with the FK triggers off here the row would be left pointing
        -- at nobody — and a dump of this database would then not restore
        -- (IM1). The seed's own allocations carry no allocator either.
        update doc_number_allocation set allocated_by = null
         where document_no in (select code from chart_of_account where is_system);
      end $$;
    `);

    // Drop the counters tests created, keep the five account-code counters, and
    // wind those back to 1 so the next account of each type is again 000002.
    await client.query(`
      do $$
      declare r record; v_keep text[];
      begin
        select coalesce(array_agg(doc_sequence_name(key, '')), '{}')
          into v_keep
          from doc_sequence where key like 'ACCOUNT_CODE_%';

        for r in select c.relname
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where c.relkind = 'S' and n.nspname = 'public'
                    and c.relname like 'docseq_%'
        loop
          if r.relname = any (v_keep) then
            execute format('select setval(%L, 1, true)', r.relname);
          else
            execute format('drop sequence %I', r.relname);
          end if;
        end loop;
      end $$;
    `);

    // Sequence *definitions* seeded by migrations stay; the year- and
    // branch-scoped counters they spawn were dropped above, so each test file
    // starts its numbering from one.
    await client.query(`
      delete from doc_sequence
       where key not like 'ACCOUNT_CODE_%'
         and key not in (-- A master record's own identity, seeded by
                         -- migrations 0204 and 0205. Like the account codes
                         -- above, these survive the reset.
                         'ITEM_CODE', 'BANK_ACCOUNT_CODE', 'CASH_ACCOUNT_CODE',
                         -- Operations block 7's reconciliation, migration 0207.
                         'STOCK_ADJUSTMENT',
                         -- Customer, supplier, warehouse and payment term
                         -- codes, migration 0208.
                         'CUSTOMER_CODE', 'SUPPLIER_CODE', 'WAREHOUSE_CODE', 'PAYMENT_TERM_CODE',
                         'DEPARTMENT_CODE', 'COST_CENTRE_CODE', 'PAYMENT_METHOD_CODE',
                         -- Phase 00, seeded by migration 0160.
                         'INVOICE',
                         'JOURNAL_ENTRY', 'WAREHOUSE_TRANSFER', 'OPENING_STOCK', 'STOCK_COUNT',
                         'PURCHASE_ORDER', 'GOODS_RECEIPT', 'SERVICE_RECEIPT', 'AP_INVOICE',
                         'SUPPLIER_ADVANCE',
                         -- REQ-AP-001 Stage 1, migration 0225 — one per payable type.
                         'PAYABLE_IMPORT', 'PAYABLE_SERVICE', 'PAYABLE_RECURRING',
                         'PAYABLE_LOCAL_GOODS', 'PAYABLE_ADVANCE', 'RECURRING_CONTRACT',
                         -- REQ-AP-001 Stage 3, migration 0232.
                         'PAYMENT_APPLICATION', 'BANK_CODE',
                         -- REQ-AP-001 Stage 5, migration 0234.
                         'CONTAINER_RECEIPT', 'PORT_CODE',
                         -- REQ-AP-001 Stage 6, migration 0235.
                         'LOAN',
                         -- REQ-HR-001 Stage HR-1, migration 0241.
                         'EMPLOYEE', 'POSITION_CODE', 'LEAVE_REQUEST', 'PAYROLL_RUN', 'PAYSLIP', 'EMPLOYEE_ADVANCE', 'PROJECT', 'PROJECT_BUDGET', 'PROJECT_VARIATION', 'PROJECT_ISSUE', 'PROJECT_SETTLEMENT',
                         'GOODS_RETURN', 'SUPPLIER_CREDIT_MEMO',
                         'SUPPLIER_PAYMENT', 'SALES_ORDER', 'PICK_LIST', 'DELIVERY_NOTE',
                         'AR_INVOICE', 'CUSTOMER_RECEIPT',
                         'SALES_RETURN', 'CUSTOMER_CREDIT_MEMO', 'AR_WRITE_OFF', 'CASH_COUNT', 'BANK_TRANSFER',
                         'PAYMENT_PROPOSAL', 'PAYMENT_BATCH', 'BANK_STATEMENT', 'CASH_ADVANCE', 'BANK_RECONCILIATION', 'OTHER_RECEIPT',
                         -- Phase 09, seeded by migrations 0120-0125.
                         'MT_CLIENT_ACCOUNT', 'MT_CLIENT_DEPOSIT', 'MONEY_TRANSFER', 'MT_EXPENSE',
                         'CLIENT_IMPORT_FILE', 'CLIENT_IMPORT_PAYMENT', 'CLIENT_GOODS_DELIVERY',
                         'BANK_EXECUTION_BATCH',
                         -- Phase 10, seeded by migrations 0140-0146.
                         'LOGISTICS_JOB', 'LOGISTICS_CLIENT_FUNDING',
                         'LOGISTICS_JOB_COST', 'LOGISTICS_JOB_SETTLEMENT', 'LOGISTICS_CLAIM',
                         -- Phase 08, seeded by migration 0147.
                         'LEAD', 'OPPORTUNITY', 'CRM_CASE',
                         -- Phase 11, seeded by migration 0148.
                         'PROJECT_CERTIFICATE', 'PROJECT_VARIATION',
                         -- Phase 12, seeded by migration 0149.
                         'FIXED_ASSET',
                         -- Phase 13, seeded by migration 0157.
                         'INVESTMENT_PROPOSAL', 'INVESTMENT', 'INVESTMENT_FUNDING',
                         'INVESTMENT_INCOME', 'INVESTMENT_DISPOSAL')
    `);

    // §17's high-risk threshold is configuration a migration seeded, and a test
    // that raises it must not leave it raised for the next one — the whole
    // point of the zero default is that it applies unless somebody decided
    // otherwise (D13).
    await client.query(`delete from payment_risk_policy where branch_code is not null`);
    await client.query(
      `update payment_risk_policy set high_risk_threshold_iqd = 0 where branch_code is null`,
    );

    // The fiscal calendar is created per test. TRUNCATE rather than DELETE on the
    // override log: it is append-only, and TRUNCATE does not fire row triggers.
    await client.query('truncate period_override restart identity');
    await client.query('delete from fiscal_period');
    await client.query('delete from fiscal_year');

    // Rates likewise, keeping the two currencies and the IQD identity rate that
    // migration 0004 seeds — §1.1 does not make those optional.
    await client.query(`
      do $$
      begin
        -- Only the self-reference is cleared, so the rows can be deleted in any
        -- order. Clearing superseded_at too would make two rates live for the
        -- same currency and date, which the partial unique index rightly refuses.
        update exchange_rate set superseded_by = null where superseded_by is not null;
        delete from exchange_rate
         where not (currency_code = 'IQD' and effective_from = date '1900-01-01');
      end $$;
    `);
    await client.query(`delete from currency where code not in ('IQD', 'USD')`);

    // Phase 03 masters. Business partners and warehouses carry a "deactivate,
    // never delete" trigger — the guarantee §4.4 asks for, lifted here only.
    await client.query(`
    `);
    await client.query('delete from project');
    await client.query('delete from partner_bank_account');
    await client.query('delete from business_partner');
    // Import batches reference the users who ran them, and a committed batch is
    // protected from deletion — the guarantee §26 asks for, lifted here only.
    await client.query(`
      delete from import_row;
      delete from import_batch;
    `);

    await client.query('delete from partner_role_required_field');
    // After the partners, which point at a price list and payment terms.
    await client.query(`
      delete from price_list;
    `);
    await client.query('delete from payment_term_instalment');
    await client.query('delete from payment_terms');
    // Organisation records are deactivated, never deleted, in production (§1.1) —
    // the guard is lifted here only, exactly as it is for the other masters.
    await client.query(`
      delete from cost_centre;
    `);
    await client.query('delete from bin');
    // Branch points at its default warehouse and the warehouse points back.
    await client.query('update branch set default_warehouse_code = null, manager_user_id = null');
    await client.query('delete from warehouse');
    await client.query('delete from company');
    await client.query(`
    `);
    await client.query('update department set parent_code = null, manager_user_id = null');

    // Sessions and credentials cascade from the user, but a revoked session is
    // protected from reinstatement by a trigger that also guards the token — off
    // for the delete, back on after.
    await client.query('delete from sign_in_attempt');
    await client.query('delete from auth_session');
    await client.query('delete from auth_account');
    await client.query('delete from auth_verification');
    await client.query('delete from user_mfa');
    await client.query(`update role set requires_mfa = false`);

    // A saved view belongs to a user but does not cascade from one: deleting an
    // account should not silently discard a view other people are sharing, so the
    // reference is restricting and the view is cleared here first.
    await client.query('delete from saved_view');

    // A user's roles and scopes, explicitly.
    //
    // These used to be left to `ON DELETE CASCADE`, and under
    // `session_replication_role = replica` the cascade does not fire — the
    // foreign-key actions are triggers too. The rows survived as orphans, a
    // later test loaded a principal from them, and the notification it raised
    // named a user who no longer existed.
    //
    // Explicit is better here regardless: a reset that relies on a cascade
    // hides what it removes, and the next person to add a child table has no
    // reason to notice.
    // Phase 00 — the invoice is the document the foundation is demonstrated
    // on. It names a branch and a department, so it goes before both. It is
    // never deleted in production (a reject-delete trigger sees to that);
    // this is a test-harness affordance, run with the guards lifted.
    await client.query('delete from invoice_line');
    await client.query('delete from invoice');

    await client.query('delete from user_role');
    await client.query('delete from user_branch_scope');
    await client.query('delete from user_department_scope');

    // Roles seeded by a migration stay, with their grants; a test's role goes
    // with its grants, or the grants would outlive it (the FK triggers are off).
    await client.query('delete from app_user');
    await client.query('delete from role_grant g where not exists (select 1 from role r where r.code = g.role_code and r.is_system)');
    await client.query('delete from role where not is_system');
    await client.query(`
      delete from branch;
      delete from department;
    `);

  } finally {
    await client.query("set session_replication_role = origin");
    client.release();
  }
}

/**
 * Runs `fn` in a transaction on the app pool with the RLS scope set. Mirrors
 * `withScope` in src/server/db/client.ts.
 *
 * Rolls back by default, so a test that only reads or only probes a rejection
 * cannot contaminate the next one. Pass `{ commit: true }` when the rows are a
 * fixture a later statement must actually see — an append-only trigger fires
 * per row, so an UPDATE against rows that were rolled back matches nothing and
 * the assertion passes for the wrong reason. `beforeEach` truncates, which is
 * what keeps committed fixtures from leaking between tests.
 */
export async function asApp<T>(
  scope: { userId: string; branchCode: string; isSuperUser?: boolean },
  fn: (query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>,
  { commit = false }: { commit?: boolean } = {},
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.user_id', scope.userId]);
    await client.query('select set_config($1, $2, true)', ['app.branch_code', scope.branchCode]);
    await client.query('select set_config($1, $2, true)', [
      'app.is_super_user',
      scope.isSuperUser ? 'true' : 'false',
    ]);
    const result = await fn((text, values) => client.query(text, values as any[]));
    await client.query(commit ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
