# Final audit against the ERP Operations Build — 2026-09-26

The Operations Build (`phase03.md`) is the source of truth. Every block was
checked in the code, in the database, and by driving the screens in a browser
against a chart configured only through what the screens offer. Where a
requirement failed, it was fixed and tested again.

**Status key** — **PASS**: implemented and tested. **FIXED**: found wrong or
missing, corrected, tested. **DECISION**: working, but a business choice is
needed on the call.

## Evidence

| Check | Result |
|---|---|
| Integration suite (real PostgreSQL) | 82 files, 1,945 tests passed |
| Unit suite | 62 files, 1,220 tests passed |
| Audit suite `tests/integration/ops13-final-audit.test.ts` | 26 tests, run 4× in a row, all passed |
| Browser run of every block (clerk → CEO → manager), then the database read back | All documents posted; see *Cross-system consistency* |
| Browser specs touched by this audit (`operations-screens`, `invoice-to-statement`, `accounting`, `tabs-navigate`, `phase0` departments) | all passed after updating them to minted codes, the CEO role and the build's screen names |
| Whole browser suite | 50 passed before those updates; the failures that remain are pre-existing and unrelated: screens the phase gate hides (Price Lists, Availability), the Arabic chart-of-accounts table, a theme button, audit-trail labels now shown in words, and a design comparison that depends on which journal is listed first |

**Cross-system consistency after the browser run** (dev database): journal
debits = credits (9,728.57); Inventory account = FIFO layer valuation
(4,028.57); AR control = customer subledger; AP control = supplier subledger;
stock by movements = stock by layers; no negative position in any warehouse.

## Critical Rule 1 — every code and number is the system's

| Identifier | Before | Now | Status |
|---|---|---|---|
| Item Code | minted (last commit) | `ITM-000001` | PASS |
| Bank / Cash Number | minted (last commit) | `BANK-000001` / `CASH-000001` | PASS |
| Customer Code | typed, prefilled from the name | `CUS-000001` | FIXED |
| Supplier Code | typed, prefilled from the name | `SUP-000001` | FIXED |
| Warehouse Code | typed | `WH-0001` | FIXED |
| Payment Term code | typed | `PT-0001` | FIXED |
| Department / Cost Centre / Payment Method code (Phase 03 master data) | typed | `DEP-` / `CC-` / `PM-0001` | FIXED |
| Purchase Invoice No. | sequence | `API-HQ-2026-000001` | PASS |
| Sales Invoice No. | sequence | `INV-HQ-2026-000001` | PASS |
| Payment / Receipt / Returns / Opening Stock | sequence | `PAY-` `RCT-` `SRN-` `GRT-` `OPN-` | PASS |
| Transfer / Item Reconciliation (new) | — | `TRF-HQ-2026-…` / `ADJ-HQ-2026-…` | FIXED |

For each: no form carries the field, no server action reads it, no service
accepts it (a code slipped into a request is ignored — tested), the database
enforces uniqueness, and counters start past any existing code in the minted
shape. **Concurrency:** six customers created at the same instant receive six
different codes (tested). The same test found that two saves needing a
not-yet-created counter could fail with "relation already exists" — fixed in
migration 0210. Rolled-back saves leave a reported gap, never a reused number.

Kept typed on purpose: **branch code** (a short mnemonic printed inside every
document number), **unit-of-measure code** (its symbol, EA/KG), **role code**
(a system key), currency codes (ISO) and period codes (calendar).

## Block by block

### 1. Items — PASS / FIXED
- Code minted; Full Name; Inventory, Sales, COGS accounts; several suppliers
  per item (tested: one item, two suppliers) — **PASS**.
- The create form asked for Kind, Base Unit and Tracking, and the accounts
  only afterwards. Choosing "serial" tracking would have made every invoice
  for that item fail. The form now asks exactly block 1's fields — **FIXED**.

### 2–3. Customers and Suppliers — PASS / FIXED
- Codes minted — **FIXED**. Credit limit/terms removed from the forms — **FIXED**.
- "A new payment term can be defined whenever required": only a Super User
  could create one. The Accounting Manager now can — **FIXED** (0211).
- Statements: customer sales Debit, receipts/returns Credit; supplier
  purchases Credit, payments/returns Debit — **PASS** (verified on screen).

### 4. Purchase Invoice — FIXED
- Header, lines, stock into the chosen warehouse, `Inventory Dr / AP Cr` — **PASS**.
- **CEO approval was not implemented**: there was no CEO; the Accounting
  Manager held the approval and could raise, approve and post alone. There is
  now a **CEO** role holding it; the manager and the clerk are refused
  (tested in code and in the browser) — **FIXED** (0206).
- Lines raised from the New form were saved with the description "Charge";
  they now carry the item's name — **FIXED**.
- The form's "Expense account" could never apply (every line is stock) — removed.

### 5. Sales Invoice — PASS / FIXED
- **Each item's own Sales Account was being overridden**: the New form opened
  its Revenue account on the posting mapping, and an invoice-level account
  outranks the item's. It now opens on "as configured", so the item's Sales
  Account applies unless someone deliberately picks another — **FIXED**.
- Code ↔ Name both ways; linked suppliers offered; same item on two lines
  under two suppliers — **PASS**.
- FIFO by item + supplier + warehouse, tested with several purchases at
  different costs: selling 12 of supplier A's stock costs 10×100 + 2×120 and
  leaves supplier B's untouched — **PASS**.
- `AR Dr / Revenue Cr / COGS Dr / Inventory Cr` — **PASS** (screen + ledger).
- CEO approval: the manager can no longer approve; posting from draft is
  refused by the status machine — **FIXED** (0206).

### 6. Banks and Cash — PASS / FIXED
- Number minted; statement Debit in / Credit out; payment `AP Dr / Bank Cr`,
  receipt `Bank Dr / AR Cr` — **PASS**.
- **Partial allocation stopped at the first part**: once an invoice was part
  paid (or credited by a return) it disappeared from the allocation list and
  its remainder could never be allocated. Fixed for both payments and
  receipts; verified 1,000 + 500 settling a 1,500 invoice — **FIXED**.

### 7. Warehouses — FIXED
- Setup and Warehouses Report — **PASS**.
- **Transfer, Opening Stock, Item Reconciliation and Stock Movement had no
  screens.** All four exist now:
  - *Transfer*: Out of one warehouse, In to the other, same quantity, same
    cost, supplier and FIFO date carried; refuses more than is held.
  - *Opening Stock*: Item, Quantity, Total Price, Average Unit Price (shown
    live = total ÷ quantity), Warehouse; posts to the item's inventory account.
  - *Item Reconciliation*: Item, Warehouse, In/Out, Adjustment Quantity; Out at
    FIFO cost, In at the item's current average; refuses going negative.
  - *Stock Movement*: every In/Out with its document (Purchase, Sale,
    Transfer, Reconciliation, Returns, Opening, Invoice Status Tracking).

### 8. Invoice Status Tracking — FIXED
- Automatic opening, In Process → On Board → On Port → In Bounded (warehouse
  required), forward only, never duplicated — **PASS**.
- **Goods lost their supplier when they moved**, so stock that arrived through
  the stages could not be sold by supplier, and two containers in process at
  once could swap goods. Each stage now moves exactly that invoice's goods
  with cost, supplier and date intact — **FIXED**.
- **Nobody could be selected for notifications, and nobody could see them.**
  The screen now has the user list, and the bell shows each user's latest
  notifications (verified: four notifications for one shipment) — **FIXED**.

### 9. Sales Returns — FIXED
- Offset AR or Bank (one required); quantity never above what remains after
  earlier returns (full, partial, repeated, over-limit all tested) — **PASS**.
- **The money half never posted from the screen**: the goods came back but the
  customer was never credited (it lived in a credit memo no screen raised).
  Accept now posts `Sales Return Dr / AR or Bank Cr` and applies it to the
  invoice — **FIXED**.
- **Returned cost used only the first FIFO layer** of the sold line (sale of
  5@100 + 3@120 returned at 100, not 107.50) — **FIXED**.
- **Returned goods went to an arbitrary warehouse** (the alphabetically first).
  Each line now chooses its warehouse, defaulting to where it was sold from —
  **FIXED**. Returned stock keeps the supplier it was sold from.
- Receive + Accept were two steps; Accept now does both — simplified.

### 10. Purchase Returns — FIXED
- Offset AP or Bank; quantity control — **PASS**.
- **The payable was never reduced from the screen** (only via a credit memo no
  screen raised). Sending a return back now posts `AP or Bank Dr / Inventory
  Cr` in one entry and reduces what the invoice still owes — **FIXED**.
- Returns from a part-paid invoice were refused — **FIXED**.
- Each line can name the warehouse the goods leave from, and the return
  follows the goods after a transfer or shipment — **FIXED**.

### 11. Negative stock — PASS
Refused for sales (including per-supplier stock), transfers, reconciliation
Out and returns — in the service, and by the database trigger
`inventory_no_negative_stock` regardless of path. Verified in tests and in the
browser (a refused transfer/adjustment moves nothing).

### Posting on a real chart — FIXED
Returns' stock half and Opening Stock needed mappings the Posting Mappings
screen could not set, and expense accounts' default "requires Department"
refused sales returns and reconciliations. Movements now post to the item's
own Inventory/COGS accounts, the screen offers the two remaining roles
(Opening Stock → opening balance; Item Reconciliation → adjustment account),
and Department is waived for those documents as it already was for invoices.

## Before the live system is used

1. **Deploy** this branch; migrations **0206–0211** run automatically and are
   additive (no existing record is renamed or rewritten).
2. **Assign the CEO role** (Administration → Users) to the CEO. Until then no
   invoice can be approved by anyone except a Super User.
3. **Posting Mappings**: set the two new rows — *Opening Stock* and
   *Item Reconciliation*.
4. **Warehouses**: the In Process / On Board / On Port warehouses must exist
   and be marked with their stage for block 8.
5. **Invoice Status Tracking**: tick the users who should be notified.

## Decisions for the call

- **Super User** accounts bypass every permission by design (Phase 0), so a
  Super User can also approve invoices. If the administrator is not the CEO,
  remove Super User from that account once setup is finished.
- **Bank account number and cash custodian** are still asked on the Bank/Cash
  forms: the database requires them (accepted Phase 2 controls). The build
  lists only Name, Number, Type, Related Account. Keep or remove?
- **Opening Stock needs a second person to approve** (the person who typed the
  figures cannot confirm them). The build does not mention approval.
- **Purchase Return has Approve then Send back.** The build does not mention
  approval.
- **"Any supplier"** remains on the Sales Invoice supplier list: stock from
  Opening Stock or a reconciliation has no supplier and can only be sold that way.
- Accepted Phase 0–2 screens (administration, chart of accounts, journals,
  financial statements, UoM, cost centres…) were left in place; they were
  accepted before the build and the build's documents post through them.
