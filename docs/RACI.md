# RACI

**Phase 00.8** · Blueprint Appendix E, "RACI template"

**R** = Responsible · **A** = Accountable · **C** = Consulted · **I** = Informed

---

## Authority

From page 1 of the blueprint, the execution rule:

> **Issa Mohammed** is the sole Business Process Owner and final authority for ERP functional design, accounting logic, workflows, document lifecycles, reporting structure and implementation priorities. The IT specialist shall implement the approved requirements, report technical constraints, perform technical testing and submit results. **No business rule, accounting rule, workflow or permission rule may be changed without written approval from Issa Mohammed.**

And §5.5:

> The IT specialist has no authority to change business processes, accounting logic, workflow rules or permission policy without written approval from Issa Mohammed.

---

## Responsibility matrix

*Reproduced from Appendix E. Do not alter the letters — this is the approved allocation.*

| Deliverable / decision | Issa Mohammed | Department Manager | IT Specialist | Users / Testers |
|---|---|---|---|---|
| Business process, accounting logic, workflow and scope | **A/R** | C | C | I |
| Department operational requirements | **A** | R/C | C | C |
| Solution architecture and technical implementation | **A** for business outcome | I | **R** | C |
| Permissions and approval configuration | **A** | C | **R** | I |
| Build and technical tests | I | I | **A/R** | C |
| UAT and business reconciliation | **A** | R | C | **R** |
| Migration and go-live approval | **A/R** | C | R | C |

---

## Named people

*To be completed in Phase 00.8. Every row needs a name before the phase gate passes.*

| Role | Name | Contact | Departments covered |
|---|---|---|---|
| Business Process Owner | Issa Mohammed | | all |
| IT Specialist / lead | | | — |
| Finance Manager | | | Finance |
| Department Manager — Procurement | | | Procurement |
| Department Manager — Sales | | | Sales |
| Department Manager — Warehouse | | | Warehouse |
| Department Manager — Projects | | | Projects |
| Department Manager — Contracting | | | Contracting |
| Department Manager — Logistics | | | Logistics |
| Department Manager — Money Transfer | | | Money Transfer |
| Department Manager — Investments | | | Investments |
| Department Manager — HR | | | HR |
| Treasury owner | | | Treasury |
| Legal / compliance contact | | | Money Transfer (D9) |

> §2.1: there is **no separate Legal Department** in the current ERP structure. The legal/compliance contact above is for the D9 regulatory approval only, not an ERP department.

---

## Master data owners

From §4.3. Each signs their own master at the Phase 03 gate.

| Master | Data owner | Named person |
|---|---|---|
| Chart of Accounts | Finance | |
| Currency and Rates | Treasury / Finance | |
| Business Partner | Finance / Commercial | |
| Item / Service | Inventory / Commercial | |
| Warehouse / Bin | Warehouse | |
| Bank / Cash Account | Treasury | |
| Project / Contract | Projects | |
| Tax / Charge Code | Finance | |
| Payment Terms / Methods | Finance | |
| Document Sequences | System Admin | |

---

## Department ownership of documents

From §8.6, extended across modules. Determines who creates and who finalises.

| Document | Responsible department |
|---|---|
| Purchase Order | Purchasing |
| Goods Receipt, Goods Return | Warehouse |
| Service Receipt / Expense Confirmation | Benefiting department |
| A/P Invoice, Supplier Credit Memo | Finance |
| Supplier Advance, Supplier Payment | Finance / Treasury |
| Sales Order | Sales |
| Pick List, Delivery Note | Warehouse |
| A/R Invoice, Customer Credit Memo | Finance |
| Customer Receipt | Finance / Treasury |
| Journal Entry | Finance *(exclusively — §14)* |
| Fixed Asset Document | Finance |
| Logistics Job | Logistics |
| Money Transfer, Client Deposit | Money Transfer |
| Bank Execution Batch | Treasury / Money Transfer |

---

## The clarification route

Per §28.2, when the implementation team hits a constraint or ambiguity:

1. **Document** the issue and the available technical options — do not choose
2. **Record** it in [`DECISIONS.md`](DECISIONS.md) with the phase it blocks
3. **Raise** it to the Business Process Owner
4. **Implement** the approved treatment once decided in writing
5. If it changes something already built, raise a change request — [`CHANGE-REQUEST-TEMPLATE.md`](CHANGE-REQUEST-TEMPLATE.md)

The Phase 00.8 gate requires this route to be exercised once as a dry run, so the path is proven before it is needed under pressure.
