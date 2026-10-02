# Ranked fixes for the current build

This is a static review of existing behavior, focused on security, data integrity, and defects already affecting the current setup. It does not propose new product modules. No application code was changed and no tests were run.

## 1. P1 — Enforce MFA before creating a session

The sign-in action verifies the password and immediately creates a session ([sign-in action](src/app/sign-in/page.tsx#L41)). The MFA check exists in `assertSecondFactor`, but the application has no call site for it; the enrolment helpers are also not connected to a screen or action ([MFA service](src/server/services/authentication.ts#L176), [MFA assertion](src/server/services/authentication.ts#L233)). A Super User or role marked as high-risk can therefore sign in with only a password. Connect enrollment and verification to sign-in, and refuse to issue a session unless the required factor is verified.

## 2. P1 — Make temporary passwords a real sign-in restriction

The domain defines `assertPasswordNotTemporary`, and user creation sets `mustChangePassword`, but sign-in does not check that flag and no server path calls the assertion ([password rule](src/server/domain/authentication.ts#L154), [sign-in action](src/app/sign-in/page.tsx#L45)). A user created with a temporary password can open the full application without replacing it. Enforce the flag on every protected request and permit only the password-change action until it is cleared.

## 3. P1 — Stop access to a branch after it is deactivated

Deactivation currently only flips `branch.active` ([branch service](src/server/services/branches.ts#L194)). User principals still load all branch-scope rows ([authorization service](src/server/services/authorization.ts#L70)), permission checks accept any listed branch ([permissions](src/server/domain/permissions.ts#L166)), and the database's permitted-branch function does not filter inactive branches ([RLS migration](src/server/db/migrations/0041_d10_permitted_branches.sql#L48)). Existing users therefore retain access to that branch. Block new work in inactive branches while retaining the historical records needed for review.

## 4. P1 — Repair the production cash account's broken G/L link

The repository's operational note says `CASH-ACCOUNTANT_ERBIL` points to a deleted `chart_of_account` row and causes the restore drill to fail ([known production item](AGENTS.md#L43), [incident record](docs/INCIDENTS.md#L57)). Re-link it to a valid approved asset account, then rerun the restore drill to confirm the production backup restores cleanly. This item comes from the repository's live-operations notes; I did not query the production database during this review.

## 5. P1 — Throttle and audit failed sign-in attempts

The sign-in action catches every authentication error and redirects with the same generic result ([sign-in action](src/app/sign-in/page.tsx#L41)); it applies no attempt limit and writes no failed-login audit event. Also, an unknown email returns before the expensive password hash check while a known email with a wrong password runs scrypt ([credential check](src/server/services/authentication.ts#L132)), which can expose account existence through response timing. Add rate limits and durable failure records, and use a dummy hash check for unknown accounts.

## 6. P2 — Encrypt TOTP secrets at rest

The MFA shared secret is stored directly as text in `user_mfa`; the schema comment confirms it is not encrypted ([MFA schema](src/server/db/schema/auth.ts#L133)). A database read or backup exposes the factor needed to generate codes. Encrypt it with a key managed outside the database and application source, and verify recovery behavior for that key.

## 7. P2 — Replace the attachment signature check with an actual malware scan

The configured scanner detects the EICAR sample and a script interpreter line, then treats every other file as clean ([scanner](src/server/attachments-runtime.ts#L75), [registration](src/server/attachments-runtime.ts#L109)). That does not detect malware embedded in ordinary PDF or Office files. Connect the upload path to the maintained scanner required for production and keep uploads quarantined when scanning is unavailable.

## 8. P2 — Remove the branch-to-cash-account dependency

The current branch schema has `defaultCashAccountId` ([branch schema](src/server/db/schema/platform.ts#L62)); branch creation automatically creates and assigns a cash account ([branch service](src/server/services/branches.ts#L148), [assignment](src/server/services/branches.ts#L162)), and a default account cannot be deactivated ([account service](src/server/services/bank-cash-accounts.ts#L358)). This coupling remains in the current build despite your earlier request to remove branch linking. Remove that association and its database constraint, keeping branch information on each payment or receipt.

## 9. P2 — Validate cash-account currencies against configured currencies

The form offers active configured currencies, but the service only checks that the submitted value has three letters ([currency check](src/server/services/bank-cash-accounts.ts#L214), [form options](src/components/admin/bank-cash-account.tsx#L129)). A direct server-action request can save an unsupported or retired code because the database only checks its shape. Validate existence and active status in the service so invalid accounts fail before they are used for payments or receipts.

## 10. P3 — Preserve database failures instead of treating them as signed-out users

`optionalContext` converts every error from session resolution into `null` ([session helper](src/server/session.ts#L85)); `requireContext` then redirects to sign-in ([guard](src/server/session.ts#L103)). A database outage or query defect is therefore presented as an authentication problem. Return `null` only for missing or invalid sessions and let infrastructure failures reach the normal error handling and monitoring path.
