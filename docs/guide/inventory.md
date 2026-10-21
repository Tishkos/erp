# Inventory — user guide

Inventory is where the company sees what stock it holds, where it is, what it cost, and every movement that changed it.
The work flows in this order: set up the master data (Units of Measure → Items → Warehouses, under Accounting → Master Data — Inventory Reference); bring in the starting stock (Opening Stock); after that purchases, sales, returns and projects move stock from their own screens, and Inventory shows the result (Availability, Stock Receipts, Stock Issues, Stock Movement, Stock Ledger).
Inside Inventory itself you can move stock between warehouses (Transfer), count it (Stock Count), correct it (Item Reconciliation) and issue it (the Issue stock dialog on Availability).
Three screens check and value the stock and change nothing: Inventory Checks, Inventory Valuation and the Warehouses Report.
All quantities are kept in each item's base unit, all values are in Iraqi dinars (IQD) at FIFO cost.

## Concepts — Inventory

These ideas are shared by every Inventory screen. The screen blocks below refer to them by name.

### The stock ledger is the only source of quantity — Concepts, Inventory
Every change of stock is written as one movement line in the stock ledger: a quantity in (positive) or out (negative), for one item, in one warehouse, on one date, with the document that caused it. Nothing else holds a quantity. The figures on Availability, the Items list, the Warehouses Report, the Stock Movement screen and the Stock Ledger are all the same movement lines added up, so they cannot disagree with each other. A movement is never edited or deleted; a mistake is corrected by another movement (a reversal of the document, a transfer back, an Item Reconciliation or a Stock Count). To see why a quantity is what it is, open the Stock Ledger for the item and read the lines one by one.

### FIFO cost — Concepts, Inventory
FIFO means "first in, first out": the oldest stock is treated as leaving first. Every time stock comes in, the system keeps a cost layer — the quantity received, its date and what one unit cost. When stock goes out, the system takes it from the oldest layer that still has something left, then the next, and the cost of what left is the cost of those layers. What remains in the warehouse is valued at the layers that are left. Example: 10 units bought at 50 IQD, then 500 units bought at 500 IQD, then 3 sold. The 3 leave the oldest layer at 50 IQD each (cost of the sale 150 IQD). What is left is 7 × 50 + 500 × 500 = 250,350 IQD for 507 units. FIFO is the only costing method in the system; there is no setting to change it. A transfer between warehouses carries each layer with its own cost and its own date, so the order is not disturbed.

### Value is always cost in IQD — Concepts, Inventory
"Value", "Total Price" and "Unit cost" on the Inventory screens are what the stock cost the company in Iraqi dinars at FIFO. They are not selling prices and not quantities. Quantity × average unit cost = value.

### Base unit and other units — Concepts, Inventory
Each item has one base unit (for example EA). Stock, cost layers and every Inventory screen count in the base unit. An item can also be bought or sold in other units (for example BOX = 24 EA); the conversion is set on the item's page under Units. A document line written in another unit is converted to the base unit when the stock moves; if the conversion does not give an exact quantity the line is refused. Quantities accept up to 6 decimal places.

### Batch tracking — Concepts, Inventory
Every item created on the Items screen is a stock item tracked by batch. The batch is the number of the document that brought the stock in: the purchase invoice number, the Opening Stock number, or the Item Reconciliation number. You are only asked to type a batch in the Issue stock dialog on Availability. Items tracked by serial number are not created by the Items screen; if one exists (for example from a data import) the Inventory forms refuse it because they have no serial number field.

### Warehouses, branches and the active branch — Concepts, Inventory
A warehouse belongs to exactly one branch, and a stock movement is always recorded under the branch of its warehouse. The forms that move stock (Opening Stock, Transfer, Item Reconciliation) offer only the normal, active warehouses of your active branch — the branch shown at the top of the screen. To work in a warehouse of another branch, switch the active branch first. Stock Movement and Stock Ledger show the active branch only. Availability, Stock Receipts, Stock Issues, Inventory Valuation and the Warehouses Report show every branch you are permitted to see.

### In transit, not available — Concepts, Inventory
Four special warehouses hold goods that the company owns but that have not arrived: **On Process (Without SWIFT)**, **In Process**, **On Board** and **At Port**. On Process (Without SWIFT) (قيد المعالجة — بدون سويفت) is only for an import bought with an advance: its goods wait there until the advance's payment application is Paid, then move by themselves to In Process (since 2026-10-06). They are transit warehouses, made once by the system administrator when the company is set up (they cannot be made on the Warehouses screen). Goods standing in them are "in transit": Availability shows them with On hand 0, Available 0 and the quantity under In transit; Inventory Valuation marks the line "In transit"; the Warehouses Report marks the warehouse "transit". They are not offered as a warehouse in Opening Stock, Transfer, Item Reconciliation or Stock Count. The goods have a cost and are part of the stock value, but their quantity is not counted as available until they are moved into a normal warehouse: for an import, when its containers are received (Logistics); for other purchase invoices followed stage by stage (In Process → On Board → At Port → the final warehouse), when the shipment is advanced to its last stage, where the final warehouse is chosen (Logistics → In Transit → In-Transit Inventory).

### Negative stock is never allowed — Concepts, Inventory
No screen can take a warehouse below zero. An issue, a transfer or an "Out" reconciliation larger than what the warehouse holds is refused with the figures. There is no setting or permission that overrides this.

### Numbers come from the system — Concepts, Inventory
Document numbers (opening stock, transfer, reconciliation, stock count), item codes and warehouse codes are given by the system when you save. They cannot be typed or changed.

### Saved and refused messages — Concepts, Inventory
After a successful save the screen shows **Saved.** (تم الحفظ.). When the system refuses, it shows **That could not be saved.** (تعذّر الحفظ.) followed by one sentence saying why and what to do; the refusal sentence itself is in English. If you may not open a screen you see **Not available to you** (غير متاح لك) — ask an administrator for access to that screen. If a button described in this guide is missing, you do not hold the permission for that action.

### The four icons on a record — Concepts, Inventory
An Opening Stock record, a Stock Count record, a Transfer record and an Item Reconciliation record carry four icons in the title bar, in this order:
1. **Printer** — **Print / Export** (طباعة / تصدير): downloads the record as PDF, Excel (.xlsx) or Word (.docx), in English or العربية. PDF needs the print permission, Excel and Word need the export permission; a format you may not have is not offered.
2. **Paperclip** — **Attachments** (المرفقات): the files kept with the record, with a count. To add one press **Choose a file** (اختر ملفاً) then **Attach** (إرفاق). Up to 25MB; programs and archives are refused.
3. **Speech bubble** — **Notes** (الملاحظات): what people wrote about the record (When, Who, Note), newest first. Type in **Add note** (إضافة ملاحظة) and press **Add note**. A note is dated and signed and can never be edited or removed; at most 2,000 characters.
4. **Clock** — **Audit log** (سجل التدقيق): everything that happened to the record, who did it and when.
The item profile and the warehouse profile carry only the Notes and Audit log icons.

### Print / Export on lists and reports — Concepts, Inventory
Lists and reports carry a **Print / Export** (طباعة / تصدير) menu (at the top of a report, or on each row of the Transfer and Item Reconciliation lists). It offers PDF, Excel (.xlsx) and Word (.docx) in English and العربية, with the filters you have set. The menu is not shown if you hold neither the print nor the export permission.

### Closed accounting periods — Concepts, Inventory
A stock movement cannot be dated inside a closed accounting period. The refusal reads "A stock movement dated … cannot be written: the period is closed". Use a date in an open period, or ask Finance about the period (Accounting → General Ledger → Accounting Periods). A posting dated where no period exists is refused with "No accounting period covers …".

### What posts a journal entry — Concepts, Inventory
- Opening Stock, on approval: debit each item's inventory account, credit the opening balance account.
- Item Reconciliation and Stock Count adjustment: the item's inventory account against the Inventory Adjustment account (stock found = debit inventory; stock missing = credit inventory).
- Transfer between warehouses: no journal entry (the same item stays in the same inventory account).
- Issue stock from the Availability dialog: a stock movement only, no journal entry.
- Purchases, sales, returns and project issues post from their own screens.
The opening balance account and the Inventory Adjustment account are set by Finance on Accounting → General Ledger → Posting Mappings (خرائط الترحيل). The inventory account and the COGS account are set on each item.

## Availability (التوافر)
Inventory → Stock & Availability → Availability   |   Arabic: المخزون ← المخزون والتوفّر ← التوافر
Address: /inventory/availability
Needs: `view` on `inventory_movement` to open; `execute` on `inventory_movement` to see and use **Issue stock**.
What it is for: Shows what each warehouse holds, item by item — on hand, available to issue, reserved, in transit, in quarantine, damaged, returned, on order — with the unit cost and value. Every figure is added up from the stock ledger. It is also where stock can be issued out of a warehouse from a dialog.

### How to read and filter the list — Availability
1. Open Inventory → Stock & Availability → **Availability** (التوافر).
2. There is one row per item per warehouse that has ever had a movement. Fifty rows a page; the page numbers are at the foot.
3. To search, type in the box **Search this list** (ابحث في هذه القائمة) — it looks in the item code, item name, warehouse code and warehouse name — and press Enter. **Clear** (مسح) removes the search.
4. To narrow, choose **Warehouse** (المخزن) (default **All warehouses** — كل المستودعات), **Category** (الفئة) (default **All categories** — كل الفئات), **Branch** (الفرع) (default **All branches** — كل الفروع), tick **Only items with stock available** (المواد المتاحة فقط) if wanted, then press **Filter** (تصفية).
5. Click an item code to open the item's profile; click a warehouse to open the warehouse's profile.

### How to open an item's movements — Availability
1. Find the row of the item and warehouse.
2. In the last column **Ledger** (الدفتر) press **Movements** (الحركات).
3. The Stock Ledger opens for that item in that warehouse, with every movement and the running balance.

### How to issue stock — Availability
1. Press **Issue stock** (صرف مخزون) at the top of the screen (shown only if you may issue).
2. **Item Code** (رمز الصنف): choose the item. Only items that have stock available somewhere you may see are listed.
3. **Warehouse Code** (رمز المخزن): choose the warehouse to take the stock from. If you had filtered the list by a warehouse, it is already chosen.
4. **Batch** (الدفعة): type the batch — the number of the document that brought the stock in (purchase invoice, opening stock or reconciliation number). An item tracked by batch is refused without it.
5. **Quantity** (الكمية): the quantity to issue, in the item's base unit.
6. Press **Issue** (صرف).
7. On success you see **Saved.** (تم الحفظ.) and the row's figures drop. If it is refused, the reason is shown on the page under **That could not be saved.** (تعذّر الحفظ.) and the dialog opens again, empty, for another try.

### Fields — Availability
List columns:
- **Item Code** (رمز الصنف) — link to the item's profile.
- **Item Name** (اسم الصنف).
- **Warehouse** (المخزن) — link to the warehouse's profile.
- **Branch** (الفرع) — the warehouse's branch.
- **On hand** (في المخزون) — the quantity standing in the warehouse, shown with the item's base unit. For a transit warehouse this is 0 (its goods are under In transit).
- **Available** (المتاح) — what can be issued or sold from this warehouse: the quantity held minus what is reserved. It is 0 for any warehouse that is not a normal warehouse (transit, quarantine, damaged goods, returns).
- **Reserved** (المحجوز) — stock promised to a document and not yet released.
- **In transit** (قيد النقل) — for a transit warehouse, the quantity standing in it; plus any units of the item that left on a transfer and have not yet arrived (that part is shown on every row of the item).
- **In quarantine** (في الحجر), **Damaged** (تالف), **Returns** (المرتجعات) — the quantity held when the warehouse is a quarantine, damaged-goods or returns warehouse. The Warehouses screen creates only normal warehouses, so these are normally 0.
- **On order** (مطلوب شراؤه) — what approved purchase orders still owe: ordered minus received minus closed, in the base unit. An order line that names no warehouse is counted on every warehouse row of its item.
- **Unit cost (IQD)** (تكلفة الوحدة (د.ع)) — Value divided by the quantity held.
- **Value (IQD)** (القيمة (د.ع)) — the FIFO cost of what is left here: each cost layer's remaining quantity × its unit cost.
- **Ledger** (الدفتر) — the link **Movements** (الحركات) to the Stock Ledger.

Issue stock dialog:
- **Item Code** (رمز الصنف) — required; chosen from the list.
- **Warehouse Code** (رمز المخزن) — required; chosen from the active warehouses you may see.
- **Batch** (الدفعة) — the form lets you leave it empty, but an item tracked by batch (every item made on the Items screen) is refused without it.
- **Quantity** (الكمية) — required; above zero; base unit; at most 6 decimals.

### After you save — Availability
The list itself is read-only. An issue from the dialog writes one stock movement dated today, taking the oldest FIFO cost layers first; the quantity and value of the row fall at once. The movement appears on Stock Movement and Stock Issues with the movement type **Sale** (بيع) and no document number. This dialog does not make a journal entry and needs no approval; Inventory Checks lists such movements under "Movements of a posting kind with no journal". Stock sold to a customer should go through the Sales Invoice, and a counting difference through Item Reconciliation or Stock Count, because those post to the accounts.

### Refusals — Availability
- "Cannot issue … of … from …: … is available. Negative inventory is prohibited without exception (§9.2). Reduce the quantity, receive stock first, or issue from another warehouse." — the quantity is more than the warehouse has available. Issue less, or choose another warehouse.
- "… is tracked by batch, so this movement needs a batch number. … Supply the missing identification, or correct the item if it should not be tracked." — fill the Batch field.
- "Not a quantity: …" or "… has … decimal places, more than the 6 permitted." — type the quantity as a plain number with at most 6 decimals.
- "No item '…'." or "No warehouse '…'." — the item or warehouse was not chosen from the list; choose it again.
- "Permission denied: 'execute' on 'inventory_movement' is not granted to this user." — you may not issue stock; ask an administrator.
- "A stock movement dated … cannot be written: the period is closed" — today falls in a closed period; see Closed accounting periods in Concepts — Inventory.
- "Cost layers for … in … are short by … The quantity ledger and the FIFO layers disagree …" — the stock records are inconsistent; nothing was issued. Tell the accounting manager and open Inventory Checks.

## Opening Stock (رصيد أول المدة)
Inventory → Receipts, Issues & Transfers → Opening Stock   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← رصيد أول المدة
Address: /inventory/opening-stock (record: /inventory/opening-stock/<number>)
Needs: `view` on `opening_stock` to open; `create` and `submit` on `opening_stock` to raise one; `approve` on `opening_stock` and `execute` on `inventory_movement` to approve; `edit_draft` on `opening_stock` to add a note; `edit_draft` on `opening_stock` and `create` on `attachment` to attach a file; `print` / `export` on `opening_stock` for copies.
What it is for: Brings in the stock the company starts with — the quantities and what they cost. One document is one warehouse with a line per item. Saving sends it for approval; approving puts the quantities into the stock ledger, creates the FIFO cost layers and posts the opening journal.

### How to raise an opening stock document — Opening Stock
1. Make sure your active branch (top of the screen) is the branch of the warehouse; only that branch's normal, active warehouses are offered.
2. Open Inventory → Receipts, Issues & Transfers → **Opening Stock** (رصيد أول المدة) and press **New opening stock** (رصيد أول مدة جديد).
3. Choose the **Warehouse** (المخزن) and set the **Date** (التاريخ) (today by default).
4. On the first line type the **Item Code** (رمز الصنف) or the **Item Name** (اسم الصنف) — each fills the other from the list of active stock items.
5. Type the **Quantity** (الكمية) in the item's base unit and the **Total Price (IQD)** (القيمة الإجمالية (د.ع)) — the whole cost of that quantity. The **Average Unit Price (IQD)** (متوسط سعر الوحدة (د.ع)) is worked out for you.
6. A new empty line opens when you fill the last one. To drop a line press ✕ (**Remove line** — حذف البند). The **Totals** (الإجماليات) row shows the document total.
7. Press **Save** (حفظ). The system gives the document its number, sends it for approval and opens its record.

### How to approve an opening stock document — Opening Stock
1. A person other than the one who entered it opens the document (click its Number in the list). The person who entered it does not get the button; they see **Waiting for approval.** (بانتظار الموافقة.).
2. Check the lines: item, quantity, total price, average unit price, warehouse.
3. Press **Approve and post** (موافقة وترحيل).
4. The status becomes **Approved** (معتمد); the stock is now in the warehouse.

### How to open a record — Opening Stock
1. In the list click the document's **Number** (الرقم).
2. The record shows: **Number** (الرقم), **Status** (الحالة), **Warehouse** (المخزن) (link to its profile), **Branch** (الفرع), **Date** (التاريخ), **Total** (المجموع); and the **Lines** (البنود): Item Name (link to the item), Item Code, Quantity, Total Price (IQD), Average Unit Price (IQD), Warehouse Name, Warehouse Code.
3. The title bar carries the four icons (printer, paperclip, notes, clock) — see "The four icons on a record" in Concepts — Inventory. Files can be attached until the document is approved.
4. The only action is **Approve and post** (موافقة وترحيل), while the status is Pending approval. There is no button to edit, reject, cancel or reverse an opening stock document.

### How to search the list — Opening Stock
1. Type in **Search this list** (ابحث في هذه القائمة) — any part of the number, date, warehouse code or name, or status — and press Enter.
2. **Clear** (مسح) shows everything again. The list is newest first: Number, Date, Warehouse Code, Warehouse Name, Lines, Total Price (IQD), Status.

### Fields — Opening Stock
- **Warehouse** (المخزن) — required. Where the stock stands. Only normal, active warehouses of your active branch; transit warehouses are not offered. One warehouse per document.
- **Date** (التاريخ) — required; default today. It is the date of the stock movement, of the journal entry, and of the FIFO cost layer: opening stock dated before later purchases is used up first.
- **Item Code** (رمز الصنف) / **Item Name** (اسم الصنف) — the first line must name an item. Only active stock items are suggested.
- **Quantity** (الكمية) — required on a line that names an item; above zero; in the item's base unit.
- **Total Price (IQD)** (القيمة الإجمالية (د.ع)) — required on a line that names an item; the total cost of the quantity in dinars; zero is accepted, a negative figure is not.
- **Average Unit Price (IQD)** (متوسط سعر الوحدة (د.ع)) — not typed: Total Price ÷ Quantity. It becomes the unit cost of the FIFO layer.
- There is no batch field: for an item tracked by batch the document's own number becomes the batch.

### After you save — Opening Stock
Statuses: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Approved** (معتمد). Saving on the screen goes straight to Pending approval; the screen never leaves a document in Draft. Nothing moves and nothing is posted until approval. When somebody else presses **Approve and post**: each line becomes a stock movement into the warehouse (type Opening Stock) and a FIFO cost layer at the average unit price dated the document date; and one journal entry is posted, dated the document date — debit each item's inventory account, credit the opening balance account. No journal is posted when the document's total value is zero. An approved document cannot be changed; a wrong quantity is corrected afterwards with Item Reconciliation or a Stock Count.

### Refusals — Opening Stock
- "Name at least one item." — no line names an item.
- "Line … names … but not its quantity and total price. Complete it, or clear the item." — fill both figures on that line or empty the line.
- "Line …: enter a quantity above zero." / "Line …: the total price cannot be negative." — correct the figure.
- "No item '…'. Opening stock can only be entered for an item that exists — create the item first (§4.4)." — the code typed is not an item; pick it from the list or create it on the Items screen.
- "… is a service, not a stock item, so it has no inventory." — a service cannot have opening stock.
- "… is tracked by serial, so this movement needs a serial number. …" — the item is tracked by serial number and this form has no serial field; it cannot be opened here.
- "Opening stock … is 'approved': only a submitted document can be approved." — it was already approved (for example a second press); nothing more to do.
- "Permission denied: 'approve' on 'opening_stock' is not granted to this user." or "… 'execute' on 'inventory_movement' …" — the approver needs both permissions.
- "No accounting mapping is configured for the 'opening_balance' line of 'inventory.opening_stock' … Configure the mapping in Accounting Mapping" — Finance has not set the opening balance account on Posting Mappings. Ask Finance to set it, then approve again.
- "Account … requires … Supply the missing value(s) and post again." — the account asks for an analysis value (such as a department) that this form does not carry; Finance must change the account's requirement or the mapping.
- "A stock movement dated … cannot be written: the period is closed" or "No accounting period covers …" — the document date is in a closed period, or in a year not opened yet. See Closed accounting periods in Concepts — Inventory.

## Manual Stock Additions (إضافات المخزون اليدوية)
Inventory → Receipts, Issues & Transfers → Manual Stock Additions   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← إضافات المخزون اليدوية
Address: /inventory/manual-additions (sheet: /inventory/manual-additions/new; record: /inventory/manual-additions/<number>)
Needs: `view` on `manual_stock_addition` to open; `create` to raise one; `edit_draft` to edit, return to draft or cancel one; `submit` to send it for approval; `approve` on `manual_stock_addition` and `execute` on `inventory_movement` to approve or reject; `create` to add a note; `create` on `manual_stock_addition` and on `attachment` to attach a file; `print` / `export` on `manual_stock_addition` for copies.
What it is for: Puts stock onto the books that arrived without a purchase invoice — found in a store, returned without a document, brought over from an old system — at what it cost, with the reason written down for the audit. One document is one warehouse with a line per item. It is a draft until somebody sends it for approval; a second person approves it, and approving brings the stock in and posts its journal. Also opened from the Warehouses Report: **Add items manually** (إضافة أصناف يدويًا) and **Manually added items** (الأصناف المضافة يدويًا).

### How to add items manually — Manual Stock Additions
1. Make sure your active branch (top of the screen) is the branch of the warehouse; only that branch's main, active warehouses are offered (no transit or shipment-stage warehouse).
2. Open Inventory → Receipts, Issues & Transfers → **Manual Stock Additions** (إضافات المخزون اليدوية) and press **Add items manually** (إضافة أصناف يدويًا) — or press the same button on the Warehouses Report; filtered to one warehouse, the report opens the sheet with that warehouse chosen.
3. Choose the **Warehouse** (المستودع) and check the **Posting Date** (تاريخ الترحيل) (today by default; not a day in the future).
4. Leave **Offset account** (الحساب المقابل) on **As configured** (حسب الإعداد) unless Finance has told you which account the value is credited to.
5. Write the **Note / reason** (ملاحظة / سبب) — why the stock is being added. It is required and stays with the record.
6. On the first line choose the **Item** (الصنف) (type to search), its **Unit** (الوحدة) — the base unit first, then the item's other units with what each holds — the **Quantity** (الكمية) in that unit and the **Unit price (IQD)** (سعر الوحدة (دينار)) — what one of that unit cost. The **Line value** (قيمة البند) and the **Total value** (إجمالي القيمة) are worked out as you type.
7. A new empty line opens when you choose an item on the last one; ✕ (**Remove line** — حذف البند) drops a line.
8. Press **Save as draft** (حفظ كمسودة). The system gives the document its number (MSA-branch-year-serial) and opens its record. Pressing twice saves it once.
9. On the record press **Send for approval** (إرسال للموافقة). The approvers are told in their notifications and see it in **My Approvals**.

### How to approve, reject or correct one — Manual Stock Additions
1. Somebody who holds approve and who neither raised it nor sent it opens the record (from My Approvals or the list).
2. Check the warehouse, the note and the lines, then press **Approve and post** (اعتماد وترحيل) — or write why in the box and press **Reject** (رفض).
3. Whoever raised or sent it does not get Approve; the record says **You raised or sent this one, so somebody else approves it.**
4. A rejected one shows who rejected it and why. Press **Return to draft** (إعادة إلى مسودة), then **Edit draft** (تعديل المسودة) to correct the sheet and **Save changes** (حفظ التعديلات), and send it again — or **Cancel** (إلغاء) it with a reason.
5. A draft is changed with **Edit draft** and set aside with **Cancel** and a reason. Nothing is ever deleted.
6. A super user's own sheet has **Save and approve** (حفظ واعتماد), and a super user's own draft has **Approve and post** instead of Send for approval: one press records both the sending and the approval.

### How to open a record, search and print — Manual Stock Additions
1. The list shows Number, Posting Date, Warehouse, Lines, Total value, Status and Created by, newest first. Type in **Search this list** (any part of the number, the warehouse, the note or who created it); filter by **Status** and **Warehouse** and press **Show** (عرض).
2. Click the number to open the record: the fields, the status, the lines (Item Code, Item Name, Unit, Quantity, Unit price, Line value, In base unit), then **FIFO layers created** (طبقات FIFO المُنشأة) and **Journal entries** (قيود اليومية) with each debit and credit.
3. The title bar carries the four icons — printer, paperclip, notes, clock — from the draft on. The printed copy shows the same fields, lines, layers and journal.

### Fields — Manual Stock Additions
- **Warehouse** (المستودع) — required; a main, active warehouse of your active branch. One warehouse per document.
- **Posting Date** (تاريخ الترحيل) — required; today by default; not in the future. It is the date of the stock movements, of the FIFO layers and of the journal; it must be in an open period when the document is approved.
- **Offset account** (الحساب المقابل) — optional. Empty: the value is credited to the account Finance mapped for the inventory adjustment (Posting Mappings → Item Reconciliation's `inventory.stock_adjustment` › `inventory_adjustment`, the same account a Stock Count surplus uses). Chosen: that account — any postable dinar account that is not a customer, supplier, loan or bank/cash account.
- **Department** (القسم) — optional; default **None** (بدون). The department the journal is analysed by. Choose one when the offset account asks for a department (the refusal says "requires Department / Cost Centre").
- **Note / reason** (ملاحظة / سبب) — required; up to 2,000 characters; kept for the audit.
- **Item** (الصنف) — an active stock item. Items tracked by serial number are not offered (their serials are entered on Opening Stock or a Purchase Invoice). A batch-tracked item takes the document's number as its batch.
- **Unit** (الوحدة) — one of the item's active units; the stock is received in the base unit (2 BOX of 24 come in as 48 EA). A quantity that does not convert exactly is refused.
- **Quantity** (الكمية) — above zero, in the line's unit.
- **Unit price (IQD)** (سعر الوحدة (دينار)) — above zero; what one of the line's unit cost.
- **Line value** (قيمة البند) — not typed: Quantity × Unit price.

### After you save — Manual Stock Additions
Statuses: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Approved** (معتمد); **Rejected** (مرفوض) goes back to Draft; **Cancelled** (ملغى) is final. Nothing moves and nothing posts until approval. On approval: each line becomes one stock movement into the warehouse (Stock Movement type **Manual Addition** — إضافة يدوية) and one FIFO cost layer in the base unit, at the line value ÷ the base quantity, dated the posting date; and one journal entry is posted on the posting date — debit each item's inventory account, credit the offset account — equal to the layers. The warehouse's quantity, the Warehouses Report and the valuation include the stock at once. An approved addition cannot be changed or cancelled; stock added wrongly is taken out again with Item Reconciliation (Out) or a Stock Count.

### Refusals — Manual Stock Additions
- "Say why the stock is being added — the note is kept with the record for the audit." — write the Note / reason.
- "… is not a main store …" / "… belongs to branch …" / "… is inactive …" — choose a main warehouse of your active branch, or switch branch first.
- "The posting date … is after today." — stock is added on the day it is there.
- "Line …: … is tracked by serial number …" — bring it in on Opening Stock or a Purchase Invoice.
- "Line …: … names no inventory account …" — set the item's inventory account on the item first.
- "… is not kept in … Add … to the item's units …" — choose one of the item's units, or add the unit on the item.
- "Line … names … but not its quantity and unit price." / "enter a quantity above zero" / "enter the stock price" — complete or clear the line.
- "… is the … control account …" / "… is a bank or cash account …" — choose another offset account, or leave it as configured.
- "whoever raised it or sent it for approval cannot approve it." — somebody else who holds approve approves it.
- "No accounting mapping is configured for the 'inventory_adjustment' line of 'inventory.stock_adjustment' …" — Finance has not mapped the inventory adjustment account; ask Finance to map it on Posting Mappings, or choose an offset account on the draft.
- "Account … requires Department / Cost Centre. Supply the missing value(s) and post again." — the account asks for a department. A draft: Edit draft, choose the **Department**, save and send it again. One waiting for approval: the approver rejects it, its author returns it to draft, chooses the Department and sends it again. For any other analysis value, Finance changes the account's requirement or the mapping.
- "the period is closed" / "No accounting period covers …" — the posting date is in a closed period or a year not opened; correct the date on the draft (Return to draft / Edit draft).
- "Manual stock addition … is '…': only …" — it has already moved on (for example a second press); open it again to see where it stands.

## Stock Receipts (إيصالات المخزون)
Inventory → Receipts, Issues & Transfers → Stock Receipts   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← إيصالات المخزون
Address: /inventory/stock-receipts
Needs: `view` on `stock_movement`.
What it is for: A read-only register of everything that came into stock, taken from the stock ledger: goods receipts, opening stock, an import's arrival from transit, returns, stock found by a count or reconciliation, and reversed issues. Nothing is entered here — the documents do that. Transfers between warehouses are not listed (they are on the Transfer screen).

### How to read and filter the list — Stock Receipts
1. Open Inventory → Receipts, Issues & Transfers → **Stock Receipts** (إيصالات المخزون). Newest first, fifty rows a page.
2. Search with **Search this list** (ابحث في هذه القائمة): item code, item name, warehouse code or document number.
3. Narrow with **From** (من) and **To** (إلى) dates, **Warehouse** (المخزن) (default **All warehouses** — كل المستودعات) and **Kind** (النوع) (default **All kinds** — كل الأنواع), then press **Filter** (تصفية).
4. Click the **Number** (الرقم) to open the document that moved the stock, the item code or warehouse to open its profile, the **Journal** (القيد) number to open the journal entry.

### Fields — Stock Receipts
- **Date** (التاريخ) — the date of the movement.
- **Kind** (النوع) — one of: **Goods receipt** (استلام بضاعة) — a purchase; **Opening stock** (مخزون افتتاحي); **Container receipt** (استلام حاوية) — an import arriving from a transit warehouse; **Sales return** (مرتجع مبيعات); **Project return** (إرجاع من مشروع); **Count / reconciliation** (جرد / مطابقة) — stock found by a Stock Count or added by an Item Reconciliation "In"; **Reversal** (عكس) — an issue that was reversed.
- **Number** (الرقم) — the document's number. It opens the purchase invoice, sales return, opening stock, stock count, the import (for a container receipt) or the project material issue; for a reconciliation it opens the Item Reconciliation list. "—" when the movement has no document.
- **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **Warehouse** (المخزن).
- **Quantity** (الكمية) — in the item's base unit, shown with the unit.
- **Unit cost (IQD)** (تكلفة الوحدة (د.ع)) and **Value (IQD)** (القيمة (د.ع)) — what the receipt was valued at when it came in (quantity × the cost of its FIFO layer at receipt). "—" when unknown.
- **Journal** (القيد) — the journal entry recorded on the movement itself, when there is one. "—" does not always mean nothing was posted: many documents post one journal for the whole document, which you find on the document's own page.

### After you save — Stock Receipts
Nothing is saved on this screen; it is read-only. A row appears as soon as a document posts a movement into stock.

### Refusals — Stock Receipts
- **Not available to you** (غير متاح لك) — you do not hold the permission to view stock movements; ask an administrator.

## Stock Issues (صرف المخزون)
Inventory → Receipts, Issues & Transfers → Stock Issues   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← صرف المخزون
Address: /inventory/stock-issues
Needs: `view` on `stock_movement`.
What it is for: A read-only register of everything that left stock, taken from the stock ledger: sales, project material issues, returns to suppliers, write-offs and damage, stock counted short, and reversed receipts. Nothing is entered here. Transfers between warehouses are not listed.

### How to read and filter the list — Stock Issues
1. Open Inventory → Receipts, Issues & Transfers → **Stock Issues** (صرف المخزون). Newest first, fifty rows a page.
2. Search with **Search this list** (ابحث في هذه القائمة): item code, item name, warehouse code or document number.
3. Narrow with **From** (من) and **To** (إلى) dates, **Warehouse** (المخزن) and **Kind** (النوع), then press **Filter** (تصفية).
4. Click the **Number** (الرقم) to open the document, the item or warehouse to open its profile, the **Journal** (القيد) number to open the journal entry.

### Fields — Stock Issues
- **Date** (التاريخ) — the date of the movement.
- **Kind** (النوع) — one of: **Sale** (بيع) — a sales invoice or delivery, and also an issue made from the Availability dialog; **Project material issue** (صرف مواد لمشروع); **Supplier return** (مرتجع للمورد); **Write-off** (شطب); **Damage** (تلف); **Count / reconciliation** (جرد / مطابقة) — stock counted short or removed by an Item Reconciliation "Out"; **Reversal** (عكس) — a receipt that was reversed.
- **Number** (الرقم) — the document's number, opening the sales invoice, delivery note, purchase return, stock count or project material issue; a reconciliation opens the Item Reconciliation list. "—" when the movement has no document (an issue from the Availability dialog).
- **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **Warehouse** (المخزن).
- **Quantity** (الكمية) — shown as a positive figure in the base unit.
- **Unit cost (IQD)** (تكلفة الوحدة (د.ع)) and **Value (IQD)** (القيمة (د.ع)) — the FIFO cost of what left: the cost of the layers the issue used up.
- **Journal** (القيد) — the journal entry recorded on the movement itself, when there is one.

### After you save — Stock Issues
Nothing is saved on this screen; it is read-only. A row appears as soon as a document posts a movement out of stock.

### Refusals — Stock Issues
- **Not available to you** (غير متاح لك) — you do not hold the permission to view stock movements; ask an administrator.

## Transfer (التحويل)
Inventory → Receipts, Issues & Transfers → Transfer   |   Arabic: المخزون ← الاستلام والصرف والتحويل ← التحويل
Address: /inventory/transfers (one transfer: /inventory/transfers/<transfer number>)
Needs: `view` on `warehouse_transfer` to open the list and a transfer's record; `create` on `warehouse_transfer` and `execute` on `inventory_movement` to make a transfer; `print` / `export` on `warehouse_transfer` for copies; `create` on `warehouse_transfer` to add a note or a file to a transfer's record.
What it is for: Moves an item from one warehouse to another inside the same branch. Saving the form moves the stock at once — out of the first warehouse, into the second — at the cost it already carries. There is no request to approve and nothing stays "on the way".

### How to transfer stock between warehouses — Transfer
1. Make sure your active branch (top of the screen) is the branch of both warehouses; only that branch's normal, active warehouses are offered.
2. Open Inventory → Receipts, Issues & Transfers → **Transfer** (التحويل) and press **New transfer** (تحويل جديد).
3. **Item Name** (اسم الصنف): start typing and pick the item from the list. The name must match an item exactly; a half-typed name sends nothing and is refused.
4. **From Warehouse** (من مستودع): the warehouse the stock leaves.
5. **To Warehouse** (إلى مستودع): the warehouse it goes to. It must be a different one.
6. **Quantity** (الكمية): in the item's base unit.
7. **Date** (التاريخ): today by default.
8. Press **Create** (إنشاء). The transfer gets its number and appears in the list with **Recorded** (مسجّل) in the **Stock Movement** (حركة المخزون) column. The screen returns to the list; click the new transfer's **Number** (الرقم) to open its record.

### How to search the list and print a transfer — Transfer
1. Type in **Search this list** (ابحث في هذه القائمة) — any part of the number, date, item code or name, or warehouse code — and press Enter. **Clear** (مسح) shows everything again.
2. Click a transfer's **Number** (الرقم) to open its record (see "How to open a transfer and what it shows").
3. To take a copy without opening it: on the transfer's row open **Print / Export** (طباعة / تصدير) and choose PDF, Excel (.xlsx) or Word (.docx), in English or العربية. The same copy is behind the printer icon on the record.

### How to open a transfer and what it shows — Transfer
Needs: `view` on `warehouse_transfer`.
1. In the list click the transfer's **Number** (الرقم). The record opens titled with the number; the back button **Transfer** (التحويل) returns to the list.
2. The header: **Number** (الرقم); **Status** (الحالة) — **Recorded** (مسجّل) or **No ledger entry** (لا قيد في السجل); **Item Name** (اسم الصنف), **From Warehouse** (من مستودع), **To Warehouse** (إلى مستودع) and **Branch** (الفرع) — each a link to its own page; **Date** (التاريخ); **Quantity** (الكمية) with the base unit; **Cost carried (IQD)** (الكلفة المنقولة (د.ع)) — what the moved stock cost, in total; **Created** (تاريخ الإنشاء) — who made the transfer and when.
3. The lines, **Layers carried** (الطبقات المنقولة): one row for each FIFO layer the transfer took stock from, oldest first — #, **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **Batch** (الدفعة), **Layer date** (تاريخ الطبقة) — the layer's FIFO date, **Quantity** (الكمية) taken from that layer, **Unit cost (IQD)** (كلفة الوحدة (د.ع)) and **Value (IQD)** (القيمة (د.ع)). A transfer of 15 units that emptied a layer of 10 and took 5 from the next shows two rows. At the foot: the total **Quantity** and **Cost carried (IQD)**; the rows add up to them.
4. Under the window, **Stock positions** (أرصدة المخزون) "as the Stock Ledger carries them": one row for the warehouse the stock left and one for the warehouse it went to — **Warehouse** (المخزن), **Before** (قبل), **Change** (التغيّر) — minus for the first, plus for the second — and **After** (بعد). Before + Change = After.
5. The title bar carries the four icons — see "The four icons and the printed copy".
There is no button on the record: a transfer is complete when it is saved, so there is nothing to approve, edit, cancel or reverse here.

### How to read the layers and the positions — Transfer
- The costs on a transfer's record are the exact figures the stock ledger holds — 12.5 a unit, 37.5 for three — to as many as four decimals, not rounded to whole dinars. This is so that the layer rows can be added up and checked against **Cost carried (IQD)**.
- Each layer arrives in the second warehouse with the same unit cost and the same FIFO date it had in the first. That is why a transfer changes no value and posts no journal.
- **Before** and **After** are the item's balance in that warehouse in the Stock Ledger's own order, just before and just after this transfer. A document entered later — even one dated the same day — does not change them. To see today's balance open the Stock Ledger or Availability.
- Example: Main held 40 and Shop held 6; a transfer of 15 shows Main Before 40, Change -15, After 25 and Shop Before 6, Change +15, After 21.
- **No ledger entry** (لا قيد في السجل) in the status, with "No layers: the Stock Movement ledger holds nothing for this transfer." and no positions: the transfer moved nothing the system can see. It is a leftover of data removed outside the application — report it to the accounting manager, do not enter it again.

### The four icons and the printed copy — Transfer
A transfer's record carries the four icons in its title bar from the moment it is saved:
1. **Printer** — **Print / Export** (طباعة / تصدير): PDF needs `print` on `warehouse_transfer`, Excel (.xlsx) and Word (.docx) need `export`; in English or العربية.
2. **Paperclip** — **Attachments** (المرفقات): for example the signed slip between the two warehouses. **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Adding a file needs `create` on `warehouse_transfer` and the permission to attach files.
3. **Speech bubble** — **Notes** (الملاحظات): dated, signed notes, never edited. The box **Add note** (إضافة ملاحظة) shows to whoever holds `create` on `warehouse_transfer`.
4. **Clock** — **Audit log** (سجل التدقيق): what has been recorded about this transfer — who made it and when, and the notes added since.
The printed copy is titled **Transfer** (تحويل مخزني) and carries what the record shows: the header facts, the **Layers carried** table (batch, layer date, quantity, unit cost to four decimals, value, with totals), the **Stock positions** table (each warehouse with its code and name: Before, Change, After) and the signature boxes. A transfer with **No ledger entry** prints stamped DRAFT / NOT POSTED.

### Fields — Transfer
New transfer form:
- **Item Name** (اسم الصنف) — required. Only active stock items are listed.
- **From Warehouse** (من مستودع) — required. A normal, active warehouse of your active branch.
- **To Warehouse** (إلى مستودع) — required. Another normal, active warehouse of the same branch.
- **Quantity** (الكمية) — required; above zero; base unit; cannot be more than the first warehouse has available (held minus reserved).
- **Date** (التاريخ) — required; default today. The date of both movements.

List columns: **Number** (الرقم) — opens the transfer's record, **Date** (التاريخ), **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **From Warehouse** (من مستودع), **To Warehouse** (إلى مستودع), **Quantity** (الكمية), **Stock Movement** (حركة المخزون), **Print / Export** (طباعة / تصدير).
- **Stock Movement** (حركة المخزون) shows **Recorded** (مسجّل) when the stock ledger holds the transfer's movements — always the case for a transfer made on this screen. **No ledger entry** (لا قيد في السجل) means the transfer has no lines in the stock ledger and moved nothing; it is a leftover of data removed outside the application — report it to the accounting manager, do not enter it again.

### After you save — Transfer
There is no approval and no status to move through: the transfer is done when it is saved (the **Status** on its record only says whether the stock ledger holds it — **Recorded** — or not). The system writes the stock out of the first warehouse and into the second on the chosen date, oldest stock first. Each cost layer arrives with the same unit cost, the same FIFO date and the same supplier it had, so the value of the stock does not change. No journal entry is posted. Both movements show on Stock Movement and the Stock Ledger with the type **Transfer** (تحويل), the warehouse it came from and the one it went to. Pressing Create twice on the same form moves the stock only once. There is no edit, cancel or reverse button, on the list or on the transfer's record; a new transfer in the opposite direction moves the stock back. What the transfer did can be read afterwards on its record: the layers it carried and what both warehouses held before and after.

### Refusals — Transfer
- "No item ''. Choose an item from the list." — the item name did not match an item exactly; pick it from the suggestions.
- "Enter a quantity above zero." / "Enter the date." — fill the field.
- "Stock moves between two different warehouses. Choose another destination." — From and To are the same warehouse.
- "Choose the source warehouse." / "Choose the destination warehouse." — a warehouse was not chosen.
- "… is inactive, so no stock can move through it." — the warehouse was closed; reopen it on the Warehouses screen or choose another.
- "… belongs to another branch. Choose a warehouse of this branch." — switch your active branch to the warehouse's branch, or choose a warehouse of the current branch. A transfer cannot cross branches.
- "… holds … of …, so … cannot be transferred. Negative stock is not allowed." — the first warehouse does not have that much available; transfer less.
- "Only … of … in … has a cost to carry. Nothing was transferred." — part of the quantity has no cost layer behind it; the stock records are inconsistent. Tell the accounting manager and open Inventory Checks.
- "The form is stale. Open it again." — close the dialog, reload the page and open **New transfer** again.
- "… is tracked by serial, so this movement needs a serial number. …" — the item is tracked by serial number and this form cannot move it.
- "… is a service, not a stock item, so it has no inventory." — services cannot be transferred.
- "A stock movement dated … cannot be written: the period is closed" — choose a date in an open period.
- "Permission denied: 'execute' on 'inventory_movement' is not granted to this user." — you may raise transfers but not move stock; ask an administrator.
- **That page does not exist** (هذه الصفحة غير موجودة) on a transfer's address — no transfer has that number, or it belongs to a branch you are not assigned to. Open it from the list.

## Stock Movement (حركة المخزون)
Inventory → Stock & Availability → Stock Movement   |   Arabic: المخزون ← المخزون والتوفّر ← حركة المخزون
Address: /inventory/stock-movements
Needs: `view` on `stock_movement`; `print` / `export` on `stock_movement` for copies.
What it is for: A read-only list of every movement of stock in your active branch, In or Out, newest first, with the document that made it and who entered it. It is the stock ledger itself, line by line; the Warehouses Report is these lines added up.

### How to read and filter the list — Stock Movement
1. Open Inventory → Stock & Availability → **Stock Movement** (حركة المخزون). It shows the active branch only; switch branch at the top of the screen to see another.
2. Set any of: **From** (من) and **To** (إلى) dates; **Item Name** (اسم الصنف) — type part of the name or of the code (**Name or code** — الاسم أو الرمز); **Warehouse** (المخزن) (default **All warehouses** — كل المستودعات; transit warehouses are in the list too); **Document** (المستند) — part of an invoice, return or transfer number.
3. Press **Show** (عرض).
4. The line above the table says how many there are: "Showing 1–200 of … movements, newest first". Two hundred a page; use **Older** (الأقدم) and **Newer** (الأحدث) to move.
5. Click a document number to open it.
6. **Print / Export** (طباعة / تصدير) at the top downloads the list with the filters you set.

### Fields — Stock Movement
- **Date** (التاريخ) — the date of the movement.
- **Item Code** (رمز الصنف), **Item Name** (اسم الصنف).
- **Entered** (أُدخل) — the moment it was entered, so two movements on the same date read in the order they happened.
- **Warehouse Code** (رمز المخزن), **Warehouse Name** (اسم المخزن) — the warehouse this line belongs to.
- **From** (من) and **To** (إلى) — for a transfer or a shipment stage, the warehouse the stock left and the one it reached. "—" for other movements.
- **Movement** (الحركة) — the type: **Opening Stock** (رصيد أول المدة); **Purchase** (شراء); **Sale** (بيع); **Transfer** (تحويل); **Invoice Status Tracking** (تتبع حالة الفواتير) — a purchase moving between the In Process, On Board and At Port warehouses; **Reconciliation** (تسوية) — an Item Reconciliation or a Stock Count adjustment; **Sales Return** (مرتجع مبيعات); **Purchase Return** (مرتجع مشتريات); **Other** (أخرى) — anything else, such as a reversal, a project issue or return, a write-off or damage.
- **In** (إدخال) / **Out** (إخراج) — the quantity, in one column or the other.
- **Unit** (الوحدة) — the item's base unit.
- **Document** (المستند) — the number of the purchase invoice, sales invoice, sales return, purchase return, opening stock, transfer or reconciliation. A transfer or reconciliation number opens its list with the number in the search box. Other kinds of document (for example a stock count or a project issue) show no number here; find them on Stock Receipts or Stock Issues.
- **Raised by** (أدخله) — who entered it.

### After you save — Stock Movement
Nothing is saved on this screen; it is read-only. A warning line at the top — "The stock ledger disagrees with its documents in … place(s)." — appears only when the checks find a problem; tell the accounting manager and open Inventory Checks.

### Refusals — Stock Movement
- **Not available to you** (غير متاح لك) — you do not hold the permission to view stock movements; ask an administrator.
- **No movements in this range.** (لا توجد حركات في هذه الفترة.) — nothing matches the filters in the active branch; widen the dates or switch branch.

## Stock Ledger (دفتر المخزون)
Inventory → Stock & Availability → Stock Ledger   |   Arabic: المخزون ← المخزون والتوفّر ← دفتر المخزون
Address: /inventory/stock-ledger
Needs: `view` on `stock_movement`; `print` / `export` on `stock_movement` for copies.
What it is for: One item, warehouse by warehouse: the opening balance, every movement oldest first with the balance carried down after each, and the closing balance. It answers "why does the screen say this quantity?" — the closing balance is the same figure Availability and the Warehouses Report show. Read-only, active branch only.

### How to read an item's ledger — Stock Ledger
1. Open Inventory → Stock & Availability → **Stock Ledger** (دفتر المخزون), or press **Movements** (الحركات) on a row of Availability or of the Warehouses Report (the item and warehouse are then already chosen).
2. **Item Name** (اسم الصنف): required — type and pick the item from the list (shown as name · code).
3. Optionally choose a **Warehouse** (المخزن) (default **All warehouses** — كل المستودعات) and **From** (من) / **To** (إلى) dates.
4. Press **Show** (عرض).
5. Each warehouse gets its own table: the first line is **Opening** (الافتتاحي) — what the warehouse held before the From date (zero when no From date is set); then every movement with the **Balance** (الرصيد) after it; the last line is **Closing** (الختامي).
6. Click a document number to open the document.
7. **Print / Export** (طباعة / تصدير) at the top downloads the ledger.

### Fields — Stock Ledger
- **Date** (التاريخ), **Entered** (أُدخل) — the movement's date and the moment it was entered.
- **Movement** (الحركة) — the type, the same list as on Stock Movement: Opening Stock, Purchase, Sale, Transfer, Invoice Status Tracking, Reconciliation, Sales Return, Purchase Return, Other.
- **Document** (المستند) — the document's number (link), or "—".
- **From** (من) / **To** (إلى) — both ends of a transfer.
- **In** (إدخال) — quantity in, shown with a plus sign. **Out** (إخراج) — quantity out, shown with a minus sign.
- **Balance** (الرصيد) — the quantity in the warehouse after this line.
- **Unit** (الوحدة) — the base unit. **Raised by** (أدخله) — who entered it.

### After you save — Stock Ledger
Nothing is saved on this screen; it is read-only.

### Refusals — Stock Ledger
- "Choose an item to read its ledger. Every row is a document; the number opens it." (اختر صنفاً لقراءة دفتره) — no item is chosen yet; pick one and press Show.
- "No movements of … in this range." — the item has no movements in the active branch for the dates and warehouse chosen; widen the dates or switch branch.
- **Not available to you** (غير متاح لك) — you do not hold the permission to view stock movements.

## Stock Count (جرد المخزون)
Inventory → Counts & Valuation → Stock Count   |   Arabic: المخزون ← الجرد والتقييم ← جرد المخزون
Address: /inventory/stock-count (record: /inventory/stock-count/<count number>)
Needs: `view` on `stock_count` to open; `create` on `stock_count` to plan a count and to add notes; `execute` on `stock_count` to record the count or recount, request a recount, adjust the books, cancel, and (with `create` on `attachment`) attach files; `approve` on `stock_count` to approve the variance; adjusting also needs `execute` on `inventory_movement`; `print` / `export` on `stock_count` for copies.
What it is for: The physical count of a warehouse. A count is planned (the book quantities are frozen at that moment), the counters record what they found on the lines, a recount can be asked for, a manager approves the difference, and then the books are adjusted to the count with a journal entry.

### How to plan a count — Stock Count
1. Make sure your active branch (top of the screen) is the branch of the warehouse you will count. A count planned under another branch cannot be adjusted later.
2. Open Inventory → Counts & Valuation → **Stock Count** (جرد المخزون) and press **Plan a count** (تخطيط جرد).
3. **Warehouse** (المخزن): the warehouse to count. Transit warehouses are not offered.
4. **Planned on** (تاريخ التخطيط): today by default.
5. **Scope** (النطاق): **Everything** (كل شيء) or **The warehouse** (المستودع) — all stock in that warehouse; **One item** (صنف واحد); or **One category** (فئة واحدة).
6. **Item code or category** (رمز الصنف أو الفئة): fill it only for One item (the exact item code) or One category (the exact category).
7. Press **Plan** (تخطيط). The count gets its number and its page opens with status **Planned** (مخطَّط). It has one line per item — and per batch for an item tracked by batch — that the stock ledger shows in the warehouse, each with its **Book quantity** (الكمية الدفترية) frozen at this moment.

### How to record what was counted — Stock Count
1. Open the count (click its Number in the list). While the status is **Planned** each line has a box in the **Counted** (المعدود) column and a **Note** (ملاحظة) box.
2. Type what was found on each line, in the item's base unit. Type 0 when nothing was found. A line left empty is treated as not counted: it gets no variance and will not be adjusted.
3. Add a note on any line where something looked wrong.
4. At the foot set **Counted on** (تاريخ العدّ) (today by default) and press **Record the count** (تسجيل العدّ).
5. The status becomes **Counted** (معدود) and the **Variance** (الفرق) column shows counted minus book quantity for each line.

### How to request and record a recount — Stock Count
1. On a count with status **Counted**, type the reason in the box **What looked wrong** (ما بدا خاطئًا) and press **Request a recount** (طلب إعادة عدّ). The status becomes **Recount** (إعادة عدّ).
2. The lines now have a box in the **Recount** (إعادة العدّ) column. Type the recounted quantity on the lines that were counted again.
3. Set **Counted on** (تاريخ العدّ) and press **Record the recount** (تسجيل إعادة العدّ). The status returns to **Counted**.
4. Where a recount figure exists it replaces the first count for the variance; both figures stay on the line.

### How to approve the variance — Stock Count
1. On a count with status **Counted**, a person who may approve reads the lines and the variances.
2. Type the reason in the box **Why the variance is accepted** (سبب قبول الفرق).
3. Press **Approve the variance** (اعتماد الفرق). The status becomes **Variance approved — to adjust** (اعتُمد الفرق — للتعديل). Nothing has moved yet.

### How to adjust the books — Stock Count
1. On a count with status **Variance approved — to adjust**, set the date **Adjusted on** (تاريخ التعديل) (today by default).
2. Choose a **Department** (القسم) if the Inventory Adjustment account asks for one; otherwise leave it.
3. Press **Adjust the books** (تعديل الدفاتر).
4. The status becomes **Adjusted** (معدَّل). Every line with a variance has been corrected in the stock ledger and posted.

### How to cancel a count — Stock Count
1. On a count that is not yet Adjusted, type the reason in the box **Why the count is cancelled** (سبب إلغاء الجرد).
2. Press **Cancel the count** (إلغاء الجرد). The status becomes **Cancelled** (ملغى). Nothing is moved or posted. A cancelled or adjusted count cannot be reopened; plan a new one.

### How to open a record, search and print — Stock Count
1. The list shows **Number** (الرقم), **Warehouse** (المخزن), **Scope** (النطاق), **Planned on** (تاريخ التخطيط), **Counted on** (تاريخ العدّ), **Lines** (السطور), **Variances** (الفروقات) — how many lines differ from the book — and **Status** (الحالة). Fifty a page, newest first.
2. Search with **Search this list** (ابحث في هذه القائمة) (count number, warehouse code or name, scope text). Filter by **Status** (الحالة) (default **All statuses** — كل الحالات) and **Warehouse** (المخزن), then press **Filter** (تصفية).
3. Click the **Number** to open the count. Its page shows Number, Status, Warehouse (link), Branch, Scope, Planned on (date and who), Counted on (date and who), **Variance approved by** (اعتمد الفرق) (who, when, the reason), Adjusted on; the lines; and the total **Variances**.
4. The four icons in the title bar (printer, paperclip, notes, clock) work as described in "The four icons on a record" in Concepts — Inventory. The printer gives the count sheet as PDF, Excel or Word.

### Fields — Stock Count
Plan a count form:
- **Warehouse** (المخزن) — required. An active warehouse that is not a transit warehouse, in a branch you may see.
- **Planned on** (تاريخ التخطيط) — required; default today.
- **Scope** (النطاق) — required; default **The warehouse** (المستودع). **Everything** (كل شيء) and **The warehouse** both take every item held in the warehouse; **One item** (صنف واحد) takes one item; **One category** (فئة واحدة) takes the items of one category.
- **Item code or category** (رمز الصنف أو الفئة) — required for One item and One category, ignored otherwise. It must be typed exactly as the item code or the category is written.

Lines on the count's page:
- **#** — line number. **Item Code** (رمز الصنف) (link), **Item Name** (اسم الصنف).
- **Batch** (الدفعة) — the batch (or serial number) the line counts; "—" when none.
- **Book quantity** (الكمية الدفترية) — what the stock ledger held when the count was planned, with the unit. It does not change afterwards, even if stock moves during the count.
- **Counted** (المعدود) — what was found at the first count.
- **Recount** (إعادة العدّ) — what was found at the recount, if any.
- **Variance** (الفرق) — recount (or counted) minus book quantity. Positive = more found than the books say; negative = less.
- **Note** (ملاحظة) — free text per line.

Action boxes: **What looked wrong** (ما بدا خاطئًا), **Why the variance is accepted** (سبب قبول الفرق), **Why the count is cancelled** (سبب إلغاء الجرد) — each required for its button; **Adjusted on** (تاريخ التعديل) — required, default today, the date of the adjustment movements and their journals; **Department** (القسم) — optional.

### After you save — Stock Count
Statuses: **Planned** (مخطَّط) → **Counted** (معدود) → (optionally **Recount** (إعادة عدّ) → Counted again) → **Variance approved — to adjust** (اعتُمد الفرق — للتعديل) → **Adjusted** (معدَّل). **Cancelled** (ملغى) is possible at any point before Adjusted.
Who acts: the person who plans; the counters who record; a manager who approves the variance; then whoever may adjust. The system asks only for the right permission at each step; it does not stop the person who counted from approving the variance.
Nothing moves and nothing is posted until **Adjust the books**. Then, for every line with a variance: a surplus is received into the warehouse, valued at what the item already costs there (the average of its remaining stock in that warehouse; if none, anywhere; if none, its last cost), posting debit the item's inventory account, credit Inventory Adjustment; a shortfall is issued at FIFO cost, posting debit Inventory Adjustment, credit the item's inventory account. Each line posts its own journal entry dated Adjusted on. The movements show on Stock Receipts / Stock Issues as **Count / reconciliation** with the count's number, and on Stock Movement as **Reconciliation**.

### Refusals — Stock Count
- "Name the item to count." / "Name the category to count." — the scope is One item or One category and the box beside it is empty.
- "Nothing is in scope for this count: … Widen the scope, or check that the warehouse holds the stock you meant." — the warehouse holds nothing matching the scope; check the item code or category spelling, or the warehouse.
- "Enter what was found on at least one line." — no quantity was typed before pressing Record.
- "Stock count … is '…': a count can only be recorded while it is planned or being recounted." — the count has moved on; reload the page.
- "Stock count … is '…': only a completed count can be sent for recount." — a recount can be asked only while the status is Counted.
- "A recount costs the warehouse a day. §5.4 keeps the reason with it — state what looked wrong." — type the reason.
- "Approving a variance moves stock and may post a loss. §5.4 keeps the reason with it — state what the difference was and why it is accepted." — type the reason.
- "Stock count … is '…': a variance can only be approved once the stock has been counted." — record the count first.
- "Stock count … has a variance nobody has approved, so nothing can be adjusted (§9.6). …" or "… the adjustment follows an approved variance." — the variance must be approved before adjusting.
- "Stock count … is '…': only a count not yet adjusted is cancelled." / "Say why the count is cancelled (§5.4)." — an adjusted count cannot be cancelled; a reason is required.
- "… belongs to branch …, and this movement was raised under … Choose a warehouse of the current branch, or switch branch first." — the count was planned while another branch was active, so it cannot be adjusted. Cancel it, switch to the warehouse's branch and plan it again.
- "Cannot issue … of … from …: … is available. Negative inventory is prohibited without exception (§9.2). …" — stock left the warehouse after the count was planned, so the shortfall is larger than what is there now. Cancel the count and count again.
- "… has never had a cost, so stock found of it cannot be valued. Enter its first stock on Opening Stock or a Purchase Invoice." — a surplus of an item that never had a cost cannot be valued.
- "… is tracked by batch, so this movement needs a batch number. …" — a line of a batch-tracked item carries no batch (its Batch column shows "—"), so its adjustment cannot be written and nothing was adjusted. Tell the accounting manager.
- "No accounting mapping is configured for the 'inventory_adjustment' line of 'inventory.stock_adjustment' …" — Finance has not set the Inventory Adjustment account on Posting Mappings.
- "Account … requires … Supply the missing value(s) and post again." — the Inventory Adjustment account asks for a department; choose one in the Department box and adjust again.
- "A stock movement dated … cannot be written: the period is closed" — choose an Adjusted on date in an open period.
- "Permission denied: '…' on 'stock_count' is not granted to this user." or "… 'execute' on 'inventory_movement' …" — you lack the permission for that step.

## Item Reconciliation (تسوية الأصناف)
Inventory → Counts & Valuation → Item Reconciliation   |   Arabic: المخزون ← الجرد والتقييم ← تسوية الأصناف
Address: /inventory/stock-reconciliation (one reconciliation: /inventory/stock-reconciliation/<reconciliation number>)
Needs: `view` on `stock_reconciliation` to open the list and a reconciliation's record; `create` on `stock_reconciliation` and `execute` on `inventory_movement` to make one; `print` / `export` on `stock_reconciliation` for copies; `create` on `stock_reconciliation` to add a note or a file to a record; `view` on `journal_entry` to see the journal's lines on a record.
What it is for: A quick correction of one item in one warehouse to bring the system's quantity to what is really on the shelf: **In** adds stock that was found, **Out** removes stock that is missing. It moves the stock and posts the value at once, with no approval. For counting a whole warehouse use Stock Count.

### How to make a reconciliation (adjustment) — Item Reconciliation
1. Make sure your active branch (top of the screen) is the branch of the warehouse.
2. Open Inventory → Counts & Valuation → **Item Reconciliation** (تسوية الأصناف) and press **New reconciliation** (تسوية جديدة).
3. Type the **Item Code** (رمز الصنف) or the **Item Name** (اسم الصنف) and pick the item; each box fills the other.
4. Choose the **Warehouse** (المخزن).
5. **In/Out** (إدخال/إخراج): **In** (إدخال) to add stock that was found, **Out** (إخراج) to remove stock that is missing.
6. **Adjustment Quantity** (كمية التسوية): the difference, in the item's base unit — not the new total.
7. **Date** (التاريخ): today by default.
8. Press **Create** (إنشاء). The reconciliation gets its number and appears in the list. The screen returns to the list; click the new reconciliation's **Number** (الرقم) to open its record and see the journal it posted.

### How to search the list and print a reconciliation — Item Reconciliation
1. Type in **Search this list** (ابحث في هذه القائمة) — number, date, item or warehouse — and press Enter; **Clear** (مسح) shows everything again.
2. Click a reconciliation's **Number** (الرقم) to open its record (see "How to open a reconciliation and what it shows").
3. To take a copy without opening it: on the row open **Print / Export** (طباعة / تصدير) for a PDF, Excel or Word copy in English or العربية. The same copy is behind the printer icon on the record.

### How to open a reconciliation and what it shows — Item Reconciliation
Needs: `view` on `stock_reconciliation`; the journal's lines also need `view` on `journal_entry`.
1. In the list click the reconciliation's **Number** (الرقم). The record opens titled with the number; the back button **Item Reconciliation** (تسوية الأصناف) returns to the list.
2. The header: **Number** (الرقم); **Status** (الحالة); **Item Name** (اسم الصنف), **Warehouse** (المخزن) and **Branch** (الفرع) — each a link to its own page; **Date** (التاريخ); **In/Out** (إدخال/إخراج) — **In** (إدخال) or **Out** (إخراج); **Adjustment Quantity** (كمية التسوية) with the base unit; **Value (IQD)** (القيمة (د.ع)) — what the adjusted stock was worth at cost; **Journal** (القيد) — the number of the journal it posted (a link if you may open journals), or "—"; **Created** (تاريخ الإنشاء) — who made it and when.
3. The lines. For an Out: **Layers taken out** (الطبقات المُخرَجة) — one row for each FIFO layer the stock left, oldest first. For an In: **Layer brought in** (الطبقة المُدخَلة) — the one new layer it created. Columns: #, **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **Batch** (الدفعة), **Layer date** (تاريخ الطبقة), **Quantity** (الكمية), **Unit cost (IQD)** (كلفة الوحدة (د.ع)), **Value (IQD)** (القيمة (د.ع)). At the foot: the total **Adjustment Quantity** and **Value (IQD)**.
4. Under the window, **Stock position** (رصيد المخزون) "as the Stock Ledger carries it": the warehouse with **Before** (قبل), **Change** (التغيّر) — plus for an In, minus for an Out — and **After** (بعد).
5. Then **Posting** (الترحيل), with the journal's number as a link: #, **Account** (الحساب) — a link to the account, **Debit** (مدين), **Credit** (دائن). It is shown only to a reader who may open journal entries.
6. The title bar carries the four icons — see "The four icons and the printed copy".
There is no button on the record: a reconciliation is complete when it is saved, so there is nothing to approve, edit, cancel or reverse here.

### How to read the status, the layers and the journal — Item Reconciliation
The **Status** (الحالة) of a reconciliation's record is not typed by anyone; it says what stands behind the document:
- **Posted** (مرحّل) — its stock movement is in the stock ledger and its journal is posted. The normal case.
- **Reversed** (معكوس) — its journal has since been reversed.
- **Recorded** (مسجّل) — the stock moved but no journal was posted, because the stock it moved carried no cost. **Journal** shows "—".
- **No ledger entry** (لا قيد في السجل) — the stock ledger holds nothing for this reconciliation ("No layers: the Stock Movement ledger holds nothing for this reconciliation."). It is a leftover of data removed outside the application: report it to the accounting manager, do not enter it again.
Reading the figures:
- Costs are the exact figures of the stock ledger and the journal, to as many as four decimals (12.5 a unit, 37.5 for three), not rounded to whole dinars — so the layer rows add up to **Value (IQD)**, and **Value (IQD)** equals the journal's debit and credit.
- An Out of 8 that emptied a layer of 5 at 100 and took 3 from a layer at 120 shows two rows, 500 and 360, and a journal of 860: debit Inventory Adjustment, credit the item's inventory account.
- An In shows one row: the new layer, whose **Batch** (الدفعة) is the reconciliation's own number, at the unit cost the system gave it (see "After you save"). Journal: debit the item's inventory account, credit Inventory Adjustment.
- **Before** and **After** are the item's balance in that warehouse just before and just after this reconciliation, in the Stock Ledger's own order; a document entered later does not change them.

### The four icons and the printed copy — Item Reconciliation
A reconciliation's record carries the four icons in its title bar from the moment it is saved:
1. **Printer** — **Print / Export** (طباعة / تصدير): PDF needs `print` on `stock_reconciliation`, Excel (.xlsx) and Word (.docx) need `export`; in English or العربية.
2. **Paperclip** — **Attachments** (المرفقات): for example the count sheet or the damage report that explains the difference. **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Adding a file needs `create` on `stock_reconciliation` and the permission to attach files.
3. **Speech bubble** — **Notes** (الملاحظات): dated, signed notes, never edited — the place to say why the quantity was corrected. The box **Add note** (إضافة ملاحظة) shows to whoever holds `create` on `stock_reconciliation`.
4. **Clock** — **Audit log** (سجل التدقيق): what has been recorded about this reconciliation — who made it and when, and the notes added since.
The printed copy is titled **Item Reconciliation** (تسوية صنف) and carries what the record shows: the header facts with the status and the journal number, the layers table (batch, layer date, quantity, unit cost to four decimals, value, with totals), the **Stock position** table (Before, Change, After) and the signature boxes. The **Posting** table — the journal's accounts with debit, credit and totals — is printed only for a reader who may open journal entries. A reconciliation with **No ledger entry** prints stamped DRAFT / NOT POSTED.

### Fields — Item Reconciliation
- **Item Code** (رمز الصنف) / **Item Name** (اسم الصنف) — required; an active stock item chosen from the list. The item must have an inventory account.
- **Warehouse** (المخزن) — required; a normal, active warehouse of your active branch.
- **In/Out** (إدخال/إخراج) — required; **In** (إدخال) or **Out** (إخراج).
- **Adjustment Quantity** (كمية التسوية) — required; above zero. For Out it cannot be more than the warehouse has available.
- **Date** (التاريخ) — required; default today; the date of the movement and of the journal.
- There is no price field: stock found is valued by the system (see After you save).

List columns: **Number** (الرقم) — opens the reconciliation's record, **Date** (التاريخ), **Item Code** (رمز الصنف), **Item Name** (اسم الصنف), **Warehouse** (المخزن), **In/Out** (إدخال/إخراج), **Adjustment Quantity** (كمية التسوية), **Print / Export** (طباعة / تصدير).

### After you save — Item Reconciliation
There is no approval and no status to move through: the adjustment is done when it is saved (the **Status** on its record only reports its journal and its stock movement — see "How to read the status, the layers and the journal").
- **In**: the quantity is received into the warehouse at what the item already costs — the average cost of what is left of it in that warehouse; if nothing is left there, the average anywhere; if nothing anywhere, the last cost it had. A new FIFO layer is created with the reconciliation's number as its batch. Journal: debit the item's inventory account, credit Inventory Adjustment.
- **Out**: the quantity leaves the oldest FIFO layers first, at what they cost. Journal: debit Inventory Adjustment, credit the item's inventory account.
The journal is dated the reconciliation date. The movement shows on Stock Movement as **Reconciliation** (تسوية) and on Stock Receipts / Stock Issues as **Count / reconciliation**. Pressing Create twice on the same form adjusts only once. There is no edit, cancel or reverse button, on the list or on the reconciliation's record; a wrong reconciliation is corrected by a new one in the opposite direction. What a reconciliation did can be read afterwards on its record: the layers it took out or the layer it brought in, the warehouse's quantity before and after, and the journal with its accounts.

### Refusals — Item Reconciliation
- "No item ''. Choose an item from the list." — the item was not picked from the list.
- "Enter a quantity above zero." / "Enter the date." — fill the field.
- "Choose the the warehouse." — no warehouse was chosen (the sentence is shown with the word "the" twice).
- "… is inactive, so no stock can move through it." — the warehouse was closed.
- "… belongs to another branch. Choose a warehouse of this branch." — switch your active branch to the warehouse's branch.
- "… names no inventory account, so the adjustment has nowhere to post. Set one on the item." — open the item (Accounting → Master Data — Inventory Reference → Items) and set its Inventory account.
- "… holds … of …, so … cannot be taken out. Negative stock is not allowed." — an Out larger than what the warehouse has available; reduce it.
- "… has never had a cost, so stock found of it cannot be valued. Enter its first stock on Opening Stock or a Purchase Invoice." — an In for an item that never had a cost; use Opening Stock or a purchase invoice, which carry a price.
- "No accounting mapping is configured for the 'inventory_adjustment' line of 'inventory.stock_adjustment' …" — Finance has not set the Inventory Adjustment account on Posting Mappings.
- "Account … requires … Supply the missing value(s) and post again." — the Inventory Adjustment account asks for an analysis value (such as a department) that this form does not carry. Use a Stock Count instead (its adjustment has a Department box), or ask Finance.
- "… is tracked by serial, so this movement needs a serial number. …" — the item is tracked by serial number and this form cannot adjust it.
- "The form is stale. Open it again." — reload the page and open **New reconciliation** again.
- "A stock movement dated … cannot be written: the period is closed" or "No accounting period covers …" — choose a date in an open period.
- **That page does not exist** (هذه الصفحة غير موجودة) on a reconciliation's address — no reconciliation has that number, or it belongs to a branch you are not assigned to. Open it from the list.
- No **Posting** table and a journal number that is not a link on a record — you do not hold `view` on `journal_entry`; the reconciliation is still complete.

## Inventory Checks (فحوصات المخزون)
Inventory → Counts & Valuation → Inventory Checks   |   Arabic: المخزون ← الجرد والتقييم ← فحوصات المخزون
Address: /inventory/checks
Needs: `view` on `inventory_movement`; `print` / `export` on `inventory_movement` for copies.
What it is for: A read-only health check of the stock records: twelve checks, each shown as Healthy, Warning or Error with a figure and the lines behind it. It never repairs anything. A correction is made with the document that fits (Item Reconciliation, Stock Count, a reversal) or by the system administrator.

### How to read the checks — Inventory Checks
1. Open Inventory → Counts & Valuation → **Inventory Checks** (فحوصات المخزون). The checks run at once, for today; the heading reads "Checks as of …" with a summary "… healthy · … warning · … error".
2. Read the **State** (الحالة) of each row: **Healthy** (سليم) — nothing found; **Warning** (تحذير) — worth a look, the books are not wrong; **Error** (خطأ) — the stock records disagree with themselves.
3. For a row that is not healthy, read **Figure** (الرقم) and **Detail** (التفاصيل) (the first eight lines are shown, then "… and N more"), and press **Open** (فتح) in the **Screen** (الشاشة) column to go to the screen that shows the same thing in full.
4. Report every Error to the accounting manager. Nothing can be fixed from this screen.
5. **Print / Export** (طباعة / تصدير) at the top downloads the checks.

### Fields — Inventory Checks
Columns: **Check** (الفحص), **State** (الحالة), **Figure** (الرقم) — a count or a difference, **Source** (المصدر) — a technical reference for the system administrator, **Detail** (التفاصيل), **Screen** (الشاشة).
The twelve checks:
- **Documents that moved stock without ledger rows** (مستندات حرّكت المخزون بلا سطور في الدفتر) — Error. A document that should have moved stock (a transfer, a reconciliation, a posted invoice, a return, an approved opening stock) has no lines in the stock ledger. Opens Stock Ledger.
- **Ledger rows with no document behind them** (سطور دفتر بلا مستند خلفها) — Error. A movement names a document that no longer exists. Opens Stock Movement.
- **Transfers issued and received unequally** (تحويلات صُرفت واستُلمت بكميات مختلفة) — Error. What left one warehouse is not what arrived in the other. Opens Transfer.
- **Ledger quantity against FIFO layers** (كمية الدفتر مقابل طبقات FIFO) — Error. For an item in a warehouse, the quantity in the stock ledger differs from the quantity left in its cost layers. Opens the Warehouses Report.
- **Positions below zero** (مواقف دون الصفر) — Warning. An item stands below zero in a warehouse. Opens Availability.
- **FIFO layers: remaining = original − consumed** (طبقات FIFO: المتبقي = الأصلي − المستهلك) — Error. A cost layer's remaining quantity does not equal what came in less what was used. Opens Stock Ledger.
- **Movements in their warehouse's branch** (الحركات في فرع مستودعها) — Error. Movements recorded under a branch that is not the warehouse's. Opens Stock Movement.
- **Transfers still on the way** (تحويلات ما زالت في الطريق) — Warning. Transfers issued and not wholly received. Opens Transfer.
- **Movements of a posting kind with no journal** (حركات من نوع يُرحَّل بلا قيد) — Warning. Movements of a kind that should post (purchase, sale, write-off, damage, count, opening stock, returns) with no journal entry behind them — for example an issue made from the Availability dialog. The detail gives the kind, the count and the value in IQD. Opens Stock Movement.
- **Layers' value against the inventory accounts** (قيمة الطبقات مقابل حسابات المخزون) — Warning when not zero. The figure is the value of all cost layers today minus the balance of the items' inventory accounts; the detail gives "layers … · accounts … · not yet posted …". Opens Inventory Valuation.
- **Landed-cost locks fully accounted for** (أقفال التكلفة النهائية محسوبة بالكامل) — Error. An import's landed-cost lock whose total is not fully split between stock and what had left. Opens Import Applications.
- **Posting roles a landed-cost lock may need** (أدوار الترحيل التي قد يحتاجها قفل تكلفة) — Warning. The inventory loss or Inventory Adjustment account is not set on Posting Mappings. Opens Posting Mappings.

### After you save — Inventory Checks
Nothing is saved on this screen; it is read-only and keeps no history. A check that is healthy today may have been in error yesterday. A nightly check of the stock ledger against its documents notifies the accounting managers when it finds something.

### Refusals — Inventory Checks
- **Not available to you** (غير متاح لك) — you do not hold the permission to view inventory movements; ask an administrator.

## Inventory Valuation (تقييم المخزون)
Inventory → Counts & Valuation → Inventory Valuation   |   Arabic: المخزون ← الجرد والتقييم ← تقييم المخزون
Address: /inventory/valuation
Needs: `view` on `inventory_movement`; `print` / `export` on `inventory_movement` for copies.
What it is for: The stock position at any past date or today — quantity, unit cost and value per item and warehouse at FIFO — beside the General Ledger balance of the inventory accounts at the same date. Read-only. Use it for month-end and year-end figures and to compare stock with the accounts.

### How to run the valuation at a date — Inventory Valuation
1. Open Inventory → Counts & Valuation → **Inventory Valuation** (تقييم المخزون).
2. Set **As of** (بتاريخ) — today by default. A future date is refused.
3. Optionally choose **Warehouse** (المخزن) (default **All warehouses** — كل المستودعات), **Category** (الفئة) (default **All categories** — كل الفئات) and **Branch** (الفرع) (default **All branches** — كل الفروع, meaning every branch you may see).
4. Press **Run** (تشغيل).
5. Read the heading "Stock position at …" and its chip: **Final** (نهائي) — the date lies inside closed accounting periods, the figures will not change; **Provisional** (مبدئي) — the date is in an open or soft-closed period, the figures may still move until the period is closed. Beside it: the costing method FIFO and "final through …", the last date for which figures are final.
6. Read the lines and the **Total** (الإجمالي), then the second table **Against the General Ledger** (مقابل دفتر الأستاذ العام).
7. **Print / Export** (طباعة / تصدير) at the top downloads the valuation with your filters.

### Fields — Inventory Valuation
First table (one line per item, warehouse and branch that held stock at the date):
- **Item Code** (رمز الصنف) (link), **Item Name** (اسم الصنف), **Category** (الفئة), **Warehouse** (المخزن) (link), **Branch** (الفرع).
- **Quantity** (الكمية) — what had come in on or before the date less what had gone out on or before it, in the base unit.
- **Unit cost (IQD)** (تكلفة الوحدة (د.ع)) — Value ÷ Quantity. An import's landed cost that was added after the date is left out of a past date's cost.
- **Value (IQD)** (القيمة (د.ع)) — the FIFO layers at the date: quantity left × unit cost, layer by layer.
- **Note** (ملاحظة) — **In transit** (في الطريق): the warehouse is a transit warehouse; **Flagged** (معلَّم): an issue was dated before the receipt it drew from, so the position between the two dates cannot be right — the figure is shown as recorded and is not corrected; "—" otherwise.
Second table, **Against the General Ledger** (مقابل دفتر الأستاذ العام), one line per inventory account of the items shown:
- **Account** (الحساب) — the inventory account (link).
- **Layers (IQD)** (الطبقات (د.ع)) — the value of the stock of the items that name this account.
- **G/L balance (IQD)** (رصيد الأستاذ (د.ع)) — the account's posted balance at the date.
- **Difference (IQD)** (الفرق (د.ع)) — Layers minus G/L balance. Zero means stock and accounts agree. A difference can come from stock movements that posted no journal, manual journals on the inventory account, or rounding; Inventory Checks helps find which.

### After you save — Inventory Valuation
Nothing is saved on this screen; it is read-only. Every figure is worked out from the stock ledger and the cost layers each time you press Run.

### Refusals — Inventory Valuation
- "… has not come: stock is valued on a day that has, … at the latest." — the As of date is in the future; choose today or an earlier date. The chip shows **Refused** (مرفوض) and no figures are drawn.
- "'…' is not a date." — choose the date with the date picker.
- **Nothing in stock at this date for these filters.** (لا مخزون بهذا التاريخ وبهذه التصفية.) — no stock matched; widen the filters or check the date.
- **No inventory account in view.** (لا حساب مخزون في النطاق.) — none of the items shown names an inventory account, so there is nothing to compare with the General Ledger.

## Warehouses Report (تقرير المستودعات)
Inventory → Counts & Valuation → Warehouses Report   |   Arabic: المخزون ← الجرد والتقييم ← تقرير المستودعات
Address: /inventory/fifo-valuation
Needs: `view` on `fifo_valuation` for the screen to appear in the menu; `view` on `inventory_movement` to open it; `print` / `export` on `inventory_movement` for copies.
What it is for: The stock held now, valued at what it cost: a summary per warehouse and, below it, every item in every warehouse with its quantity, average unit cost and total cost. Read-only. Quantity is in units; Total Price is the FIFO cost in IQD — not a quantity and not a selling price. (The page's own Arabic title reads تقرير المخازن.)

### How to read the report and drill down — Warehouses Report
1. Open Inventory → Counts & Valuation → **Warehouses Report** (تقرير المستودعات). It shows every branch you may see.
2. The first table, **By warehouse** (حسب المستودع), has one line per active warehouse. Click a **Warehouse Code** to see only that warehouse's items; click the warehouse name to open its profile.
3. The second table lists the items. Click an item or warehouse name to open its profile; press **Movements** (الحركات) at the end of a row to open the Stock Ledger for that item in that warehouse.
4. To find an item, type part of its name or code in **Item Name** (اسم الصنف) (**Name or code** — الاسم أو الرمز); to keep one warehouse choose **Warehouse Name** (اسم المخزن) (default **All warehouses** — كل المخازن); then press **Search** (بحث). When a filter is set the By warehouse summary is hidden.
5. **Print / Export** (طباعة / تصدير) at the top downloads the report with your filters.
6. Beside it, **Add items manually** (إضافة أصناف يدويًا) opens the Manual Stock Additions sheet (with the warehouse chosen when the report is filtered to one), and **Manually added items** (الأصناف المضافة يدويًا) opens their list. They show to whoever may raise or read manual stock additions.

### Fields — Warehouses Report
By warehouse (summary):
- **Warehouse Code** (رمز المخزن), **Warehouse Name** (اسم المخزن) — a transit warehouse carries the word **transit** (ترانزيت) after its name; **Branch** (الفرع).
- **Items** (الأصناف) — how many items have a quantity other than zero there.
- **Units** (الوحدات) — the quantities added together, each in its own base unit.
- **Value (IQD)** (القيمة (د.ع)) — the FIFO cost of what the warehouse holds.
- **Low stock** (مخزون منخفض) — how many items are at or below their minimum stock level. Nothing counts where no minimum is set on the item, and no screen sets it, so this is normally 0.
- **Negative** (سالب) — how many items stand below zero (should always be 0).
- **Last movement** (آخر حركة) — the date of the latest movement in the warehouse.
- **Totals** (الإجماليات) — the value of all warehouses.
Items table:
- **Item Name** (اسم الصنف), **Item Code** (رمز الصنف), **Warehouse Name** (اسم المخزن), **Warehouse Code** (رمز المخزن).
- **Quantity** (الكمية) — the stock ledger's total for the item in the warehouse; **Unit** (الوحدة) — the base unit.
- **Avg. Unit Cost (IQD)** (متوسط كلفة الوحدة (د.ع)) — Total Price ÷ Quantity.
- **Total Price (IQD)** (القيمة الإجمالية (د.ع)) — the FIFO cost of that quantity: what is left in each cost layer × its unit cost.
- **Movements** (الحركات) — link to the Stock Ledger.
An item with no stock left in a warehouse is not listed.

### After you save — Warehouses Report
Nothing is saved on this screen; it is read-only. A warning line at the top — "The stock ledger disagrees with its documents in … place(s)." — appears only when the checks find a problem; tell the accounting manager and open Inventory Checks.

### Refusals — Warehouses Report
- **Not available to you** (غير متاح لك) — you do not hold the permission to view inventory movements; ask an administrator.
- **No stock is held in any warehouse.** (لا يوجد مخزون في أي مخزن.) — nothing matches; clear the filters.
- The screen is missing from the menu although the address opens — the menu entry needs its own permission (see Needs); ask an administrator to grant it.

## Items (الأصناف)
Path: Accounting → Master Data — Inventory Reference → Items   |   Arabic: المحاسبة ← البيانات الرئيسية — مرجع المخزون ← الأصناف
Address: /inventory/items (profile: /inventory/items/<item code>)
Needs: `view` on `item` to open; `create` on `item` to add an item; `configure` on `item` to change the name and accounts, set prices, link suppliers, manage units and add notes; `administer` on `item` to deactivate or reactivate.
What it is for: The one record of each thing the company buys, stocks and sells. Purchasing, Inventory and Sales all pick items from here. An item carries its name, its base unit and other units, its accounts (inventory, COGS, sales), its prices and the suppliers it is bought from.

### How to create an item — Items
1. If the unit you need does not exist yet, add it first on Units of Measure.
2. Open Accounting → Master Data — Inventory Reference → **Items** (الأصناف) and press **New item** (صنف جديد).
3. **Item Full Name** (الاسم الكامل للصنف): type the name.
4. **Base unit** (الوحدة الأساسية): the unit its stock is counted in (EA is chosen for you when it exists).
5. **Inventory account** (حساب المخزون): the asset account where its stock is held.
6. **Sales account** (حساب المبيعات): the revenue account for its sales, or leave **Decided by posting rule** (تحدده قاعدة القيد).
7. **COGS account** (حساب تكلفة المبيعات): the expense account its cost goes to when it is sold.
8. **Bought from (supplier)** (يُشترى من (المورد)): choose the supplier or suppliers it is bought from — optional; hold Ctrl (Cmd on a Mac) to choose more than one. The first in the list becomes its default supplier.
9. Press **Create** (إنشاء). The system gives the item its code and opens its profile.
10. An item is bought only from a supplier linked to it (since 2026-10-06): if none was chosen, link at least one on the profile (see "How to link suppliers") — until then the profile says "No supplier is linked yet, so this item cannot be bought — not on a purchase invoice, not on a purchase order." — and add any other units.

### How to open and change an item — Items
1. In the list click the item's **Code** (الرمز). Search with **Search this list** (ابحث في هذه القائمة) by code, name or unit.
2. The profile shows the name, code and **Active** (نشط) / **Inactive** (غير نشط); **Details** (التفاصيل): Sales account, Inventory account, COGS account, Selling price (IQD); **Stock on hand** (الرصيد المتوفر): the quantity in each warehouse in the base unit, with "(… reserved)" when some is reserved — added up from the stock movements, transit warehouses included.
3. To change the name or the accounts use the **Update** (تحديث) panel: **Name** (الاسم), **Sales account** (حساب المبيعات), **Inventory account** (حساب المخزون), **COGS account** (حساب تكلفة المبيعات), then **Save** (حفظ). Keep the Inventory and COGS accounts set — see "Accounts an item needs".
4. The two icons at the top are **Notes** (الملاحظات) and **Audit log** (سجل التدقيق) — see "The four icons on a record" in Concepts — Inventory.
5. The code and the base unit cannot be changed here.

### How to set prices — Items
1. Selling price: on the profile, in the **Selling price (IQD)** (سعر البيع (دينار عراقي)) panel type the price per base unit and press **Save** (حفظ). Empty the box and save to remove it.
2. Buying price: in **Bought from** (يُشترى من), on the supplier's row type **Buying price (IQD)** (سعر الشراء (دينار عراقي)) and press **Save** (حفظ).
3. These are defaults offered on new invoice lines. Changing one does not change invoices already saved.

### How to link suppliers — Items
The link is what may be bought: a purchase invoice line, a draft line and a purchase order line name only an item linked to their supplier, and the purchase invoice's lines offer only those items (since 2026-10-06). Pairs already bought before that day were linked by the release.
1. On the profile, in **Bought from (N)** (يُشترى من), choose the supplier under **Add a supplier** (إضافة مورد). Only active partners with the supplier role are listed.
2. Optionally type **Their code for it** (رمزه لديهم) — the code the supplier knows the item by. It is shown under the item on that supplier's purchase invoice lines.
3. Press **Link supplier** (ربط المورد). The first supplier linked becomes the **Default** (افتراضي).
4. To change the default press **Make default** (اجعله الافتراضي) on another supplier's row.
5. To remove a supplier type the reason in **Why … no longer sells it** (سبب توقّف … عن بيعه) on its row and press **Remove** (إزالة). The row stays, marked **Inactive** (غير نشط) with the reason; from then on the item cannot be bought from that supplier, and what was already bought stays as it is. If it was the default, the next supplier in use by code becomes the default. A supplier removed can be linked again with Link supplier.

### How to add a unit and its conversion (for example BOX = 24) — Items
1. Make sure the unit (for example BOX) exists on Units of Measure and is active.
2. On the item's profile, in the **Units (N)** (الوحدات) panel, choose the unit under **Add unit** (إضافة وحدة).
3. **One unit holds** (تحتوي الوحدة الواحدة): type how many base units one of this unit holds — 24 for a box of 24, 0.5 for a half.
4. Optionally type its **Barcode** (الباركود).
5. Tick **Bought in** (تُشترى بـ) to make it the unit new purchase lines start in, and/or **Sold in** (تُباع بـ).
6. Press **Add unit** (إضافة وحدة). The row reads "1 BOX = 24 EA".
7. To change a default later press **Make default** (اجعله الافتراضي) in the Bought in or Sold in column. To stop offering a unit type a **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل). The base unit cannot be deactivated. To change a conversion, deactivate the unit and add it again with the new figure.

### How to deactivate or reactivate an item — Items
1. On the profile, in **Deactivate this item** (إلغاء تنشيط الصنف), type the **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل).
2. The item shows **Inactive** (غير نشط) and is no longer offered on new documents (invoice lines, Opening Stock, Transfer, Item Reconciliation). Its stock and history stay.
3. To bring it back press **Reactivate** (إعادة التفعيل).

### Accounts an item needs — Items
- **Inventory account** (حساب المخزون) — an asset account. Where the item's stock value is held: debited when stock comes in, credited when it leaves. Without it the item cannot be bought into a warehouse, sold, or adjusted.
- **COGS account** (حساب تكلفة المبيعات) — an expense account. Receives the FIFO cost of the item when it is sold. Without it the item cannot be sold.
- **Sales account** (حساب المبيعات) — a revenue account; optional. Left as **Decided by posting rule** (تحدده قاعدة القيد), the sale posts to the general sales account set on Posting Mappings; a more specific posting exception, where Finance has made one, wins over the item's account.
So: before an item can be bought it needs an inventory account; before it can be sold it needs an inventory account and a COGS account. The New item form asks for both (it starts on the company default when one is set). The Update form lets them be emptied — do not empty them: an emptied account is filled again from its category's default on save, when there is one.

### How to set default accounts by category — Items
Since 2026-10-21. For items that name no inventory or COGS account — items brought in from a sheet or the old system, mostly — so that their sales invoices post instead of stopping at "names no COGS account".
1. Open **Items** (الأصناف) and press **Category accounts** (حسابات الفئات). Needs `configure` on `item` (the accounting manager).
2. The window says how many stock items still name no inventory or COGS account, lists the defaults already set with **Items without accounts** (أصناف بلا حسابات) for each, and names the categories in use that have no default of their own.
3. **Default for** (الافتراضي لـ): **The company (any category without its own)** (الشركة (أي فئة ليس لها افتراضي خاص)), or one of the categories the items carry.
4. **Inventory account** (حساب المخزون) — an asset posting account; **COGS account** (حساب تكلفة المبيعات) — an expense posting account. Choose one or both.
5. Press **Save default** (حفظ الافتراضي). Every stock item it answers for that names no such account is given it at once — each one written to that item's Audit log ("item.stock_accounts_defaulted") — and a new item takes it as it is made.
6. A category's own default wins, account by account; the company default answers for the rest. An account an item already names is never replaced: to move items that already have accounts, change them on each item.
7. Then post the invoice again (Sales Invoices → the invoice → Post); its approval stands.
A default is not used by the posting itself: a sale always posts to the item's own accounts. Saving a default again replaces it (the old value stays in the audit log); a default is never deleted.

### Refusals — Category accounts — Items
- "inventoryAccountId: must be an asset account" / "cogsAccountId: must be an expense account" — choose a posting account of the right type.
- "cogsAccountId: choose an inventory account, a COGS account or both" — choose at least one account.
- Not allowed to … `configure` on `item` — ask the accounting manager.

### Fields — Items
New item form:
- **Item Full Name** (الاسم الكامل للصنف) — required; up to 200 characters.
- **Base unit** (الوحدة الأساسية) — required; an active unit from Units of Measure. Stock is counted in it. It cannot be changed on the screens afterwards.
- **Inventory account** (حساب المخزون) — required; a posting account of type asset.
- **Sales account** (حساب المبيعات) — optional; a posting account of type revenue.
- **COGS account** (حساب تكلفة المبيعات) — required; a posting account of type expense.
- **Bought from (supplier)** (يُشترى من (المورد)) — optional; one or more partners with the supplier role. The first in the list is its default supplier.
- The item code is given by the system. Every item made here is a stock item tracked by batch.
Profile:
- **Name** (الاسم) — required.
- **Selling price (IQD)** (سعر البيع (دينار عراقي)) — optional; not negative; per base unit; the default price on a new sales line.
- **Buying price (IQD)** (سعر الشراء (دينار عراقي)) — optional, per supplier; not negative; per base unit; the default price on a new purchase line from that supplier.
- **Add a supplier** (إضافة مورد) — a supplier to link. **Their code for it** (رمزه لديهم) — optional, up to 100 characters. **Default** (الافتراضي) — one supplier per item. **Why … no longer sells it** — required to remove a supplier.
- **Add unit** (إضافة وحدة) — an active unit the item does not have yet. **One unit holds** (تحتوي الوحدة الواحدة) — required; a number above zero and not 1; decimals allowed (up to 6). **Barcode** (الباركود) — optional. **Bought in** (تُشترى بـ) / **Sold in** (تُباع بـ) — the default unit for purchase and for sales; when none is ticked the base unit is the default. A purchase line can be written in any active unit of the item; a sales invoice line is written in the base unit.
List columns: **Code** (الرمز), **Name** (الاسم), **Kind** (النوع) — **Stock item** (صنف مخزني) or **Service** (خدمة), **Base unit** (الوحدة الأساسية), **On hand** (المتوفر) — all normal warehouses together, "—" for a service, **Supplier** (المورد) — the suppliers it is bought from (code · name, the default first; "None" when none is linked), **Active** (نشط). The search box finds an item by its supplier's code or name too.
Kept on the item but with no field on these screens: the purchase account, tracking (serial / batch — always batch for items made here), warranty months, category, description, and the minimum stock level used by the Warehouses Report's Low stock column. They cannot be seen or changed from the Items screens.

### After you save — Items
An item has no approval: it is usable as soon as it is created — **Active** (نشط). Every change (name, accounts, prices, suppliers, units, deactivation) is written to the item's Audit log with who and when. Changing an account affects only postings made afterwards. Nothing is posted by saving an item.

### Refusals — Items
- "name: is required" — type the item's name.
- "baseUomCode: is not a known unit of measure" / "… is not an active unit of measure" — choose an active unit.
- "inventoryAccountId: must be an asset account", "cogsAccountId: must be an expense account", "salesAccountId: must be a revenue account", or "…: is a header, not a posting account" — choose a posting account of the right type.
- "price: must not be negative" — type zero or more.
- "supplierId: does not hold the supplier role" / "supplierId: is not linked to this item" — choose a supplier from the list.
- "reason: is required to take a supplier off an item" — type why the supplier no longer sells it.
- On a purchase invoice or a purchase order: "… is not linked to … : an item is bought only from the suppliers linked to it…" — link that supplier here (How to link suppliers), or buy the item from a supplier already linked.
- "uomCode: is not an active unit of measure" — add or reactivate the unit on Units of Measure first.
- "uomCode: is …'s base unit, which it already has at one" — the base unit is already there; choose another unit.
- "uomCode: is already one of …'s units" — the item already has that unit.
- "numerator: must be more than nothing: one unit holds some of the base" / "numerator: equals one base unit — that is the base unit under another name" — One unit holds must be above zero and not 1.
- "… is not a quantity of the base unit. Say how many base units one of this unit holds, e.g. 24 or 0.5." — type a plain number in One unit holds.
- "reason: is required to deactivate an item" / "reason: is required" — type the reason.
- "The item counter is a hundred numbers behind the catalogue. Set it past the highest code in use on the Numbering screen before adding another item." — ask the administrator to move the item code counter forward on the Numbering screen.
- Refusals this item causes on other screens when an account is missing: on a purchase invoice "Line … item … names no inventory account, so its stock has nowhere to be held. Set one on the item."; on a sales invoice "Line … sells …, which names no inventory account. Set one on the item, or set the default for its category under Items › Category accounts." and "Line … sells …, which names no COGS account, so its cost has nowhere to go. Set one on the item, or set the default for its category under Items › Category accounts." (see "How to set default accounts by category"); on Item Reconciliation "… names no inventory account, so the adjustment has nowhere to post. Set one on the item." In each case open the item, set the account in the Update panel and save, then repeat the document.
- Refusals about units on other screens: "… is not kept in …. Add … to the item's units (Items → … → Units), or choose one of its units." — add the unit on the item; "… is not a whole number of …. Enter the quantity in a unit it divides into, or in the base unit." — the quantity does not convert exactly to the base unit; "Line … sells … in …; a sale is written in the item's base unit, …." — write the sales line in the base unit.

## Units of Measure (وحدات القياس)
Path: Accounting → Master Data — Inventory Reference → Units of Measure   |   Arabic: المحاسبة ← البيانات الرئيسية — مرجع المخزون ← وحدات القياس
Address: /inventory/uom (record: /inventory/uom/<unit code>)
Needs: `view` on `uom` to open; `create` on `uom` to add a unit; `configure` on `uom` to rename; `administer` on `uom` to deactivate or reactivate.
What it is for: The short list of units that items state their quantities in (EA, BOX, KG …). Items choose their base unit and their other units from this list. Keep it short: PCS, PC and PIECE would be three different units in every report.

### How to add a unit of measure — Units of Measure
1. Open Accounting → Master Data — Inventory Reference → **Units of Measure** (وحدات القياس) and press **New unit of measure** (وحدة قياس جديدة).
2. **Name** (الاسم): type the unit's name (for example Box).
3. **Code** (الرمز): it fills itself from the name as you type (BOX); you may type your own. It is stored in capital letters and can never be changed.
4. Press **Create** (إنشاء). The unit's page opens; the unit is **Active** (نشط) and can be chosen on items at once.

### How to open, rename, deactivate or reactivate a unit — Units of Measure
1. In the list click the unit's **Code** (الرمز). The page shows the name, code, Active / Inactive, the list **Items measured in it (N)** (الأصناف المقاسة بها) — the items that have it as base unit, each a link — and the unit's history at the foot (**Audit log** — سجل التدقيق jumps to it).
2. To rename: in **Update** (تحديث) change **Name** (الاسم) and press **Save** (حفظ). The code does not change.
3. To deactivate: in **Deactivate this unit** (إلغاء تنشيط الوحدة) type the **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل). A unit that is the base unit of any item cannot be deactivated.
4. To reactivate press **Reactivate** (إعادة التفعيل).

### Fields — Units of Measure
- **Code** (الرمز) — optional on the form: left blank it is made from the name. 1 to 32 letters, digits, hyphens or underscores, starting with a letter or digit; Latin letters only. Must be unique. Cannot be changed later.
- **Name** (الاسم) — required; up to 200 characters. Can be changed.
- List columns: **Code** (الرمز), **Name** (الاسم), **Active** (نشط).
- A unit here has no conversion of its own. How many base units a BOX holds is set per item, on the item's Units panel.

### After you save — Units of Measure
No approval and nothing is posted. A new unit is Active and is offered at once as a base unit on the New item form and under Add unit on an item. A deactivated unit is no longer offered for new items or new item units; items and documents that already use it keep it. Changes are written to the unit's history.

### Refusals — Units of Measure
- "name: is required" — type the name.
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — correct the code.
- "code: '…' is already a unit of measure" — the code exists; use the existing unit or another code.
- "code: could not be made from the name; type one" — the name has no Latin letters or digits (for example an Arabic name), so no code could be made; type a code in Latin letters.
- "reason: is required to deactivate a unit of measure" — type the reason.
- "code: is the base unit of at least one item" — the unit cannot be deactivated while any item has it as base unit; the page lists those items.

## Warehouses (المستودعات)
Path: Accounting → Master Data — Inventory Reference → Warehouses   |   Arabic: المحاسبة ← البيانات الرئيسية — مرجع المخزون ← المستودعات
Address: /master-data/warehouses (profile: /master-data/warehouses/<warehouse code>)
Needs: `view` on `warehouse` to open; `create` on `warehouse` to add one; `configure` on `warehouse` to rename, close, reopen and add notes.
What it is for: The places where stock is held. Every stock movement names a warehouse, and each warehouse belongs to one branch. The list also shows the four transit warehouses On Process (Without SWIFT), In Process, On Board and At Port.

### How to create a warehouse — Warehouses
1. Switch your active branch (top of the screen) to the branch the warehouse belongs to. The new warehouse is created in the active branch and the branch cannot be changed afterwards.
2. Open Accounting → Master Data — Inventory Reference → **Warehouses** (المستودعات) and press **New warehouse** (مخزن جديد).
3. Type the **Warehouse Name** (اسم المخزن).
4. Press **Create** (إنشاء). The system gives the warehouse its code. It is a normal warehouse, **Active** (نشط), and is offered at once on Opening Stock, Transfer, Item Reconciliation and Stock Count for that branch.

### How to open, rename, close or reopen a warehouse — Warehouses
1. In the list click the **Warehouse Code** (رمز المخزن). Search with **Search this list** (ابحث في هذه القائمة) by code, name or branch.
2. The profile shows the name, code and Active / Inactive; **Details** (التفاصيل): **Branch** (الفرع), **Totals** (الإجماليات) — the FIFO cost in IQD of everything it holds — and **Created** (تاريخ الإنشاء); and the panel **Warehouses Report** (تقرير المخازن): every item it holds with Item Code, Item Name, Quantity and Total Price (IQD).
3. To rename: in **Update** (تحديث) change **Warehouse Name** (اسم المخزن) and press **Save** (حفظ).
4. To close: in the **Close** (إغلاق) panel type the **Reason** (السبب) and press **Close** (إغلاق). The warehouse becomes **Inactive** (غير نشط): it disappears from the pickers and no stock can be moved through it, but what it holds and its history are untouched. Move the stock out with a Transfer before closing.
5. To reopen press **Reopen** (إعادة فتح).
6. The two icons at the top are **Notes** (الملاحظات) and **Audit log** (سجل التدقيق) — see "The four icons on a record" in Concepts — Inventory.

### Transit warehouses On Process (Without SWIFT), In Process, On Board and At Port — Warehouses
These four warehouses hold goods that have been bought but have not arrived, one warehouse for each stage of the journey: On Process (Without SWIFT), then In Process, then On Board, then At Port. The first is used only by an import that agrees an advance payment: when its purchase invoice is posted the goods land in On Process (Without SWIFT) and a draft payment application for the advance is raised; when that application is Paid the goods move to In Process by themselves, one step ahead, and go on like any other import. Every other import starts in In Process. They are made once by the system administrator at company setup, one warehouse per stage; the New warehouse form cannot make one and there is no field on the profile that marks a warehouse as a stage. They appear in this list and can be renamed like any warehouse. Their stock is "in transit, not available": it belongs to the company and has a cost, but Availability shows it with On hand 0 and Available 0 and the quantity under In transit, and the warehouses are not offered on Opening Stock, Transfer, Item Reconciliation or Stock Count. Goods move from stage to stage and finally into a normal warehouse from Logistics (container receipts for an import; Logistics → In Transit → In-Transit Inventory for other purchase invoices followed by stage). If they do not exist, shipment tracking stays empty — ask the system administrator to set them up.

### Fields — Warehouses
- **Warehouse Name** (اسم المخزن) — required. The only field on the New warehouse and Update forms.
- **Warehouse Code** (رمز المخزن) — given by the system; cannot be typed or changed.
- **Branch** (الفرع) — taken from your active branch when the warehouse is created; cannot be changed.
- **Reason** (السبب) — required to close a warehouse; kept in the Audit log.
- List columns: **Warehouse Code** (رمز المخزن), **Warehouse Name** (اسم المخزن), **Branch** (الفرع), **Active** (نشط).

### After you save — Warehouses
No approval and nothing is posted. Creating, renaming, closing and reopening are written to the warehouse's Audit log. A warehouse is never deleted.

### Refusals — Warehouses
- "A warehouse needs a name." — type the name.
- "Say why this warehouse is being closed." — type the reason.
- "No warehouse with code '…'." — the code in the address does not exist; open the warehouse from the list.
- "Permission denied: 'configure' on 'warehouse' is not granted to this user." or "Out of scope: this user has no access to branch '…'." — you may not change this warehouse, or it belongs to a branch you cannot work in.
- On other screens, after a warehouse is closed: "… is inactive, so no stock can move through it." — reopen the warehouse or choose another.
- When advancing a shipment in Logistics: "No warehouse is set up for …. Mark one on the Warehouses screen before moving a shipment into it." — the Warehouses screen has no control for this; the stage warehouses (On Process (Without SWIFT), In Process, On Board, At Port) are created by the system administrator.
