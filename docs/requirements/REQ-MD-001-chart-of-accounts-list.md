# REQ-MD-001 — Chart of Accounts list

**Phase 00.6 gate:** *"One real screen is specified end to end using the template as
proof it is workable"* and *"Requirement ID → test case linkage is demonstrated for
that screen."*

This is that proof. The screen exists, the tests named below run in CI, and every
acceptance criterion in §15 names the test that holds it up. It is written after
the fact for one screen deliberately: a template nobody has filled in is not
known to be workable, and the cost of discovering that on Phase 06's fifty-two
gate items is a phase.

| | |
|---|---|
| **Requirement ID** | `REQ-MD-001` |
| **Release** | 1 |
| **Phase** | 01.12 (screen) on 02.1 (data) |
| **Blueprint section** | Appendix A menu 19 · §1.2 · §3.3 · §14.1 |
| **Test case(s)** | see §15 — every criterion names its test |
| **Status** | Built — awaiting acceptance |
| **Approved by** | *Not yet approved. §28.1 requires written approval from the Business Process Owner before this moves to Accepted.* |

---

## 1. Business objective

Finance staff need to find an account without knowing its code. The Chart of
Accounts is the spine of every report in the system (§1.2 — *"The Chart of
Accounts shall remain hierarchical and configurable"*), and the list is how
anyone answers "does an account for this already exist?" before raising a new
one — which is what stops the chart growing a second Bank Charges account every
quarter.

Process owner: Business Process Owner (Issa Mohammed), per §28.

## 2. Actors and permissions

| Verb | Role(s) | Data scope | Notes |
|---|---|---|---|
| View | Accounting Officer, Accounting Manager | Company-wide | The chart is not branch-scoped (§1.2) |
| Create | Accounting Officer, Accounting Manager | Company-wide | Raises a draft; code is allocated automatically |
| Edit Draft | Accounting Officer, Accounting Manager | Company-wide | Draft only |
| Submit | Accounting Officer, Accounting Manager | Company-wide | |
| Approve | Accounting Manager | Company-wide | Never the raiser (§14.4) |
| Execute | — | — | Not applicable — an account has no operational effect |
| Post | — | — | Not applicable |
| Reverse/Cancel | — | — | An approved account is deactivated, never deleted (§1.1) |
| Print | Accounting Officer, Accounting Manager | Company-wide | |
| **Export** | **Accounting Manager only** | Company-wide | Deliberately narrower than View — see §6 rule 7 |
| Import | Accounting Manager | Company-wide | Phase 03.9 import definition |
| Configure | Accounting Manager | Company-wide | Control-account flags, currency restriction |
| Administer | Super User | All | §5.1 |

**Department Manager (§5.2):** does **not** apply. The chart is Finance-owned and
routed by role under §14.4, not by the department a document belongs to. This is
the distinction `approver_kind` makes explicit in the workflow engine.

## 3. Preconditions

- The five account groups exist as system roots (seeded by migration 0003).
- The signed-in user holds `view` on `chart_of_account`.
- No prior document is required — this is a master-data list.

## 4. Screen and fields

Columns rendered by the list framework from `chartOfAccountList`
(`src/server/lists/index.ts`). "Editable when" refers to the record screen;
the list itself is read-only.

| Field | Type | Length / precision | Mandatory | Default | Source | Allowed values | Editable when | Help text |
|---|---|---|---|---|---|---|---|---|
| Code | text | 7 (`[ALERX]` + 6 digits) | yes | allocated | generated | pattern-bound | never | The letter is the account type |
| Name | text | 200 | yes | — | user | — | draft | |
| Type | enum | — | yes | inherited from parent | user | asset, liability, equity, revenue, expense | draft | Decides the normal balance |
| Status | enum | — | yes | `draft` | system | draft, submitted, approved, rejected, cancelled | never directly | Moves through the workflow |
| Group | boolean | — | yes | false | user | — | draft | A group holds children; only non-groups may be posted to |
| Active | boolean | — | yes | false | system | — | on approval | An account is active only once approved |
| Level | integer | — | yes | derived | system | 0–n | never | Depth in the hierarchy |
| Control account | enum | — | no | null | user | receivable, payable, inventory, bank, fixed_asset, … | draft | Restricts manual posting (§14.3) |
| Currency | char(3) | 3 | no | null | user | IQD, USD, configured currencies | draft | Restricts which currencies may post |

**Money fields:** none on this screen. The list carries no amounts, so the
four-part tuple (§24) does not arise here; it does on REQ-FIN-* balances.

## 5. Workflow and status

Reference: Appendix B has no Chart of Accounts row — it is master data, not a
transaction — so the states are the §3.2 subset applicable to a master record
under maker-checker (§14.4).

| From | To | Actor | Condition | Fields locked on entry |
|---|---|---|---|---|
| draft | submitted | Officer or Manager | all mandatory fields present | account_type, parent_id, control_account, currency_restriction |
| submitted | approved | Manager, not the raiser | — | all |
| submitted | rejected | Manager, not the raiser | reason given | — (returns to draft) |
| submitted | draft | raiser (recall) | not yet decided | — |
| rejected | draft | raiser | — | — |
| approved | cancelled | Manager | account never posted to | all |

Locked fields are the §24 controlled fields, configured in
`document_type_controlled_field` and enforced by
`workflow.assertControlledFieldsEditable`.

## 6. Validations

| # | Rule | Trigger | Message | Blueprint ref |
|---|---|---|---|---|
| 1 | Search term is matched literally | list query | — (no failure; `%` matches a percent sign) | §25 |
| 2 | Filter column must exist on this list | list query | *"'x' is not a column of the chart_of_account list. Choose one of: …"* | §25 |
| 3 | Operator must suit the column kind | list query | *"'contains' cannot be used on a date column. Use one of: …"* | §25 |
| 4 | Enum filter value must be a declared value | list query | *"'approved' is not a value of status. Choose one of: draft, submitted, posted."* | §25 |
| 5 | Range filter needs both ends | list query | *"A range filter needs exactly two values, a start and an end."* | §25 |
| 6 | Page size within the ceiling | list query | *"A page holds between 1 and 200 rows. Ask for at most 200, or export the list instead."* | §25 |
| 7 | Export requires the `export` verb | export | permission denied | §5.3 |
| 8 | A hidden column cannot be filtered on | list query | *"You do not have permission to filter by created_by."* | §5.1, §25 |

Rule 8 reports a permission problem rather than an unknown column: saying the
column does not exist would be a lie, and naming it would confirm to someone
who may not see it that it is there.

## 7. Calculations

None. The list computes no figures; `level` is maintained by the hierarchy
trigger on write, not by the screen. Row count is `count(*)` over the same
predicate the rows come from, so the count and the rows cannot disagree.

## 8. Accounting event

None. Listing accounts posts nothing.

| Event | Debit | Credit | Control rule | Appendix C row |
|---|---|---|---|---|
| — | — | — | not applicable | — |

## 9. Inventory and operational event

None.

## 10. Integrations

The screen and the export are the same code path: `services/list.ts` compiles one
`ListQuery`, and the export differs only in that it drops the page window
(`toExportQuery`). §23 requires the API to enforce what the UI enforces; here
there is nothing to keep in step because there is one implementation.

Permission decision: `src/server/domain/permissions.ts`.
Query validation: `src/server/domain/list-view.ts`.

## 11. Attachments and evidence

None required. An account may carry an attachment through the generic service
(§21) but nothing on this screen blocks on one.

## 12. Notifications

Submission notifies the Accounting Manager through the §21 engine, by rule, not
by this screen. The list itself raises none.

## 13. Reports and audit

- Every export is written to the audit trail with actor, filters and row count
  — never the rows themselves.
- The list is the drill-down target from Trial Balance and Financial Statements.
- No reconciliation applies to a master list.

## 14. Exceptions

- **No rows match:** the screen says so and suggests clearing a filter. It does
  not render an empty table, which reads as a fault.
- **A saved view references a removed column:** re-validated on open and
  reported as a named field, not a database error.
- **A user loses `export` after opening the screen:** the export refuses on the
  request, not on the render — the button being visible is not the control.

## 15. Acceptance criteria

Each criterion names the automated test that holds it. A criterion with no test
is not a criterion.

```
Given  a signed-in user holding `view` on chart_of_account
When   they open /master-data/chart-of-accounts
Then   the accounts appear in code order
```
→ `tests/e2e/shell.spec.ts` › *lists the chart, in code order*
→ `tests/integration/phase01-list-framework.test.ts` › *returns the seeded account groups in code order*

```
Given  a list of accounts
When   the user searches for "Liabilit"
Then   only matching accounts are shown
```
→ `tests/e2e/shell.spec.ts` › *searches, and says plainly when nothing matches*
→ `tests/integration/phase01-list-framework.test.ts` › *searches the text columns, case-insensitively*

```
Given  a search that matches nothing
When   the results are rendered
Then   the screen states that nothing matched and what to do next
```
→ `tests/e2e/shell.spec.ts` › *searches, and says plainly when nothing matches*

```
Given  a user without the `export` verb
When   they request the export URL directly
Then   the request is refused
```
→ `tests/e2e/shell.spec.ts` › *refuses the export to someone without the export permission*
→ `tests/integration/phase01-list-framework.test.ts` › *refuses the export to someone who may view but not export*

```
Given  a user holding `export`, viewing a filtered list
When   they export
Then   the file contains exactly the rows on screen — no more
```
→ `tests/e2e/shell.spec.ts` › *gives the manager the same rows the screen showed*
→ `tests/integration/phase01-list-framework.test.ts` › *carries every filter through to the export*

```
Given  any export
When   it completes
Then   the audit trail records the actor, the filters and the row count, and not the rows
```
→ `tests/integration/phase01-list-framework.test.ts` › *records who exported what, without copying the rows into the audit trail*

```
Given  a signed-in user with no grants at all
When   they open the screen by URL
Then   they are refused, and told what to ask for
```
→ `tests/e2e/shell.spec.ts` › *refuses the page itself to a signed-in user with no grants*
→ `tests/e2e/shell.spec.ts` › *tells them what to ask for, rather than only refusing*

```
Given  an unauthenticated visitor
When   they open the screen by URL
Then   they reach the sign-in form, not the screen
```
→ `tests/e2e/shell.spec.ts` › *an unauthenticated visitor is sent to sign in, not to a screen*

```
Given  a filter naming a column the user may not see
When   the query is validated
Then   it is refused as a permission matter, naming the field and the correction
```
→ `tests/unit/ui-frameworks.test.ts` › *refuses to filter by a hidden column as a permission matter*

```
Given  the layout is rendered right-to-left
When   the screen is displayed
Then   it remains usable, with no code change and no sideways scroll
```
→ `tests/e2e/rtl.spec.ts` › *mirrors the brand and user utilities in the application header*
→ `tests/e2e/rtl.spec.ts` › *does not make the page scroll sideways*

## 16. Out of scope

Excluded, not deferred:

- **Editing an account from the list.** Changes are made on the record screen,
  so that the maker-checker route has one entry point.
- **A tree view.** The hierarchy is real and the record screen shows parent and
  children; a draggable tree is a usability improvement, not a requirement, and
  Appendix A specifies a list.
- **Balances on the list.** A balance belongs to a period and a branch; showing
  one without saying which would be a figure nobody can reconcile. Trial Balance
  (REQ-FIN-*) is where balances appear.
- **Bulk approval.** §14.4's maker-checker is per account. Approving forty
  accounts with one click is how a control becomes a formality.

---

## Review checklist

- [x] All sixteen sections completed
- [x] Every field in §4 has precision and mandatory rule
- [x] Every §8 account is a name, not a code — not applicable; no accounting event
- [x] Every §15 criterion maps to a named test
- [x] §16 states exclusions explicitly
- [ ] Approved in writing by the Business Process Owner (§28.1)
