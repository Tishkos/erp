-- ===========================================================================
-- Scrub a copy of the live database for staging — REQ-IMPROVE-001 OP-10 (IM7).
--
-- Applied by scripts/ops/make-staging-copy.sh to the *copy*, never to the
-- live database (the script refuses a database named erp, and the LIVE
-- guard refuses on the live host). Run as erp_owner, which bypasses row
-- security.
--
-- What is kept: every document, journal, movement, balance and master code,
-- so staging reproduces the live figures. What goes: everything that
-- identifies a person or opens a door —
--
--   * user e-mails are replaced (the id prefix keeps them distinct), pictures
--     dropped, password hashes and OAuth tokens nulled, MFA seeds deleted,
--     sessions, verifications and sign-in attempts deleted;
--   * KYC records and their documents, CRM contacts, partner contact
--     details and partner bank accounts go; the partner's name and code
--     stay, because a statement without a name is not a test of anything;
--   * attachment rows go (the files are not copied) and attachment access
--     with them;
--   * the delivery outbox and pending deliveries are abandoned, so staging
--     never e-mails a real person; notifications keep their text (it names
--     documents, not people) but lose their deliveries.
--
-- Applied in one transaction (psql --single-transaction). The append-only
-- triggers on attachment and the audit trail are the live system's rules,
-- not the copy's: for the length of this transaction the session acts as a
-- replication apply worker, which user triggers do not fire for. Nothing
-- here touches the live database, where those triggers stand.
--
-- tests/integration/im07-staging-scrub.test.ts applies this file to seeded
-- rows and checks that none of the listed values survives.
-- ===========================================================================

SET LOCAL session_replication_role = replica;

-- People.
UPDATE app_user
   SET email = 'user-' || left(id::text, 8) || '@staging.invalid',
       image = NULL,
       email_verified = false,
       must_change_password = true,
       mfa_required_since = NULL;

UPDATE auth_account
   SET password = NULL, access_token = NULL, refresh_token = NULL, id_token = NULL,
       account_id = CASE WHEN provider_id = 'credential' THEN account_id ELSE 'scrubbed' END;

DELETE FROM user_mfa;
DELETE FROM auth_session;
DELETE FROM auth_verification;
DELETE FROM sign_in_attempt;

-- Partners' people and accounts.
DELETE FROM client_kyc_document;
DELETE FROM client_kyc_record;
DELETE FROM crm_contact;
DELETE FROM partner_bank_account;
UPDATE business_partner SET email = NULL, phone = NULL, address = NULL, tax_identifier = NULL;
UPDATE bank_cash_account SET account_number = CASE WHEN account_number IS NULL THEN NULL ELSE 'STAGING-' || left(md5(account_number), 10) END, iban = NULL, swift = NULL;

-- Files: the rows are dropped with the files they describe.
DELETE FROM attachment_access;
DELETE FROM attachment;

-- Nothing queued on the live system is delivered from staging.
UPDATE notification_delivery SET status = 'suppressed', error_message = NULL WHERE status = 'pending';
UPDATE job_outbox SET status = 'abandoned', abandoned_reason = 'staging copy' WHERE status = 'pending';

-- Where this copy came from, for the footer and the screens that read it.
INSERT INTO audit_event (occurred_at, actor_user_id, action, object_type, object_id, outcome, after_value)
VALUES (now(), NULL, 'system.staging_copy', 'database', current_database(), 'success',
        jsonb_build_object('scrubbed_at', now()));
