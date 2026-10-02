/**
 * REQ-IMPROVE-001 IM7 — no user e-mail, hash, MFA seed, KYC row or partner
 * contact survives the staging copy.
 *
 * `scripts/sql/scrub-staging.sql` is the file make-staging-copy.sh applies
 * to the restored copy. Here it is applied, as the owner, to rows seeded
 * with every kind of value it must remove, inside a transaction that is
 * rolled back — so the test database is untouched and the file is tested as
 * it ships rather than through a copy of its statements.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';

const SCRUB = readFileSync(join(process.cwd(), 'scripts/sql/scrub-staging.sql'), 'utf8');

beforeAll(async () => {
  await resetTestData();
  await seedBranch('BGW', 'Baghdad');
});

describe('IM7 · the staging scrub', () => {
  it('removes every identifying value and keeps the books', async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const userId = randomUUID();
      await client.query(`insert into app_user (id, email, display_name, image) values ($1, 'real.person@qs-groups.com', 'Real Person', 'https://x/y.png')`, [userId]);
      await client.query(
        `insert into auth_account (id, user_id, account_id, provider_id, password, access_token)
         values ($1, $2, $3, 'credential', '$argon2id$v=19$m=65536,t=3,p=4$hash', 'token')`,
        [randomUUID(), userId, userId],
      );
      await client.query(`insert into user_mfa (user_id, secret, enrolled_at) values ($1, 'JBSWY3DPEHPK3PXP', now())`, [userId]);
      await client.query(
        `insert into auth_session (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
        [randomUUID(), userId, randomUUID()],
      );
      await client.query(`insert into sign_in_attempt (email, ip_address, outcome) values ('real.person@qs-groups.com', '10.0.0.1', 'success')`);

      const partnerId = randomUUID();
      await client.query(
        `insert into business_partner (id, code, legal_name, is_customer, is_supplier, email, phone, address, tax_identifier, created_by)
         values ($1, 'IM7-P', 'Partner', true, false, 'owner@partner.iq', '+964 770 000 0000', 'Street 1', 'TAX-1', $2)`,
        [partnerId, userId],
      );
      await client.query(
        `insert into crm_contact (partner_id, name, phone, email, created_by) values ($1, 'Contact', '+964 1', 'c@partner.iq', $2)`,
        [partnerId, userId],
      );
      await client.query(`insert into client_kyc_record (partner_id, status, created_by) values ($1, 'draft', $2)`, [partnerId, userId]);
      await client.query(
        `insert into partner_bank_account (partner_id, bank_name, account_number, iban, created_by) values ($1, 'Bank', '12345', 'IQ00', $2)`,
        [partnerId, userId],
      );
      await client.query(
        `insert into attachment (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by, branch_code)
         values ('ap_invoice', 'X', 'contract.pdf', 'application/pdf', 10, repeat('a', 64), 'k', $1, 'BGW')`,
        [userId],
      );

      const before = await client.query(`select count(*)::int as n from chart_of_account`);

      await client.query(SCRUB);

      const user = await client.query(`select email, image, must_change_password, mfa_required_since from app_user where id = $1`, [userId]);
      expect(user.rows[0].email).toMatch(/^user-[0-9a-f]{8}@staging\.invalid$/);
      expect(user.rows[0].image).toBeNull();
      expect(user.rows[0].must_change_password).toBe(true);
      expect(user.rows[0].mfa_required_since).toBeNull();

      const counts = async (sql: string) => (await client.query(sql)).rows[0].n as number;
      expect(await counts(`select count(*)::int as n from app_user where email not like '%@staging.invalid'`)).toBe(0);
      expect(await counts(`select count(*)::int as n from auth_account where password is not null or access_token is not null`)).toBe(0);
      expect(await counts(`select count(*)::int as n from user_mfa`)).toBe(0);
      expect(await counts(`select count(*)::int as n from auth_session`)).toBe(0);
      expect(await counts(`select count(*)::int as n from auth_verification`)).toBe(0);
      expect(await counts(`select count(*)::int as n from sign_in_attempt`)).toBe(0);
      expect(await counts(`select count(*)::int as n from client_kyc_record`)).toBe(0);
      expect(await counts(`select count(*)::int as n from client_kyc_document`)).toBe(0);
      expect(await counts(`select count(*)::int as n from crm_contact`)).toBe(0);
      expect(await counts(`select count(*)::int as n from partner_bank_account`)).toBe(0);
      expect(await counts(`select count(*)::int as n from business_partner where email is not null or phone is not null or address is not null or tax_identifier is not null`)).toBe(0);
      expect(await counts(`select count(*)::int as n from attachment`)).toBe(0);
      expect(await counts(`select count(*)::int as n from attachment_access`)).toBe(0);
      expect(await counts(`select count(*)::int as n from notification_delivery where status = 'pending'`)).toBe(0);
      expect(await counts(`select count(*)::int as n from job_outbox where status = 'pending'`)).toBe(0);
      expect(await counts(`select count(*)::int as n from bank_cash_account where iban is not null or swift is not null`)).toBe(0);

      // The books and the master codes are what staging is for.
      const after = await client.query(`select count(*)::int as n from chart_of_account`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      const partner = await client.query(`select code, legal_name as name from business_partner where id = $1`, [partnerId]);
      expect(partner.rows[0]).toEqual({ code: 'IM7-P', name: 'Partner' });
      const marker = await client.query(`select count(*)::int as n from audit_event where action = 'system.staging_copy'`);
      expect(marker.rows[0].n).toBe(1);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('is the file the script applies, and the script refuses the live names', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/ops/make-staging-copy.sh'), 'utf8');
    expect(script).toContain('scrub-staging.sql');
    expect(script).toMatch(/\[\[ "\$TARGET_DB" != "erp" \]\] \|\| fail/);
    expect(script).toMatch(/\[\[ "\$TARGET_DB" != "\$SOURCE_DB" \]\] \|\| fail/);
    expect(script).toContain('var/LIVE');
  });
});
