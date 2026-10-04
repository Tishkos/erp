# REQ-LOG-001 — Logistics: the physical journey of imported goods

| | |
|---|---|
| **Requirement ID** | `REQ-LOG-001` |
| **Release** | 2 (module branch `feat/logistics-module`) |
| **Source** | The owner's message of 2026-10-04, 02:03 (Europe/Budapest). **The message itself is not available to this branch**: this document is written from the audit handoff that read it (`handoff/logistics`, 2026-10-04 02:20 — "What I understood", the audit table and its 26 work items) and from the orchestrator's decisions of 2026-10-04. If the message is forwarded later, it is reconciled into §1 and any difference is listed in §5. |
| **Test case(s)** | Named per item in §3; each lands with its test. The chain test is `tests/integration/log01-chain.test.ts`. |
| **Status** | IN BUILD on `feat/logistics-module` (2026-10-04). §3 says what is built, item by item. |
| **Approved by** | *Not yet approved.* The decisions in §4 were taken by default and wait on the owner. |

**How to read this document.** §1 is what was asked, as the audit understood it.
§2 is what the audit found on `main` (verified again on this branch before
building). §3 is the 26 work items, with what was built. §4 is the decisions
taken by default, which the owner may reverse. §5 is what is left.

---

# §1 — What was asked (as understood; the owner's words are not on this branch)

* Logistics manages the **physical** journey of imported goods: foreign
  supplier → shipment → B/L → containers → customs (PD, declaration,
  clearance) → landed cost → goods receipt → Iraqi warehouse.
* It **owns nothing financial or commercial**. The Import Application stays in
  Payables (a `payable` with `payable_type_code = 'import'`); the supplier
  liability and AP stay in Payables; stock quantity stays in
  `inventory_movement`; cost stays in `cost_layer` and the landed-cost engine
  (`services/landed-cost.ts`, Inventory's). Logistics may **reference** all of
  these and show them, but never creates a second inventory, shipment,
  container, customs, landed-cost, FX or attachment engine.
* Goods in transit are **not on hand** and in **no** real warehouse until the
  receipt posts: 500 shipped, 300 received → +300 on hand, 200 in transit.
* The final navbar is four headings, fifteen items:
  * **Customs — ASYCUDA:** Customs Pre-Declarations · Customs Declarations ·
    Update from ASYCUDA · Customs Duties & Taxes · Customs Documents
  * **Shipping:** Shipments · Bills of Lading · Containers · Ports & Routes ·
    Freight & Shipping Costs · Shipment Documents
  * **In Transit:** In-Transit Inventory · Shipment Tracking
  * **Landed Costs:** Landed Costs · Cost Allocation
* Legacy routes (`/payables/pd`, `/payables/pd/asycuda`, `/payables/shipments`,
  `/payables/containers`, `/inventory/in-transit`) keep working; where
  ownership moves, a redirect — never a duplicate screen.
* The UI is the existing Qimah design only (AGENTS.md › "Screens copy existing
  models" and "Every record wears the same four doors").
* Shared files are touched as little as possible, so the owner can merge the
  six module branches by hand.

The owner's standing design rule of 2026-10-04 applies to every record this
module owns: four doors (Printer, Paperclip, Notes, Clock) from the moment the
draft exists, and every party on a record links to its profile — "like Bank
Loans: we can click the bank or the customer; the parts have profiles".
Logistics owns the profiles of the **port, B/L, container and PD**.

# §2 — What was found (audit of `main` @ `946633a`, re-verified on this branch @ `81a5ede`)

| Navbar item | Exists on `main` | Classification |
|---|---|---|
| Customs Pre-Declarations | `/payables/pd`, `/payables/pd/[pdNo]`; `services/customs-pd.ts`; `customs_pd`, `customs_pd_status_history`, `pd_status` | **KEEP / IMPROVE** — the PD page does not show the import's B/Ls or containers |
| Customs Declarations | Nothing. No final declaration; no duty/tax/HS columns. The PD status (`totally_written_off`) and the container's `customs_cleared_on` stand in for clearance | **ADD** (Q1) |
| Update from ASYCUDA | `/payables/pd/asycuda`, `/[runNo]`; `services/asycuda-runs.ts`; `customs-pd.asycudaDiff/asycudaApply` | **KEEP** |
| Customs Duties & Taxes | Only as money: `landed_cost_charge` type `customs_asycuda` | **ADD** — register over existing charges |
| Customs Documents | Attachments on `customs_pd`, `asycuda_run` | **ADD** — register over existing attachments |
| Shipments | No `shipment` table; the import and its B/Ls are the shipment | **ADD** — register, one row per import (Q2) |
| Bills of Lading | `/payables/shipments`, `/[blNo]`; `bill_of_lading`; menu key `shipments` | **KEEP** |
| Containers | `/payables/containers`, `/[containerNo]`; `shipment_container(_line)`, `container_receipt(_line)` | **KEEP** |
| Ports & Routes | Table `port` (two seeded rows, **no writer, no screen**); `bill_of_lading.port_of_loading` free text | **ADD** — ports screen + routes in use |
| Freight & Shipping Costs | `landed_cost_charge` types `freight`, `port_forwarding`, `other` | **ADD** — register over existing charges |
| Shipment Documents | Attachments on `bill_of_lading`, `shipment_container`, `payable` | **ADD** — register over existing attachments |
| In-Transit Inventory | `/inventory/in-transit` is *Invoice Status Tracking* for **non-import** invoices (`supplier-shipment.list` filters `is_import = false`) with Advance actions | **ADD + REDIRECT** |
| Shipment Tracking | Nothing as one view; the data is on containers | **ADD** — read-only view |
| Landed Costs | Engine `services/landed-cost.ts`; UI only on the import page (`#landed-cost`) | **KEEP engine, ADD register** |
| Cost Allocation | `landed_cost_lock` + `landed_cost_layer_adjustment` | **ADD** — read view |
| *(client logistics jobs, section `logistics`, 12 items)* | Phase 10 service-revenue model, no screens, every item `href: null` | **Out of the dropdown, kept in `MENU`** (Q3) |

Bugs found on `main` and their owner:

* **`in_transit` is a menu object nobody holds** — the item showed only to a
  Super User. Fixed here (§3 item 5).
* **Import goods in transit read as on hand** in `stock_position` (migration
  0027) — Inventory's view; **not patched here**. The In-Transit Inventory read
  (§3 item 18) is correct on its own: it reads the cost layers in transit
  warehouses and never `stock_position`.
* **No print model** for the PD, the container or the container receipt —
  built here (§3 item 23).
* **`landed_cost_departure`** is not on `main`; it is on `feat/inventory-module`
  (migration 0285, unmerged). Cost Allocation reads the lock and the layer
  adjustments now; departures are a follow-up (§5).

# §3 — The work, item by item

Routes: the existing screens keep their routes (D-FX-1); every new screen
lives under `/logistics/…`; only `/inventory/in-transit` redirects. Reads live
in one new file, `src/server/services/logistics-views.ts`; the engines
(`landed-cost.ts`, `payables.ts`, `inventory.ts`) are not edited.

| # | Item | What is built | Test |
|---|---|---|---|
| 1 | This document | — | — |
| 2 | Four headings in `MENU` | `logistics_customs` (Customs — ASYCUDA), `logistics_shipping`, `logistics_in_transit`, `logistics_landed_costs`, fifteen items in the owner's order | `tests/unit/fx1-menu.test.ts`, `log01-menu.test.ts` |
| 3 | `erp-shell.tsx` | Logistics module = the four headings; `logistics` (client jobs) leaves the dropdown | `log01-menu.test.ts` |
| 4 | Labels | `nav.*`, `page.*` and `admin.logistics.*` in both locales | `i18n-catalogue`, `hd18`, `hd19` |
| 5 | Grants migration (0300) | `in_transit` held by whoever holds `supplier_shipment`; each new menu object granted to the roles that hold the object it reads | `log01-views.test.ts` (grants) |
| 6 | `set-up-people.ts` | The two new section keys beside `logistics_customs` / `logistics_shipping` | `log01-menu.test.ts` |
| 7 | PD record | The import's B/Ls and containers stacked under the PD (customs/clearance per container) | e2e `logistics.spec.ts` |
| 8 | Customs Declarations | `customs_declaration` (0301): Draft → Submitted → Accepted → Assessed → Cleared, or Cancelled / Rejected; linked to PD and import; declared figures only; declared vs charged; four doors; print model | `log01-declaration.test.ts` |
| 9 | Update from ASYCUDA | Verified: a line whose PD the import does not own, or that would move a terminal PD, is listed as a conflict and not applied | `im2-03-asycuda.test.ts` |
| 10 | Customs Duties & Taxes | Register over `landed_cost_charge` type `customs_asycuda` | `log01-views.test.ts` |
| 11 | Customs Documents | Register over attachments on `customs_pd`, `asycuda_run`, `customs_declaration` | `log01-views.test.ts` |
| 12 | Shipments | Register, one row per import with B/Ls, linking to the import's `#shipment` and its B/Ls | `log01-views.test.ts` |
| 13 | Bills of Lading | Kept; label stays "Bills of Lading" | `fx1-menu` |
| 14 | Containers | Customs-cleared date and the import's PD status on the register and the record | e2e |
| 15 | Ports & Routes | `services/ports.ts` (add, edit name, deactivate with reason, reactivate — audited); screen + port profile; routes in use read from the B/Ls | `log01-ports.test.ts` |
| 16 | Freight & Shipping Costs | Register over `landed_cost_charge` types `freight`, `port_forwarding`, `other` | `log01-views.test.ts` |
| 17 | Shipment Documents | Register over attachments on `bill_of_lading`, `shipment_container`, import `payable` | `log01-views.test.ts` |
| 18 | In-Transit Inventory | Ledger read: what is left in transit warehouses per import / invoice / container / item, base unit, value, destination, customs status; absorbs Invoice Status Tracking's register and Advance actions | `log01-views.test.ts`, chain |
| 19 | Redirect | `/inventory/in-transit` → `/logistics/in-transit` (`next.config.ts`); e2e specs updated | `ap01-menu-redirects` style unit check |
| 20 | Shipment Tracking | Read-only: container, stage, ETA, delay, customs, clearance, last update, next action | `log01-views.test.ts` |
| 21 | Landed Costs | Register of imports: charges, unlocked total, lock state, `lockableState` reason, final value → `/payables/[payableNo]#landed-cost` | `log01-views.test.ts` |
| 22 | Cost Allocation | Read over `landed_cost_lock` + `landed_cost_layer_adjustment` | `log01-views.test.ts` |
| 23 | Print models | PD, container, container receipt, customs declaration (`print/logistics-documents.ts`) | `log01-print.test.ts` |
| 24 | Tests | menu, catalogue counts, i18n, one integration per read, e2e per screen | — |
| 25 | Chain test | Import → B/L → containers → PD → declaration → clearance → landed cost → receipt → inventory, with 500 shipped / 300 received / 200 in transit / 200 received | `log01-chain.test.ts` |
| 26 | AGENTS.md | "Logistics (REQ-LOG-001)" | — |

# §4 — Decided by default, owner to confirm

* **Q1 — Customs Declarations.** *Decided by default, owner to confirm:* a thin
  new record `customs_declaration` (links to the PD and the import; declared
  value, duty, taxes, fees as **declared** figures only). The money stays where
  it is: the customs-brokerage invoice line → `landed_cost_charge` → landed
  cost. The screen shows declared beside charged.
* **Q2 — Shipments.** *Decided by default, owner to confirm:* a register over
  the import and its B/Ls — no new table. **No ETD column**: ETD exists nowhere
  (only the actual `shipment_container.departed_on` and `bill_of_lading.eta`);
  adding `bill_of_lading.etd` is left for the owner.
* **Q3 — Client logistics jobs.** *Decided by default, owner to confirm:* out of
  the Logistics dropdown, kept in `MENU` (Appendix A) under its own key; no
  module draws it until a screen exists.
* **Q4 — Routes.** *Decided by default, owner to confirm:* existing routes
  unchanged; new screens under `/logistics/…`; only `/inventory/in-transit`
  redirects (to `/logistics/in-transit`).
* **Q5 — Insurance and handling.** *Decided by default, owner to confirm:* they
  stay under the `other` charge type; no new charge types.
* **Q6 — Document types.** *Decided by default, owner to confirm:* no attachment
  category column; the document registers tell a paper by the record it hangs
  on and its file name.
* **Q7 — `landed_cost_departure`.** *Decided by default, owner to confirm:* it
  lives on `feat/inventory-module` (migration 0285, unmerged). Cost Allocation
  reads the lock and the layer adjustments now; reading departures is a
  follow-up once Inventory merges.
* **Ownership.** PD, ASYCUDA, B/L and container **screens and their services**
  (`customs-pd.ts`, `asycuda-runs.ts`, `shipments.ts`) are Logistics'; Payables
  does not touch them. `stock_position` counting transit warehouses as on hand
  is Inventory's.

# §5 — Left / follow-ups

Kept current in the module's report and in AGENTS.md › "Logistics (REQ-LOG-001)".
