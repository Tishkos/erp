# Playwright suite on `verify/e2e` at `1f13c73` + fixes (PR #52 + the owner's `main` `9fd09f2`) — 2026-10-04, second run

The owner merged the six module PRs and said "something is wrong with the ERP
integration" without saying what. This run is the whole browser suite on the
merged tree plus a walk through the application the way the owner would see
it: every module dropdown and every menu item as the super user (135 items)
and the accounting manager (119), the header at 390 / 1024 / 1280 / 1440 in
English and Arabic, one record of every register with its doors, as the super
user in both languages and as the manager.

**How it ran** (as on 2026-10-04a): dev DB `erp_e2e` seeded with `npm run db:seed`
(the seed alone is enough for the suite; the setup scripts AGENTS.md lists for a
live database built from nothing were not needed); a production build
(`NEXT_DIST_DIR=.next-prod next build` with `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`
pointing at `var/probe/font-mock.js`, which serves local font files from a
`python3 -m http.server 3999` over `var/probe/fonts`) behind `next start -p 3008`,
which `reuseExistingServer` picks up; each spec with
`heavy npx playwright test -c playwright.local.config.ts tests/e2e/<spec> --workers=1 --project=chromium`
(`mobile-rtl`: `--project=mobile`). Another agent ran the whole integration
suite on the same two CPUs throughout, so the times below are slow and one
test flaked (see operations-screens). `next build` adds `.next-prod/types` to
`tsconfig.json`: `git checkout tsconfig.json` after every build.

## What the browser showed, and what was done about it

| Where | Symptom | Cause | Done |
|---|---|---|---|
| `/treasury/deposits/<no>` (fx1-navigation FX3) | the record said "Bank deposit" where the spec, and the first run, said "Bank deposit — other source" | the merge kept both branches' `deposits.source_bank / source_transfer / document_type_bank / document_type_transfer` — the same four keys twice in both locales; JSON keeps the second | one set each; `i18n-catalogue.test.ts` now fails on a key written twice in either locale |
| `/administration/whatsapp` | `admin.whatsapp.setting_group_only` on the screen as a key | 0246's `group_only` row had no label | both locales |
| header, every width | avatar "ST" for System Administrator; the phone drawer showed `990485df` where the header shows the name | `displayName.split(/s+/)` — split on the letter s; the drawer printed `shortUserId` | `/\s+/`; the drawer shows the name |
| `/master-data/chart-of-accounts` | every visit, with nothing pressed, wrote a `chart_of_account.exported` audit row and rendered the CSV (the page never reached network-idle) | the Export button was a `Link` to the route handler, which Next prefetches as soon as it is in view | `LinkButton download` — a plain anchor, as the export menu's |
| `/finance/posting-mappings` at 390px | 663px wide, the page scrolls sideways | the stack's grid items (the forms) take the table's 46rem minimum | `.mapStack > * { min-inline-size: 0 }`; the table scrolls in its frame |
| `/administration/permissions` at 390px | 536px wide; the role list and the permissions panel squeezed side by side | an inline `gridTemplateColumns` on `profileGrid` beat the module's single-column rule | the inline style comes off |
| `/treasury/loans/<no>`, `/treasury/deposits/<no>` | three doors: no printer | no print model (both "none" in doors-coverage) | print models `bank_loan` and `bank_deposit` (`print/accounting-documents.ts`), the printer first in both title bars; held in `ap06-loans` and `fx1-bank-deposits`; review-doors expects four |

Not touched, noted: the module popover opens at most 38rem tall and scrolls
(the Accounting menu's third row of headings is below the fold at 900px);
"HR" and "CRM" are named in Latin letters in Arabic by an earlier decision;
every one of the 135 menu items answers 200 with a heading for the super user,
every one of the manager's 119 too; no record page shows a raw key in either
language; the header overlaps nothing at 390 / 1024 / 1280 / 1440 in either
language (`data-squeeze` gives up the user's name, the branch caption and the
chevrons at 1440 EN with eleven modules; 1024 is the drawer).

## Results

First pass, then the reruns after the fixes (the fixes were built and the
server restarted; `fx1-navigation` was rerun again after the printer door, whose
window is headed like the record, made the FX3 locator ambiguous — `.first()`).

| Spec | First pass | After the fixes | Notes |
|---|---|---|---|
| accounting | 11 passed (1.2m) | — | |
| accounting-screens | 10 passed (1.2m) | 10 passed (1.2m) | |
| ap17-invoice-currency | 1 passed | — | |
| appearance-presets | 1 passed | — | |
| document-design | 4 passed | — | |
| foundation | 9 passed | — | |
| fx1-navigation | **1 failed** 5 passed | 6 passed (17.9s) | FX3: the duplicate `document_type_bank`; then `.first()` for the printer's window title |
| fx2-screens | 2 passed | — | |
| fx4-units | 1 passed | — | |
| fx5-hr | 2 passed | — | |
| harden | 2 passed | — | |
| hr | 2 passed | — | |
| hr-advances | 2 passed | — | |
| hr-payroll | 2 passed | — | |
| hr-requests | 4 passed | — | |
| hr-talent | 2 passed | — | |
| hr-time | 2 passed | — | |
| im2-asycuda | 2 passed | — | |
| im2-bl | 3 passed | — | |
| im2-import-shortage | 2 passed | — | |
| im2-supplier-banks | 2 passed | — | |
| inventory | 4 passed | — | |
| inventory-screens | 8 passed, 1 skipped | — | the skip is intentional (no opening-stock document in the seed) |
| invoice-to-statement | 4 passed | — | |
| logistics | 5 passed | — | |
| mobile-rtl | 1 passed (58s) | 1 passed (1.1m) | |
| operations-screens | **1 failed**, 11 did not run, 6 passed | 18 passed (1.4m) | "draft quantity remains reliable while a row saves" lost a keystroke under the integration suite's load; passes alone and in the rerun — flake, not a defect |
| pay-doors | 3 passed | 3 passed | |
| payables | 9 passed (1.1m) | 9 passed (1.4m) | |
| print-export | 6 passed | 6 passed | |
| projects | 1 passed | — | |
| projects-billing | 1 passed | — | |
| projects-budget | 1 passed | — | |
| projects-close | 1 passed | — | |
| projects-execution | 1 passed | — | |
| projects-schedule | 1 passed | — | |
| receivables | 11 passed (55s) | — | |
| review-doors | 7 passed | 7 passed (41s) | after the spec expects the printer on the loan and the deposit |
| rtl | 5 passed | 5 passed | |
| shared-doors | 3 passed | 3 passed | |
| shell | 17 passed | 17 passed | |
| smoke | 2 passed | — | |
| subacct | 1 passed | — | |
| tabs-navigate | 1 passed | — | |
| theme-readability | 14 passed (47s) | 14 passed (48s) | |
| whatsapp | 2 passed | — | |

**Totals:** 46 spec files; first pass 2 files red (fx1-navigation, operations-screens);
after the fixes every file green — 198 tests passed, 0 failed, 1 skipped (intentional).
Unit suite 115 files / 1760 tests green; typecheck green; `fx1-bank-deposits` and
`ap06-loans` (the two new print cases) green on `erp_test_e2e`.

Screenshots of the walk: `/home/claude/shots/main-check/` (menus, home at each
width, one record per register under `records/`, the changed screens after the
fixes under `after/`).
