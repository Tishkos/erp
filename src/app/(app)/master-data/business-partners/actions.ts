'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as bankDetails from '@/server/services/business-partner';
import * as partners from '@/server/services/partners';

const listFor = (role: partners.PartnerRole) =>
  role === 'customer' ? '/sales/customers' : '/payables/suppliers';
const record = (role: partners.PartnerRole, code: string) =>
  `${listFor(role)}/${encodeURIComponent(code)}?role=${role}`;

/**
 * Customers and suppliers are two lists over one record, so a create returns
 * to the list it came from and everything else returns to the record.
 */
const roleOf = (formData: FormData): partners.PartnerRole =>
  text(formData, 'role') === 'supplier' ? 'supplier' : 'customer';
const returnRoleOf = (formData: FormData): partners.PartnerRole =>
  text(formData, 'returnRole') === 'supplier' ? 'supplier' : 'customer';

function inputFrom(formData: FormData) {
  return {
    legalName: text(formData, 'legalName'),
    tradeName: text(formData, 'tradeName') || null,
    registrationNo: text(formData, 'registrationNo') || null,
    taxIdentifier: text(formData, 'taxIdentifier') || null,
    email: text(formData, 'email') || null,
    phone: text(formData, 'phone') || null,
    address: text(formData, 'address') || null,
    paymentTermsCode: text(formData, 'paymentTermsCode') || null,
    creditLimitIqd: text(formData, 'creditLimitIqd') || null,
    creditTermsDays: text(formData, 'creditTermsDays') || null,
  };
}

export async function createPartnerInRole(formData: FormData): Promise<void> {
  const role = roleOf(formData);
  await runAdminAndReturn(
    (tx, ctx) =>
      partners.createInRole(tx, ctx, role, {
        ...inputFrom(formData),
        // §4.4 — the duplicate search runs on every save; this is the answer
        // to it, given by a person who looked at what it found.
        confirmedNotDuplicate: flag(formData, 'confirmedNotDuplicate'),
      }),
    (value) => {
      const created = value as { code?: string } | null | undefined;
      return created?.code ? record(role, created.code) : listFor(role);
    },
  );
}

export async function updatePartnerRecord(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => partners.updateByCode(tx, ctx, code, inputFrom(formData)),
    record(returnRoleOf(formData), code),
  );
}

/** §6 — a partner may hold either role, or both, but never neither. */
export async function setPartnerRole(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  const role = roleOf(formData);
  const held = flag(formData, 'held');
  const destinationRole = held ? role : role === 'customer' ? 'supplier' : 'customer';
  await runAdminAndReturn(
    (tx, ctx) => partners.setRole(tx, ctx, code, role, held),
    record(destinationRole, code),
  );
}

export async function setPartnerActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      partners.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(returnRoleOf(formData), code),
  );
}

// ---------------------------------------------------------------------------
// IMPROVEMENT-002 — the partner's bank accounts, set up on its profile.
// ---------------------------------------------------------------------------

const accountRecord = (formData: FormData, accountId?: string | null) => {
  const base = record(returnRoleOf(formData), text(formData, 'code'));
  return accountId ? `${base}&account=${encodeURIComponent(accountId)}` : base;
};

export async function addPartnerBankAccount(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => {
      const partner = await partners.detail(tx, text(formData, 'code'));
      return bankDetails.addBankAccount(tx, ctx, partner.id, {
        bankCode: text(formData, 'bank_code') || null,
        bankName: text(formData, 'bank_name') || null,
        bankBranch: text(formData, 'bank_branch') || null,
        bankAddress: text(formData, 'bank_address') || null,
        accountHolder: text(formData, 'account_holder') || null,
        accountNumber: text(formData, 'account_number') || null,
        iban: text(formData, 'iban') || null,
        swift: text(formData, 'swift') || null,
        currency: text(formData, 'currency') || 'IQD',
        intermediaryBank: text(formData, 'intermediary_bank') || null,
        intermediarySwift: text(formData, 'intermediary_swift') || null,
        note: text(formData, 'note') || null,
        confirmedNotDuplicate: flag(formData, 'confirmed_not_duplicate'),
      });
    },
    // Refused, it comes back with the dialog open on what was typed wrong.
    (value) => {
      const id = (value as { id?: string } | null | undefined)?.id;
      return id ? accountRecord(formData, id) : `${accountRecord(formData)}&add_bank=1`;
    },
  );
}

export async function submitPartnerBankAccount(formData: FormData): Promise<void> {
  const id = text(formData, 'account');
  await runAdminAndReturn((tx, ctx) => bankDetails.submitBankAccount(tx, ctx, id), accountRecord(formData, id));
}

export async function verifyPartnerBankAccount(formData: FormData): Promise<void> {
  const id = text(formData, 'account');
  await runAdminAndReturn((tx, ctx) => bankDetails.approveBankAccount(tx, ctx, id), accountRecord(formData, id));
}

export async function returnPartnerBankAccount(formData: FormData): Promise<void> {
  const id = text(formData, 'account');
  await runAdminAndReturn(
    (tx, ctx) => bankDetails.returnBankAccount(tx, ctx, id, text(formData, 'reason')),
    accountRecord(formData, id),
  );
}

export async function defaultPartnerBankAccount(formData: FormData): Promise<void> {
  const id = text(formData, 'account');
  await runAdminAndReturn((tx, ctx) => bankDetails.setDefaultBankAccount(tx, ctx, id), accountRecord(formData, id));
}

export async function deactivatePartnerBankAccount(formData: FormData): Promise<void> {
  const id = text(formData, 'account');
  await runAdminAndReturn(
    (tx, ctx) => bankDetails.deactivateBankAccount(tx, ctx, id, text(formData, 'reason')),
    accountRecord(formData, id),
  );
}
