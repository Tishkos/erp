# REQ-LOG-001 — Logistics: the physical journey of imported goods

| | |
|---|---|
| **Requirement ID** | `REQ-LOG-001` |
| **Release** | 2 (module branch `feat/logistics-module`) |
| **Source** | The owner's message of 2026-10-04, 02:03 (Europe/Budapest). **The message itself is not available to this branch**: this document is written from the audit handoff that read it (`handoff/logistics`, 2026-10-04 02:20 — "What I understood", the audit table and its 26 work items) and from the orchestrator's decisions of 2026-10-04. If the message is forwarded later, it is reconciled into §1 and any difference is listed in §5. |
| **Test case(s)** | Named per item in §3; each lands with its test. The chain test is `tests/integration/log01-chain.test.ts`. |
| **Status** | BUILT on `feat/logistics-module` (2026-10-04); §3 says what is built, item by item; §5 the follow-ups. |
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
| 1 | This document | Written; kept current | — |
| 2 | Four headings in `MENU` | `logistics_customs` (Customs — ASYCUDA), `logistics_shipping`, `logistics_in_transit`, `logistics_landed_costs`, fifteen items in the owner's order | `tests/unit/fx1-menu.test.ts`, `log01-menu.test.ts` |
| 3 | `erp-shell.tsx` | Logistics module = the four headings; `logistics` (client jobs) leaves the dropdown | `log01-menu.test.ts` |
| 4 | Labels | `nav.*`, `page.*` and `admin.logistics.*` in both locales | `i18n-catalogue`, `hd18`, `hd19` |
| 5 | Grants migration (0300) | `in_transit` held by whoever holds `supplier_shipment`; each new menu object granted to the roles that hold the object it reads | `log01-views.test.ts` (grants) |
| 6 | `set-up-people.ts` | The two new section keys beside `logistics_customs` / `logistics_shipping` | `log01-menu.test.ts` |
| 7 | PD record | **Built.** The import's B/Ls and containers stacked under the PD (status, ETA, at port, customs cleared, port file, received, warehouse — `views.shippingForImport`) and the declarations against the PD; four doors in order; import, supplier, bank, PDs, applications linked | `log01-views` (print model lists the same rows), e2e `logistics.spec.ts` |
| 8 | Customs Declarations | **Built.** `customs_declaration` (0301), `services/customs-declarations.ts`: Draft → Submitted → Accepted (needs customs' reference) → Assessed → Cleared, or Cancelled / Rejected with a reason; forward one step; figures frozen by trigger once past draft; linked to the import and its PD; declared beside charged (`chargedFor`); `/logistics/customs-declarations` list + record with four doors; print model `customs_declaration` | `log01-declaration.test.ts`, `log01-chain.test.ts`, C-53 |
| 9 | Update from ASYCUDA | **Verified** (`customs-pd.asycudaDiff`): a line is `change`, `same`, `not_found`, `ambiguous` (two standing PDs with the number) or `final` (a terminal PD); only `change` is applied, each as a history row with source `asycuda_list`; the reading keeps was/now per line and the screen lists every outcome — conflicts are visible, never overwritten. Notes door and profile links added to the reading | `im2-03-asycuda.test.ts` (unchanged, green) |
| 10 | Customs Duties & Taxes | **Built.** `/logistics/customs-duties` over `landed_cost_charge` type `customs_asycuda`: amount, state (not locked / locked · n / withdrawn), lock date, journal, the import's PD standing; totals by state | `log01-views.test.ts`, `log01-chain.test.ts` |
| 11 | Customs Documents | **Built.** `/logistics/customs-documents` over `attachment` on `customs_pd`, `asycuda_run`, `customs_declaration` — the record each hangs on, its import, uploader, size; opened through the record's own download route | `log01-views.test.ts` |
| 12 | Shipments | **Built.** `/logistics/shipments`: one row per import with a live B/L — B/Ls, containers received / total, late count, next ETA, route (loading → discharge), furthest-back stage, import stage, PD standing, declarations cleared of total; the import's `#shipment` is the record | `log01-views.test.ts`, `log01-chain.test.ts` |
| 13 | Bills of Lading | Kept; label stays "Bills of Lading"; four doors in order, port of discharge → port profile | `fx1-menu`, `im2-02-bl` |
| 14 | Containers | **Built.** The register shows the import's PD standing and the customs-cleared date; the record shows the PD standing (chips, linked), the declarations with their clearance date, four doors in order, and prints the container and its receipt | `log01-views` (print), e2e |
| 15 | Ports & Routes | **Built.** `services/ports.ts` (add — code minted, rename, retire with reason, reactivate; audited by code; never deleted); `/logistics/ports` + `/logistics/ports/[code]` profile with four doors (`profileHref('port')`); routes in use read from the B/Ls | `log01-ports.test.ts` |
| 16 | Freight & Shipping Costs | **Built.** `/logistics/freight-costs` over types `freight`, `port_forwarding`, `other` (Q5), same columns as the duties | `log01-views.test.ts` |
| 17 | Shipment Documents | **Built.** `/logistics/shipment-documents` over `attachment` on `bill_of_lading`, `shipment_container` and import `payable` | `log01-views.test.ts` |
| 18 | In-Transit Inventory | **Built.** `/logistics/in-transit`: per import and item — ordered, in containers, **in transit** (the invoice's layers in transit warehouses, with the warehouses), value, **received** (receipts' moved qty), **on hand** (the receipts' layers now, with the warehouses), containers open / total, invoices, PD standing, declaration; under it the ledger's own balance per transit warehouse (`stock_position`, labelled in transit, available 0) and the reconciliation of the two; under that Invoice Status Tracking with its Advance actions and watchers | `log01-chain.test.ts`, C-54 |
| 19 | Redirect | **Built.** `/inventory/in-transit` → `/logistics/in-transit` (`next.config.ts`, permanent); the old page removed; `payables.spec.ts`, `operations-screens.spec.ts`, `mobile-rtl.spec.ts` follow; `invoice_status_tracking` export route moved | e2e `logistics.spec.ts` |
| 20 | Shipment Tracking | **Built.** `/logistics/shipment-tracking`: every live container (or all) — stage and since when, ETA, delay in days, PD standing and declaration, customs cleared, port file, last update and note, next action (`domain/import-logistics.nextAction`) | `log01-views.test.ts`, `log01-import-logistics.test.ts` |
| 21 | Landed Costs | **Built.** `/logistics/landed-costs`: every import with a charge or a receipt — charges, not locked / locked, lock state in a word (`lockReason` over the import page's own `lockableState` facts: ready, waiting PDs, waiting containers, locked, late charges, nothing to lock), allocation (none / partial / complete), PD standing, containers in, into stock / COGS, received / on hand, final value as the layers hold it, last lock and journal → `/payables/[payableNo]#landed-cost` | `log01-views.test.ts`, `log01-chain.test.ts` |
| 22 | Cost Allocation | **Built.** `/logistics/cost-allocation`: the locks (date, basis, total, into stock, COGS, journal, layers, charges, by) and layer by layer (layer qty now left, on hand at lock, unit cost before / after / now, allocated, inventory, COGS, via-transfer warehouse, journal); filter by lock | `log01-views.test.ts`, `log01-chain.test.ts` |
| 23 | Print models | **Built.** `print/logistics-documents.ts`: `customs_pd`, `shipment_container`, `container_receipt`, `customs_declaration`, `port` — in `EXPORT_ACCESS` and `registry.ts` | `log01-views.test.ts` › print |
| 24 | Tests | menu / catalogue / i18n units green; `log01-declaration`, `log01-ports`, `log01-views`, `log01-chain` integration; `log01-import-logistics` unit; `logistics.spec.ts` e2e over every screen (EN desktop, AR mobile) | — |
| 25 | Chain test | **Built**: Import → B/L → containers → PD → declaration → clearance → landed cost → receipt → inventory, 500 shipped / 300 received / 200 in transit / 200 received later; every read checked against the ledger at each step | `log01-chain.test.ts` |
| 26 | AGENTS.md | **Written**: "Logistics (REQ-LOG-001)"; `docs/CONTROLS.md` C-53, C-54; `docs/notes/doors-coverage.md` rows | — |

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

* **`landed_cost_departure`** (Q7): Cost Allocation reads the lock and the layer adjustments; what left a layer before the lock is shown as its COGS share and, for a transfer, the layer it followed (`via_layer_id`). Reading the departure rows is a follow-up once `feat/inventory-module` merges.
* **ETD** (Q2): no column exists; the Shipments register shows the first sailing date (`departed_on`) and the next ETA. Adding `bill_of_lading.etd` is the owner's call.
* **Document categories** (Q6): the document registers tell a paper by its record and its name; a category column on `attachment` belongs to the Documents owner.
* **The transit warehouse in `stock_position`** reads as that warehouse's `on_hand` — Inventory's view. Logistics labels it in transit everywhere it shows it and reconciles to it; it does not patch the view.
* **ASYCUDA conflicts**: already visible and never applied (item 9) — no change made; a line-by-line "apply this one" is not built.
