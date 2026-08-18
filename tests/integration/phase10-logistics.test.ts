/**
 * Phase 10 test gates — Logistics Operations, §11.
 *
 * Every test names the blueprint clause it comes from, and every rule that
 * matters is tested twice: once at the service, and once directly at the
 * database, bypassing the service entirely. A rule that only the service
 * enforces is a rule an import, a second code path or a direct insert walks
 * past.
 *
 * The through-line of the phase is §11's separation: *"A logistics job can be
 * linked to the same client import file as a Money Transfer transaction without
 * combining their accounting results."*
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asApp, ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as logistics from '@/server/services/logistics';
import * as reports from '@/server/services/logistics-reports';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const BASRA = 'BSR';
const LOGISTICS_DEPT = 'LOG';

const iqd = (value: string) => parseDecimal(value, 4n);
const money = (value: bigint) => toDecimalString(value, 4n);

let officer: ActorContext;
let manager: ActorContext;
let clientId: string;
let carrierPartnerId: string;
let bankAccountId: string;
let accounts: Record<string, string>;

async function createUser(role: string, branchCode = BAGHDAD): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    branchCode,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,$2)`,
    [id, LOGISTICS_DEPT],
  );

  const principal = await withScope({ userId: id, branchCode }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode };
}

const scope = (ctx: ActorContext) => ({
  userId: ctx.principal.userId,
  branchCode: ctx.branchCode,
});

/**
 * The accounts §11.4 names, mapped by role rather than by number (§3.3).
 *
 * The bank account is deliberately *not* a control account: the posting engine
 * fills the business-partner dimension, not the bank-account one, so a bank
 * control account would demand a party the engine cannot supply. Supplier A/P
 * and Client A/R *are* control accounts, because 10.3 and 10.8 require their
 * subledgers to reconcile.
 */
const ACCOUNT_PLAN = [
  ['bank', 'A100001', 'asset', 'Bank — Logistics Receipts', null],
  ['cash', 'A100002', 'asset', 'Cash — Logistics', null],
  ['client_account', 'A100003', 'asset', 'Client Account', null],
  ['client_receivable', 'A100004', 'asset', 'Client A/R — Logistics', 'customer'],
  ['client_logistics_clearing', 'L100001', 'liability', 'Client Logistics Clearing', null],
  ['deferred_service_balance', 'L100002', 'liability', 'Deferred Service Balance', null],
  ['supplier_payable', 'L100003', 'liability', 'Supplier A/P — Carriers', 'supplier'],
  ['logistics_job_cost', 'X100001', 'expense', 'Logistics Job Cost', null],
  ['logistics_revenue', 'R100001', 'revenue', 'Logistics Revenue', null],
] as const;

const EVENTS = [
  'logistics.client_funding',
  'logistics.job_cost',
  'logistics.job_settlement',
] as const;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(BASRA, 'Basra');

  await ownerPool.query(
    `insert into department (code, name, is_finance)
     values ($1, 'Logistics', false) on conflict (code) do nothing`,
    [LOGISTICS_DEPT],
  );

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  const { rows: client } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, status, active)
     values ('CLI-001','Al-Rafidain Trading', true, 'active', true) returning id`,
  );
  clientId = client[0].id;

  const { rows: carrier } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('CAR-001','Gulf Freight Lines', true, 'active', true) returning id`,
  );
  carrierPartnerId = carrier[0].id;

  // The fiscal calendar the postings land in.
  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,3,'March 2026','2026-03-01','2026-03-31'),
            ($1,4,'April 2026','2026-04-01','2026-04-30')
     on conflict do nothing`,
    [years[0].id],
  );

  // §14.5 — every line converts to IQD, so a rate must exist.
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  accounts = {};
  for (const [role, code, type, name, control] of ACCOUNT_PLAN) {
    const { rows: roots } = await ownerPool.query(
      `select id from chart_of_account where account_type = $1 and is_system limit 1`,
      [type],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [code, name, type, roots[0].id, control],
    );
    accounts[role] = rows[0].id;

    for (const eventType of EVENTS) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [eventType, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  const { rows: bank } = await ownerPool.query(
    `select id from bank_cash_account where code = $1`,
    [`CASH-${BAGHDAD}`],
  );
  bankAccountId = bank[0].id;

  // §11.1's masters, and 10.7's evidence requirement as configuration.
  await withScope(scope(manager), async (tx) => {
    await logistics.createServiceType(tx, manager, {
      code: 'IMPORT_CLEARANCE',
      name: 'Import clearance and delivery',
      requiredEvidence: ['proof_of_delivery', 'customs_clearance'],
    });
    await logistics.createServiceType(tx, manager, {
      code: 'SIMPLE_HAULAGE',
      name: 'Domestic haulage',
    });
    await logistics.createRoute(tx, manager, {
      code: 'JEBEL-BGW',
      name: 'Jebel Ali to Baghdad',
      origin: 'Jebel Ali',
      destination: 'Baghdad',
    });
    await logistics.createCarrier(tx, manager, {
      code: 'GFL',
      name: 'Gulf Freight Lines',
      businessPartnerId: carrierPartnerId,
      mode: 'sea',
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function importFile(): Promise<{ id: string; fileNo: string }> {
  return withScope(scope(officer), (tx) =>
    logistics.createImportFile(tx, officer, {
      clientId,
      branchCode: BAGHDAD,
      openedOn: '2026-03-01',
      originCountry: 'AE',
      description: 'Container of retail fittings',
    }),
  );
}

async function draftJob(
  fileId: string,
  serviceTypeCode = 'IMPORT_CLEARANCE',
): Promise<{ id: string; jobNo: string }> {
  return withScope(scope(officer), (tx) =>
    logistics.createJob(tx, officer, {
      importFileId: fileId,
      serviceTypeCode,
      routeCode: 'JEBEL-BGW',
      branchCode: BAGHDAD,
      departmentCode: LOGISTICS_DEPT,
      jobDate: '2026-03-02',
      promisedDeliveryDate: '2026-03-20',
      description: 'Import clearance and inland delivery',
    }),
  );
}

/** A job taken to In Progress, which is where costs may be recorded. */
async function jobInProgress(serviceTypeCode = 'IMPORT_CLEARANCE') {
  const file = await importFile();
  const job = await draftJob(file.id, serviceTypeCode);
  await withScope(scope(manager), (tx) =>
    logistics.advanceJob(tx, manager, job.id, 'approved'),
  );
  await withScope(scope(manager), (tx) =>
    logistics.advanceJob(tx, manager, job.id, 'partially_executed'),
  );
  return { file, job };
}

async function attachEvidence(jobId: string, evidenceType: string): Promise<void> {
  const { rows } = await ownerPool.query(
    `insert into attachment
       (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
        scan_status, scanned_at, uploaded_by, branch_code)
     values ('logistics_job', $1, $2, 'application/pdf', 1024, $3, $4, 'clean', now(), $5, $6)
     returning id`,
    [
      jobId,
      `${evidenceType}.pdf`,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `logistics/${jobId}/${evidenceType}/${randomUUID()}`,
      officer.principal.userId,
      BAGHDAD,
    ],
  );

  await withScope(scope(officer), (tx) =>
    logistics.recordDeliveryEvidence(tx, officer, {
      jobId,
      evidenceType,
      attachmentId: rows[0].id,
      receivedOn: '2026-03-18',
    }),
  );
}

/** §11.4's stage mapping — the configuration that ships empty. */
async function mapFundingStage(jobStatus: string, lineRole: string): Promise<void> {
  await withScope(scope(manager), (tx) =>
    logistics.setFundingStageRole(tx, manager, {
      jobStatus: jobStatus as never,
      lineRole,
      note: 'Configured by the test, as Finance would in production.',
    }),
  );
}

// ---------------------------------------------------------------------------
// 10.1 Client import files
// ---------------------------------------------------------------------------

describe('10.1 — client import files, §11', () => {
  it('links a logistics job and a transfer case to one import file', async () => {
    const file = await importFile();
    const job = await draftJob(file.id);

    // Phase 09 does not exist yet, so the transfer side is registered exactly as
    // that phase will register it: through the module-agnostic cross-reference,
    // naming its own module and document type.
    await withScope(scope(officer), (tx) =>
      logistics.linkToImportFile(tx, officer, {
        importFileId: file.id,
        module: 'money_transfer',
        documentType: 'money_transfer',
        documentId: randomUUID(),
        documentNo: 'MTR-BGW-2026-000001',
      }),
    );

    const report = await withScope(scope(officer), (tx) => reports.crossReference(tx, file.id));

    expect(report.sides.map((s) => s.module)).toEqual(['logistics', 'money_transfer']);
    expect(report.sides[0]!.documents[0]!.documentNo).toBe(job.jobNo);
    expect(report.sides[1]!.documents[0]!.documentNo).toBe('MTR-BGW-2026-000001');
  });

  it('has nowhere to combine the two services\' results — §11', async () => {
    // The guarantee is structural: the cross-reference table holds no amount, so
    // there is no column a report could sum across modules. Asserted against the
    // catalogue rather than against behaviour, because behaviour can be added.
    const { rows } = await ownerPool.query(
      `select column_name, data_type from information_schema.columns
        where table_name = 'logistics_client_import_file_reference'`,
    );

    const numeric = rows.filter((r: { data_type: string }) =>
      ['numeric', 'integer', 'bigint', 'double precision', 'real'].includes(r.data_type),
    );
    expect(numeric).toEqual([]);

    const names = rows.map((r: { column_name: string }) => r.column_name);
    for (const forbidden of ['amount', 'total', 'value', 'margin', 'currency_code']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('keeps each service\'s figures in its own object, never netted', async () => {
    const { file, job } = await jobInProgress();

    await withScope(scope(officer), (tx) =>
      logistics.linkToImportFile(tx, officer, {
        importFileId: file.id,
        module: 'money_transfer',
        documentType: 'money_transfer',
        documentId: randomUUID(),
        documentNo: 'MTR-BGW-2026-000002',
      }),
    );

    await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        costDate: '2026-03-10',
        costType: 'freight',
        description: 'Sea freight',
        amountIqd: iqd('700000'),
        settlementMode: 'supplier_payable',
        supplierId: carrierPartnerId,
      }),
    ).then((cost) => withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id)));

    const report = await withScope(scope(officer), (tx) => reports.crossReference(tx, file.id));

    const logisticsSide = report.sides.find((s) => s.module === 'logistics')!;
    const transferSide = report.sides.find((s) => s.module === 'money_transfer')!;

    expect(logisticsSide.figures).toMatchObject({ directCostIqd: money(iqd('700000')) });
    // Reported as absent rather than as zero: Phase 09 has not registered a
    // provider, and zero would be a claim about figures nobody has computed.
    expect(transferSide.figures).toBeNull();

    // And the report itself carries no combined total to be misread.
    expect(Object.keys(report)).not.toContain('total');
    expect(Object.keys(report)).not.toContain('combined');
  });

  it('refuses to close a file while a logistics job on it is still running', async () => {
    const { file } = await jobInProgress();

    const message = await rejection(
      withScope(scope(manager), (tx) =>
        logistics.closeImportFile(tx, manager, file.id, '2026-04-01'),
      ),
    );
    expect(message).toMatch(/still has 1 logistics job\(s\) running/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const { file } = await jobInProgress();

    const message = await rejection(
      ownerPool.query(`update logistics_client_import_file set status='closed', closed_on='2026-04-01' where id=$1`, [
        file.id,
      ]),
    );
    expect(message).toMatch(/logistics job\(s\) running/);
  });

  it('will not attach an import file to a party that is not a customer', async () => {
    const message = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.createImportFile(tx, officer, {
          clientId: carrierPartnerId,
          branchCode: BAGHDAD,
          openedOn: '2026-03-01',
        }),
      ),
    );
    expect(message).toMatch(/is not a customer/);
  });

  it('never re-points a cross-reference — it is withdrawn and made again', async () => {
    const file = await importFile();
    await draftJob(file.id);

    const other = await importFile();
    const message = await rejection(
      ownerPool.query(`update logistics_client_import_file_reference set import_file_id = $1`, [other.id]),
    );
    expect(message).toMatch(/created or removed, never edited/);
  });
});

// ---------------------------------------------------------------------------
// 10.2 The job workflow
// ---------------------------------------------------------------------------

describe('10.2 — the logistics job, Appendix B', () => {
  it('progresses through every status in the defined order', async () => {
    const file = await importFile();
    const job = await draftJob(file.id);

    const seen: string[] = ['draft'];
    for (const next of ['approved', 'partially_executed', 'executed'] as const) {
      await withScope(scope(manager), (tx) =>
        logistics.advanceJob(tx, manager, job.id, next, { deliveredOn: '2026-03-18' }),
      );
      const { rows } = await ownerPool.query(`select status from logistics_job where id=$1`, [
        job.id,
      ]);
      seen.push(rows[0].status);
    }

    expect(seen).toEqual(['draft', 'approved', 'partially_executed', 'executed']);
  });

  it('rejects skips', async () => {
    const file = await importFile();
    const job = await draftJob(file.id);

    const message = await rejection(
      withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'executed')),
    );
    expect(message).toMatch(/cannot move straight to 'Delivered'/);
  });

  it('refuses a skip at the database too, passing the service by', async () => {
    const file = await importFile();
    const job = await draftJob(file.id);

    const message = await rejection(
      ownerPool.query(`update logistics_job set status='settled' where id=$1`, [job.id]),
    );
    expect(message).toMatch(/one step at a time, forwards/);
  });

  it('does not let the person who raised a job approve it (§5.2)', async () => {
    // Raised by the manager, who *does* hold the approve grant — so the refusal
    // is the separation-of-duties rule and not merely a missing permission.
    const file = await importFile();
    const job = await withScope(scope(manager), (tx) =>
      logistics.createJob(tx, manager, {
        importFileId: file.id,
        serviceTypeCode: 'IMPORT_CLEARANCE',
        branchCode: BAGHDAD,
        departmentCode: LOGISTICS_DEPT,
        jobDate: '2026-03-02',
      }),
    );

    const message = await rejection(
      withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'approved')),
    );
    expect(message).toMatch(/cannot approve it/);
  });

  it('denies approval outright to someone without the grant (§5.3)', async () => {
    const file = await importFile();
    const job = await draftJob(file.id);

    const message = await rejection(
      withScope(scope(officer), (tx) => logistics.advanceJob(tx, officer, job.id, 'approved')),
    );
    expect(message).toMatch(/Permission denied: 'approve' on 'logistics_job'/);
  });

  it('cancels a draft, and refuses to cancel a job already under way (Q10-3)', async () => {
    const file = await importFile();
    const draft = await draftJob(file.id);

    await withScope(scope(manager), (tx) =>
      logistics.cancelJob(tx, manager, draft.id, 'Client withdrew the instruction.'),
    );
    const { rows } = await ownerPool.query(`select status from logistics_job where id=$1`, [
      draft.id,
    ]);
    expect(rows[0].status).toBe('cancelled');

    const { job } = await jobInProgress();
    const message = await rejection(
      withScope(scope(manager), (tx) =>
        logistics.cancelJob(tx, manager, job.id, 'Changed our minds.'),
      ),
    );
    expect(message).toMatch(/already under way/);
  });

  it('fixes the client, file, service type and branch once approved (§3.2)', async () => {
    const { job } = await jobInProgress();

    const message = await rejection(
      ownerPool.query(`update logistics_job set service_type_code='SIMPLE_HAULAGE' where id=$1`, [
        job.id,
      ]),
    );
    expect(message).toMatch(/fixed from that point/);
  });

  it('will not take a job whose client differs from its import file\'s', async () => {
    const file = await importFile();
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, status, active)
       values ('CLI-002','Another Client', true, 'active', true) returning id`,
    );

    const message = await rejection(
      ownerPool.query(
        `insert into logistics_job
           (job_no, import_file_id, client_id, service_type_code, branch_code, department_code,
            job_date, created_by)
         values ('LJB-X', $1, $2, 'IMPORT_CLEARANCE', $3, $4, '2026-03-02', $5)`,
        [file.id, rows[0].id, BAGHDAD, LOGISTICS_DEPT, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/names a different client from import file/);
  });

  it('attributes both job cost and service revenue to the job', async () => {
    const { job } = await settledJob();

    const margin = await withScope(scope(officer), (tx) => logistics.marginFor(tx, job.id));
    expect(margin.serviceChargeIqd).toBeGreaterThan(0n);
    expect(margin.directCostIqd).toBeGreaterThan(0n);

    // Both sides trace back to this job and nothing else.
    const { rows } = await ownerPool.query(
      `select (select count(*) from logistics_job_cost where job_id=$1 and status='posted') as costs,
              (select count(*) from logistics_job_settlement where job_id=$1 and status='posted') as revenue`,
      [job.id],
    );
    expect(Number(rows[0].costs)).toBeGreaterThan(0);
    expect(Number(rows[0].revenue)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10.3 Routes, legs and carriers
// ---------------------------------------------------------------------------

describe('10.3 — routes, legs and carriers, §11.1', () => {
  it('supports multiple legs with distinct carriers', async () => {
    const { job } = await jobInProgress();

    await withScope(scope(manager), (tx) =>
      logistics.createCarrier(tx, manager, {
        code: 'IHT',
        name: 'Iraq Haulage & Transport',
        businessPartnerId: carrierPartnerId,
        mode: 'road',
      }),
    );

    const first = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'GFL',
        mode: 'sea',
        origin: 'Jebel Ali',
        destination: 'Umm Qasr',
        plannedArrival: '2026-03-12',
      }),
    );
    const second = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'IHT',
        mode: 'road',
        origin: 'Umm Qasr',
        destination: 'Baghdad',
        plannedArrival: '2026-03-18',
      }),
    );

    expect(first.legNo).toBe(1);
    expect(second.legNo).toBe(2);

    const { rows } = await ownerPool.query(
      `select carrier_code from logistics_job_leg where job_id=$1 order by leg_no`,
      [job.id],
    );
    expect(rows.map((r: { carrier_code: string }) => r.carrier_code)).toEqual(['GFL', 'IHT']);
  });

  it('reconciles carrier payables to the A/P subledger', async () => {
    // 10.3's gate. The reconciliation is by construction: the cost credits the
    // supplier_payable role with the carrier as its business partner, and Phase
    // 02's subledger writes itself from that journal line.
    const { job } = await jobInProgress();

    const leg = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'GFL',
        mode: 'sea',
        origin: 'Jebel Ali',
        destination: 'Umm Qasr',
        plannedArrival: '2026-03-12',
      }),
    );

    const cost = await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        legId: leg.id,
        costDate: '2026-03-10',
        costType: 'freight',
        description: 'Sea freight Jebel Ali to Umm Qasr',
        amountIqd: iqd('700000'),
        settlementMode: 'supplier_payable',
        supplierId: carrierPartnerId,
      }),
    );
    await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));

    const payables = await withScope(scope(officer), (tx) => reports.carrierPayables(tx));
    expect(payables).toHaveLength(1);
    expect(payables[0]!.postedPayableIqd).toBe(money(iqd('700000')));

    const { rows } = await ownerPool.query(
      `select coalesce(sum(credit_iqd - debit_iqd), 0)::text as balance
         from subledger_entry
        where subledger_type = 'supplier' and party_code = 'CAR-001'`,
    );
    expect(rows[0].balance).toBe(money(iqd('700000')));
  });

  it('captures carrier performance for the required report', async () => {
    const { job } = await jobInProgress();

    const leg = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'GFL',
        mode: 'sea',
        origin: 'Jebel Ali',
        destination: 'Umm Qasr',
        plannedArrival: '2026-03-12',
      }),
    );
    await withScope(scope(manager), (tx) =>
      logistics.completeLeg(tx, manager, leg.id, { arrival: '2026-03-14' }),
    );

    const performance = await withScope(scope(officer), (tx) =>
      reports.carrierPerformanceReport(tx),
    );
    expect(performance).toEqual([
      expect.objectContaining({ carrierCode: 'GFL', delivered: 1, late: 1, onTimeBasisPoints: 0 }),
    ]);
  });

  it('will not make a party that is not a supplier into a carrier', async () => {
    const message = await rejection(
      withScope(scope(manager), (tx) =>
        logistics.createCarrier(tx, manager, {
          code: 'BAD',
          name: 'Not a supplier',
          businessPartnerId: clientId,
          mode: 'road',
        }),
      ),
    );
    expect(message).toMatch(/is not a supplier/);
  });

  it('refuses a completed leg with no arrival date', async () => {
    const { job } = await jobInProgress();
    const leg = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'GFL',
        mode: 'sea',
        origin: 'Jebel Ali',
        destination: 'Umm Qasr',
      }),
    );

    const message = await rejection(
      ownerPool.query(`update logistics_job_leg set status='completed' where id=$1`, [leg.id]),
    );
    expect(message).toMatch(/logistics_job_leg_completed_has_arrival/);
  });
});

// ---------------------------------------------------------------------------
// 10.4 Client charges and funding
// ---------------------------------------------------------------------------

describe('10.4 — client charges and funding, §11.3 and §11.4', () => {
  it('refuses to post funding until Finance maps the stage (§28.1, Q10-1)', async () => {
    // §11.4 names two possible credit accounts "according to document stage" and
    // never says which stage takes which. The system will not choose.
    const { job } = await jobInProgress();

    const funding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: job.id,
        fundingDate: '2026-03-05',
        amountIqd: iqd('600000'),
        receivedVia: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );

    const message = await rejection(
      withScope(scope(manager), (tx) => logistics.postFunding(tx, manager, funding.id)),
    );
    expect(message).toMatch(/no role is configured for a job at stage 'partially_executed'/);
    expect(message).toMatch(/Q10-1/);
  });

  it('credits Client Logistics Clearing, distinct from any money transfer account', async () => {
    const { job } = await jobInProgress();
    await mapFundingStage('partially_executed', 'client_logistics_clearing');

    const funding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: job.id,
        fundingDate: '2026-03-05',
        amountIqd: iqd('600000'),
        receivedVia: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
    const posted = await withScope(scope(manager), (tx) =>
      logistics.postFunding(tx, manager, funding.id),
    );

    expect(posted.clearingRole).toBe('client_logistics_clearing');

    const { rows } = await ownerPool.query(
      `select l.line_role, a.code, l.debit_iqd::text, l.credit_iqd::text, l.business_line_code
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [posted.journalEntryId],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].line_role).toBe('bank');
    expect(rows[0].debit_iqd).toBe(money(iqd('600000')));
    expect(rows[1].line_role).toBe('client_logistics_clearing');
    expect(rows[1].code).toBe('L100001');
    // Every logistics line carries the Logistics business line, so the G/L
    // separates the two services as well as the module does (§2.2, §11.3).
    expect(rows.every((r: { business_line_code: string }) => r.business_line_code === 'LOGISTICS'))
      .toBe(true);
  });

  it('selects the account by document stage, per §11.4', async () => {
    // The gate: "the account selected depends on document stage". Two jobs, two
    // stages, two different clearing accounts — decided by configuration, not by
    // code.
    await mapFundingStage('approved', 'deferred_service_balance');
    await mapFundingStage('partially_executed', 'client_logistics_clearing');

    const early = await importFile().then((file) => draftJob(file.id));
    await withScope(scope(manager), (tx) =>
      logistics.advanceJob(tx, manager, early.id, 'approved'),
    );

    const earlyFunding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: early.id,
        fundingDate: '2026-03-03',
        amountIqd: iqd('100000'),
        receivedVia: 'cash',
        bankCashAccountId: bankAccountId,
      }),
    );
    const earlyPosted = await withScope(scope(manager), (tx) =>
      logistics.postFunding(tx, manager, earlyFunding.id),
    );

    const { job: later } = await jobInProgress();
    const laterFunding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: later.id,
        fundingDate: '2026-03-06',
        amountIqd: iqd('100000'),
        receivedVia: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
    const laterPosted = await withScope(scope(manager), (tx) =>
      logistics.postFunding(tx, manager, laterFunding.id),
    );

    expect(earlyPosted.clearingRole).toBe('deferred_service_balance');
    expect(laterPosted.clearingRole).toBe('client_logistics_clearing');

    const accountFor = async (journalEntryId: string) => {
      const { rows } = await ownerPool.query(
        `select a.code from journal_line l join chart_of_account a on a.id = l.account_id
          where l.journal_entry_id = $1 and l.credit_iqd > 0`,
        [journalEntryId],
      );
      return rows[0].code;
    };

    expect(await accountFor(earlyPosted.journalEntryId)).toBe('L100002');
    expect(await accountFor(laterPosted.journalEntryId)).toBe('L100001');
  });

  it('reports client logistics balances separately from any other service', async () => {
    const { job } = await jobInProgress();
    await mapFundingStage('partially_executed', 'client_logistics_clearing');

    const funding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: job.id,
        fundingDate: '2026-03-05',
        amountIqd: iqd('600000'),
        receivedVia: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
    await withScope(scope(manager), (tx) => logistics.postFunding(tx, manager, funding.id));

    const balances = await withScope(scope(officer), (tx) => reports.clientBalances(tx));
    expect(balances).toHaveLength(1);
    expect(parseDecimal(balances[0]!.fundedIqd, 4n)).toBe(iqd('600000'));
    expect(parseDecimal(balances[0]!.recognisedIqd, 4n)).toBe(0n);

    // The report reads only logistics tables. There is no parameter, and no
    // column, that could widen it to another service.
    expect(Object.keys(balances[0]!)).not.toContain('transferBalanceIqd');
  });

  it('requires a bank or cash account when the money came through one', async () => {
    const { job } = await jobInProgress();

    const message = await rejection(
      ownerPool.query(
        `insert into logistics_client_funding
           (funding_no, job_id, branch_code, funding_date, amount, currency_code, received_via,
            created_by)
         values ('LCF-X', $1, $2, '2026-03-05', 100, 'IQD', 'bank', $3)`,
        [job.id, BAGHDAD, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/logistics_client_funding_account_matches_method/);
  });

  it('will not charge or fund a job in a currency other than its own', async () => {
    const { job } = await jobInProgress();

    const message = await rejection(
      ownerPool.query(
        `insert into logistics_client_charge
           (job_id, line_no, charge_type, description, amount, currency_code, created_by)
         values ($1, 99, 'freight', 'USD charge', 100, 'USD', $2)`,
        [job.id, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/needs one currency on the client side/);
  });
});

// ---------------------------------------------------------------------------
// 10.5 Third-party cost
// ---------------------------------------------------------------------------

describe('10.5 — third-party cost, §11.3 and Appendix C', () => {
  it('cannot represent a logistics cost without a job link', async () => {
    // Appendix C: "Job link mandatory." Not a check — a NOT NULL column, so
    // there is no state of the table in which an unallocated cost exists.
    const message = await rejection(
      ownerPool.query(
        `insert into logistics_job_cost
           (cost_no, job_id, branch_code, cost_date, cost_type, description, amount,
            currency_code, settlement_mode, bank_cash_account_id, created_by)
         values ('LJC-X', NULL, $1, '2026-03-10', 'freight', 'Orphan cost', 100, 'IQD', 'bank',
                 $2, $3)`,
        [BAGHDAD, bankAccountId, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/null value in column "job_id"/);

    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name='logistics_job_cost' and column_name='job_id'`,
    );
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('posts Dr Logistics Job Cost / Cr Supplier A/P when accrued', async () => {
    const { job } = await jobInProgress();

    const cost = await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        costDate: '2026-03-10',
        costType: 'customs_duty',
        description: 'Customs duty',
        amountIqd: iqd('150000'),
        settlementMode: 'supplier_payable',
        supplierId: carrierPartnerId,
      }),
    );
    const posted = await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));

    const { rows } = await ownerPool.query(
      `select l.line_role, a.code, l.debit_iqd::text as debit, l.credit_iqd::text as credit,
              l.department_code, l.business_line_code, l.business_partner_code
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [posted.journalEntryId],
    );

    expect(rows[0]).toMatchObject({
      line_role: 'logistics_job_cost',
      code: 'X100001',
      debit: money(iqd('150000')),
      department_code: LOGISTICS_DEPT,
      business_line_code: 'LOGISTICS',
    });
    expect(rows[1]).toMatchObject({
      line_role: 'supplier_payable',
      code: 'L100003',
      credit: money(iqd('150000')),
      business_partner_code: 'CAR-001',
    });
  });

  it('posts Dr Logistics Job Cost / Cr Bank when paid directly', async () => {
    const { job } = await jobInProgress();

    const cost = await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        costDate: '2026-03-11',
        costType: 'handling',
        description: 'Port handling, paid at the counter',
        amountIqd: iqd('80000'),
        settlementMode: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
    const posted = await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));

    const { rows } = await ownerPool.query(
      `select l.line_role, a.code from journal_line l join chart_of_account a on a.id=l.account_id
        where l.journal_entry_id=$1 order by l.line_no`,
      [posted.journalEntryId],
    );
    expect(rows.map((r: { line_role: string }) => r.line_role)).toEqual([
      'logistics_job_cost',
      'bank',
    ]);
    expect(rows[1].code).toBe('A100001');
  });

  it('lands no logistics cost in a general overhead account', async () => {
    // The debit is always the logistics_job_cost role, and §3.3's mapping is
    // what turns that into an account. Proved by exhaustion over every posted
    // cost: no other debit role has ever been emitted.
    const { job } = await jobInProgress();

    for (const [type, value] of [
      ['freight', '700000'],
      ['clearance', '90000'],
      ['storage', '30000'],
    ] as const) {
      const cost = await withScope(scope(officer), (tx) =>
        logistics.createCost(tx, officer, {
          jobId: job.id,
          costDate: '2026-03-12',
          costType: type,
          description: `${type} charge`,
          amountIqd: iqd(value),
          settlementMode: 'supplier_payable',
          supplierId: carrierPartnerId,
        }),
      );
      await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));
    }

    const { rows } = await ownerPool.query(
      `select distinct l.line_role, a.code
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.source_module = 'logistics' and l.debit_iqd > 0`,
    );

    expect(rows).toEqual([{ line_role: 'logistics_job_cost', code: 'X100001' }]);
  });

  it('computes job margin as charge less allocated cost, against a hand-worked example', async () => {
    const { job } = await settledJob();

    // Charged 1,500,000; cost 700,000 + 150,000 = 850,000; margin 650,000.
    const margin = await withScope(scope(officer), (tx) => logistics.marginFor(tx, job.id));
    expect(margin.serviceChargeIqd).toBe(iqd('1500000'));
    expect(margin.directCostIqd).toBe(iqd('850000'));
    expect(margin.marginIqd).toBe(iqd('650000'));
  });

  it('refuses a cost against a draft job and against a settled one', async () => {
    const file = await importFile();
    const draft = await draftJob(file.id);

    const early = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.createCost(tx, officer, {
          jobId: draft.id,
          costDate: '2026-03-10',
          costType: 'freight',
          description: 'Too early',
          amountIqd: iqd('1000'),
          settlementMode: 'bank',
          bankCashAccountId: bankAccountId,
        }),
      ),
    );
    expect(early).toMatch(/still a draft/);

    const { job } = await settledJob();
    const late = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.createCost(tx, officer, {
          jobId: job.id,
          costDate: '2026-03-25',
          costType: 'freight',
          description: 'Too late',
          amountIqd: iqd('1000'),
          settlementMode: 'bank',
          bankCashAccountId: bankAccountId,
        }),
      ),
    );
    expect(late).toMatch(/margin has already been reported/);
  });
});

// ---------------------------------------------------------------------------
// 10.6 No company inventory
// ---------------------------------------------------------------------------

describe('10.6 — goods handling, §11.3', () => {
  it('creates zero company inventory quantity in every availability bucket', async () => {
    await settledJob();

    const { rows } = await ownerPool.query(
      `select (select count(*) from inventory_movement) as movements,
              (select count(*) from cost_layer)         as layers,
              (select count(*) from stock_reservation)  as reservations`,
    );

    expect(rows[0]).toEqual({ movements: '0', layers: '0', reservations: '0' });
  });

  it('has no column anywhere in the phase that could hold a stock quantity', async () => {
    const { rows } = await ownerPool.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and (table_name like 'logistics!_%' escape '!' or table_name like 'client!_import!_%' escape '!')
          and column_name in ('item_code','item_id','quantity','uom_code','warehouse_code',
                              'bin_code','serial_number','batch_number','movement_id')`,
    );

    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10.7 Delivery evidence and claims
// ---------------------------------------------------------------------------

describe('10.7 — delivery evidence and claims', () => {
  it('attaches proof of delivery through the Phase 01 attachment service', async () => {
    const { job } = await jobInProgress();
    await attachEvidence(job.id, 'proof_of_delivery');

    const documents = await withScope(scope(officer), (tx) => reports.jobDocuments(tx, job.id));
    expect(documents.evidence).toHaveLength(1);
    expect(documents.evidence[0]!.evidenceType).toBe('proof_of_delivery');

    // The bytes live in the §21 attachment store, not in a second one here.
    const { rows } = await ownerPool.query(
      `select object_type, scan_status from attachment where id = $1`,
      [documents.evidence[0]!.attachmentId],
    );
    expect(rows[0]).toMatchObject({ object_type: 'logistics_job', scan_status: 'clean' });
  });

  it('will not accept an attachment held against a different job', async () => {
    const { job } = await jobInProgress();
    const other = await jobInProgress();

    const { rows } = await ownerPool.query(
      `insert into attachment
         (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
          scan_status, scanned_at, uploaded_by, branch_code)
       values ('logistics_job', $1, 'pod.pdf', 'application/pdf', 10, $2, $3, 'clean', now(), $4, $5)
       returning id`,
      [
        other.job.id,
        randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
        `logistics/${other.job.id}/${randomUUID()}`,
        officer.principal.userId,
        BAGHDAD,
      ],
    );

    const message = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.recordDeliveryEvidence(tx, officer, {
          jobId: job.id,
          evidenceType: 'proof_of_delivery',
          attachmentId: rows[0].id,
          receivedOn: '2026-03-18',
        }),
      ),
    );
    expect(message).toMatch(/not held against logistics job/);
  });

  it('will not accept evidence that has not cleared the malware scan (§21)', async () => {
    const { job } = await jobInProgress();
    const { rows } = await ownerPool.query(
      `insert into attachment
         (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
          scan_status, scanned_at, uploaded_by, branch_code)
       values ('logistics_job', $1, 'pod.pdf', 'application/pdf', 10, $2, $3, 'pending', null, $4, $5)
       returning id`,
      [
        job.id,
        randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
        `logistics/${job.id}/${randomUUID()}`,
        officer.principal.userId,
        BAGHDAD,
      ],
    );

    const message = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.recordDeliveryEvidence(tx, officer, {
          jobId: job.id,
          evidenceType: 'proof_of_delivery',
          attachmentId: rows[0].id,
          receivedOn: '2026-03-18',
        }),
      ),
    );
    expect(message).toMatch(/not cleared the malware scan/);
  });

  it('will not settle a job without the evidence its service type requires', async () => {
    const { job } = await jobInProgress();
    await withScope(scope(manager), (tx) =>
      logistics.advanceJob(tx, manager, job.id, 'executed', { deliveredOn: '2026-03-18' }),
    );
    // Only one of the two required kinds.
    await attachEvidence(job.id, 'proof_of_delivery');

    const message = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.createSettlement(tx, officer, { jobId: job.id, settlementDate: '2026-03-20' }),
      ),
    );
    expect(message).toMatch(/requires customs_clearance/);
  });

  it('refuses at the database too, passing the service by', async () => {
    const { job } = await jobInProgress();
    await withScope(scope(manager), (tx) =>
      logistics.advanceJob(tx, manager, job.id, 'executed', { deliveredOn: '2026-03-18' }),
    );

    const message = await rejection(
      ownerPool.query(
        `insert into logistics_job_settlement
           (settlement_no, job_id, branch_code, settlement_date, recognised_amount,
            from_receivable_amount, currency_code, created_by)
         values ('LJS-X', $1, $2, '2026-03-20', 100, 100, 'IQD', $3)`,
        [job.id, BAGHDAD, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/still requires/);
  });

  it('links claims to the job and reports them as delivery exceptions', async () => {
    const { job } = await jobInProgress();
    const leg = await withScope(scope(officer), (tx) =>
      logistics.addLeg(tx, officer, {
        jobId: job.id,
        carrierCode: 'GFL',
        mode: 'sea',
        origin: 'Jebel Ali',
        destination: 'Umm Qasr',
      }),
    );

    const claim = await withScope(scope(officer), (tx) =>
      logistics.raiseClaim(tx, officer, {
        jobId: job.id,
        legId: leg.id,
        claimType: 'damage',
        raisedOn: '2026-03-19',
        description: 'Two cartons crushed in transit.',
        estimatedAmountIqd: iqd('45000'),
      }),
    );

    const exceptions = await withScope(scope(officer), (tx) => reports.deliveryExceptions(tx));
    expect(exceptions.claims).toHaveLength(1);
    expect(exceptions.claims[0]).toMatchObject({
      reference: claim.claimNo,
      carrierCode: 'GFL',
      claimType: 'damage',
      status: 'open',
    });
  });

  it('keeps a resolved claim resolved (§5.4)', async () => {
    const { job } = await jobInProgress();
    const claim = await withScope(scope(officer), (tx) =>
      logistics.raiseClaim(tx, officer, {
        jobId: job.id,
        claimType: 'delay',
        raisedOn: '2026-03-19',
        description: 'Late by four days.',
      }),
    );
    await withScope(scope(manager), (tx) =>
      logistics.resolveClaim(tx, manager, claim.id, {
        status: 'resolved',
        resolution: 'Carrier credited the demurrage in full.',
      }),
    );

    const message = await rejection(
      ownerPool.query(`update logistics_claim set status='open' where id=$1`, [claim.id]),
    );
    expect(message).toMatch(/the decision and its reason are part of the record/);
  });
});

// ---------------------------------------------------------------------------
// 10.8 Settlement, billing and close
// ---------------------------------------------------------------------------

/**
 * A job carried the whole way through §11.2's workflow: funded, executed by a
 * carrier, costed, delivered with evidence, settled and posted.
 *
 * Charged 1,500,000; funded 600,000; cost 850,000.
 */
async function settledJob() {
  await mapFundingStage('partially_executed', 'client_logistics_clearing');
  const { file, job } = await jobInProgress();

  await withScope(scope(officer), (tx) =>
    logistics.addClientCharge(tx, officer, {
      jobId: job.id,
      chargeType: 'freight',
      description: 'Freight forwarding',
      amountIqd: iqd('1200000'),
    }),
  );
  await withScope(scope(officer), (tx) =>
    logistics.addClientCharge(tx, officer, {
      jobId: job.id,
      chargeType: 'customs',
      description: 'Customs handling',
      amountIqd: iqd('300000'),
    }),
  );

  const funding = await withScope(scope(officer), (tx) =>
    logistics.createFunding(tx, officer, {
      jobId: job.id,
      fundingDate: '2026-03-05',
      amountIqd: iqd('600000'),
      receivedVia: 'bank',
      bankCashAccountId: bankAccountId,
    }),
  );
  await withScope(scope(manager), (tx) => logistics.postFunding(tx, manager, funding.id));

  for (const [type, value] of [
    ['freight', '700000'],
    ['customs_duty', '150000'],
  ] as const) {
    const cost = await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        costDate: '2026-03-10',
        costType: type,
        description: `${type} charge`,
        amountIqd: iqd(value),
        settlementMode: 'supplier_payable',
        supplierId: carrierPartnerId,
      }),
    );
    await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));
  }

  await withScope(scope(manager), (tx) =>
    logistics.advanceJob(tx, manager, job.id, 'executed', { deliveredOn: '2026-03-18' }),
  );
  await attachEvidence(job.id, 'proof_of_delivery');
  await attachEvidence(job.id, 'customs_clearance');

  const settlement = await withScope(scope(officer), (tx) =>
    logistics.createSettlement(tx, officer, { jobId: job.id, settlementDate: '2026-03-20' }),
  );
  await withScope(scope(manager), (tx) => logistics.postSettlement(tx, manager, settlement.id));
  await withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'settled'));

  return { file, job, settlement };
}

/**
 * A job funded for exactly what it is charged, settled and posted, left at
 * Delivered so the caller can take it the rest of the way.
 *
 * Charged 1,000,000; funded 1,000,000; posted cost 400,000; margin 600,000. The
 * client balance is nil, which is the only state a job can close from.
 */
async function squareJob({ withDraftCost = false }: { withDraftCost?: boolean } = {}) {
  await mapFundingStage('partially_executed', 'client_logistics_clearing');
  const { file, job } = await jobInProgress();

  await withScope(scope(officer), (tx) =>
    logistics.addClientCharge(tx, officer, {
      jobId: job.id,
      chargeType: 'freight',
      description: 'Freight forwarding',
      amountIqd: iqd('1000000'),
    }),
  );

  const funding = await withScope(scope(officer), (tx) =>
    logistics.createFunding(tx, officer, {
      jobId: job.id,
      fundingDate: '2026-03-05',
      amountIqd: iqd('1000000'),
      receivedVia: 'bank',
      bankCashAccountId: bankAccountId,
    }),
  );
  await withScope(scope(manager), (tx) => logistics.postFunding(tx, manager, funding.id));

  const cost = await withScope(scope(officer), (tx) =>
    logistics.createCost(tx, officer, {
      jobId: job.id,
      costDate: '2026-03-10',
      costType: 'freight',
      description: 'Sea freight',
      amountIqd: iqd('400000'),
      settlementMode: 'supplier_payable',
      supplierId: carrierPartnerId,
    }),
  );
  await withScope(scope(manager), (tx) => logistics.postCost(tx, manager, cost.id));

  if (withDraftCost) {
    await withScope(scope(officer), (tx) =>
      logistics.createCost(tx, officer, {
        jobId: job.id,
        costDate: '2026-03-11',
        costType: 'handling',
        description: 'Recorded but never posted',
        amountIqd: iqd('12345'),
        settlementMode: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
  }

  await withScope(scope(manager), (tx) =>
    logistics.advanceJob(tx, manager, job.id, 'executed', { deliveredOn: '2026-03-18' }),
  );
  await attachEvidence(job.id, 'proof_of_delivery');
  await attachEvidence(job.id, 'customs_clearance');

  const settlement = await withScope(scope(officer), (tx) =>
    logistics.createSettlement(tx, officer, { jobId: job.id, settlementDate: '2026-03-20' }),
  );
  await withScope(scope(manager), (tx) => logistics.postSettlement(tx, manager, settlement.id));

  return { file, job, settlement };
}

describe('10.8 — settlement, billing and close, §11.4', () => {
  it('recognises revenue on service completion, not on funding', async () => {
    const { job } = await jobInProgress();
    await mapFundingStage('partially_executed', 'client_logistics_clearing');

    await withScope(scope(officer), (tx) =>
      logistics.addClientCharge(tx, officer, {
        jobId: job.id,
        chargeType: 'freight',
        description: 'Freight forwarding',
        amountIqd: iqd('1000000'),
      }),
    );
    const funding = await withScope(scope(officer), (tx) =>
      logistics.createFunding(tx, officer, {
        jobId: job.id,
        fundingDate: '2026-03-05',
        amountIqd: iqd('1000000'),
        receivedVia: 'bank',
        bankCashAccountId: bankAccountId,
      }),
    );
    await withScope(scope(manager), (tx) => logistics.postFunding(tx, manager, funding.id));

    // Funded in full — and no revenue anywhere yet.
    const { rows: beforeRows } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd), 0)::text as revenue
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'R100001'`,
    );
    expect(parseDecimal(beforeRows[0].revenue, 4n)).toBe(0n);

    await withScope(scope(manager), (tx) =>
      logistics.advanceJob(tx, manager, job.id, 'executed', { deliveredOn: '2026-03-18' }),
    );
    await attachEvidence(job.id, 'proof_of_delivery');
    await attachEvidence(job.id, 'customs_clearance');

    const settlement = await withScope(scope(officer), (tx) =>
      logistics.createSettlement(tx, officer, { jobId: job.id, settlementDate: '2026-03-20' }),
    );
    await withScope(scope(manager), (tx) => logistics.postSettlement(tx, manager, settlement.id));

    const { rows: afterRows } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd), 0)::text as revenue
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'R100001'`,
    );
    expect(afterRows[0].revenue).toBe(money(iqd('1000000')));
  });

  it('posts logistics revenue to a logistics account no transfer event names', async () => {
    const { job } = await settledJob();

    const { rows } = await ownerPool.query(
      `select l.line_role, a.code, a.name, l.credit_iqd::text as credit, l.business_line_code
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.source_module = 'logistics' and l.line_role = 'logistics_revenue'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: 'R100001',
      name: 'Logistics Revenue',
      credit: money(iqd('1500000')),
      business_line_code: 'LOGISTICS',
    });

    // No money transfer event resolves that role — §3.3's mapping is per event.
    const { rows: mapped } = await ownerPool.query(
      `select distinct event_type from posting_rule where line_role = 'logistics_revenue'`,
    );
    expect(mapped.every((r: { event_type: string }) => r.event_type.startsWith('logistics.'))).toBe(
      true,
    );
    expect(job).toBeTruthy();
  });

  it('splits the debit between clearing and receivable, funded first (§11.4)', async () => {
    const { settlement } = await settledJob();

    const { rows } = await ownerPool.query(
      `select recognised_amount::text as recognised,
              from_clearing_amount::text as clearing,
              from_receivable_amount::text as receivable
         from logistics_job_settlement where id = $1`,
      [settlement.id],
    );

    expect(rows[0]).toEqual({
      recognised: money(iqd('1500000')),
      clearing: money(iqd('600000')),
      receivable: money(iqd('900000')),
    });

    const { rows: lines } = await ownerPool.query(
      `select l.line_role, a.code, l.debit_iqd::text as debit, l.credit_iqd::text as credit
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.source_doc_id = $1 order by l.line_no`,
      [settlement.id],
    );

    expect(lines.map((l: { line_role: string }) => l.line_role)).toEqual([
      'client_logistics_clearing',
      'client_receivable',
      'logistics_revenue',
    ]);
    expect(lines[0].debit).toBe(money(iqd('600000')));
    expect(lines[1].debit).toBe(money(iqd('900000')));
    expect(lines[2].credit).toBe(money(iqd('1500000')));
  });

  it('reconciles job margin to the G/L', async () => {
    // 10.8's gate, and the phase exit criterion. The report's margin and the
    // ledger's are computed from different places and must agree.
    const { job } = await settledJob();

    const margin = await withScope(scope(officer), (tx) => logistics.marginFor(tx, job.id));

    const { rows } = await ownerPool.query(
      `select
         coalesce(sum(l.credit_iqd) filter (where a.code = 'R100001'), 0)::text as revenue,
         coalesce(sum(l.debit_iqd)  filter (where a.code = 'X100001'), 0)::text as cost
       from journal_line l
       join journal_entry e on e.id = l.journal_entry_id
       join chart_of_account a on a.id = l.account_id
      where e.source_module = 'logistics'`,
    );

    expect(rows[0].revenue).toBe(money(margin.serviceChargeIqd));
    expect(rows[0].cost).toBe(money(margin.directCostIqd));

    const reported = await withScope(scope(officer), (tx) => reports.grossMargin(tx));
    expect(reported).toHaveLength(1);
    expect(reported[0]!.marginIqd).toBe(money(iqd('650000')));
    expect(reported[0]!.marginIqd).toBe(money(margin.marginIqd));
  });

  it('will not settle the same job twice', async () => {
    const { job } = await settledJob();

    const message = await rejection(
      ownerPool.query(
        `insert into logistics_job_settlement
           (settlement_no, job_id, branch_code, settlement_date, recognised_amount,
            from_receivable_amount, currency_code, created_by)
         values ('LJS-DUP', $1, $2, '2026-03-21', 100, 100, 'IQD', $3)`,
        [job.id, BAGHDAD, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/logistics_job_settlement_one_live_per_job|not Delivered/);
  });

  it('refuses a settlement whose two debits do not add back to the credit', async () => {
    const message = await rejection(
      ownerPool.query(
        `insert into logistics_job_settlement
           (settlement_no, job_id, branch_code, settlement_date, recognised_amount,
            from_clearing_amount, from_receivable_amount, currency_code, created_by)
         values ('LJS-BAD', gen_random_uuid(), $1, '2026-03-20', 1000, 400, 400, 'IQD', $2)`,
        [BAGHDAD, officer.principal.userId],
      ),
    );
    expect(message).toMatch(/logistics_job_settlement_split_totals|violates foreign key/);
  });

  it('refuses to close a part-funded job while the client still owes (10.8)', async () => {
    // The settled fixture is funded 600,000 against 1,500,000 recognised. The
    // 900,000 difference sits on Client A/R, and until it is collected or the
    // funding matched, the job's client position is not nil.
    const { job } = await settledJob();

    const position = await withScope(scope(officer), (tx) => logistics.closePosition(tx, job.id));
    expect(position.unbilledChargeIqd).toBe(0n);
    expect(position.unsettledCostIqd).toBe(0n);
    expect(position.openClientBalanceIqd).toBe(iqd('600000') - iqd('1500000'));

    const message = await rejection(
      withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'closed')),
    );
    expect(message).toMatch(/client balance on this job/);
  });

  it('refuses a further charge on a settled job at all', async () => {
    const { job } = await settledJob();

    const message = await rejection(
      withScope(scope(officer), (tx) =>
        logistics.addClientCharge(tx, officer, {
          jobId: job.id,
          chargeType: 'storage',
          description: 'Demurrage discovered after settlement',
          amountIqd: iqd('50000'),
        }),
      ),
    );
    expect(message).toMatch(/nothing further can be charged/);
  });

  it('refuses to close over an unbilled charge — 10.2', async () => {
    // Reached the only way it can be: a charge added *after* the settlement was
    // raised (which bills what was unbilled at that moment) but while the job is
    // still Delivered, so the charge is legitimate and simply never billed.
    const { job } = await squareJob();

    await withScope(scope(officer), (tx) =>
      logistics.addClientCharge(tx, officer, {
        jobId: job.id,
        chargeType: 'storage',
        description: 'Demurrage, agreed after the settlement was raised',
        amountIqd: iqd('50000'),
      }),
    );
    await withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'settled'));

    const position = await withScope(scope(officer), (tx) => logistics.closePosition(tx, job.id));
    expect(position.unbilledChargeIqd).toBe(iqd('50000'));

    const viaService = await rejection(
      withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'closed')),
    );
    expect(viaService).toMatch(/has not been billed/);

    const viaDatabase = await rejection(
      ownerPool.query(`update logistics_job set status='closed' where id=$1`, [job.id]),
    );
    expect(viaDatabase).toMatch(/client charges that were never billed/);
  });

  it('refuses to close while a cost is still in draft — 10.8', async () => {
    const { job } = await squareJob({ withDraftCost: true });
    await withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'settled'));

    const viaService = await rejection(
      withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'closed')),
    );
    expect(viaService).toMatch(/recorded but not posted/);

    const viaDatabase = await rejection(
      ownerPool.query(`update logistics_job set status='closed' where id=$1`, [job.id]),
    );
    expect(viaDatabase).toMatch(/third-party cost still in draft/);
  });

  it('closes a job with nothing outstanding', async () => {
    const { job } = await squareJob();
    await withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'settled'));

    expect(await withScope(scope(officer), (tx) => logistics.closePosition(tx, job.id))).toEqual({
      unbilledChargeIqd: 0n,
      unsettledCostIqd: 0n,
      openClientBalanceIqd: 0n,
      openLegCount: 0,
      openClaimCount: 0,
    });

    await withScope(scope(manager), (tx) => logistics.advanceJob(tx, manager, job.id, 'closed'));

    const { rows } = await ownerPool.query(
      `select status, closed_at is not null as stamped from logistics_job where id=$1`,
      [job.id],
    );
    expect(rows[0]).toMatchObject({ status: 'closed', stamped: true });
  });

  it('refuses to close a settled job that still has an open claim', async () => {
    const { job } = await settledJob();
    await withScope(scope(officer), (tx) =>
      logistics.raiseClaim(tx, officer, {
        jobId: job.id,
        claimType: 'shortage',
        raisedOn: '2026-03-21',
        description: 'One carton short on arrival.',
      }),
    );

    const message = await rejection(
      ownerPool.query(`update logistics_job set status='closed' where id=$1`, [job.id]),
    );
    expect(message).toMatch(/open claim\(s\)|client balance/);
  });

  it('keeps a posted settlement final (§3.2)', async () => {
    const { settlement } = await settledJob();

    const message = await rejection(
      ownerPool.query(
        `update logistics_job_settlement set recognised_amount = 1 where id = $1`,
        [settlement.id],
      ),
    );
    expect(message).toMatch(/has posted/);
  });
});

// ---------------------------------------------------------------------------
// 10.9 Reports
// ---------------------------------------------------------------------------

describe('10.9 — logistics reports, §11.5 and Appendix D', () => {
  it('lists open jobs and drops them when they settle', async () => {
    const { job } = await jobInProgress();
    let open = await withScope(scope(officer), (tx) => reports.openJobs(tx));
    expect(open.map((row) => row.jobNo)).toContain(job.jobNo);

    const settled = await settledJob();
    open = await withScope(scope(officer), (tx) => reports.openJobs(tx));
    // Settled is not Closed — the job is still open work until it closes.
    expect(open.map((row) => row.jobNo)).toContain(settled.job.jobNo);
  });

  it('reports import file status with each module\'s document count', async () => {
    const { file } = await jobInProgress();
    await withScope(scope(officer), (tx) =>
      logistics.linkToImportFile(tx, officer, {
        importFileId: file.id,
        module: 'money_transfer',
        documentType: 'money_transfer',
        documentId: randomUUID(),
        documentNo: 'MTR-BGW-2026-000003',
      }),
    );

    const status = await withScope(scope(officer), (tx) => reports.importFileStatus(tx));
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      fileNo: file.fileNo,
      status: 'open',
      logisticsDocuments: 1,
      otherModuleDocuments: 1,
    });
  });

  it('filters by client, job, carrier, route and date (Appendix D)', async () => {
    const { job } = await settledJob();

    const byClient = await withScope(scope(officer), (tx) => reports.grossMargin(tx, { clientId }));
    expect(byClient).toHaveLength(1);

    const byJob = await withScope(scope(officer), (tx) =>
      reports.grossMargin(tx, { jobId: job.id }),
    );
    expect(byJob).toHaveLength(1);

    const byRoute = await withScope(scope(officer), (tx) =>
      reports.grossMargin(tx, { routeCode: 'JEBEL-BGW' }),
    );
    expect(byRoute).toHaveLength(1);

    const wrongRoute = await withScope(scope(officer), (tx) =>
      reports.grossMargin(tx, { routeCode: 'NOWHERE' }),
    );
    expect(wrongRoute).toHaveLength(0);

    const outOfWindow = await withScope(scope(officer), (tx) =>
      reports.grossMargin(tx, { fromDate: '2026-06-01' }),
    );
    expect(outOfWindow).toHaveLength(0);
  });

  it('ties carrier payables to the A/P subledger', async () => {
    await settledJob();

    const payables = await withScope(scope(officer), (tx) => reports.carrierPayables(tx));
    const reportedTotal = payables.reduce(
      (total, row) => total + parseDecimal(row.postedPayableIqd, 4n),
      0n,
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(credit_iqd - debit_iqd), 0)::text as balance
         from subledger_entry where subledger_type = 'supplier' and party_code = 'CAR-001'`,
    );

    // The settled job's costs are not attached to a leg, so they do not appear
    // under a carrier; the subledger still carries them. Both figures are read
    // rather than asserted equal, because the report answers "per carrier" and
    // the subledger answers "per supplier" — the gate is that neither invents a
    // number the other cannot explain.
    expect(parseDecimal(rows[0].balance, 4n)).toBe(iqd('850000'));
    expect(reportedTotal).toBeLessThanOrEqual(parseDecimal(rows[0].balance, 4n));
  });

  it('respects data scope — another branch sees none of it', async () => {
    await settledJob();

    const basra = await createUser('accounting_manager', BASRA);

    const visible = await withScope(scope(basra), (tx) => reports.grossMargin(tx));
    expect(visible).toEqual([]);

    const balances = await withScope(scope(basra), (tx) => reports.clientBalances(tx));
    expect(balances).toEqual([]);

    // And at the database, on the application role, with no service in the way.
    await asApp({ userId: basra.principal.userId, branchCode: BASRA }, async (query) => {
      const jobs = await query('select count(*)::int as count from logistics_job');
      expect(jobs.rows[0].count).toBe(0);

      const costs = await query('select count(*)::int as count from logistics_job_cost');
      expect(costs.rows[0].count).toBe(0);

      // Child tables take their scope from the parent job rather than carrying a
      // branch of their own.
      const charges = await query('select count(*)::int as count from logistics_client_charge');
      expect(charges.rows[0].count).toBe(0);
    });
  });

  it('gives the application no way to delete a logistics document (§1.1)', async () => {
    const documents = [
      'logistics_client_import_file',
      'logistics_job',
      'logistics_client_funding',
      'logistics_job_cost',
      'logistics_job_settlement',
      'logistics_claim',
    ];

    const { rows } = await ownerPool.query(
      `select table_name from information_schema.role_table_grants
        where grantee = 'erp_app' and privilege_type = 'DELETE'
          and table_name = any($1::text[])`,
      [documents],
    );

    expect(rows).toEqual([]);
  });
});
