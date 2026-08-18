/**
 * Phase 09 test gates — Money Transfer, §12.
 *
 * Sub-phases 09.1 to 09.5 and 09.7 to 09.9. The Bank Execution Batch (09.6),
 * the client-funded import (09.10) and the report set (09.11) have their own
 * files.
 *
 * Every rule that matters is asserted twice: once through the service, so the
 * caller gets a sentence, and once straight at the database as the application
 * role, so the rule holds on the paths this test is not on. §12.7's own gate
 * asks for the second one in terms — *"the system prevents editing after
 * Initiate Transfer"* is not a statement about a form.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asApp, ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as client from '@/server/services/money-transfer-client';
import * as mt from '@/server/services/money-transfer';
import * as subledger from '@/server/services/subledger';
import { parseDecimal, toDecimalString } from '@domain/money';
import {
  approveKycFor,
  BRANCH,
  buildWorld,
  OTHER_BRANCH,
  scopeOf,
  type Phase09World,
} from './phase09-fixture';

const iqd = (value: string) => parseDecimal(value, 4n);
const show = (value: bigint) => toDecimalString(value, 4n);

const FEB = '2026-02-10';

let world: Phase09World;

beforeEach(async () => {
  await resetTestData();
  world = await buildWorld();
});

/** Opens an account, pays in the given amounts and posts each deposit. */
async function fundedAccount(amounts: string[]): Promise<{ id: string; accountNo: string }> {
  const account = await withScope(scopeOf(world.clerk), (tx) =>
    client.openAccount(tx, world.clerk, {
      partnerId: world.clientPartnerId,
      branchCode: BRANCH,
      openedOn: '2026-02-01',
    }),
  );

  for (const [index, amount] of amounts.entries()) {
    const deposit = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordDeposit(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        depositDate: `2026-02-0${index + 1}`,
        method: index % 2 === 0 ? 'cash' : 'bank_transfer',
        companyBankAccountId: world.bankAccountId,
        amountIqd: iqd(amount),
        bankReference: `SLIP-${index + 1}`,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.postDeposit(tx, world.manager, deposit.id),
    );
  }

  return account;
}

/** A transfer of the standard worked example, left at Funded. */
async function fundedTransfer(accountId: string, amountIqd = '13050000') {
  await withScope(scopeOf(world.manager), (tx) =>
    client.confirmFunding(tx, world.manager, accountId, iqd(amountIqd)),
  );

  const transfer = await withScope(scopeOf(world.clerk), (tx) =>
    mt.createTransfer(tx, world.clerk, {
      clientAccountId: accountId,
      branchCode: BRANCH,
      transferDate: FEB,
      requestedUsd: iqd('9000'),
      officialRateId: world.rates.officialId,
      clientRateId: world.rates.clientId,
      transferAmountIqd: iqd(amountIqd),
      companyBankAccountId: world.bankAccountId,
      beneficiaryName: 'Beneficiary Trading LLC',
      beneficiaryBank: 'Gulf Bank',
      beneficiaryAccount: 'GB-99887766',
      beneficiaryCountry: 'AE',
    }),
  );

  await withScope(scopeOf(world.manager), (tx) => mt.markFunded(tx, world.manager, transfer.id));
  return transfer;
}

// ===========================================================================
// 09.1 — Client accounts and KYC
// ===========================================================================

describe('09.1 — client accounts and KYC (§12.2, §21, Appendix E)', () => {
  it('a client account uses the central Business Partner record, not a module-local copy', async () => {
    // §6: "one record serves CRM, Sales, Finance, Projects, Logistics and Money
    // Transfer." The gate is met by the columns that are *absent*: there is
    // nowhere on the account to keep a second name or address, so there is no
    // copy that could drift from the partner.
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'money_transfer_client_account'`,
    );
    const columns = rows.map((r) => r.column_name as string);

    for (const forbidden of [
      'legal_name',
      'trade_name',
      'name',
      'address',
      'email',
      'phone',
      'tax_identifier',
      'registration_no',
    ]) {
      expect(columns, `money_transfer_client_account must not carry ${forbidden}`).not.toContain(
        forbidden,
      );
    }

    // And the link to the one authoritative record is mandatory.
    const { rows: partnerColumn } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'money_transfer_client_account' and column_name = 'partner_id'`,
    );
    expect(partnerColumn[0].is_nullable).toBe('NO');
  });

  it('refuses an account for a partner who does not hold the customer role (§6)', async () => {
    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        client.openAccount(tx, world.clerk, {
          partnerId: world.vendorPartnerId,
          branchCode: BRANCH,
          openedOn: '2026-02-01',
        }),
      ),
    );
    expect(message).toMatch(/does not hold the customer role/i);
  });

  it('KYC documents attach through the Phase 01 attachment service with correct classification', async () => {
    await ownerPool.query(
      `insert into kyc_required_document (code, name) values ('PASSPORT','Passport')`,
    );

    const kycId = await withScope(scopeOf(world.clerk), (tx) =>
      client.raiseKyc(tx, world.clerk, { partnerId: world.clientPartnerId }),
    );

    const attached = await withScope(scopeOf(world.clerk), (tx) =>
      client.attachKycDocument(tx, world.clerk, {
        kycRecordId: kycId.id,
        requiredDocumentCode: 'PASSPORT',
        fileName: 'passport.pdf',
        content: Buffer.from('%PDF-1.4 passport scan'),
        providedOn: '2026-02-01',
        expiresOn: '2030-01-01',
      }),
    );

    // It is a real Phase 01 attachment — scanned, versioned, access-logged —
    // rather than a byte array this module kept for itself.
    const { rows: attachment } = await ownerPool.query(
      `select object_type, object_id, file_name, version from attachment where id = $1`,
      [attached.attachmentId],
    );
    expect(attachment[0].object_type).toBe('client_kyc_record');
    expect(attachment[0].object_id).toBe(kycId.id);
    expect(attachment[0].version).toBe(1);

    // The classification: which requirement this file answers.
    const { rows: link } = await ownerPool.query(
      `select required_document_code from client_kyc_document where id = $1`,
      [attached.id],
    );
    expect(link[0].required_document_code).toBe('PASSPORT');
  });

  it('a transfer cannot be initiated for a client whose KYC is incomplete', async () => {
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    // No KYC record at all.
    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        mt.initiateTransfer(tx, world.manager, transfer.id),
      ),
    );
    expect(message).toMatch(/no approved KYC record/i);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    // The 09.5 gate asks for locks to hold on the API and import paths, and the
    // same applies to this one: a status change made straight against the table
    // as the application role is exactly what those paths do.
    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update money_transfer set status = 'posted' where id = $1`, [transfer.id]),
      ),
    );
    expect(message).toMatch(/no approved KYC record|cannot be initiated/i);
  });

  it('refuses a client whose KYC has expired before the transfer date', async () => {
    await approveKycFor(world, world.clientPartnerId, { expiresOn: '2026-01-31' });

    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        mt.initiateTransfer(tx, world.manager, transfer.id),
      ),
    );
    expect(message).toMatch(/expired on 2026-01-31/i);
  });

  it('refuses a client missing a required document, and names it', async () => {
    // Appendix E's risk-based controls are Compliance's to configure (D9). With
    // a requirement on file and no document against it, the transfer stops.
    await ownerPool.query(
      `insert into kyc_required_document (code, name) values ('SOURCE_OF_FUNDS','Source of funds')`,
    );
    await approveKycFor(world, world.clientPartnerId);

    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        mt.initiateTransfer(tx, world.manager, transfer.id),
      ),
    );
    expect(message).toMatch(/SOURCE_OF_FUNDS/);
  });

  it('KYC records are visible from both the partner record and the transfer case', async () => {
    await approveKycFor(world, world.clientPartnerId);

    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const [fromPartner, fromAccount, fromTransfer] = await withScope(
      scopeOf(world.manager),
      async (tx) => [
        await client.kycFor(tx, { partnerId: world.clientPartnerId }),
        await client.kycFor(tx, { clientAccountId: account.id }),
        await client.kycFor(tx, { moneyTransferId: transfer.id }),
      ],
    );

    // The same record reached three ways, because there is only one record.
    expect(fromPartner).toHaveLength(1);
    expect(fromAccount.map((r) => r.id)).toEqual(fromPartner.map((r) => r.id));
    expect(fromTransfer.map((r) => r.id)).toEqual(fromPartner.map((r) => r.id));
    expect(fromTransfer[0]!.partnerCode).toBe(world.clientPartnerCode);
  });

  it('the person who raised a KYC record cannot approve it (§5.2)', async () => {
    const raised = await withScope(scopeOf(world.manager), async (tx) => {
      const record = await client.raiseKyc(tx, world.manager, {
        partnerId: world.clientPartnerId,
      });
      await client.submitKyc(tx, world.manager, record.id);
      return record;
    });

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        client.approveKyc(tx, world.manager, raised.id),
      ),
    );
    expect(message).toMatch(/cannot approve it/i);
  });

  it('a renewal supersedes rather than overwrites, so history stays answerable (§21)', async () => {
    const first = await approveKycFor(world, world.clientPartnerId);
    const second = await approveKycFor(world, world.clientPartnerId);

    const { rows } = await ownerPool.query(
      `select id, superseded_by from client_kyc_record where partner_id = $1 order by created_at`,
      [world.clientPartnerId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first);
    expect(rows[0].superseded_by).toBe(second);
    expect(rows[1].superseded_by).toBeNull();
  });

  it('an approved KYC record is evidence and cannot be edited at the database', async () => {
    const kycId = await approveKycFor(world, world.clientPartnerId);

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update client_kyc_record set expires_on = '2099-01-01' where id = $1`, [kycId]),
      ),
    );
    expect(message).toMatch(/is approved|Supersede it/i);
  });
});

// ===========================================================================
// 09.2 — Client deposits
// ===========================================================================

describe('09.2 — client deposits (§12.3, §12.4)', () => {
  it('multiple partial deposits accumulate against one client account', async () => {
    // §12.3: "A client can make one or several partial deposits."
    const account = await fundedAccount(['5000000', '7000000', '3000000']);

    const balance = await withScope(scopeOf(world.manager), (tx) =>
      client.clearingBalance(tx, account.id),
    );
    expect(show(balance)).toBe('15000000.0000');

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from money_transfer_deposit where client_account_id = $1`,
      [account.id],
    );
    expect(rows[0].n).toBe(3);
  });

  it('each deposit posts Dr Bank / Cr Client Clearing atomically', async () => {
    const account = await fundedAccount(['5000000']);

    const { rows } = await ownerPool.query(
      `select l.line_role, l.debit_iqd, l.credit_iqd, l.account_id
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where e.source_module = 'money_transfer' and e.source_event = 'posted'
        order by l.line_no`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].line_role).toBe('bank');
    expect(rows[0].debit_iqd).toBe('5000000.0000');
    expect(rows[0].account_id).toBe(world.accounts.bank);
    expect(rows[1].line_role).toBe('client_clearing');
    expect(rows[1].credit_iqd).toBe('5000000.0000');
    expect(rows[1].account_id).toBe(world.accounts.client_clearing);
  });

  it('the deposit row and its journal commit together, or neither does (§24)', async () => {
    const account = await withScope(scopeOf(world.clerk), (tx) =>
      client.openAccount(tx, world.clerk, {
        partnerId: world.clientPartnerId,
        branchCode: BRANCH,
        openedOn: '2026-02-01',
      }),
    );

    const deposit = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordDeposit(tx, world.clerk, {
        clientAccountId: account.id,
        branchCode: BRANCH,
        depositDate: FEB,
        method: 'cash',
        companyBankAccountId: world.bankAccountId,
        amountIqd: iqd('5000000'),
      }),
    );

    // A posting that fails must leave nothing behind — not a half-posted
    // deposit, and not a status that says it posted. The mapping is removed so
    // the engine cannot resolve an account.
    await ownerPool.query(
      `delete from posting_rule where event_type = 'money_transfer.client_deposit'`,
    );

    await rejection(
      withScope(scopeOf(world.manager), (tx) => mt.postDeposit(tx, world.manager, deposit.id)),
    );

    const { rows: after } = await ownerPool.query(
      `select status, journal_entry_id from money_transfer_deposit where id = $1`,
      [deposit.id],
    );
    expect(after[0].status).toBe('draft');
    expect(after[0].journal_entry_id).toBeNull();

    const { rows: journals } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_module = 'money_transfer'`,
    );
    expect(journals[0].n).toBe(0);
  });

  it('the client clearing balance equals deposits less usage at all times', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['5000000', '7000000', '3000000']);

    const before = await withScope(scopeOf(world.manager), (tx) =>
      client.clearingBalance(tx, account.id),
    );
    expect(show(before)).toBe('15000000.0000');

    const transfer = await fundedTransfer(account.id, '9000000');
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const after = await withScope(scopeOf(world.manager), (tx) =>
      client.clearingBalance(tx, account.id),
    );
    expect(show(after)).toBe('6000000.0000');

    // And the deposits say which money went: oldest first (§12.3).
    const { rows } = await ownerPool.query(
      `select d.deposit_no, d.status, d.used_amount_iqd
         from money_transfer_deposit d where d.client_account_id = $1 order by d.deposit_date`,
      [account.id],
    );
    expect(rows.map((r) => [r.status, r.used_amount_iqd])).toEqual([
      ['settled', '5000000.0000'],
      ['partially_executed', '4000000.0000'],
      ['posted', '0.0000'],
    ]);
  });

  it('refuses to consume more of a deposit than it holds, at the database', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['5000000']);
    const transfer = await fundedTransfer(account.id, '5000000');
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const { rows: deposits } = await ownerPool.query(
      `select id from money_transfer_deposit where client_account_id = $1`,
      [account.id],
    );

    // A second allocation on top of a fully consumed deposit. The CHECK refuses
    // it; the service is not involved.
    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(
          `update money_transfer_deposit set used_amount_iqd = used_amount_iqd + 1 where id = $1`,
          [deposits[0].id],
        ),
      ),
    );
    expect(message).toMatch(/money_transfer_deposit_not_over_used|posted/i);
  });

  it('the account cannot be closed while the client has not confirmed funding complete', async () => {
    const account = await fundedAccount(['5000000']);

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        client.closeAccount(tx, world.manager, account.id),
      ),
    );
    expect(message).toMatch(/has not confirmed that funding is complete/i);
  });

  it('refuses the close at the database too, bypassing the service', async () => {
    const account = await fundedAccount(['5000000']);

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(
          `update money_transfer_client_account set status = 'closed',
             closed_at = now(), closed_by = $2 where id = $1`,
          [account.id, world.manager.principal.userId],
        ),
      ),
    );
    expect(message).toMatch(/close_needs_confirmation/i);
  });

  it('no further deposit can be added once funding is confirmed (§12.3)', async () => {
    const account = await fundedAccount(['5000000']);
    await withScope(scopeOf(world.manager), (tx) =>
      client.confirmFunding(tx, world.manager, account.id, iqd('5000000')),
    );

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        mt.recordDeposit(tx, world.clerk, {
          clientAccountId: account.id,
          branchCode: BRANCH,
          depositDate: FEB,
          method: 'cash',
          companyBankAccountId: world.bankAccountId,
          amountIqd: iqd('1000000'),
        }),
      ),
    );
    expect(message).toMatch(/funding was confirmed complete/i);
  });

  it('Client Clearing subledger reconciles to its G/L control account (§1.2)', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['5000000', '7000000', '3000000']);
    const transfer = await fundedTransfer(account.id, '9000000');
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const rows = await withScope(scopeOf(world.manager), (tx) => subledger.reconciliation(tx));
    const clearing = rows.find((r) => r.accountCode === 'MT-CLIENT_CLEARING');

    expect(clearing).toBeDefined();
    expect(clearing!.difference).toBe('0.0000');
    // The client owes nothing and is owed 6,000,000 — a credit balance on a
    // liability, which is what "the company is holding client money" looks like.
    expect(clearing!.subledgerBalance).toBe('-6000000.0000');

    const balances = await withScope(scopeOf(world.manager), (tx) =>
      subledger.balances(tx, 'customer'),
    );
    const forClient = balances.find((b) => b.partyCode === world.clientPartnerCode);
    expect(forClient?.balanceIqd).toBe('-6000000.0000');
  });
});

// ===========================================================================
// 09.3 — Exchange rate reference
// ===========================================================================

describe('09.3 — exchange rate reference (§12.2, §14.3)', () => {
  it('both rates are captured on the transaction and stored historically', async () => {
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const { rows } = await ownerPool.query(
      `select official_rate_id, client_rate_id,
              official_rate_iqd_per_usd, client_rate_iqd_per_usd
         from money_transfer where id = $1`,
      [transfer.id],
    );

    expect(rows[0].official_rate_id).toBe(world.rates.officialId);
    expect(rows[0].client_rate_id).toBe(world.rates.clientId);
    // Snapshots, so a reprint five years from now reproduces (§22).
    expect(rows[0].official_rate_iqd_per_usd).toBe('1450.00000000');
    expect(rows[0].client_rate_iqd_per_usd).toBe('1500.00000000');
  });

  it('rates cannot be edited on the transfer document itself', async () => {
    // §14.3: "Rates are maintained only in the Finance Exchange Rate section."
    // The trigger does not refuse the write — it overwrites it from the
    // published rate, which is a stronger guarantee than a refusal: there is no
    // value anybody can put in this column that survives the statement.
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    await asApp(
      scopeOf(world.manager),
      async (query) => {
        await query(
          `update money_transfer set client_rate_iqd_per_usd = 9999.00000000 where id = $1`,
          [transfer.id],
        );
        const { rows } = await query(
          `select client_rate_iqd_per_usd from money_transfer where id = $1`,
          [transfer.id],
        );
        expect(rows[0].client_rate_iqd_per_usd).toBe('1500.00000000');
      },
      { commit: true },
    );
  });

  it('refuses a market rate where §12.2 asks for the official one', async () => {
    const account = await fundedAccount(['15000000']);
    await withScope(scopeOf(world.manager), (tx) =>
      client.confirmFunding(tx, world.manager, account.id, iqd('13050000')),
    );

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        mt.createTransfer(tx, world.clerk, {
          clientAccountId: account.id,
          branchCode: BRANCH,
          transferDate: FEB,
          requestedUsd: iqd('9000'),
          officialRateId: world.rates.marketId,
          clientRateId: world.rates.clientId,
          transferAmountIqd: iqd('13050000'),
          companyBankAccountId: world.bankAccountId,
          beneficiaryName: 'Beneficiary Trading LLC',
        }),
      ),
    );
    expect(message).toMatch(/must be an accounting rate/i);
  });

  it('refuses the same rate row for both, which would report a spread of zero', async () => {
    const account = await fundedAccount(['15000000']);
    await withScope(scopeOf(world.manager), (tx) =>
      client.confirmFunding(tx, world.manager, account.id, iqd('13050000')),
    );

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        mt.createTransfer(tx, world.clerk, {
          clientAccountId: account.id,
          branchCode: BRANCH,
          transferDate: FEB,
          requestedUsd: iqd('9000'),
          officialRateId: world.rates.officialId,
          clientRateId: world.rates.officialId,
          transferAmountIqd: iqd('13050000'),
          companyBankAccountId: world.bankAccountId,
          beneficiaryName: 'Beneficiary Trading LLC',
        }),
      ),
    );
    expect(message).toMatch(/rates_distinct|must be a client rate/i);
  });

  it('Gross Exchange Spread computes from the two rates and is reproducible', async () => {
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const margin = await withScope(scopeOf(world.manager), (tx) => mt.margin(tx, transfer.id));

    // 9,000 × (1,500 − 1,450), reproduced by hand from the two stored rates.
    expect(show(margin.grossExchangeSpreadIqd)).toBe('450000.0000');
  });
});

// ===========================================================================
// 09.4 — Required transaction data
// ===========================================================================

describe('09.4 — the §12.2 required transaction data', () => {
  it('captures every element §12.2 names', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    const { rows } = await ownerPool.query(
      `select t.client_account_id, a.partner_id, t.requested_usd,
              t.official_rate_id, t.client_rate_id,
              t.transfer_amount_iqd, t.company_bank_account_id,
              t.beneficiary_name, t.beneficiary_bank, t.beneficiary_account,
              t.client_import_file_id, t.logistics_job_id
         from money_transfer t
         join money_transfer_client_account a on a.id = t.client_account_id
        where t.id = $1`,
      [transfer.id],
    );
    const row = rows[0];

    // 1 — client business partner and client account
    expect(row.client_account_id).toBe(account.id);
    expect(row.partner_id).toBe(world.clientPartnerId);
    // 2 — requested USD equivalent
    expect(row.requested_usd).toBe('9000.0000');
    // 3 — official and client exchange rate
    expect(row.official_rate_id).toBe(world.rates.officialId);
    expect(row.client_rate_id).toBe(world.rates.clientId);
    // 5 — IQD transfer amount, company bank account, beneficiary
    expect(row.transfer_amount_iqd).toBe('13050000.0000');
    expect(row.company_bank_account_id).toBe(world.bankAccountId);
    expect(row.beneficiary_name).toBe('Beneficiary Trading LLC');
    expect(row.beneficiary_bank).toBe('Gulf Bank');
    // 7 — related client import file and logistics job, optional by §12.2's own
    // "where the approved process requires it".
    expect(row.client_import_file_id).toBeNull();
    expect(row.logistics_job_id).toBeNull();

    // 4 — actual IQD deposits and deposit dates, on the account.
    const { rows: deposits } = await ownerPool.query(
      `select deposit_date, amount_iqd from money_transfer_deposit
        where client_account_id = $1 order by deposit_date`,
      [account.id],
    );
    expect(deposits).toHaveLength(1);
    expect(deposits[0].amount_iqd).toBe('15000000.0000');

    // 6 — direct bank charges, in their own document (09.7).
    const { rows: expenseColumns } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'money_transfer_expense' and column_name = 'money_transfer_id'`,
    );
    expect(expenseColumns).toHaveLength(1);
  });

  it('the beneficiary and the bank reference are mandatory where the process requires them', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const secondAccount = await fundedAccount(['15000000']);

    await withScope(scopeOf(world.manager), (tx) =>
      client.confirmFunding(tx, world.manager, secondAccount.id, iqd('13050000')),
    );

    const noBeneficiary = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        mt.createTransfer(tx, world.clerk, {
          clientAccountId: secondAccount.id,
          branchCode: BRANCH,
          transferDate: FEB,
          requestedUsd: iqd('9000'),
          officialRateId: world.rates.officialId,
          clientRateId: world.rates.clientId,
          transferAmountIqd: iqd('13050000'),
          companyBankAccountId: world.bankAccountId,
          beneficiaryName: '   ',
        }),
      ),
    );
    expect(noBeneficiary).toMatch(/requires the beneficiary/i);

    // The bank reference is known only when the bank executes, so it is
    // required to move to Sent rather than at creation.
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const noReference = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update money_transfer set status = 'executed' where id = $1`, [transfer.id]),
      ),
    );
    expect(noReference).toMatch(/without the bank reference/i);
  });

  it('the requested USD is stored for reference and does not become the ledger amount', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const { rows } = await ownerPool.query(
      `select l.debit_iqd, l.credit_iqd, l.currency, e.total_debit_iqd
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.source_doc_id = $1 and e.source_event = 'initiated' order by l.line_no`,
      [transfer.id],
    );

    // §1.1 — IQD is the ledger currency. The USD figure priced the deal and
    // appears nowhere in the journal.
    expect(rows[0].debit_iqd).toBe('13050000.0000');
    expect(rows[0].currency).toBe('IQD');
    expect(rows.every((r) => r.debit_iqd !== '9000.0000')).toBe(true);
    expect(rows[0].total_debit_iqd).toBe('13050000.0000');
  });
});

// ===========================================================================
// 09.5 — Initiate Transfer and the edit lock
// ===========================================================================

describe('09.5 — the edit lock (§12.3, §12.7 acceptance 2)', () => {
  it('rates and details are editable before initiation', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);

    await withScope(scopeOf(world.clerk), (tx) =>
      mt.amendTransfer(tx, world.clerk, transfer.id, {
        beneficiaryName: 'Corrected Beneficiary LLC',
        transferAmountIqd: iqd('12000000'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select beneficiary_name, transfer_amount_iqd from money_transfer where id = $1`,
      [transfer.id],
    );
    expect(rows[0].beneficiary_name).toBe('Corrected Beneficiary LLC');
    expect(rows[0].transfer_amount_iqd).toBe('12000000.0000');
  });

  it('after initiation the service refuses an amendment', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const message = await rejection(
      withScope(scopeOf(world.clerk), (tx) =>
        mt.amendTransfer(tx, world.clerk, transfer.id, { beneficiaryName: 'Someone Else' }),
      ),
    );
    expect(message).toMatch(/the transaction is locked/i);
  });

  it('after initiation EVERY field is locked at the database — the API and import path', async () => {
    // §12.7 acceptance 2, tested where it has to hold. The trigger compares the
    // whole row rather than a list of columns, so this loop covers fields a
    // column-by-column lock would have to remember.
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const frozen: Array<[string, string]> = [
      ['beneficiary_name', `'Someone Else'`],
      ['beneficiary_bank', `'Another Bank'`],
      ['beneficiary_account', `'XX-000'`],
      ['beneficiary_country', `'IQ'`],
      ['transfer_amount_iqd', `1`],
      ['requested_usd', `1`],
      ['transfer_date', `'2026-02-11'`],
      ['company_bank_account_id', `null`],
      ['client_account_id', `null`],
      ['branch_code', `'${OTHER_BRANCH}'`],
      ['note', `'a note'`],
      // A real foreign key since D16 merged the import registers. The freeze
      // trigger is BEFORE UPDATE, so it refuses the edit before the reference is
      // ever checked — which is the point: the row is frozen, not validated.
      ['logistics_job_id', `'00000000-0000-0000-0000-000000000001'::uuid`],
      ['journal_entry_id', `null`],
      ['initiated_at', `now()`],
    ];

    for (const [column, value] of frozen) {
      const message = await asApp(scopeOf(world.manager), (query) =>
        rejection(
          query(`update money_transfer set ${column} = ${value} where id = $1`, [transfer.id]),
        ),
      );
      expect(message, `${column} must be locked after Initiate Transfer`).toMatch(
        /the transaction is locked/i,
      );
    }
  });

  it('the bank reference is write-once: supplied by the bank, never re-typed', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-12345'),
    );

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update money_transfer set bank_reference = 'SWIFT-99999' where id = $1`, [
          transfer.id,
        ]),
      ),
    );
    expect(message).toMatch(/already carries bank reference/i);
  });

  it('no partial edit path exists: correction is reversal plus a new transaction', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    // There is no DELETE grant either, so the document cannot be removed and
    // re-entered as a way around the lock (§1.1).
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'erp_app' and table_name = 'money_transfer'`,
    );
    expect(rows.map((r) => r.privilege_type)).not.toContain('DELETE');

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(query(`delete from money_transfer where id = $1`, [transfer.id])),
    );
    expect(message).toMatch(/permission denied/i);
  });
});

// ===========================================================================
// 09.7 — Bank fees and direct expenses
// ===========================================================================

describe('09.7 — bank fees and direct expenses (§12.4)', () => {
  async function sentTransfer() {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-12345'),
    );
    return { account, transfer };
  }

  it('every fee links to a specific transfer, and an unlinked one cannot exist', async () => {
    const { transfer } = await sentTransfer();

    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'bank_charge',
        amountIqd: iqd('25000'),
        chargedToClient: false,
        companyBankAccountId: world.bankAccountId,
        description: 'Correspondent bank charge',
      }),
    );
    expect(expense.expenseNo).toMatch(/^MTE-/);

    // Appendix C's "linked to transfer" is the column, not a rule: there is no
    // way to write a row without one.
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'money_transfer_expense' and column_name = 'money_transfer_id'`,
    );
    expect(rows[0].is_nullable).toBe('NO');

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(
          `insert into money_transfer_expense
             (expense_no, money_transfer_id, branch_code, expense_date, expense_type,
              amount_iqd, charged_to_client, company_bank_account_id, created_by)
           values ('MTE-X', null, $1, $2, 'bank_charge', 1000, false, $3, $4)`,
          [BRANCH, FEB, world.bankAccountId, world.manager.principal.userId],
        ),
      ),
    );
    expect(message).toMatch(/null value in column "money_transfer_id"/i);
  });

  it('fees reduce Net Service Margin and stay visible beside Gross Exchange Spread', async () => {
    const { transfer } = await sentTransfer();

    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'bank_charge',
        amountIqd: iqd('25000'),
        chargedToClient: false,
        companyBankAccountId: world.bankAccountId,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

    const margin = await withScope(scopeOf(world.manager), (tx) => mt.margin(tx, transfer.id));

    expect(show(margin.grossExchangeSpreadIqd)).toBe('450000.0000');
    expect(show(margin.directExpensesIqd)).toBe('25000.0000');
    expect(show(margin.netServiceMarginIqd)).toBe('425000.0000');
  });

  it('posts Dr Money Transfer Direct Expense / Cr Company Bank Account (§12.4)', async () => {
    const { transfer } = await sentTransfer();

    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'bank_charge',
        amountIqd: iqd('25000'),
        chargedToClient: false,
        companyBankAccountId: world.bankAccountId,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

    const { rows } = await ownerPool.query(
      `select l.line_role, l.debit_iqd, l.credit_iqd, l.account_id
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.source_doc_id = $1 order by l.line_no`,
      [expense.id],
    );
    expect(rows[0].line_role).toBe('transfer_expense');
    expect(rows[0].debit_iqd).toBe('25000.0000');
    expect(rows[0].account_id).toBe(world.accounts.transfer_expense);
    expect(rows[1].line_role).toBe('bank');
    expect(rows[1].credit_iqd).toBe('25000.0000');
  });

  it('charged_to_client has no default, so nobody’s silence decides who pays', async () => {
    const { rows } = await ownerPool.query(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'money_transfer_expense' and column_name = 'charged_to_client'`,
    );
    expect(rows[0].column_default).toBeNull();
    expect(rows[0].is_nullable).toBe('NO');
  });
});

// ===========================================================================
// 09.8 — Margin calculation
// ===========================================================================

describe('09.8 — the six §12.4 figures, end to end', () => {
  it('computes all six correctly against the hand-worked example', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['5000000', '7000000', '3000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-12345'),
    );

    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'bank_charge',
        amountIqd: iqd('25000'),
        chargedToClient: false,
        companyBankAccountId: world.bankAccountId,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

    const margin = await withScope(scopeOf(world.manager), (tx) => mt.margin(tx, transfer.id));

    expect(show(margin.totalClientDepositsIqd)).toBe('15000000.0000');
    expect(show(margin.transferPrincipalIqd)).toBe('13050000.0000');
    expect(show(margin.grossExchangeSpreadIqd)).toBe('450000.0000');
    expect(show(margin.directExpensesIqd)).toBe('25000.0000');
    expect(show(margin.netServiceMarginIqd)).toBe('425000.0000');
    expect(show(margin.remainingClientBalanceIqd)).toBe('1950000.0000');
  });

  it('Remaining Client Balance drops by an expense charged to the client', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-1'),
    );

    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'other',
        amountIqd: iqd('25000'),
        chargedToClient: true,
        companyBankAccountId: world.bankAccountId,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

    const margin = await withScope(scopeOf(world.manager), (tx) => mt.margin(tx, transfer.id));
    expect(show(margin.remainingClientBalanceIqd)).toBe('1925000.0000');
  });

  it('no account code is hardcoded: changing the mapping changes the posting', async () => {
    // The 09.8 gate, tested the only way it can be — by changing the mapping and
    // showing the module follows it without a code change.
    await approveKycFor(world, world.clientPartnerId);

    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = 'L000001'`,
    );
    const { rows: replacement } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ('MT-CLEARING-2','Client Clearing (remapped)',$1,$2,false,true,'approved',1,'IQD','customer')
       returning id`,
      [parents[0].account_type, parents[0].id],
    );

    await ownerPool.query(
      `update posting_rule set account_id = $1
        where event_type = 'money_transfer.client_deposit' and line_role = 'client_clearing'`,
      [replacement[0].id],
    );

    const account = await fundedAccount(['5000000']);

    const { rows } = await ownerPool.query(
      `select l.account_id from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where e.source_module = 'money_transfer' and l.line_role = 'client_clearing'`,
    );
    expect(rows[0].account_id).toBe(replacement[0].id);
    expect(rows[0].account_id).not.toBe(world.accounts.client_clearing);
    expect(account.accountNo).toMatch(/^MTC-/);
  });

  it('margin drills to client → case → deposit → settlement → journal (§22)', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['5000000', '7000000', '3000000']);
    const transfer = await fundedTransfer(account.id, '9000000');
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );

    const chain = await withScope(scopeOf(world.manager), (tx) => mt.drillDown(tx, transfer.id));

    expect(chain).toHaveLength(2);
    for (const step of chain) {
      expect(step.clientCode).toBe(world.clientPartnerCode); // client
      expect(step.accountNo).toBe(account.accountNo); // case
      expect(step.depositNo).toMatch(/^MTD-/); // deposit
      expect(step.settlementAmountIqd).toBeTruthy(); // settlement
      expect(step.depositJournalEntryId).toBeTruthy(); // journal
      expect(step.transferJournalEntryId).toBeTruthy();
    }
    expect(chain.map((s) => s.settlementAmountIqd)).toEqual(['5000000.0000', '4000000.0000']);
  });

  it('refuses to recognise more service result than the transfer earned', async () => {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-1'),
    );

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        mt.recogniseServiceResult(tx, world.manager, transfer.id, {
          amountIqd: iqd('500000'),
          postingDate: FEB,
        }),
      ),
    );
    expect(message).toMatch(/Net Service Margin of 450000/i);
  });
});

// ===========================================================================
// 09.9 — Returned transfers and refunds
// ===========================================================================

describe('09.9 — returned transfers and refunds (§12.6)', () => {
  async function returnedTransfer() {
    await approveKycFor(world, world.clientPartnerId);
    const account = await fundedAccount(['15000000']);
    const transfer = await fundedTransfer(account.id);
    await withScope(scopeOf(world.manager), (tx) =>
      mt.initiateTransfer(tx, world.manager, transfer.id),
    );
    await withScope(scopeOf(world.manager), (tx) =>
      mt.markSent(tx, world.manager, transfer.id, 'SWIFT-12345'),
    );

    // The bank charged for a transfer that then came back. §12.6: the company
    // absorbs it.
    const expense = await withScope(scopeOf(world.clerk), (tx) =>
      mt.recordExpense(tx, world.clerk, {
        moneyTransferId: transfer.id,
        expenseDate: FEB,
        expenseType: 'bank_charge',
        amountIqd: iqd('25000'),
        chargedToClient: false,
        companyBankAccountId: world.bankAccountId,
      }),
    );
    await withScope(scopeOf(world.manager), (tx) => mt.postExpense(tx, world.manager, expense.id));

    const recognition = await withScope(scopeOf(world.manager), (tx) =>
      mt.recogniseServiceResult(tx, world.manager, transfer.id, {
        amountIqd: iqd('425000'),
        postingDate: FEB,
      }),
    );

    await withScope(scopeOf(world.manager), (tx) =>
      mt.markReturned(tx, world.manager, transfer.id, {
        returnDate: '2026-02-20',
        reason: 'Beneficiary account closed',
      }),
    );

    return { account, transfer, expense, recognition };
  }

  it('the client’s clearing balance returns to its pre-transfer position exactly', async () => {
    const { account } = await returnedTransfer();

    const balance = await withScope(scopeOf(world.manager), (tx) =>
      client.clearingBalance(tx, account.id),
    );
    // The whole 15,000,000 is the client's again. Not 14,975,000 — the bank
    // charge is the company's, not theirs.
    expect(show(balance)).toBe('15000000.0000');
  });

  it('the refund to the client is the full amount, with no deduction of bank charges', async () => {
    const { transfer } = await returnedTransfer();

    const refund = await withScope(scopeOf(world.manager), (tx) =>
      mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-21' }),
    );

    expect(show(refund.refundedIqd)).toBe('15000000.0000');

    const { rows } = await ownerPool.query(
      `select refund_amount_iqd, status from money_transfer where id = $1`,
      [transfer.id],
    );
    expect(rows[0].refund_amount_iqd).toBe('15000000.0000');
    expect(rows[0].status).toBe('closed'); // Appendix B — Refunded
  });

  it('refuses a refund net of charges at the database, bypassing the service', async () => {
    const { transfer } = await returnedTransfer();

    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(
          `update money_transfer set status = 'closed', refund_amount_iqd = 14975000,
             refunded_at = now(), refunded_by = $2 where id = $1`,
          [transfer.id, world.manager.principal.userId],
        ),
      ),
    );
    expect(message).toMatch(/receives a full refund of 15000000/i);
  });

  it('bank charges remain a company expense after the refund', async () => {
    const { transfer, expense } = await returnedTransfer();
    await withScope(scopeOf(world.manager), (tx) =>
      mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-21' }),
    );

    const { rows } = await ownerPool.query(
      `select e.status, l.debit_iqd
         from money_transfer_expense e
         join journal_line l on l.journal_entry_id = e.journal_entry_id
        where e.id = $1 and l.line_role = 'transfer_expense'`,
      [expense.id],
    );
    // Still posted, still a debit to the expense account. Absorbing a charge
    // means leaving it exactly where it is.
    expect(rows[0].status).toBe('posted');
    expect(rows[0].debit_iqd).toBe('25000.0000');
  });

  it('the recognised service result is reversed, not left standing', async () => {
    const { recognition } = await returnedTransfer();

    const { rows } = await ownerPool.query(
      `select status, reversed_by_id from journal_entry where id = $1`,
      [recognition.journalEntryId],
    );
    expect(rows[0].status).toBe('reversed');
    expect(rows[0].reversed_by_id).not.toBeNull();

    // And the revenue nets to nothing.
    const { rows: revenue } = await ownerPool.query(
      `select coalesce(sum(credit_iqd) - sum(debit_iqd), 0)::text as net
         from journal_line where account_id = $1`,
      [world.accounts.service_revenue],
    );
    expect(revenue[0].net).toBe('0.0000');
  });

  it('original and reversing entries link permanently, in both directions', async () => {
    const { transfer } = await returnedTransfer();

    const { rows } = await ownerPool.query(
      `select t.journal_entry_id, t.return_journal_entry_id,
              o.status as original_status, o.reversed_by_id,
              r.reverses_id
         from money_transfer t
         join journal_entry o on o.id = t.journal_entry_id
         join journal_entry r on r.id = t.return_journal_entry_id
        where t.id = $1`,
      [transfer.id],
    );

    expect(rows[0].original_status).toBe('reversed');
    expect(rows[0].reversed_by_id).toBe(rows[0].return_journal_entry_id);
    expect(rows[0].reverses_id).toBe(rows[0].journal_entry_id);
  });

  it('both linked entries are read-only afterwards', async () => {
    const { transfer } = await returnedTransfer();

    const { rows } = await ownerPool.query(
      `select journal_entry_id, return_journal_entry_id from money_transfer where id = $1`,
      [transfer.id],
    );

    for (const id of [rows[0].journal_entry_id, rows[0].return_journal_entry_id]) {
      const message = await asApp(scopeOf(world.manager), (query) =>
        rejection(query(`update journal_entry set description = 'edited' where id = $1`, [id])),
      );
      expect(message).toMatch(/cannot be edited|posted/i);
    }

    // And the link itself cannot be unpicked (migration 0023).
    const message = await asApp(scopeOf(world.manager), (query) =>
      rejection(
        query(`update journal_entry set reverses_id = null where id = $1`, [
          rows[0].return_journal_entry_id,
        ]),
      ),
    );
    expect(message).toMatch(/cannot be changed or removed/i);
  });

  it('the return reverses the transfer posting, so the bank is whole again', async () => {
    const { transfer } = await returnedTransfer();

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as net
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1
          and e.source_doc_id = $2
          and e.source_event in ('initiated','returned')`,
      [world.accounts.bank, transfer.id],
    );
    expect(rows[0].net).toBe('0.0000');
  });

  it('a returned transfer cannot be refunded twice', async () => {
    const { transfer } = await returnedTransfer();
    await withScope(scopeOf(world.manager), (tx) =>
      mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-21' }),
    );

    const message = await rejection(
      withScope(scopeOf(world.manager), (tx) =>
        mt.refundClient(tx, world.manager, transfer.id, { refundDate: '2026-02-22' }),
      ),
    );
    expect(message).toMatch(/a refund follows a returned transfer/i);
  });
});
