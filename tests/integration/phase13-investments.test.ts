/**
 * Phase 13 test gates — Investment Management. §13, Appendix D, Appendix E.
 *
 * ── What these tests are careful not to assert ──────────────────────────────
 * §13: *"The IT team must implement configurable types and posting rules only
 * after Finance defines the required categories."*
 *
 * So no test here names a category or a valuation method as though the system
 * knew one. Every fixture below **creates its own** type and method, which is
 * exactly what Finance will do — and the first describe block asserts that both
 * catalogues ship empty and that nothing can be recorded until they are filled.
 * A test that seeded 'equity' and 'fair_value' would freeze D2's answer as
 * firmly as the code would, and would pass either way.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as investments from '@/server/services/investments';
import * as coa from '@/server/services/chart-of-accounts';
import * as cashForecast from '@/server/services/cash-forecast';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const iqd = (value: string) => parseDecimal(value, 4n);
const units = (value: string) => parseDecimal(value, 6n);

let clerk: ActorContext;
let manager: ActorContext;
let approver: ActorContext;
let accounts: Record<string, string>;
let bankAccountId: string;
let partnerId: string;
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

/** An attachment standing in for a signed statement or contract. */
async function evidence(objectId: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into attachment
       (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
        scan_status, scanned_at, uploaded_by, branch_code)
     values ('investment', $1, $2, 'application/pdf', 1024, $3, $4, 'clean', now(), $5, $6)
     returning id`,
    [
      objectId,
      `evidence-${(seq += 1)}.pdf`,
      // lower-case hex, 64 characters — the shape attachment_hash_shape wants.
      seq.toString(16).padStart(64, '0'),
      `key-${seq}`,
      manager.principal.userId,
      BAGHDAD,
    ],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  approver = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  for (const [no, from, to] of [
    [1, '2026-01-01', '2026-01-31'],
    [2, '2026-02-01', '2026-02-28'],
    [3, '2026-03-01', '2026-03-31'],
    [6, '2026-06-01', '2026-06-30'],
    [9, '2026-09-01', '2026-09-30'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [years[0].id, no, `P${no} 2026`, from, to],
    );
  }
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  // The accounts §13.4's events post to. Roles, resolved through §3.3.
  accounts = {};
  for (const [role, parent, code, name] of [
    ['investment_cost', 'A000001', 'A9INVCST', 'Investment Cost'],
    ['investment_valuation', 'A000001', 'A9INVVAL', 'Investment Valuation'],
    ['bank', 'A000001', 'A9INVBNK', 'Investment Bank'],
    ['investment_income', 'R000001', 'R9INVINC', 'Investment Income'],
    ['investment_disposal_gain', 'R000001', 'R9INVGAI', 'Investment Disposal Gain'],
    ['investment_impairment', 'X000001', 'X9INVIMP', 'Investment Impairment'],
    ['investment_disposal_loss', 'X000001', 'X9INVLOS', 'Investment Disposal Loss'],
    // Only to put opening money in the bank, so §17's "the funds must be there"
    // check has something to find. Not part of §13.
    ['suspense', 'L000001', 'L9INVSUS', 'Opening funds suspense'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;

    for (const event of [
      'investments.acquisition',
      'investments.income',
      'investments.impairment',
      'investments.disposal',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1,$2,$3,true,$4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  // D15 — nobody chooses a department for an investment income or a disposal
  // gain. Cleared so these gates test the gate rather than the gap.
  for (const role of [
    'investment_income',
    'investment_disposal_gain',
    'investment_impairment',
    'investment_disposal_loss',
  ] as const) {
    await withScope(scope(manager), (tx) =>
      coa.setRequiredDimensions(tx, manager, accounts[role]!, []),
    );
  }

  const { rows: bank } = await ownerPool.query(
    `insert into bank_cash_account
       (code, name, account_type, account_number, branch_code, currency, gl_account_id)
     values ('BANK-INV','Investment bank','bank','ACC-INV-1',$1,'IQD',$2) returning id`,
    [BAGHDAD, accounts.bank],
  );
  bankAccountId = bank[0].id;

  // §4.4 keeps one identity per counterparty, and `business_partner` requires a
  // partner to be a customer or a supplier. An investee is neither — it is a
  // company the business holds a stake in — so it is recorded as a supplier
  // because money flows to it at acquisition. That is the defensible reading and
  // not obviously the right one: raised as **D31**.
  const { rows: partner } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, is_supplier, status)
     values ('BP-INV','Gulf Holdings PJSC',false,true,'active') returning id`,
  );
  partnerId = partner[0].id;

  // §13 — Treasury provides the funding, and §17 refuses a payment out of an
  // account that has not got the money. So the account starts with some.
  await fundBank(iqd('50000000'));
});

/** Opening money in the investment bank account, posted as a real journal. */
async function fundBank(amountIqd: bigint) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= '2026-01-01'::date
          and ends_on >= '2026-01-01'::date limit 1`,
    );
    const amount = toDecimalString(amountIqd, 4n);
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1, '2026-01-01', '2026-01-01', $2, $3, 'Opening funds', 'draft', $4, $4, $5)
       returning id`,
      [`FUND-INV-${(seq += 1)}`, periods[0].id, BAGHDAD, amount, manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, accounts.bank, amount, accounts.suspense, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now()
        where id = $1`,
      [entry[0].id, manager.principal.userId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Finance's job, done by the test: a category and a valuation method. */
async function financeConfigures(
  overrides: { requiredFields?: string[]; relatedPartyApprovalRequired?: boolean } = {},
) {
  await ownerPool.query(
    `insert into investment_type
       (code, name, required_fields, related_party_approval_required)
     values ('TYPE-UNDER-TEST', 'A category Finance defined', $1, $2)`,
    [overrides.requiredFields ?? [], overrides.relatedPartyApprovalRequired ?? false],
  );
  await ownerPool.query(
    `insert into investment_valuation_method (code, name, review_frequency_months)
     values ('METHOD-UNDER-TEST', 'A method Finance approved', 12)`,
  );
}

async function approvedProposal(overrides: Record<string, unknown> = {}) {
  const proposal = await withScope(scope(clerk), (tx) =>
    investments.propose(tx, clerk, {
      typeCode: 'TYPE-UNDER-TEST',
      branchCode: BAGHDAD,
      amountIqd: iqd('500000'),
      currencyCode: 'IQD',
      expectedReturn: '8% per annum',
      riskAssessment: 'Moderate — counterparty is rated',
      proposedOn: '2026-01-15',
      counterpartyPartnerId: partnerId,
      ...overrides,
    }),
  );
  await withScope(scope(manager), (tx) =>
    investments.approve(tx, manager, proposal.id, 'management'),
  );
  await withScope(scope(approver), (tx) =>
    investments.approve(tx, approver, proposal.id, 'funding'),
  );
  return proposal;
}

async function acquired(overrides: Record<string, unknown> = {}) {
  const proposal = await approvedProposal();
  return withScope(scope(manager), (tx) =>
    investments.acquire(tx, manager, {
      proposalId: proposal.id,
      description: 'Ordinary shares',
      acquiredOn: '2026-01-20',
      units: units('1000'),
      amountTxn: iqd('500000'),
      amountIqd: iqd('500000'),
      bankCashAccountId: bankAccountId,
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('D2 · the catalogues ship empty, and emptiness refuses', () => {
  it('has no investment categories at all', async () => {
    // §13 leaves the categories to Finance. A seed list would be this build
    // answering D2, and it would be invisible: every test would be written
    // against the same invented rule and would pass.
    const { rows } = await ownerPool.query(`select count(*)::int as n from investment_type`);
    expect(rows[0].n).toBe(0);
  });

  it('has no valuation methods at all', async () => {
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from investment_valuation_method`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('refuses a proposal under a category nobody has defined', async () => {
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          investments.propose(tx, clerk, {
            typeCode: 'EQUITY',
            branchCode: BAGHDAD,
            amountIqd: iqd('500000'),
            currencyCode: 'IQD',
            expectedReturn: '8%',
            riskAssessment: 'Moderate',
            proposedOn: '2026-01-15',
          }),
        ),
      ),
    ).toMatch(/no active investment type 'EQUITY'/i);
  });

  it('names D2 in the refusal, so the reader knows whose answer is missing', async () => {
    const message = await rejection(
      withScope(scope(clerk), (tx) =>
        investments.propose(tx, clerk, {
          typeCode: 'ANYTHING',
          branchCode: BAGHDAD,
          amountIqd: iqd('1'),
          currencyCode: 'IQD',
          expectedReturn: 'x',
          riskAssessment: 'y',
          proposedOn: '2026-01-15',
        }),
      ),
    );
    expect(message).toMatch(/D2/);
  });

  it('refuses a valuation on a method nobody has approved', async () => {
    await financeConfigures();
    const held = await acquired();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.value(tx, manager, held.id, {
            valuedOn: '2026-03-31',
            methodCode: 'fair_value',
            valueTxn: iqd('520000'),
            valueIqd: iqd('520000'),
          }),
        ),
      ),
    ).toMatch(/not a valuation method Finance has approved/i);
  });
});

describe('13.1 gate · types are configuration, not code', () => {
  it('takes a category Finance invents, whatever it is called', async () => {
    for (const code of ['MURABAHA-DEPOSIT', 'ASSOCIATE-STAKE', 'ANYTHING-AT-ALL']) {
      await ownerPool.query(`insert into investment_type (code, name) values ($1, $2)`, [
        code,
        `${code} defined by Finance`,
      ]);
    }
    const { rows } = await ownerPool.query(`select count(*)::int as n from investment_type`);
    expect(rows[0].n).toBe(3);
  });

  it('enforces the required fields the type names, at save', async () => {
    await financeConfigures({ requiredFields: ['custodian', 'maturityDate'] });
    const proposal = await approvedProposal();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.acquire(tx, manager, {
            proposalId: proposal.id,
            description: 'Ordinary shares',
            acquiredOn: '2026-01-20',
            units: units('1000'),
            amountTxn: iqd('500000'),
            amountIqd: iqd('500000'),
            bankCashAccountId: bankAccountId,
          }),
        ),
      ),
    ).toMatch(/requires custodian, maturityDate/);
  });

  it('accepts once those fields are supplied', async () => {
    await financeConfigures({ requiredFields: ['custodian', 'maturityDate'] });
    const proposal = await approvedProposal();

    const held = await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'Ordinary shares',
        acquiredOn: '2026-01-20',
        units: units('1000'),
        amountTxn: iqd('500000'),
        amountIqd: iqd('500000'),
        bankCashAccountId: bankAccountId,
        custodian: 'Regional Custody Bank',
        maturityDate: '2029-01-20',
      }),
    );
    expect(held.investmentNo).toMatch(/^INV-/);
  });

  it('demands nothing when the type demands nothing — the list is data', async () => {
    await financeConfigures({ requiredFields: [] });
    const held = await acquired();
    expect(held.investmentNo).toBeTruthy();
  });

  it('stores both the transaction currency and its base equivalent (§A4)', async () => {
    await financeConfigures();
    const proposal = await approvedProposal({ currencyCode: 'USD', amountIqd: iqd('13100000') });

    const held = await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'USD-denominated note',
        acquiredOn: '2026-01-20',
        units: units('100'),
        amountTxn: iqd('10000'), // USD
        amountIqd: iqd('13100000'), // at 1,310
        bankCashAccountId: bankAccountId,
      }),
    );

    const { rows } = await ownerPool.query(
      `select currency_code, cost_txn, cost_iqd from investment where id = $1`,
      [held.id],
    );
    expect(rows[0].currency_code).toBe('USD');
    expect(rows[0].cost_txn).toBe('10000.0000');
    expect(rows[0].cost_iqd).toBe('13100000.0000');
  });
});

describe('13.2 gate · proposal and approval (§13 workflow 1 and 2)', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('refuses a proposal missing any of the five fields, naming them all', async () => {
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          investments.propose(tx, clerk, {
            typeCode: 'TYPE-UNDER-TEST',
            branchCode: BAGHDAD,
            amountIqd: iqd('500000'),
            currencyCode: 'IQD',
            expectedReturn: '   ',
            riskAssessment: '',
            proposedOn: '2026-01-15',
          }),
        ),
      ),
    ).toMatch(/the expected return.*a risk assessment|a risk assessment.*the expected return/s);
  });

  it('refuses acquisition on management approval alone', async () => {
    const proposal = await withScope(scope(clerk), (tx) =>
      investments.propose(tx, clerk, {
        typeCode: 'TYPE-UNDER-TEST',
        branchCode: BAGHDAD,
        amountIqd: iqd('500000'),
        currencyCode: 'IQD',
        expectedReturn: '8%',
        riskAssessment: 'Moderate',
        proposedOn: '2026-01-15',
      }),
    );
    await withScope(scope(manager), (tx) =>
      investments.approve(tx, manager, proposal.id, 'management'),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.acquire(tx, manager, {
            proposalId: proposal.id,
            description: 'Shares',
            acquiredOn: '2026-01-20',
            units: units('1000'),
            amountTxn: iqd('500000'),
            amountIqd: iqd('500000'),
            bankCashAccountId: bankAccountId,
          }),
        ),
      ),
    ).toMatch(/funding source has not been approved/i);
  });

  it('refuses the proposer as their own approver (§5.2)', async () => {
    // Raised by the manager, deliberately. A clerk has no approve grant, so a
    // clerk approving their own proposal would be refused by §5.3 and this test
    // would pass without ever reaching the rule it is named after.
    const proposal = await withScope(scope(manager), (tx) =>
      investments.propose(tx, manager, {
        typeCode: 'TYPE-UNDER-TEST',
        branchCode: BAGHDAD,
        amountIqd: iqd('500000'),
        currencyCode: 'IQD',
        expectedReturn: '8%',
        riskAssessment: 'Moderate',
        proposedOn: '2026-01-15',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.approve(tx, manager, proposal.id, 'management'),
        ),
      ),
    ).toMatch(/somebody else approves it/i);

    // And somebody else can.
    await withScope(scope(approver), (tx) =>
      investments.approve(tx, approver, proposal.id, 'management'),
    );
  });

  it('records who gave which approval, and when', async () => {
    const proposal = await approvedProposal();
    const { rows } = await ownerPool.query(
      `select management_approved_by, management_approved_at,
              funding_approved_by, funding_approved_at
         from investment_proposal where id = $1`,
      [proposal.id],
    );
    expect(rows[0].management_approved_by).toBe(manager.principal.userId);
    expect(rows[0].funding_approved_by).toBe(approver.principal.userId);
    expect(rows[0].management_approved_at).not.toBeNull();
    expect(rows[0].funding_approved_at).not.toBeNull();
  });

  it('refuses half an approval in the database — a person without a time', async () => {
    const proposal = await approvedProposal();
    await expect(
      ownerPool.query(
        `update investment_proposal set related_party_approved_by = $2 where id = $1`,
        [proposal.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/related_party_approval_complete/);
  });

  it('captures related-party status whether or not it gates anything', async () => {
    const proposal = await approvedProposal({
      isRelatedParty: true,
      relatedPartyNote: 'Director holds 12% of the counterparty',
    });
    const { rows } = await ownerPool.query(
      `select is_related_party, related_party_note from investment_proposal where id = $1`,
      [proposal.id],
    );
    expect(rows[0].is_related_party).toBe(true);
    expect(rows[0].related_party_note).toMatch(/12%/);
  });
});

describe('13.2 · related-party approval, where the type requires it', () => {
  beforeEach(async () => {
    await financeConfigures({ relatedPartyApprovalRequired: true });
  });

  it('refuses acquisition of a related-party investment without the third approval', async () => {
    const proposal = await approvedProposal({ isRelatedParty: true });

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.acquire(tx, manager, {
            proposalId: proposal.id,
            description: 'Shares',
            acquiredOn: '2026-01-20',
            units: units('1000'),
            amountTxn: iqd('500000'),
            amountIqd: iqd('500000'),
            bankCashAccountId: bankAccountId,
          }),
        ),
      ),
    ).toMatch(/related-party/i);
  });

  it('accepts it once given', async () => {
    const proposal = await approvedProposal({ isRelatedParty: true });
    await withScope(scope(approver), (tx) =>
      investments.approve(tx, approver, proposal.id, 'related_party'),
    );

    const held = await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'Shares',
        acquiredOn: '2026-01-20',
        units: units('1000'),
        amountTxn: iqd('500000'),
        amountIqd: iqd('500000'),
        bankCashAccountId: bankAccountId,
      }),
    );
    expect(held.id).toBeTruthy();
  });

  it('does not demand it where the type does not — the rule is configuration', async () => {
    await ownerPool.query(
      `update investment_type set related_party_approval_required = false
        where code = 'TYPE-UNDER-TEST'`,
    );
    const proposal = await approvedProposal({ isRelatedParty: true });
    const held = await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'Shares',
        acquiredOn: '2026-01-20',
        units: units('1000'),
        amountTxn: iqd('500000'),
        amountIqd: iqd('500000'),
        bankCashAccountId: bankAccountId,
      }),
    );
    expect(held.id).toBeTruthy();
  });
});

describe('13.3 gate · acquisition (§13 acceptance 1)', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('creates the register entry and the accounting entry in one transaction', async () => {
    const held = await acquired();

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [held.journalEntryId],
    );
    expect(rows[0]).toMatchObject({ code: 'A9INVCST', debit_iqd: '500000.0000' });
    expect(rows[1]).toMatchObject({ code: 'A9INVBNK', credit_iqd: '500000.0000' });
  });

  it('credits the bank the money left, not an account a mapping chose', async () => {
    // The correction Phase 07 made for supplier payments, kept here: §13 says
    // Treasury provides the funding, and the ledger has to say which account.
    const held = await acquired();
    const { rows } = await ownerPool.query(
      `select a.code from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.credit_iqd > 0`,
      [held.journalEntryId],
    );
    expect(rows[0].code).toBe('A9INVBNK');
  });

  it('refuses at the database too — no register entry without both approvals', async () => {
    const proposal = await withScope(scope(clerk), (tx) =>
      investments.propose(tx, clerk, {
        typeCode: 'TYPE-UNDER-TEST',
        branchCode: BAGHDAD,
        amountIqd: iqd('500000'),
        currencyCode: 'IQD',
        expectedReturn: '8%',
        riskAssessment: 'Moderate',
        proposedOn: '2026-01-15',
      }),
    );

    await expect(
      ownerPool.query(
        `insert into investment
           (investment_no, type_code, proposal_id, branch_code, description,
            currency_code, created_by)
         values ('INV-BYPASS','TYPE-UNDER-TEST',$1,$2,'Bypass','IQD',$3)`,
        [proposal.id, BAGHDAD, manager.principal.userId],
      ),
    ).rejects.toThrow(/is not fully approved/);
  });

  it('spends a proposal once — a control that could be spent twice is not one', async () => {
    const proposal = await approvedProposal();
    await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'Shares',
        acquiredOn: '2026-01-20',
        units: units('1000'),
        amountTxn: iqd('500000'),
        amountIqd: iqd('500000'),
        bankCashAccountId: bankAccountId,
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.acquire(tx, manager, {
            proposalId: proposal.id,
            description: 'Shares again',
            acquiredOn: '2026-01-21',
            units: units('1000'),
            amountTxn: iqd('500000'),
            amountIqd: iqd('500000'),
            bankCashAccountId: bankAccountId,
          }),
        ),
      ),
    ).toMatch(/investment_proposal_uniq|duplicate key/i);
  });

  it('a capital call increases cost and units and posts again', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.fund(tx, manager, held.id, {
        fundedOn: '2026-02-10',
        units: units('200'),
        amountTxn: iqd('100000'),
        amountIqd: iqd('100000'),
        bankCashAccountId: bankAccountId,
      }),
    );

    const { rows } = await ownerPool.query(
      `select units_held, cost_iqd from investment where id = $1`,
      [held.id],
    );
    expect(rows[0].units_held).toBe('1200.000000');
    expect(rows[0].cost_iqd).toBe('600000.0000');

    const { rows: fundings } = await ownerPool.query(
      `select count(*)::int as n from investment_funding where investment_id = $1`,
      [held.id],
    );
    expect(fundings[0].n).toBe(2);
  });
});

describe('13.4 gate · income (§13 acceptance 3)', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('posts Dr Bank / Cr the income account the type names', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);

    const income = await withScope(scope(manager), (tx) =>
      investments.recordIncome(tx, manager, held.id, {
        kind: 'dividend',
        receivedOn: '2026-03-15',
        amountTxn: iqd('20000'),
        amountIqd: iqd('20000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [income.journalEntryId],
    );
    expect(rows[0]).toMatchObject({ code: 'A9INVBNK', debit_iqd: '20000.0000' });
    expect(rows[1]).toMatchObject({ code: 'R9INVINC', credit_iqd: '20000.0000' });
  });

  it('cannot record income without source evidence', async () => {
    const held = await acquired();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.recordIncome(tx, manager, held.id, {
            kind: 'dividend',
            receivedOn: '2026-03-15',
            amountTxn: iqd('20000'),
            amountIqd: iqd('20000'),
            bankCashAccountId: bankAccountId,
            evidenceAttachmentId: randomUUID(),
          }),
        ),
      ),
    ).toMatch(/rest on source evidence/i);
  });

  it('has nowhere to record income without evidence — the column is NOT NULL', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'investment_income'
          and column_name in ('evidence_attachment_id','bank_cash_account_id')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.is_nullable).toBe('NO');
  });

  it('traces to the bank account the money arrived in', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    const income = await withScope(scope(manager), (tx) =>
      investments.recordIncome(tx, manager, held.id, {
        kind: 'profit share',
        receivedOn: '2026-03-15',
        amountTxn: iqd('5000'),
        amountIqd: iqd('5000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    const { rows } = await ownerPool.query(
      `select bank_cash_account_id, evidence_attachment_id from investment_income where id = $1`,
      [income.id],
    );
    expect(rows[0].bank_cash_account_id).toBe(bankAccountId);
    expect(rows[0].evidence_attachment_id).toBe(doc);
  });

  it('takes whatever kind of return the instrument pays — §13 lists examples, not a set', async () => {
    const held = await acquired();
    // Three, not five: each one posts a full journal and the point is made by
    // the last of them, which is a kind no blueprint ever named.
    for (const kind of ['dividend', 'interest', 'a kind nobody listed']) {
      const doc = await evidence(held.id);
      await withScope(scope(manager), (tx) =>
        investments.recordIncome(tx, manager, held.id, {
          kind,
          receivedOn: '2026-03-15',
          amountTxn: iqd('1000'),
          amountIqd: iqd('1000'),
          bankCashAccountId: bankAccountId,
          evidenceAttachmentId: doc,
        }),
      );
    }
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from investment_income where investment_id = $1`,
      [held.id],
    );
    expect(rows[0].n).toBe(3);
  });
});

describe('13.5 gate · valuation history is preserved, never overwritten', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('keeps every valuation, with its method and its approver', async () => {
    const held = await acquired();
    for (const [on, value] of [
      ['2026-03-31', '520000'],
      ['2026-06-30', '540000'],
      ['2026-09-30', '480000'],
    ] as const) {
      await withScope(scope(manager), (tx) =>
        investments.value(tx, manager, held.id, {
          valuedOn: on,
          methodCode: 'METHOD-UNDER-TEST',
          valueTxn: iqd(value),
          valueIqd: iqd(value),
        }),
      );
    }

    const history = await withScope(scope(manager), (tx) => investments.valuations(tx, held.id));
    expect(history).toHaveLength(3);
    expect(history.map((v) => v.valuedOn)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30']);
    for (const row of history) {
      expect(row.methodCode).toBe('METHOD-UNDER-TEST');
      expect(row.approvedBy).toBe(manager.principal.userId);
      expect(row.approvedAt).not.toBeNull();
    }
  });

  it('refuses to edit a valuation, at the database — §13 says they are preserved', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('520000'),
        valueIqd: iqd('520000'),
      }),
    );

    await expect(
      ownerPool.query(`update investment_valuation set value_iqd = 1 where investment_id = $1`, [
        held.id,
      ]),
    ).rejects.toThrow(/A valuation is not edited/);
  });

  it('refuses to delete one either', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('520000'),
        valueIqd: iqd('520000'),
      }),
    );

    await expect(
      ownerPool.query(`delete from investment_valuation where investment_id = $1`, [held.id]),
    ).rejects.toThrow(/A valuation is not edited/);
  });

  it('gives one answer for the value on a date', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('520000'),
        valueIqd: iqd('520000'),
      }),
    );

    await expect(
      ownerPool.query(
        `insert into investment_valuation
           (investment_id, valued_on, method_code, value_txn, value_iqd, approved_by)
         values ($1,'2026-03-31','METHOD-UNDER-TEST',1,1,$2)`,
        [held.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/investment_valuation_date_uniq|duplicate key/);
  });

  it('reads carrying value from the history rather than from a column', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'investment' and column_name like '%carrying%'`,
    );
    // Absent on purpose: a column would be a second opinion about the latest
    // valuation, and would drift the first time one was corrected.
    expect(rows).toHaveLength(0);

    const held = await acquired();
    const before = await withScope(scope(manager), (tx) =>
      investments.carryingValueOf(tx, held.id),
    );
    expect(before.carryingIqd).toBe(iqd('500000')); // cost, before any valuation

    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('560000'),
        valueIqd: iqd('560000'),
      }),
    );
    const after = await withScope(scope(manager), (tx) => investments.carryingValueOf(tx, held.id));
    expect(after.carryingIqd).toBe(iqd('560000'));
  });

  it('impairment reduces carrying value and stays separate from valuation', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('560000'),
        valueIqd: iqd('560000'),
      }),
    );

    await withScope(scope(manager), (tx) =>
      investments.impair(tx, manager, held.id, {
        impairedOn: '2026-06-30',
        amountIqd: iqd('60000'),
        basis: 'Counterparty downgraded; recoverable amount reassessed by Finance',
      }),
    );

    const value = await withScope(scope(manager), (tx) => investments.carryingValueOf(tx, held.id));
    expect(value.valuedIqd).toBe(iqd('560000'));
    expect(value.impairedIqd).toBe(iqd('60000'));
    expect(value.carryingIqd).toBe(iqd('500000'));
  });

  it('refuses an impairment with no stated basis — the trigger is D2’s, the reason is Finance’s', async () => {
    const held = await acquired();
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.impair(tx, manager, held.id, {
            impairedOn: '2026-06-30',
            amountIqd: iqd('1000'),
            basis: '   ',
          }),
        ),
      ),
    ).toMatch(/states the basis/i);
  });

  it('refuses an impairment beyond carrying value', async () => {
    const held = await acquired();
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.impair(tx, manager, held.id, {
            impairedOn: '2026-06-30',
            amountIqd: iqd('900000'),
            basis: 'Too much',
          }),
        ),
      ),
    ).toMatch(/that is a disposal/i);
  });
});

describe('13.6 gate · disposal', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('reduces units and carrying value proportionally on a partial disposal', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);

    const result = await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('250'),
        proceedsTxn: iqd('140000'),
        proceedsIqd: iqd('140000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    expect(result.isFullDisposal).toBe(false);
    expect(result.realisedResultIqd).toBe(iqd('15000')); // 140,000 − 125,000

    const { rows } = await ownerPool.query(
      `select units_held, cost_iqd from investment where id = $1`,
      [held.id],
    );
    expect(rows[0].units_held).toBe('750.000000');
    expect(rows[0].cost_iqd).toBe('375000.0000');
  });

  it('computes a loss when proceeds fall short', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    const result = await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('250'),
        proceedsTxn: iqd('100000'),
        proceedsIqd: iqd('100000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );
    expect(result.realisedResultIqd).toBe(-iqd('25000'));

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and a.code = 'X9INVLOS'`,
      [result.journalEntryId],
    );
    expect(rows[0].debit_iqd).toBe('25000.0000');
  });

  it('clears the holding to zero on a full disposal', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    const result = await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('1000'),
        proceedsTxn: iqd('600000'),
        proceedsIqd: iqd('600000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    expect(result.isFullDisposal).toBe(true);
    expect(result.realisedResultIqd).toBe(iqd('100000'));

    const { rows } = await ownerPool.query(
      `select units_held, cost_iqd, status::text, disposed_on from investment where id = $1`,
      [held.id],
    );
    expect(rows[0].units_held).toBe('0.000000');
    expect(rows[0].cost_iqd).toBe('0.0000');
    expect(rows[0].status).toBe('closed');
    expect(rows[0].disposed_on).not.toBeNull();
  });

  it('cannot dispose of more than is held, at the database too', async () => {
    const held = await acquired();
    await expect(
      ownerPool.query(
        `insert into investment_disposal
           (investment_id, disposal_no, disposed_on, units_disposed, proceeds_txn, proceeds_iqd,
            carrying_value_disposed_iqd, realised_result_iqd, is_full_disposal,
            bank_cash_account_id, evidence_attachment_id, posted_by)
         values ($1,'IND-BYPASS','2026-06-30',5000,1,1,1,0,false,$2,$3,$4)`,
        [held.id, bankAccountId, await evidence(held.id), manager.principal.userId],
      ),
    ).rejects.toThrow(/holds .* units and the disposal is for/);
  });

  it('cannot dispose without source evidence — the column is NOT NULL', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'investment_disposal'
          and column_name in ('evidence_attachment_id','bank_cash_account_id')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.is_nullable).toBe('NO');
  });

  it('refuses a second full disposal', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('1000'),
        proceedsTxn: iqd('600000'),
        proceedsIqd: iqd('600000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          investments.dispose(tx, manager, held.id, {
            disposedOn: '2026-07-01',
            unitsDisposed: units('1'),
            proceedsTxn: iqd('1'),
            proceedsIqd: iqd('1'),
            bankCashAccountId: bankAccountId,
            evidenceAttachmentId: doc,
          }),
        ),
      ),
    ).toMatch(/already been disposed of/i);
  });
});

describe('13.7 gate · the calendar', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('shows maturity, review and capital calls in one list', async () => {
    const held = await acquired({ maturityDate: '2026-03-01' });
    await ownerPool.query(`update investment set next_review_on = '2026-02-15' where id = $1`, [
      held.id,
    ]);
    await withScope(scope(manager), (tx) =>
      investments.raiseCapitalCall(tx, manager, held.id, {
        dueOn: '2026-02-01',
        amountTxn: iqd('100000'),
        amountIqd: iqd('100000'),
        note: 'Second tranche',
      }),
    );

    const rows = await withScope(scope(manager), (tx) =>
      investments.calendar(tx, manager, '2026-03-31'),
    );
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('maturity');
    expect(kinds).toContain('review');
    expect(kinds).toContain('capital_call');
    // Chronological, so a person planning a month reads it top to bottom.
    expect(rows.map((r) => r.due_on)).toEqual([...rows.map((r) => r.due_on)].sort());
  });

  it('drops a capital call once it is funded', async () => {
    const held = await acquired();
    const call = await withScope(scope(manager), (tx) =>
      investments.raiseCapitalCall(tx, manager, held.id, {
        dueOn: '2026-02-01',
        amountTxn: iqd('100000'),
        amountIqd: iqd('100000'),
      }),
    );

    await withScope(scope(manager), (tx) =>
      investments.fund(tx, manager, held.id, {
        fundedOn: '2026-02-01',
        units: units('200'),
        amountTxn: iqd('100000'),
        amountIqd: iqd('100000'),
        bankCashAccountId: bankAccountId,
        capitalCallId: call.id,
      }),
    );

    const rows = await withScope(scope(manager), (tx) =>
      investments.calendar(tx, manager, '2026-03-31'),
    );
    expect(rows.filter((r) => r.kind === 'capital_call')).toHaveLength(0);
  });
});

describe('13.8 gate · the portfolio reconciles to the G/L', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('reports cost, carrying value, income and realised result per holding', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    await withScope(scope(manager), (tx) =>
      investments.recordIncome(tx, manager, held.id, {
        kind: 'dividend',
        receivedOn: '2026-03-15',
        amountTxn: iqd('20000'),
        amountIqd: iqd('20000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );
    await withScope(scope(manager), (tx) =>
      investments.value(tx, manager, held.id, {
        valuedOn: '2026-03-31',
        methodCode: 'METHOD-UNDER-TEST',
        valueTxn: iqd('560000'),
        valueIqd: iqd('560000'),
      }),
    );

    const rows = await withScope(scope(manager), (tx) => investments.register(tx, manager));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costIqd: '500000.0000',
      carryingValueIqd: '560000.0000',
      incomeIqd: '20000.0000',
    });
  });

  it('reconciles cost to the investment cost account', async () => {
    await acquired();

    const rows = await withScope(scope(manager), (tx) => investments.register(tx, manager));
    const registerCost = rows.reduce((sum, r) => sum + Number(r.costIqd), 0);

    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'A9INVCST'`,
    );
    expect(registerCost).toBe(Number(ledger[0].balance));
  });

  it('reports realised and unrealised separately', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('250'),
        proceedsTxn: iqd('140000'),
        proceedsIqd: iqd('140000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    const totals = await withScope(scope(manager), (tx) => investments.portfolio(tx, manager));
    expect(totals.realisedResultIqd).toBe('15000.0000');
    // Carrying value is now cost, since no valuation has been made: unrealised nil.
    expect(totals.unrealisedResultIqd).toBe('0.0000');
  });

  it('leaves fully disposed holdings out unless asked for', async () => {
    const held = await acquired();
    const doc = await evidence(held.id);
    await withScope(scope(manager), (tx) =>
      investments.dispose(tx, manager, held.id, {
        disposedOn: '2026-06-30',
        unitsDisposed: units('1000'),
        proceedsTxn: iqd('600000'),
        proceedsIqd: iqd('600000'),
        bankCashAccountId: bankAccountId,
        evidenceAttachmentId: doc,
      }),
    );

    const open = await withScope(scope(manager), (tx) => investments.register(tx, manager));
    const all = await withScope(scope(manager), (tx) =>
      investments.register(tx, manager, { includeDisposed: true }),
    );
    expect(open).toHaveLength(0);
    expect(all).toHaveLength(1);
  });

  it('respects data scope — another branch sees none of this one’s', async () => {
    await acquired();
    await seedBranch('BSR', 'Basra');

    const outsider = await createUser('accounting_manager');
    await ownerPool.query(`delete from user_branch_scope where user_id = $1`, [
      outsider.principal.userId,
    ]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,'BSR')`, [
      outsider.principal.userId,
    ]);
    const reloaded = await withScope(
      { userId: outsider.principal.userId, branchCode: 'BSR' },
      (tx) => authz.loadPrincipal(tx, outsider.principal.userId),
    );
    const basra: ActorContext = { principal: reloaded, branchCode: 'BSR' };

    const rows = await withScope({ userId: basra.principal.userId, branchCode: 'BSR' }, (tx) =>
      investments.register(tx, basra),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('13.8 gate · the investment forecast feeds Phase 07.8', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('an unmet capital call appears in the Treasury cash-flow forecast', async () => {
    const held = await acquired();
    await withScope(scope(manager), (tx) =>
      investments.raiseCapitalCall(tx, manager, held.id, {
        dueOn: '2026-02-15',
        amountTxn: iqd('300000'),
        amountIqd: iqd('300000'),
        note: 'Second tranche',
      }),
    );

    const forecast = await withScope(scope(manager), (tx) =>
      cashForecast.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        bucket: 'month',
        branchCode: BAGHDAD,
      }),
    );

    const line = forecast.lines.find((l) => l.source === 'investment_calls');
    expect(line).toBeDefined();
    // Money leaving, so it is an outflow — the same convention every other
    // outflow in §17's forecast uses.
    expect(line!.outflowIqd).toBe('300000.0000');
  });

  it('carries a foreign-currency call into the forecast in dinars, not in its own currency', async () => {
    // Every other capital-call test holds an IQD investment, where the
    // transaction amount and its base equivalent are the same number — so a
    // forecast reading the wrong column of the two still gave the right answer.
    // This one holds dollars, where the two differ by a factor of 1,310.
    const proposal = await approvedProposal({
      currencyCode: 'USD',
      amountIqd: iqd('13100000'),
    });
    const held = await withScope(scope(manager), (tx) =>
      investments.acquire(tx, manager, {
        proposalId: proposal.id,
        description: 'USD-denominated note',
        acquiredOn: '2026-01-20',
        units: units('100'),
        amountTxn: iqd('10000'), // USD
        amountIqd: iqd('13100000'), // at 1,310
        bankCashAccountId: bankAccountId,
      }),
    );

    await withScope(scope(manager), (tx) =>
      investments.raiseCapitalCall(tx, manager, held.id, {
        dueOn: '2026-02-15',
        amountTxn: iqd('1000'), // USD 1,000
        amountIqd: iqd('1310000'), // at 1,310
      }),
    );

    const forecast = await withScope(scope(manager), (tx) =>
      cashForecast.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        bucket: 'month',
        branchCode: BAGHDAD,
      }),
    );

    const line = forecast.lines.find((l) => l.source === 'investment_calls');
    expect(line).toBeDefined();
    // 1,310,000 dinars. Reading amount_txn would say 1,000 — a plausible-looking
    // number, wrong by the exchange rate, in a treasurer's cash forecast.
    expect(line!.outflowIqd).toBe('1310000.0000');
  });

  it('drops the call from the forecast once it is funded — the money has gone', async () => {
    const held = await acquired();
    const call = await withScope(scope(manager), (tx) =>
      investments.raiseCapitalCall(tx, manager, held.id, {
        dueOn: '2026-02-15',
        amountTxn: iqd('300000'),
        amountIqd: iqd('300000'),
      }),
    );
    await withScope(scope(manager), (tx) =>
      investments.fund(tx, manager, held.id, {
        fundedOn: '2026-02-15',
        units: units('100'),
        amountTxn: iqd('300000'),
        amountIqd: iqd('300000'),
        bankCashAccountId: bankAccountId,
        capitalCallId: call.id,
      }),
    );

    const forecast = await withScope(scope(manager), (tx) =>
      cashForecast.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        bucket: 'month',
        branchCode: BAGHDAD,
      }),
    );
    expect(forecast.lines.find((l) => l.source === 'investment_calls')).toBeUndefined();
  });

  it('declares itself an available source, so the treasurer knows what was drawn on', async () => {
    const forecast = await withScope(scope(manager), (tx) =>
      cashForecast.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        bucket: 'month',
        branchCode: BAGHDAD,
      }),
    );
    const status = forecast.sources.find((s) => s.source === 'investment_calls');
    expect(status).toBeDefined();
    expect(status!.available).toBe(true);
  });
});

describe('13.4 gate · income reconciles to the income G/L account', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('income by investment ties to the account the type maps to', async () => {
    const held = await acquired();
    for (const amount of ['20000', '5000', '7500']) {
      const doc = await evidence(held.id);
      await withScope(scope(manager), (tx) =>
        investments.recordIncome(tx, manager, held.id, {
          kind: 'dividend',
          receivedOn: '2026-03-15',
          amountTxn: iqd(amount),
          amountIqd: iqd(amount),
          bankCashAccountId: bankAccountId,
          evidenceAttachmentId: doc,
        }),
      );
    }

    const rows = await withScope(scope(manager), (tx) => investments.register(tx, manager));
    const registerIncome = rows.reduce((sum, r) => sum + Number(r.incomeIqd), 0);

    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd - l.debit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'R9INVINC'`,
    );

    expect(registerIncome).toBe(32500);
    expect(registerIncome).toBe(Number(ledger[0].balance));
  });
});

describe('13.4 / 13.6 · two events on one day are two journals', () => {
  beforeEach(async () => {
    await financeConfigures();
  });

  it('records a dividend and an interest coupon on the same day as two postings', async () => {
    // The posting engine treats (module, document, event) as a posting's
    // identity. Keying the event on the *date* meant a holding that paid twice
    // in a day produced two income rows against one journal — the second
    // silently reusing the first. The document number is the identity now,
    // because a number is unique by construction and a date is not.
    const held = await acquired();

    for (const [kind, amount] of [
      ['dividend', '20000'],
      ['interest', '5000'],
    ] as const) {
      const doc = await evidence(held.id);
      await withScope(scope(manager), (tx) =>
        investments.recordIncome(tx, manager, held.id, {
          kind,
          receivedOn: '2026-03-15',
          amountTxn: iqd(amount),
          amountIqd: iqd(amount),
          bankCashAccountId: bankAccountId,
          evidenceAttachmentId: doc,
        }),
      );
    }

    const { rows } = await ownerPool.query(
      `select count(distinct journal_entry_id)::int as journals, count(*)::int as rows
         from investment_income where investment_id = $1`,
      [held.id],
    );
    expect(rows[0].rows).toBe(2);
    expect(rows[0].journals).toBe(2);

    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd - l.debit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'R9INVINC'`,
    );
    expect(Number(ledger[0].balance)).toBe(25000);
  });

  it('records two impairments on the same day as two postings', async () => {
    const held = await acquired();
    for (const amount of ['10000', '5000']) {
      await withScope(scope(manager), (tx) =>
        investments.impair(tx, manager, held.id, {
          impairedOn: '2026-06-30',
          amountIqd: iqd(amount),
          basis: `Reassessed by Finance — tranche ${amount}`,
        }),
      );
    }

    const { rows } = await ownerPool.query(
      `select count(distinct journal_entry_id)::int as journals, count(*)::int as rows
         from investment_impairment where investment_id = $1`,
      [held.id],
    );
    expect(rows[0].rows).toBe(2);
    expect(rows[0].journals).toBe(2);

    const value = await withScope(scope(manager), (tx) => investments.carryingValueOf(tx, held.id));
    expect(value.impairedIqd).toBe(iqd('15000'));
  });

  it('records two partial disposals on the same day as two postings', async () => {
    const held = await acquired();
    for (const slice of ['100', '150']) {
      const doc = await evidence(held.id);
      await withScope(scope(manager), (tx) =>
        investments.dispose(tx, manager, held.id, {
          disposedOn: '2026-06-30',
          unitsDisposed: units(slice),
          proceedsTxn: iqd('60000'),
          proceedsIqd: iqd('60000'),
          bankCashAccountId: bankAccountId,
          evidenceAttachmentId: doc,
        }),
      );
    }

    const { rows } = await ownerPool.query(
      `select count(distinct journal_entry_id)::int as journals, count(*)::int as rows
         from investment_disposal where investment_id = $1`,
      [held.id],
    );
    expect(rows[0].rows).toBe(2);
    expect(rows[0].journals).toBe(2);

    const { rows: remaining } = await ownerPool.query(
      `select units_held from investment where id = $1`,
      [held.id],
    );
    expect(remaining[0].units_held).toBe('750.000000');
  });
});
