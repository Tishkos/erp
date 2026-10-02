# REQ-LEGACY-001 — The legacy books import

| | |
|---|---|
| **Requirement ID** | `REQ-LEGACY-001` |
| **Release** | 1 — before the first day on the ERP |
| **Source** | The accountant's export of the old system, sent 2026-10-02 (ten workbooks: الزبائن, الموردين, أرصدة الحسابات, المواد, المخازن, المبيعات, المشتريات, سندات القبض, سندات الدفع, الحسابات); the sponsor's instruction that the latest data must be easily imported once the build is done; the accountant's answer on the negative quantities (2026-10-02: "it is currently being shipped and has not yet arrived at the warehouse"). |
| **Test case(s)** | §5 |
| **Status** | BUILT 2026-10-02 on `feat/legacy-books-import` (unattended); applied on the development database against the real files; awaiting the sponsor's review and the accountant's first dry run on staging. |
| **Approved by** | *Not yet approved.* |

## 1. What it is

The company runs on an old system until the cut-over. On that day the
accountant exports it — ten workbooks, each a register as the old system
prints it — and uploads them all at once on **Administration → Legacy
Books Import**. A **dry run** reads them and reports what would happen;
**apply** does it, once, in one transaction:

1. **Partners** — every old account becomes a business partner whose code is
   the old account number (1000–1232), so the accountant finds a customer by
   the number she already knows. Customers from the clients' file, suppliers
   from the suppliers' file; the phone comes with them. An account the ERP
   already has under that code is matched, not created; one whose name
   disagrees stops the apply until somebody says which name is right.
2. **Opening balances** — the balance of every partner, in dinars and in
   dollars, posted at the cut-over date as the opening position: one
   journal for the dinar accounts and one for the dollar accounts, each
   partner a line on its control account (debit when they owe us, credit
   when we owe them), the equity side balancing, under the event
   `legacy.opening_balance`. The dollar accounts post in dinars at the rate
   the old books carried them at — their trial balance implies it (final =
   IQD + USD × rate; 1,470 in the files sent) — because the ledger is kept
   in IQD and every account carries one currency (§2.3). The report shows
   the ERP's own USD rate on the cut-over beside it; set to the same figure,
   the USD reading of every statement is the old one to the cent.
3. **Items and warehouses** — every item of the old catalogue is created
   (by name; stock item, batch-tracked, in the unit it is sold in); a
   warehouse is created for every old warehouse that has stock to open.
4. **Opening stock** — one Opening Stock document per warehouse for the
   positive quantities, **submitted and not approved**, at the latest cost
   the old books carry for the item (the newest purchase, else the cost on
   the newest sale, else zero). The old trial balance values the stock at
   one figure and the latest costs come to another; which is right is the
   accountant's judgement, made on the Opening Stock screen before anything
   posts. Negative quantities and the in-transit warehouse (مخزن قيد الشحن)
   are goods sold before they arrived — listed, not imported, for the import
   applications to tie up.
5. **History** — every old sale line, purchase line, receipt and payment is
   kept as read-only history (`legacy_document`), linked to the partner it
   names (vouchers by account number, sales and purchases by name), and
   shown on the partner's page under **Old books**. Nothing in it posts:
   the opening balances carry the net position.

What the accountant enters by hand, from the old trial balance the report
repeats: the cash boxes, the exchange centres, the paid capital and the
year's expenses and revenues — an opening journal on Finance → Journals,
dated the cut-over.

A re-run adds only what is missing: the opening journals' source ids carry
the file set's hash (the cells, not the bytes, so a re-saved export is the
same set), the stock documents and the history rows are recognised by their
origin. Nothing is deleted.

## 2. Reading the export

Each workbook is recognised by its header row, not its name — except the
suppliers' file, which shares the customers' header and is told apart by
"Supplier" or "مورد" in its name. Amounts arrive as text with the side in
words ("24,634,400  مدين / لنا"; "-81,486,500  دائن / علينا", the sign
already in the number), currency words after the number ("195,000 د.ع"),
units after the quantity ("14 قطعة", "10 متر"), American dates
("4/13/2025 9:13:11 AM", "---" for none). The sales register is a `.xls`
(BIFF8); `src/server/xls-read.ts` reads it with nothing but Node, including
the shared-string table continued across records.

## 3. The screen

`/administration/legacy-import`, copying the Sheet Migration screen: the
upload form (several files, the cut-over date, dry run or apply), then the
latest run's report as stacked registers — the workbooks recognised, what
stops the apply, rows that could not be read, the partners, the balances
against the old trial balance (with the agreement stated), the opening
journals, the warehouses, the items, the opening stock (proposed value
beside the old figure), positions with no cost, what is at sea, the history
kept, the old trial balance — and the runs so far. The partner page gains an
**Old books** register.

## 4. Rules

* `import` on `legacy_import` runs it; the accounting manager and the system
  administrator hold it (0240). The apply itself creates and posts through
  the services the screens use, so it needs the business verbs — the
  accounting manager's.
* Apply is refused for a set that has not been dry-run, for a set with any
  stop (a conflicting partner name, no mapping, a closed cut-over day, an
  account that would not post), and for a cut-over date that is not a day.
* The posting rules for `legacy.opening_balance` are copied by the migration
  from the documents that already map the same roles; Finance → Posting
  Mappings can change them.
* Partner balances must agree with the old trial balance; the report says
  whether they do, and the figures either way.

## 5. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| LG1 | The export's cells are read as the accountant wrote them: sides in words, currency and unit words, American dates, Arabic names keyed so spacing and letter shapes do not split a partner; every register recognised by its header; totals and the implied rate from the trial balance; item costs from the newest purchase else sale. | → `tests/unit/legacy-books.test.ts` › *reads an amount with its side in words, the sign already in the number* |
| LG2 | A `.xls` register is read exactly, through the shared-string continuations, in both scripts. | → `tests/unit/legacy-books.test.ts` › *reads every row, through the shared-string continuations, in both scripts* |
| LG3 | The dry run writes nothing but its report and decides everything: partners to create / matched / conflicting, balances and their agreement with the trial balance, the journals, the warehouses and items, the stock documents with the at-sea quantities left out, the history counts; it needs the grant; it stops on a conflicting name and on a day that cannot be posted to. | → `tests/integration/lg03-legacy-import.test.ts` › *reads every workbook, decides everything and writes nothing but its report* |
| LG4 | The apply creates the partners by their old numbers, posts the opening position so every partner's sub-ledger is the old balance (dollars at the old rate) and the journals balance, raises a submitted Opening Stock per warehouse with nothing moved, keeps every line as history on its partner. | → `tests/integration/lg03-legacy-import.test.ts` › *creates, posts, raises and keeps — once* |
| LG5 | A second apply of the same files adds nothing. | → `tests/integration/lg03-legacy-import.test.ts` › *adds nothing on a second apply of the same files* |
| LG6 | Apply is refused without a dry run and with a stop. | → `tests/integration/lg03-legacy-import.test.ts` › *refuses an apply before a dry run of the same files* |

## 6. Run against the real files (development database, 2026-10-02)

The ten files as sent: 149 partners (147 customers, 2 suppliers), 183 balance
rows, 379 positions over 19 warehouses, 1,498 sale lines, 63 purchase lines,
1,066 receipts, 95 payments, the trial balance. Dry run: no rows unreadable,
no stops, customers 4,920,621,735.5 IQD / −104,982.5 USD and suppliers
−9,199,874,500 IQD agreeing with the old trial balance to the dinar, implied
rate 1,470. Apply: 149 partners, 159 items, 9 warehouses (of 19 — the rest
hold nothing or are the in-transit one), two journals (45 and 4 lines) whose
customer sub-ledger nets to 4,766,297,460.5 IQD — the old trial balance's
"final" customers figure — and whose supplier sub-ledger is 9,199,874,500
IQD credit; 9 Opening Stock documents submitted; 2,722 history rows. A
second apply wrote nothing. The proposed stock cost (1,218,146,750 IQD at
the latest costs) differs from the old books' 404,105,773 IQD — the figure
the accountant decides on the Opening Stock screen (B-LG-2).

## 7. Decisions taken in the build (the sponsor may reverse any)

| # | Decision |
|---|---|
| B-LG-1 | The partner's code is the old account number, unprefixed. It is what the accountant and the customers use, it is a valid code, and no existing partner carried a four-digit code. |
| B-LG-2 | Opening stock is raised and submitted, never approved by the import. The old system's stock value and the sum of the latest costs disagree by a factor of three in the files sent; posting either without a person deciding would put a number nobody chose on the balance sheet. |
| B-LG-3 | Dollar balances post in dinars at the old books' implied rate, as separate journal, each line naming the dollar amount and the rate in its description. Posting them as a USD journal would need a USD control account per role, which the chart (one currency per account) and the mappings (one account per role) do not have — and no document in the ERP posts a partner in dollars today. |
| B-LG-4 | Items are created for the whole old catalogue, warehouses only where there is stock to open; the in-transit warehouse is never created. |
| B-LG-5 | The history is a table of its own, not reposted documents: the old registers have no dates on sales, name customers by name, and overlap the balances that already carry the position. A reposting would have doubled the books. |
| B-LG-6 | "The same set" is the cells, hashed, so the dry run the accountant read holds for the apply she runs with the same export re-saved. |
