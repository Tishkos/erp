# Phase 03 — Master Data

> **Blueprint:** §2.1, §4
> **Release (§27):** 2 — Master Data
> **Acceptance dependency (§27):** *"Master-data validation and change controls pass."*
> **Depends on:** 02
> **Blocks:** 04 onward

---

## Purpose

Every transaction in every later phase resolves to a master record. §3.1 requires *"one authoritative record and a unique system identifier"* per master. This phase builds them, with the governance §4.4 demands.

## In scope

Organisation hierarchy, and the nine masters in the §4.3 catalogue: Chart of Accounts (built in Phase 02), Currency and Rates (Phase 02), Business Partner, Item/Service, Warehouse/Bin, Bank/Cash Account, Project/Contract (skeleton only), Tax/Charge Code, Payment Terms/Methods, Document Sequences (Phase 01).

## Out of scope

- Project WBS, budgets and lifecycle — Phase 11 (only the master shell is created here)
- Employee master — Phase 15

---

## Sub-phases

### 03.1 Organisation hierarchy

**Build** — the §4.1 entity table:

| Entity | Key fields |
|---|---|
| Company / Legal Entity | Legal name, registration, tax identifiers, base currency, fiscal calendar |
| Branch | Code, name, address, manager, default warehouse, default cash account |
| Department | Code, name, manager, parent department |
| Cost Centre | Code, name, owner, budget responsibility |
| Business Line | Code, revenue accounts, cost accounts, approval rules |
| Warehouse / Location / Bin | Location, type, capacity, custody, transit flag |

- One legal entity, multiple branches (§2.1)
- Departments per §2.1: Finance, Procurement, Sales, Warehouse, Projects, Contracting, Logistics, Money Transfer, Investments, HR, Management — **no Legal Department** (§2.1)
- Business Lines per §2.2: Product Sales, Contracting, Projects, Logistics, Investments, Money Transfer

**Test gate**
- [x] A branch cannot be created without a default warehouse and default cash account
- [x] Department hierarchy supports a parent and rejects a cycle
- [x] Cost centres are independent of departments and can be reported separately (§2.1)
- [x] Deactivating an organisation record referenced by a transaction is permitted; deleting it is not

---

### 03.2 Business Partner master

**Build**
- Per §4.3: legal identity, roles, contacts, addresses, credit terms, bank details, tax/KYC data, status
- Roles: Customer, Supplier, or both — one record serves CRM, Sales, Finance, Projects, Logistics and Money Transfer (§6)
- Status values per §6: Prospect, Active, On Hold, Blocked, Inactive
- Duplicate detection by name, phone, email, registration number and bank details (§6)
- Designated Price List link (§7.3)

**Blueprint rules enforced**
- §3.1 — one authoritative record, unique identifier
- §6 — *"Uses the central Business Partner master"*
- §4.4 — *"Duplicate searches run before saving business partners, items and bank accounts"*
- §4.4 — *"Sensitive master changes, such as bank details, credit limits and posting accounts, require approval and before/after audit values"*
- §15 — *"Supplier bank detail changes require independent verification and approval before payment"*

**Test gate**
- [x] Saving a partner matching an existing one on name, phone, email, registration number or bank details triggers the duplicate warning before commit
- [x] A bank detail change enters approval and does not take effect until approved
- [x] The before and after values of a sensitive change are both in the audit trail
- [x] A Blocked partner cannot be used on a new transaction without an authorised override
- [x] One partner record carries both Customer and Supplier roles and is visible correctly to both sides
- [x] Role-specific mandatory fields are enforced per role (Appendix B: *"role-specific mandatory fields"*)

---

### 03.3 Item / Service master

**Build**
- Per §4.3: code, category, stock flag, UOM, serial/batch flag, costing method, sales/purchase accounts, warranty
- UOM model per §9.3: Base UOM, Purchase UOM, Sales UOM, conversion factors, barcodes by UOM
- Supplier item code and barcode retrieved from the master (§8.3)
- Warranty duration held on the item; end date calculated from A/R Invoice date (§7.4)
- Tracking flag: Serial, Batch, or both — **no-tracking is not allowed** (§9.3)

**Blueprint rules enforced**
- §9.3 — *"Every stock item shall use Serial Number Tracking, Batch Number Tracking, or both Serial and Batch Tracking. No-tracking is not allowed"*
- §9.2 — *"FIFO is the single valuation method for every item and warehouse"*
- §8.3 — *"Item selection uses the internal item code. Item name, supplier item code and barcode are retrieved from Item Master"*
- Appendix B — *"Stock/service flag; account determination; inactive-date enforcement"*

**Test gate**
- [x] Saving a stock item with no tracking method is rejected
- [x] Costing method is FIFO and cannot be set to anything else for a stock item
- [x] UOM conversion round-trips exactly: convert to purchase UOM and back yields the original quantity with no drift
- [x] A barcode resolves to the correct item **and** UOM
- [x] Item duplicate detection runs before save
- [x] An item referenced by a transaction cannot be deleted; the inactive date is enforced

---

### 03.4 Warehouse and Bin master

**Build**
- Per §4.3: physical/transit/virtual type, branch, responsible user, negative stock policy
- The six warehouse types from §9.1: Main, Branch, Transit, Quarantine, Damaged Goods, Returns
- A branch can contain multiple warehouses (§9.1)

**Test gate**
- [x] All six warehouse types can be created and are distinguishable by type
- [x] A warehouse belongs to exactly one branch
- [x] Transit warehouses are flagged and excluded from available-for-sale quantities
- [x] The negative stock policy field exists but cannot be set to allow negative — §9.2: *"Negative inventory is prohibited without exception"*

---

### 03.5 Bank and Cash Account master

**Build**
- Per §4.3: bank, account number, currency, G/L account, branch, statement format, approval limits
- Cash accounts carry custodians and limits (§17)

**Blueprint rules enforced**
- §4.4 — duplicate search before saving bank accounts
- §17 — *"Cash accounts have custodians, limits and periodic cash counts"*
- §17 — *"Bank account currency must match payment currency or use an approved FX conversion transaction"*

**Test gate**
- [x] Each bank/cash account maps to exactly one G/L account
- [x] Duplicate account numbers are detected before save
- [x] Approval limits are stored and enforceable by Phase 07
- [x] A cash account without a custodian is rejected

---

### 03.6 Price Lists

**Build**
- Price list master with effective dates
- Each Business Partner linked to one designated price list (§7.3)

**Blueprint rules enforced**
- §7.3 — *"Each Business Partner shall be linked to one designated Price List"*
- §7.3 — *"Unit prices are retrieved from the customer's linked Price List and cannot be edited in the Sales Order"*
- §4.4 — *"Effective dates are used for exchange rates, prices, tax rates and approval roles"*

**Test gate**
- [x] A partner has exactly one price list at any given date
- [x] Effective-dated prices resolve correctly by document date
- [x] The price returned for a partner+item+date is deterministic and reproducible

---

### 03.7 Tax/charge codes and payment terms

**Build**
- Tax/Charge Code per §4.3: rate, recoverable/non-recoverable, account mapping, effective dates
- Payment Terms/Methods per §4.3: due-date rules, instalments, bank/cash/transfer method, fees

**Test gate**
- [x] Due dates calculate correctly from payment terms including instalment schedules (§16)
- [x] Effective-dated tax rates resolve by document date, not by today's date
- [x] Recoverable and non-recoverable codes map to different accounts

---

### 03.8 Master data governance

**Build**
- Create/change/deactivate permissions separate from transaction entry (§4.4)
- Approval routing for sensitive changes with before/after audit values
- Deactivation instead of deletion when referenced
- Effective dating across rates, prices, tax rates and approval roles

**Blueprint rules enforced**
- §4.4 — all six bullets

**Test gate**
- [x] A user with transaction-entry permission cannot create or amend a master record
- [x] Every sensitive change (bank details, credit limits, posting accounts) routes to approval
- [x] A referenced master cannot be deleted through UI, API or import
- [x] Effective-dated values resolve by the document's date in every consuming module

---

### 03.9 Master data import

**Build**
- Import definitions for each master, on the Phase 01 import framework
- Validation preview, error file, batch ID, rollback before final posting
- Source ID retained per row for migration traceability

**Blueprint rules enforced**
- §4.4 — *"Bulk import requires validation preview, error file, import batch ID and rollback before final posting"*
- §26 — master data *"Cleanse, deduplicate, map, approve, then import with source ID"*

**Test gate**
- [x] Import enforces the same validations as manual entry, including duplicate detection
- [x] Import respects permissions — an unauthorised user cannot import
- [x] A mixed valid/invalid file commits nothing and returns a usable error file
- [x] Imported rows carry batch ID and source ID and can be traced back

---

## Phase exit gate

§27 Release 2 acceptance: *"Master-data validation and change controls pass."*

| # | Criterion | Evidence |
|---|---|---|
| 1 | Organisation hierarchy matches §4.1 and §2.1, with no Legal Department | 03.1 gate |
| 2 | One Business Partner record serves all modules, with duplicate control | 03.2 gate |
| 3 | Every stock item has serial and/or batch tracking; FIFO is the only costing method | 03.3 gate |
| 4 | All six warehouse types exist; negative stock cannot be enabled | 03.4 gate |
| 5 | Bank/cash accounts map to G/L and carry limits and custodians | 03.5 gate |
| 6 | Price lists are effective-dated and one-per-partner | 03.6 gate |
| 7 | Sensitive changes require approval with before/after audit | 03.8 gate |
| 8 | Masters are deactivated, never deleted, when referenced | 03.8 gate |
| 9 | Import validates, previews, errors and rolls back | 03.9 gate |

**Sign-off:** Data owners named in §4.3 sign their own master (Finance, Treasury/Finance, Finance/Commercial, Inventory/Commercial, Warehouse, Treasury, Projects, System Admin).
