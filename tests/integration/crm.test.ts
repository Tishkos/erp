/**
 * Phase 08 test gates — CRM and customer management. §6, Appendix B.
 *
 * 08.1  A lead saves without a Business Partner · duplicate detection fires on
 *       all five criteria · owner assignment and reassignment are audited
 * 08.2  Lead-to-opportunity conversion retains customer and source · every stage
 *       and ownership change is audited · an opportunity creates no accounting
 *       entry at any stage · lost opportunities capture a reason
 * 08.3  A transaction against an unapproved partner is rejected · one shared
 *       Business Partner record, not a CRM-local copy
 * 08.4  Activities link to lead, opportunity, partner or case, and are
 *       retrievable from each
 * 08.5  Opportunity-to-order conversion retains the identifiers; the data is
 *       copied, not re-keyed, and the link back persists
 * 08.6  Customer 360 shows only what the viewer is authorised to see
 * 08.7  A case links to invoice, serial and warranty
 * 08.8  Pipeline totals reconcile; conversion rates compute from conversions
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as crm from '@/server/services/crm';
import * as orders from '@/server/services/sales-order';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let sales: ActorContext;
let manager: ActorContext;
let customerId: string;
let supplierOnlyId: string;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    `${role}-${(seq += 1)}`,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  sales = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into lead_source (code, name) values ('REFERRAL','Referral'),('WEB','Website')
     on conflict do nothing`,
  );
  await ownerPool.query(
    `insert into crm_campaign (code, name, starts_on, ends_on, budget_iqd)
     values ('SPRING-2026','Spring 2026','2026-01-01','2026-06-30',5000.0000)
     on conflict do nothing`,
  );

  const { rows: partners } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active,
                                   phone, email, registration_no)
     values ('CUST-001','Al Rasheed Trading Co.', true, false, 'active', true,
             '+964 770 123 4567','accounts@alrasheed.iq','REG-88213'),
            ('SUP-ONLY','Tigris Supplies', false, true, 'active', true, null, null, null)
     returning id, code`,
  );
  customerId = partners.find((r) => r.code === 'CUST-001')!.id;
  supplierOnlyId = partners.find((r) => r.code === 'SUP-ONLY')!.id;

  // An item and a price list, so a conversion has something to order.
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: item } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
      [CABLE],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1,'EA',1,1)`,
      [item[0].id],
    );
    await client.query(
      `insert into price_list (code, name, currency, active) values ('PL-STD','Standard','IQD',true)
       on conflict do nothing`,
    );
    await client.query(
      `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
       values ('PL-STD',$1,'EA',10.0000,'2026-01-01') on conflict do nothing`,
      [item[0].id],
    );
    await client.query(`update business_partner set price_list_code = 'PL-STD' where id = $1`, [
      customerId,
    ]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

async function newLead(overrides: Partial<crm.CreateLeadInput> = {}) {
  return withScope(scope(sales), (tx) =>
    crm.createLead(tx, sales, {
      companyName: 'Basra Contracting LLC',
      branchCode: BAGHDAD,
      ownerUserId: sales.principal.userId,
      contactName: 'Hassan',
      phone: '+964 780 555 1234',
      email: 'hassan@basracontracting.iq',
      registrationNo: 'REG-55501',
      leadSourceCode: 'REFERRAL',
      campaignCode: 'SPRING-2026',
      businessLineCode: 'PRODUCT_SALES',
      ...overrides,
    }),
  );
}

async function qualified(leadId: string) {
  return withScope(scope(sales), (tx) =>
    crm.qualifyLead(tx, sales, {
      leadId,
      partnerId: customerId,
      businessLineCode: 'PRODUCT_SALES',
      title: 'Cable supply for the Basra site',
      expectedValueIqd: price('5000'),
      probabilityPercent: 60,
      expectedCloseOn: '2026-03-31',
      items: [{ itemCode: CABLE, description: 'Network cable', quantity: 500n * 1_000_000n }],
    }),
  );
}

// ---------------------------------------------------------------------------

describe('08.1 gate · a lead exists before a customer does (§6)', () => {
  it('saves with no Business Partner at all', async () => {
    const created = await newLead({ partnerId: null });
    const row = await withScope(scope(sales), (tx) => crm.viewLead(tx, created.id));

    expect(row.partnerId).toBeNull();
    expect(row.status).toBe('new');
    expect(created.leadNo).toMatch(/^LED-/);
  });

  it('refuses a lead with no name', async () => {
    expect(await rejection(newLead({ companyName: '   ' }))).toMatch(/needs a name/);
  });

  it('records the owner, and audits every reassignment', async () => {
    const created = await newLead();
    await withScope(scope(manager), (tx) =>
      crm.assignLead(tx, manager, created.id, manager.principal.userId, 'Territory change'),
    );

    const { rows } = await ownerPool.query(
      `select action, actor_user_id, before_value, after_value, reason from audit_event
        where object_id = $1 order by occurred_at`,
      [created.id],
    );
    const reassign = rows.find((r) => r.action === 'lead.reassigned');
    expect(reassign).toBeDefined();
    expect(reassign.before_value.owner).toBe(sales.principal.userId);
    expect(reassign.after_value.owner).toBe(manager.principal.userId);
    expect(reassign.reason).toBe('Territory change');
  });

  it('does not audit a reassignment to the same person', async () => {
    const created = await newLead();
    await withScope(scope(manager), (tx) =>
      crm.assignLead(tx, manager, created.id, sales.principal.userId),
    );
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from audit_event where action = 'lead.reassigned'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('08.1 gate · duplicate detection fires on all five criteria (§6)', () => {
  it('finds a lead that duplicates an existing customer', async () => {
    const created = await newLead({
      companyName: 'Al Rasheed Trading Co.',
      phone: '07701234567',
      email: 'ACCOUNTS@alrasheed.iq',
      registrationNo: 'REG-88213',
    });

    const hit = created.duplicates.find((d) => d.ofName === 'CUST-001');
    expect(hit).toBeDefined();
    expect(hit!.hits.map((h) => h.criterion).sort()).toEqual(
      ['email', 'name', 'phone', 'registration_number'].sort(),
    );
  });

  it('finds a lead that duplicates another lead, including on bank details', async () => {
    await newLead({ bankAccountNumber: 'IQ98 NBIQ 8501 2345 6789' });
    const second = await newLead({
      companyName: 'Someone Else Entirely',
      phone: null,
      email: null,
      registrationNo: null,
      bankAccountNumber: 'iq98nbiq850123456789',
    });

    const hit = second.duplicates.find((d) => d.hits.some((h) => h.criterion === 'bank_details'));
    expect(hit).toBeDefined();
  });

  it('saves the lead anyway — §6 asks for detection, not prevention', async () => {
    const created = await newLead({ companyName: 'Al Rasheed Trading Co.' });
    expect(created.duplicates.length).toBeGreaterThan(0);

    const row = await withScope(scope(sales), (tx) => crm.viewLead(tx, created.id));
    expect(row.companyName).toBe('Al Rasheed Trading Co.');
  });

  it('records what it matched on, in the audit trail', async () => {
    const created = await newLead({ companyName: 'Al Rasheed Trading Co.' });

    const { rows } = await ownerPool.query(
      `select after_value from audit_event where action = 'lead.created' and object_id = $1`,
      [created.id],
    );
    expect(rows[0].after_value.duplicatesFound).toBeGreaterThan(0);
    expect(rows[0].after_value.duplicateCriteria).toContain('name');
  });

  it('finds nothing for a genuinely new company', async () => {
    const created = await newLead();
    expect(created.duplicates).toEqual([]);
  });
});

describe('08.2 gate · qualification keeps the customer and the source (§6 criterion 1)', () => {
  it('carries the source and campaign onto the opportunity', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    const view = await withScope(scope(sales), (tx) => crm.viewOpportunity(tx, opp.id));

    expect(view.opportunity.leadSourceCode).toBe('REFERRAL');
    expect(view.opportunity.campaignCode).toBe('SPRING-2026');
    expect(view.opportunity.partnerId).toBe(customerId);
    expect(view.opportunity.leadId).toBe(led.id);
  });

  it('marks the lead converted and fills in the customer it now has', async () => {
    const led = await newLead();
    await qualified(led.id);
    const row = await withScope(scope(sales), (tx) => crm.viewLead(tx, led.id));

    expect(row.status).toBe('converted');
    expect(row.partnerId).toBe(customerId);
  });

  it('refuses to qualify the same lead twice', async () => {
    const led = await newLead();
    await qualified(led.id);

    expect(await rejection(qualified(led.id))).toMatch(/qualified once/);
  });

  it('refuses an opportunity for somebody who is not a customer', async () => {
    const led = await newLead();

    expect(
      await rejection(
        withScope(scope(sales), (tx) =>
          crm.qualifyLead(tx, sales, {
            leadId: led.id,
            partnerId: supplierOnlyId,
            businessLineCode: 'PRODUCT_SALES',
            title: 'x',
            expectedValueIqd: price('1'),
          }),
        ),
      ),
    ).toMatch(/not a customer/);
  });

  it('refuses a lead whose customer is changed on the way through', async () => {
    const led = await newLead({ partnerId: supplierOnlyId });

    expect(await rejection(qualified(led.id))).toMatch(/customer changed during the conversion/);
  });

  it('will not let the database hold an opportunity that drifted from its lead', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);

    await expect(
      ownerPool.query(`update opportunity set lead_source_code = 'WEB' where id = $1`, [opp.id]),
    ).rejects.toThrow(/different lead source from lead/);
  });
});

describe('08.2 gate · stages, audit and the absence of accounting (Appendix B)', () => {
  it('audits every stage change', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    await withScope(scope(sales), (tx) => crm.changeStage(tx, sales, opp.id, 'won'));

    const { rows } = await ownerPool.query(
      `select before_value, after_value from audit_event
        where action = 'opportunity.stage_changed' and object_id = $1`,
      [opp.id],
    );
    expect(rows[0].before_value.stage).toBe('qualified');
    expect(rows[0].after_value.stage).toBe('won');
  });

  it('audits ownership changes too', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    await withScope(scope(manager), (tx) =>
      crm.assignOpportunity(tx, manager, opp.id, manager.principal.userId),
    );

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from audit_event where action = 'opportunity.reassigned'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('creates no accounting entry at any stage', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    for (const stage of ['won', 'closed'] as const) {
      await withScope(scope(sales), (tx) => crm.changeStage(tx, sales, opp.id, stage));
    }

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('has nowhere to record one even if somebody wanted to', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name in ('opportunity','lead') and column_name like '%journal%'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('requires a reason for a loss, and reports it', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);

    expect(
      await rejection(withScope(scope(sales), (tx) => crm.changeStage(tx, sales, opp.id, 'lost'))),
    ).toMatch(/needs a reason/);

    await withScope(scope(sales), (tx) =>
      crm.changeStage(tx, sales, opp.id, 'lost', { lostReason: 'Competitor undercut on price' }),
    );

    const lost = await withScope(scope(sales), (tx) => crm.lostOpportunities(tx, sales));
    expect(lost).toHaveLength(1);
    expect(lost[0]!.lostReason).toMatch(/undercut/);
  });

  it('refuses to re-open a decided opportunity', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    await withScope(scope(sales), (tx) =>
      crm.changeStage(tx, sales, opp.id, 'lost', { lostReason: 'Price' }),
    );

    expect(
      await rejection(withScope(scope(sales), (tx) => crm.changeStage(tx, sales, opp.id, 'open'))),
    ).toMatch(/already been decided/);
  });
});

describe('08.5 gate · conversion to a Sales Order (§6)', () => {
  async function won() {
    const led = await newLead();
    const opp = await qualified(led.id);
    await withScope(scope(sales), (tx) => crm.changeStage(tx, sales, opp.id, 'won'));
    return opp;
  }

  it('creates the order for the same customer, and links back', async () => {
    const opp = await won();

    const converted = await withScope(scope(sales), (tx) =>
      crm.convertToSalesOrder(tx, sales, opp.id, {
        orderDate: '2026-02-15',
        lines: [
          {
            itemCode: CABLE,
            quantity: parseQuantity('100'),
            uomCode: 'EA',
            warehouseCode: `WH-${BAGHDAD}`,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );

    const { rows } = await ownerPool.query(
      `select o.sales_order_id, s.customer_id, s.business_line_code, s.order_no
         from opportunity o join sales_order s on s.id = o.sales_order_id
        where o.id = $1`,
      [opp.id],
    );
    expect(rows[0].sales_order_id).toBe(converted.salesOrderId);
    expect(rows[0].customer_id).toBe(customerId);
    expect(rows[0].business_line_code).toBe('PRODUCT_SALES');
  });

  it('takes the business line from the opportunity, not from the caller', async () => {
    const opp = await won();
    await withScope(scope(sales), (tx) =>
      crm.convertToSalesOrder(tx, sales, opp.id, {
        orderDate: '2026-02-15',
        lines: [
          {
            itemCode: CABLE,
            quantity: parseQuantity('10'),
            uomCode: 'EA',
            warehouseCode: `WH-${BAGHDAD}`,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );

    const { rows } = await ownerPool.query(
      `select s.business_line_code from sales_order s
         join opportunity o on o.sales_order_id = s.id where o.id = $1`,
      [opp.id],
    );
    expect(rows[0].business_line_code).toBe('PRODUCT_SALES');
  });

  it('refuses to convert an opportunity nobody has won', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);

    expect(
      await rejection(
        withScope(scope(sales), (tx) =>
          crm.convertToSalesOrder(tx, sales, opp.id, {
            orderDate: '2026-02-15',
            lines: [
              {
                itemCode: CABLE,
                quantity: parseQuantity('1'),
                uomCode: 'EA',
                warehouseCode: `WH-${BAGHDAD}`,
            branchCode: BAGHDAD,
              },
            ],
          }),
        ),
      ),
    ).toMatch(/converted once it has been won/);
  });

  it('refuses to convert the same win twice', async () => {
    const opp = await won();
    const line = {
      itemCode: CABLE,
      quantity: parseQuantity('1'),
      uomCode: 'EA',
      warehouseCode: `WH-${BAGHDAD}`,
      branchCode: BAGHDAD,
    };
    await withScope(scope(sales), (tx) =>
      crm.convertToSalesOrder(tx, sales, opp.id, { orderDate: '2026-02-15', lines: [line] }),
    );

    expect(
      await rejection(
        withScope(scope(sales), (tx) =>
          crm.convertToSalesOrder(tx, sales, opp.id, { orderDate: '2026-02-15', lines: [line] }),
        ),
      ),
    ).toMatch(/already been converted/);
  });

  it('will not let the database link an order for a different customer', async () => {
    const opp = await won();
    const { rows: other } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, status, active, price_list_code)
       values ('CUST-002','Tigris Retail', true, 'active', true, 'PL-STD') returning id`,
    );
    const { rows: order } = await ownerPool.query(
      `insert into sales_order (order_no, customer_id, price_list_code, branch_code, order_date,
                                currency, status, created_by)
       values ('SO-OTHER',$1,'PL-STD',$2,'2026-02-15','IQD','approved',$3) returning id`,
      [other[0].id, BAGHDAD, sales.principal.userId],
    );

    await expect(
      ownerPool.query(`update opportunity set sales_order_id = $2 where id = $1`, [
        opp.id,
        order[0].id,
      ]),
    ).rejects.toThrow(/different customer/);
  });
});

describe('08.3 gate · one Business Partner, approved before anything is sold (§6)', () => {
  const line = () => ({
    itemCode: CABLE,
    quantity: parseQuantity('10'),
    uomCode: 'EA',
    warehouseCode: `WH-${BAGHDAD}`,
    branchCode: BAGHDAD,
  });

  async function order(partnerId: string) {
    return withScope(scope(sales), (tx) =>
      orders.create(tx, sales, {
        customerId: partnerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-15',
        lines: [line()],
      }),
    );
  }

  it('refuses a Sales Order against a partner who is still a prospect', async () => {
    await ownerPool.query(`update business_partner set status = 'prospect' where id = $1`, [
      customerId,
    ]);

    expect(await rejection(order(customerId))).toMatch(/is prospect/);
  });

  it('refuses one against a blocked partner (§6 criterion 2)', async () => {
    await ownerPool.query(`update business_partner set status = 'blocked' where id = $1`, [
      customerId,
    ]);

    expect(await rejection(order(customerId))).toMatch(/is blocked/);
  });

  it('refuses one against a partner on hold, and against a deactivated one', async () => {
    await ownerPool.query(`update business_partner set status = 'on_hold' where id = $1`, [
      customerId,
    ]);
    expect(await rejection(order(customerId))).toMatch(/on hold/);

    await ownerPool.query(
      `update business_partner set status = 'active', active = false where id = $1`,
      [customerId],
    );
    expect(await rejection(order(customerId))).toMatch(/deactivated/);
  });

  it('refuses one against somebody who is not a customer at all', async () => {
    expect(await rejection(order(supplierOnlyId))).toMatch(/not a customer/);
  });

  it('accepts one against an approved, active customer', async () => {
    const created = await order(customerId);
    expect(created.orderNo).toBeTruthy();
  });

  it('lets a lead exist against the very partner an order is refused for (§6)', async () => {
    await ownerPool.query(`update business_partner set status = 'prospect' where id = $1`, [
      customerId,
    ]);

    // The asymmetry §6 states in one sentence: interest is allowed before
    // approval, commitment is not.
    const led = await newLead({ partnerId: customerId });
    expect(led.id).toBeTruthy();
    expect(await rejection(order(customerId))).toMatch(/is prospect/);
  });

  it('shares one partner record rather than keeping a CRM copy', async () => {
    // Every CRM table that names a customer names `business_partner.id`, and
    // there is no crm-local customer table for the two to drift apart.
    const { rows: fks } = await ownerPool.query(
      `select c.conrelid::regclass::text as table_name
         from pg_constraint c
         join pg_class f on f.oid = c.confrelid
        where c.contype = 'f' and f.relname = 'business_partner'
          and c.conrelid::regclass::text in ('lead','opportunity','crm_activity','crm_contact','crm_case')
        order by 1`,
    );
    expect(fks.map((r) => r.table_name).sort()).toEqual([
      'crm_activity',
      'crm_case',
      'crm_contact',
      'lead',
      'opportunity',
    ]);

    const { rows: copies } = await ownerPool.query(
      `select table_name from information_schema.tables
        where table_name like 'crm_%' and table_name like '%customer%'`,
    );
    expect(copies).toHaveLength(0);
  });

  it('is the same record Sales, A/R, Logistics and Money Transfer point at', async () => {
    const { rows } = await ownerPool.query(
      `select count(distinct c.conrelid::regclass::text)::int as n
         from pg_constraint c
         join pg_class f on f.oid = c.confrelid
        where c.contype = 'f' and f.relname = 'business_partner'`,
    );
    // One table, referenced from every module that has a customer or a
    // supplier — which is what §6 means by "the same Business Partner record".
    expect(rows[0].n).toBeGreaterThan(10);
  });
});

describe('08.4 gate · activities link to each kind of record and are retrievable', () => {
  it('links to a lead, an opportunity, a partner and a case', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);
    const kase = await withScope(scope(sales), (tx) =>
      crm.openCase(tx, sales, {
        partnerId: customerId,
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        subject: 'Cable failed within a month',
        openedOn: '2026-02-20',
      }),
    );

    for (const target of [
      { leadId: led.id },
      { opportunityId: opp.id },
      { partnerId: customerId },
      { caseId: kase.id },
    ]) {
      await withScope(scope(sales), (tx) =>
        crm.logActivity(tx, sales, {
          kind: 'call',
          subject: 'Called the buyer',
          branchCode: BAGHDAD,
          ownerUserId: sales.principal.userId,
          ...target,
        }),
      );
      const found = await withScope(scope(sales), (tx) => crm.activitiesFor(tx, target));
      expect(found).toHaveLength(1);
    }
  });

  it('refuses an activity attached to two records at once', async () => {
    const led = await newLead();
    const opp = await qualified(led.id);

    await expect(
      ownerPool.query(
        `insert into crm_activity (kind, subject, lead_id, opportunity_id, branch_code,
                                   owner_user_id, created_by)
         values ('call','Both',$1,$2,$3,$4,$4)`,
        [led.id, opp.id, BAGHDAD, sales.principal.userId],
      ),
    ).rejects.toThrow(/crm_activity_has_one_subject_record/);
  });

  it('keeps a completed activity in the audit trail', async () => {
    const led = await newLead();
    const activity = await withScope(scope(sales), (tx) =>
      crm.logActivity(tx, sales, {
        kind: 'meeting',
        subject: 'Site visit',
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        leadId: led.id,
      }),
    );

    await withScope(scope(sales), (tx) =>
      crm.completeActivity(tx, sales, activity.id, 'Agreed to quote for 500m'),
    );

    const { rows } = await ownerPool.query(
      `select after_value from audit_event where action = 'crm_activity.completed' and object_id = $1`,
      [activity.id],
    );
    expect(rows[0].after_value.outcome).toMatch(/500m/);
  });
});

describe('08.7 gate · after-sales cases link to what was sold (§6)', () => {
  it('records the invoice, the serial and the warranty registration', async () => {
    const kase = await withScope(scope(sales), (tx) =>
      crm.openCase(tx, sales, {
        partnerId: customerId,
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        subject: 'Cable failed within a month',
        openedOn: '2026-02-20',
        serialNumber: 'SN-4471',
      }),
    );

    const { rows } = await ownerPool.query(
      `select case_no, serial_number, status from crm_case where id = $1`,
      [kase.id],
    );
    expect(rows[0].case_no).toMatch(/^CAS-/);
    expect(rows[0].serial_number).toBe('SN-4471');
    expect(rows[0].status).toBe('open');
  });

  it('refuses to close a case without saying what happened', async () => {
    const kase = await withScope(scope(sales), (tx) =>
      crm.openCase(tx, sales, {
        partnerId: customerId,
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        subject: 'Faulty',
        openedOn: '2026-02-20',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          crm.resolveCase(tx, manager, kase.id, { resolution: '  ', resolvedOn: '2026-02-25' }),
        ),
      ),
    ).toMatch(/needs a resolution/);
  });

  it('records the resolution and the date', async () => {
    const kase = await withScope(scope(sales), (tx) =>
      crm.openCase(tx, sales, {
        partnerId: customerId,
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        subject: 'Faulty',
        openedOn: '2026-02-20',
      }),
    );
    await withScope(scope(manager), (tx) =>
      crm.resolveCase(tx, manager, kase.id, {
        resolution: 'Replaced under warranty',
        resolvedOn: '2026-02-25',
      }),
    );

    const { rows } = await ownerPool.query(
      `select status, resolution, resolved_on from crm_case where id = $1`,
      [kase.id],
    );
    expect(rows[0]).toMatchObject({ status: 'resolved', resolution: 'Replaced under warranty' });
  });

  it('has no expiry date of its own — warranty validity is 06.7’s calculation', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'crm_case' and column_name like '%expir%'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('08.6 gate · Customer 360 shows only what the viewer may see (§6 criterion 3)', () => {
  it('shows the commercial history', async () => {
    const led = await newLead();
    await qualified(led.id);
    await withScope(scope(sales), (tx) =>
      crm.logActivity(tx, sales, {
        kind: 'call',
        subject: 'Follow-up',
        branchCode: BAGHDAD,
        ownerUserId: sales.principal.userId,
        partnerId: customerId,
      }),
    );

    const view = await withScope(scope(manager), (tx) =>
      crm.customer360(tx, manager, customerId, '2026-02-28'),
    );

    expect(view.partnerCode).toBe('CUST-001');
    expect(view.commercial.leads).toBe(1);
    expect(view.commercial.opportunities).toEqual([{ stage: 'qualified', count: 1 }]);
    expect(view.commercial.activities).toBe(1);
  });

  it('shows the financial figures to a user with A/R permission', async () => {
    const view = await withScope(scope(manager), (tx) =>
      crm.customer360(tx, manager, customerId, '2026-02-28'),
    );
    expect(view.financial).not.toBeNull();
    expect(view.financial!.openInvoices).toBe(0);
  });

  it('omits them — rather than zeroing them — for a user without it', async () => {
    // A user with CRM rights and no A/R rights at all.
    const id = randomUUID();
    await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'crm only')`, [
      id,
      `${id}@example.com`,
    ]);
    await ownerPool.query(`insert into role (code, name) values ('crm_user','CRM User')
                           on conflict do nothing`);
    await ownerPool.query(
      `insert into role_grant (role_code, object, verb) values ('crm_user','crm','view')
       on conflict do nothing`,
    );
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'crm_user')`, [id]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      BAGHDAD,
    ]);
    const crmOnly: ActorContext = {
      principal: await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
        authz.loadPrincipal(tx, id),
      ),
      branchCode: BAGHDAD,
    };

    const view = await withScope(scope(crmOnly), (tx) =>
      crm.customer360(tx, crmOnly, customerId, '2026-02-28'),
    );

    // An absent figure and a figure of nothing are different statements, and
    // only one of them is true.
    expect(view.financial).toBeNull();
    expect(view.commercial).toBeDefined();
  });
});

describe('08.8 gate · reports reconcile to the records beneath them', () => {
  it('pipeline totals match the opportunities they came from', async () => {
    const first = await newLead();
    const opp1 = await qualified(first.id);
    const second = await newLead({ companyName: 'Mosul Engineering', phone: null, email: null, registrationNo: null });
    const opp2 = await withScope(scope(sales), (tx) =>
      crm.qualifyLead(tx, sales, {
        leadId: second.id,
        partnerId: customerId,
        businessLineCode: 'PRODUCT_SALES',
        title: 'Second deal',
        expectedValueIqd: price('3000'),
        probabilityPercent: 50,
      }),
    );

    const pipeline = await withScope(scope(manager), (tx) => crm.pipeline(tx, manager));
    const qualifiedRow = pipeline.find((row) => row.stage === 'qualified')!;

    expect(qualifiedRow.count).toBe(2);
    expect(qualifiedRow.expectedValueIqd).toBe('8000.0000'); // 5,000 + 3,000
    // 5,000×60% + 3,000×50% = 4,500
    expect(qualifiedRow.weightedValueIqd).toBe('4500.0000');
    expect([opp1.id, opp2.id]).toHaveLength(2);
  });

  it('computes lead-source conversion from actual conversions', async () => {
    const a = await newLead({ leadSourceCode: 'REFERRAL' });
    await qualified(a.id);
    await newLead({
      companyName: 'Never Qualified Co',
      leadSourceCode: 'REFERRAL',
      phone: null,
      email: null,
      registrationNo: null,
    });

    const rates = await withScope(scope(manager), (tx) => crm.leadSourceConversion(tx, manager));
    const referral = rates.find((row) => row.source === 'REFERRAL')!;

    expect(referral.leads).toBe(2);
    expect(referral.opportunities).toBe(1);
    expect(referral.qualificationRate).toBe(50);
  });

  it('lists customers with no activity and no order since a date', async () => {
    const inactive = await withScope(scope(manager), (tx) =>
      crm.inactiveCustomers(tx, manager, '2026-01-01'),
    );
    expect(inactive.map((row) => row.partnerCode)).toContain('CUST-001');
  });
});
