/**
 * IMPROVEMENT-002 — a supplier's bank accounts, set up on its profile
 * (sponsor, 2026-10-03: "I cannot verify a supplier SWIFT account anywhere …
 * suppliers can have multiple SWIFT and IBAN accounts … full account set up
 * in their profile").
 *
 *   * What a bank would refuse is refused at entry: an IBAN failing its check
 *     digits or length, a SWIFT/BIC of the wrong shape, an inactive currency,
 *     the same account twice on one partner. The bank list fills the name and
 *     SWIFT; the beneficiary defaults to the partner.
 *   * Verification is independent: whoever entered an account and whoever
 *     sent it cannot verify it. Sending it tells the accounting managers.
 *   * Sent back with a reason it returns to draft, and is sent again.
 *   * Several verified accounts at once, one default; taking the default out
 *     of use (with a reason, never deleted) hands the default on; an account
 *     out of use is never used again, by the service or at the database.
 *   * The new payable fields are frozen once verified; the holder's name, as
 *     before, un-approves the set when it changes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as partners from '@/server/services/business-partner';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { SelfApprovalError } from '@domain/workflow';

const BAGHDAD = 'BGW';
let officer: ActorContext;
let manager: ActorContext;
let secondManager: ActorContext;
let partnerId: string;

async function createUser(roleCode: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `Test ${roleCode}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN')`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const add = (ctx: ActorContext, input: partners.BankAccountInput) =>
  withScope(scope(ctx), (tx) => partners.addBankAccount(tx, ctx, partnerId, input));
const submit = (ctx: ActorContext, id: string) => withScope(scope(ctx), (tx) => partners.submitBankAccount(tx, ctx, id));
const verify = (ctx: ActorContext, id: string) => withScope(scope(ctx), (tx) => partners.approveBankAccount(tx, ctx, id));
const verified = async (ctx: ActorContext, input: partners.BankAccountInput, by = manager) => {
  const made = await add(ctx, input);
  await submit(ctx, made.id);
  await verify(by, made.id);
  return made;
};

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true)`);
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  secondManager = await createUser('accounting_manager');
  const partner = await withScope(scope(officer), (tx) =>
    partners.createPartner(tx, officer, {
      code: 'SUP-BANK-1',
      legalName: 'Shenzhen Solar Components Ltd.',
      isSupplier: true,
      email: 'export@szsolar.cn',
      phone: '+86 755 1234 5678',
    }),
  );
  partnerId = partner.id;
});

describe('IMPROVEMENT-002 · a supplier’s bank accounts, in full', () => {
  it('refuses at entry what a bank would refuse, and fills what the bank list knows', async () => {
    expect(await rejection(add(officer, { bankName: 'HSBC', iban: 'GB82 WEST 1234 5698 7654 33' }))).toMatch(/fails its check digits/);
    expect(await rejection(add(officer, { bankName: 'HSBC', iban: 'DE8937040044053201300' }))).toMatch(/from DE has 22 characters/);
    expect(await rejection(add(officer, { bankName: 'Bank of China', accountNumber: '1', swift: 'BKCH1NBJ' }))).toMatch(/not a SWIFT\/BIC code/);
    expect(
      await rejection(add(officer, { bankName: 'Bank of China', accountNumber: '1', intermediarySwift: 'CITI' })),
    ).toMatch(/Intermediary bank: CITI is not a SWIFT\/BIC code/);
    expect(await rejection(add(officer, { bankName: 'Bank of China', accountNumber: '1', currency: 'XYZ' }))).toMatch(/XYZ is not an active currency/);
    expect(await rejection(add(officer, { bankName: 'Bank of China' }))).toMatch(/account number or the IBAN/);
    expect(await rejection(add(officer, { accountNumber: '1' }))).toMatch(/Name the bank/);

    // An IBAN alone stands for the account number; the beneficiary is the supplier.
    const byIban = await add(officer, { bankName: 'HSBC UK', iban: 'gb82 west 1234 5698 7654 32', swift: 'midl gb22', currency: 'USD' });
    // From the bank list: its name and SWIFT.
    const listed = await add(officer, { bankCode: 'BNK-0002', accountNumber: '0011-223344', currency: 'IQD', accountHolder: 'SZ Solar Iraq Branch' });
    const { rows } = await ownerPool.query(
      `select account_number, iban, swift, bank_name, bank_code, account_holder, currency, approval_status, is_active
         from partner_bank_account where id = any($1) order by created_at`,
      [[byIban.id, listed.id]],
    );
    expect(rows).toEqual([
      {
        account_number: 'GB82WEST12345698765432',
        iban: 'GB82WEST12345698765432',
        swift: 'MIDLGB22',
        bank_name: 'HSBC UK',
        bank_code: null,
        account_holder: 'Shenzhen Solar Components Ltd.',
        currency: 'USD',
        approval_status: 'draft',
        is_active: false,
      },
      {
        account_number: '0011-223344',
        iban: null,
        swift: 'ARABIQBAXXX',
        bank_name: 'Arab Bank',
        bank_code: 'BNK-0002',
        account_holder: 'SZ Solar Iraq Branch',
        currency: 'IQD',
        approval_status: 'draft',
        is_active: false,
      },
    ]);

    // The same account twice on one partner, by number or by IBAN.
    expect(await rejection(add(officer, { bankName: 'HSBC', accountNumber: 'GB82WEST12345698765432' }))).toMatch(/already one of this partner's bank accounts/);
  });

  it('is verified by somebody other than whoever entered or sent it, and the managers are told', async () => {
    const entered = await add(manager, { bankName: 'Bank of China', accountNumber: '6222021001023456', swift: 'BKCHCNBJ300', currency: 'USD' });
    await submit(officer, entered.id);
    // The officer sent it, but the manager entered it: still not the manager's to verify.
    expect(await rejection(verify(manager, entered.id))).toMatch(/cannot approve a document you raised/);
    await expect(verify(manager, entered.id)).rejects.toThrow(SelfApprovalError);

    const { rows: told } = await ownerPool.query(
      `select recipient_user_id from notification where event_type = 'partner_bank_account.submitted' and object_id = $1`,
      [entered.id],
    );
    expect(told.map((row) => row.recipient_user_id).sort()).toEqual([manager.principal.userId, secondManager.principal.userId].sort());

    await verify(secondManager, entered.id);
    const payable = await withScope(scope(officer), (tx) => partners.payableBankAccount(tx, partnerId));
    expect(payable).toMatchObject({ accountNumber: '6222021001023456', isDefault: true, approvedBy: secondManager.principal.userId });
  });

  it('is sent back with what is wrong, corrected in draft, and sent again', async () => {
    const made = await add(officer, { bankName: 'Bank of China', accountNumber: '6222021001023456', swift: 'BKCHCNBJ' });
    await submit(officer, made.id);
    expect(await rejection(withScope(scope(manager), (tx) => partners.returnBankAccount(tx, manager, made.id, ' ')))).toMatch(/Say what is wrong/);
    await withScope(scope(manager), (tx) => partners.returnBankAccount(tx, manager, made.id, 'The branch code on the letter is 300'));
    // In draft the details may still change; the revision moves with them.
    await ownerPool.query(`update partner_bank_account set swift = 'BKCHCNBJ300' where id = $1`, [made.id]);
    await submit(officer, made.id);
    await verify(manager, made.id);
    const { rows } = await ownerPool.query(`select swift, revision, approval_status from partner_bank_account where id = $1`, [made.id]);
    expect(rows[0]).toEqual({ swift: 'BKCHCNBJ300', revision: 2, approval_status: 'approved' });
    const { rows: audit } = await ownerPool.query(
      `select reason from audit_event where action = 'partner_bank_account.returned' and object_id = $1`,
      [made.id],
    );
    expect(audit[0]?.reason).toBe('The branch code on the letter is 300');
  });

  it('holds several accounts, one default; out of use hands the default on and is final', async () => {
    const dollars = await verified(officer, { bankName: 'Bank of China', accountNumber: '6222021001023456', swift: 'BKCHCNBJ300', currency: 'USD' });
    const dinars = await verified(officer, { bankCode: 'BNK-0002', accountNumber: '0011-223344', currency: 'IQD' });

    const state = async () =>
      (
        await ownerPool.query(
          `select account_number, is_active, is_default, deactivated_at is not null as out from partner_bank_account where partner_id = $1 order by created_at`,
          [partnerId],
        )
      ).rows;
    expect(await state()).toEqual([
      { account_number: '6222021001023456', is_active: true, is_default: true, out: false },
      { account_number: '0011-223344', is_active: true, is_default: false, out: false },
    ]);

    await withScope(scope(officer), (tx) => partners.setDefaultBankAccount(tx, officer, dinars.id));
    expect((await withScope(scope(officer), (tx) => partners.payableBankAccount(tx, partnerId)))?.accountNumber).toBe('0011-223344');

    expect(await rejection(withScope(scope(officer), (tx) => partners.deactivateBankAccount(tx, officer, dinars.id, '')))).toMatch(/Say why/);
    await withScope(scope(officer), (tx) => partners.deactivateBankAccount(tx, officer, dinars.id, 'Supplier closed the dinar account'));
    expect(await state()).toEqual([
      { account_number: '6222021001023456', is_active: true, is_default: true, out: false },
      { account_number: '0011-223344', is_active: false, is_default: false, out: true },
    ]);

    // Out of use is final — by the service and at the database.
    expect(await rejection(submit(officer, dinars.id))).toMatch(/taken out of use/);
    expect(await rejection(withScope(scope(officer), (tx) => partners.setDefaultBankAccount(tx, officer, dinars.id)))).toMatch(/Only a verified account in use/);
    expect(await rejection(ownerPool.query(`update partner_bank_account set is_active = true where id = $1`, [dinars.id]))).toMatch(
      /deactivated bank account is not used again/,
    );
    expect(await rejection(ownerPool.query(`update partner_bank_account set is_default = true, is_active = false where id = $1`, [dollars.id]))).toMatch(
      /partner_bank_default_is_payable/,
    );

    // The profile lists them in use first, with who did what.
    const listed = await withScope(scope(officer), (tx) => partners.bankAccountsOf(tx, partnerId));
    expect(listed.map((row) => [row.accountNumber, row.state, row.isDefault])).toEqual([
      ['6222021001023456', 'verified', true],
      ['0011-223344', 'inactive', false],
    ]);
    expect(listed[1]).toMatchObject({ deactivationReason: 'Supplier closed the dinar account', deactivatedByName: 'Test accounting_officer' });
  });

  it('freezes the new payable fields once verified; a new holder un-approves it', async () => {
    const made = await verified(officer, { bankName: 'Bank of China', accountNumber: '6222021001023456', intermediarySwift: 'CITIUS33', currency: 'USD' });
    expect(
      await rejection(ownerPool.query(`update partner_bank_account set intermediary_swift = 'CHASUS33' where id = $1`, [made.id])),
    ).toMatch(/Approved bank details cannot be edited/);
    // The holder's name stays editable, as Phase 07 left it — and an edit un-approves the set.
    await ownerPool.query(`update partner_bank_account set account_holder = 'Somebody Else' where id = $1`, [made.id]);
    const { rows } = await ownerPool.query(`select approval_status, is_active, is_default, revision from partner_bank_account where id = $1`, [made.id]);
    expect(rows[0]).toEqual({ approval_status: 'draft', is_active: false, is_default: false, revision: 2 });
  });
});
