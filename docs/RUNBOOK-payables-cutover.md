# Runbook — Payables cut-over from `QS_DASHBOARD.xlsx`

REQ-AP-001 Stage 8 (§24.3, §24.4). The day the sheet stops being the record
and the Payables module starts. Written to be followed step by step by the
accounting manager and whoever runs the server; nothing here deletes, and every
step can be repeated.

**Who:** the accounting manager runs the import (`payables_migration · import`);
a **second** accounting manager signs off the cleared comparison
(`payables_migration · approve` — the screen refuses the person who applied).
The system administrator may dry-run but not sign off.

---

## 0. Before the day

1. **Merge and deploy the stages in order** — `feat/ap-stage-2-services` …
   `feat/ap-stage-8-migration`, each on top of the last. `deploy.sh` takes the
   `pg_dump`, runs `db:migrate` (0225 → 0237, all additive, journal timestamps
   strictly after production's last entry) and the integration suite.
2. **The payables sweep** must run every morning beside `due-notices`; without
   it no time limit ever opens a hold. Add to root's crontab on the VPS:

   ```
   10 6 * * *  cd /opt/qs-erp-next && npx tsx scripts/ops/payables-sweep.ts >> /var/log/qs-erp/payables-sweep.log 2>&1
   ```
3. **The shipment-stage warehouses** (In Process, On Board, On Port — transit
   warehouses where an import's goods wait while at sea, D23):
   `npx tsx scripts/ops/ensure-stage-warehouses.ts [--branch HQ]`. Idempotent;
   it reports them as *present* when they exist.
4. **Known open item:** `CASH-ACCOUNTANT_ERBIL` still points at a deleted
   chart account; re-link it on *Master Data → Bank Accounts* first, or the
   Sunday restore drill keeps failing on it.

## 1. Master data the import matches against

The import **matches, it never creates** masters. Do these on the ordinary
screens, then dry-run again; repeat until the report is clean.

| Report register | What to do | Screen |
|---|---|---|
| *Suppliers not matched — never created* | Open (or correct the legal name of) each supplier. Matching ignores case, repeated spaces, leading/trailing spaces and the en-space the sheet sometimes carries. | Payables → Suppliers |
| *Banks and accounts* — "None — open one" | One **active USD bank account** per sheet bank (MANSOUR, ARAB, NBI), with the bank chosen from the Banks master. Its chart account must be restricted to USD. | Master Data → Bank Accounts |
| (no register — a refusal) | An active payment method whose confirmation is **SWIFT copy**. | Master Data → Payment Methods |
| *Warehouses named in the sheet* | Not imported — stock is already in the ledger. A detail row's warehouse is used for a container line only when the sheet's name or code matches an ERP warehouse. | Master Data → Warehouses |
| Ports (in the report data) | B/L ports of discharge are matched by name or LOCODE; an unmatched port leaves the B/L's port empty. | Seeded rows — no screen yet (D26) |
| — | The **USD accounting rate** for the run date: every migrated import gets its IQD figure at that rate (D17). | Master Data → Currencies and Rates |

## 2. Freeze the sheet

1. Agree the cut-over date with the team; nobody edits the workbook after it.
2. Save that copy as `QS_DASHBOARD.xlsx`. The screen records the file's
   SHA-256; **apply** is refused for any file that has not been dry-run
   byte-for-byte, so the file you dry-run is the file you apply.
3. Keep the copy with the cut-over papers. It is not committed to the
   repository (business data).

## 3. Dry run (writes nothing but its report)

*Administration → Sheet Migration* (Payables tabs) → choose the workbook →
**Dry run — report only** → Run.

Read every register top to bottom:

| Register | What it tells you | Expected on the 2026-10 sheet |
|---|---|---|
| Latest run — counts | Rows read per sheet; *Already there* = rows a previous apply created | 58 imports · 80 PMT · 88 PD · 46 B/L · 175 containers · 5 detail · 9 pending-order lines · 36 PD notes |
| Totals — sheet against ERP | Invoiced / Paid (SWIFT) / Applied from the sheet; the ERP column fills after apply | 35,309,347.81 · 15,617,285.40 · 23,872,694.40 USD |
| Suppliers not matched | Fix in §1 | 23 on a fresh database; 0 before apply |
| Payment applications not imported | Each with its reason (no dashboard row, supplier not matched, no bank named, no USD account, no SWIFT method) | After §1: **3** — `INV-LSCFDF32609004` and `OCV2026-0B30-0001` (no dashboard row), `SA2026030101A` 460,900 (no bank named) |
| PDs with no import — the customs officer's holding list | Imported with no import, to be linked (§6) | 31 |
| Verify the SWIFT date | Not paid in PMT but the PD is totally written off | 11 |
| Cleared — the sheet's "Clear?" against the rule | §20.1 comparison for the sign-off (§5) | rule 10 · sheet 22 · 12 differences; 6 marked cleared without written-off PDs, 9 written off but not marked |
| Containers | Container numbers that fail the ISO 6346 check digit (not imported — the logistics officer adds the corrected number on the B/L after apply) and B/Ls without containers; how many B/Ls had their quantity **estimated** (spread over the containers) | 2 invalid · 1 without containers · 41 estimated |
| Values changed on the way in | Every trimmed key / name, with the original | 9 |

A row that cannot be imported is **reported and skipped, never guessed**.
Fix the master data or the sheet copy, dry-run again.

## 4. Apply

1. Take a dump right before applying — the only undo there is (see §8):

   ```
   PGPASSWORD=… pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
     -f /root/erp-backups/erp-before-sheet-migration-$(date +%Y%m%d-%H%M%S).dump
   ```
2. Same screen → the **same file** → **Apply** → Run.
3. What it creates, in one transaction: import applications (`IMP-…`, source
   *sheet import*, `legacy_cleared` = the sheet's *Clear?*), order lines (the
   Pending Order lines, else one summary line), payment applications
   (confirmed with the SWIFT date / sent / draft; proof = "Sheet PMT row N"),
   PDs with their status history and notes, B/Ls and containers with their
   lines, and — §24.4 — each legacy four-stage shipment of a posted purchase
   invoice as an application with one B/L and one container
   `MIGRATED-<invoice no>`. Every stage is recomputed; imports whose three
   conditions already hold are **cleared** automatically (`CLEARED`).
4. Read *Totals — sheet against ERP*. The ERP column must equal the sheet
   except for the payments listed as not imported. On the 2026-10 sheet:
   invoiced and paid equal; applied 23,411,794.40 = 23,872,694.40 − 460,900
   (`SA2026030101A`).
5. Running apply again adds only what is missing; it never changes or
   deletes what an earlier apply made.

## 5. Sign-off (a second accounting manager)

The second manager opens the same screen, reads *Cleared — the sheet's
"Clear?" against the rule* row by row (paid in full? all received? all PDs
written off?), writes what was agreed in the note and presses **Sign off**.
The run register shows who signed and when. Until it is signed the cut-over
is not finished.

## 6. The first week after

| Who | What | Where |
|---|---|---|
| Customs officer | Link every holding-list PD to its import: PD register → *Holding list — not linked* → open the PD → **Link to an import**. Once linked it is never unlinked. | Payables → Customs Pre-Declarations |
| Treasury | The 11 *verify the SWIFT date* applications (status *sent*, note "Verify the SWIFT date…"): with the bank's SWIFT copy, press **Paid before the cut-over** and give its date and MT103 reference. It records the payment and posts nothing — the money left before the cut-over and is in the opening books (D37). | Payables → Payment Applications |
| Accounting, then treasury | Any other migrated application still *sent* whose money leaves **after** the cut-over: enter the supplier's invoice as a purchase invoice ticked *Import* and choose the migrated import under *Import application* (it joins it instead of opening a second one); post it; then **Confirm SWIFT** as for any payment — that posts the supplier payment against it. A migrated import has no purchase order, so a deposit before its invoice cannot be posted. | Purchase Invoices → New, then Payment Applications |
| Treasury | The payment without a bank (`SA2026030101A`): create its application on the import's page. | Import page |
| Logistics | The container numbers reported invalid: add the corrected number to its B/L. | Payables → Bills of Lading |
| Warehouse | Containers whose lines were *estimated*: count at receipt; the receipt records what arrived and any shortage with its reason. | Payables → Containers |
| Accounting | Reconcile the supplier balances on Supplier Statements against the sheet's *Pmt Remaining* for a sample of suppliers. | Payables → Supplier Statements |

From the cut-over date the sheet is read-only. New imports start as a
purchase invoice ticked *Import* with *Import application* left at *New* (D13); *Inventory → Invoice Status Tracking*
keeps only the shipments of invoices that are not imports and points to
*Containers* for the rest.

## 7. Correcting a migrated record

Through the ordinary screens, as for any record: a wrong payment application
is cancelled with a reason and entered again; a PD's status changes with its
history; a container is received by a container receipt. Migrated rows carry
`source = 'sheet_import'` (or `shipment_migration`) and their sheet row, so a
question about where a figure came from is answered from the row itself.

## 8. If the apply itself was wrong

There is no in-app rollback: the module's records are append-only (R3). If
the apply is found wrong **before anyone has worked on top of it**, restore
the dump taken in §4.1 (see `docs/RUNBOOK-database-recovery.md`), correct the
master data or the sheet copy, and start again from §3. After people have
worked on the migrated records, correct through the screens (§7) instead.
