# Logistics — user guide

Logistics (اللوجستيات) follows the physical journey of imported goods: Import → Shipment (B/L) → Containers → Customs (PD, declaration) → Landed cost → Goods receipt → Inventory.
The work flows in this order: the customs officer registers the import's **PD** and keeps its status the same as ASYCUDA (by hand or from the ASYCUDA list); the logistics officer records the **Bill of Lading** and its **containers**, and moves each container through its stages; the broker's **customs declaration** is recorded beside the PD; the warehouse **receives** each container, which moves the goods out of transit into a real warehouse; purchasing **claims** anything short or damaged; and the registers of duties, freight, landed cost and cost allocation show what the goods finally cost.
Logistics owns no money and no stock of its own: payments, charges, the landed-cost lock and the stock ledger stay with the import's own page (opened everywhere by the **Import tracking** link), Payables and Inventory. Most Logistics screens are therefore either a document you keep up to date (PD, declaration, B/L, container, port) or a read-only register.
The menu has four headings: **Customs — ASYCUDA** (الجمارك — أسيكودا), **Shipping** (الشحن), **In Transit** (قيد النقل) and **Landed Costs** (الكلفة الواصلة).

## Concepts — Logistics (مفاهيم — اللوجستيات)
Path: Logistics (all headings)   |   Arabic: اللوجستيات (كل العناوين)
Address: (applies to every Logistics screen)
Needs: nothing of its own — each screen names its own permissions.
What it is for: the ideas every Logistics screen shares — the chain, "in transit", the four icons on a record, how lists are searched, and how a refusal is shown.

### The chain of an import — Logistics
1. **Import** — the import application (the order with the supplier). Every Logistics document names its import, shown as its number, the supplier's reference and the supplier.
2. **Shipment (B/L)** — the Bill of Lading the shipping line issued, with its containers.
3. **Containers** — each container on its own: its ETA, its stages (Not loaded → On the sea → At port → Customs cleared → Received), and what it carries.
4. **Customs** — the PD (customs pre-declaration, registered in ASYCUDA) and the customs declaration the broker lodged against it.
5. **Landed cost** — the duties, freight and other charges added to the import, locked into the cost of the goods on the import's page.
6. **Goods receipt** — the container receipt: the warehouse counts what came off the container.
7. **Inventory** — the received goods are ordinary stock in a real warehouse.
The same sentence is printed at the top of several Logistics screens under **Where this sits in the chain** (موقع هذه الشاشة في السلسلة).

### In transit is owned but not available — Logistics
- Goods standing in a **transit warehouse** or in a **stage warehouse** (On Process (Without SWIFT), In Process, On Board, At Port) belong to the company and are counted in the value of stock, but they are **never on hand and never available to sell, issue or pick**. Their available quantity is always shown as 0.
- An import's goods are booked into a transit warehouse by its posted purchase invoice. They leave it only in two ways: a **container receipt** (the goods move into a real warehouse and become available), or a **shortage claim** (a purchase return to the supplier straight out of transit).
- So after 500 units are shipped and 300 received: In transit 200, Received 300, On hand 300 (until some are sold).
- Goods of an ordinary (non-import) purchase invoice that was received into the In Process warehouse move stage by stage on the In-Transit Inventory screen; they become available only at the last stage, **In Bounded**, when a real warehouse is chosen.

### The four icons at the top of a record — Logistics
Every Logistics record (PD, ASYCUDA reading, B/L, container, customs declaration, port) has the same four icons in its title bar, in this order:
1. **Printer — Print / Export** (طباعة / تصدير): opens a small window offering the record in **English** and **العربية**, each as **PDF**, **Excel (.xlsx)** or **Word (.docx)**. PDF is offered to people who may print the record; Excel and Word to people who may export it. If you may do neither, the printer is not shown.
2. **Paperclip — Attachments** (المرفقات): lists the files kept with the record (name, size, who attached it, when). To add one press **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). The window says: "Up to 25MB. Programs and archives are refused on their content, not their name." The number on the icon is how many files there are.
3. **Speech mark — Notes** (الملاحظات): a table of **When** (متى), **Who** (من) and **Note** (ملاحظة), newest first. Type in **Add note** (إضافة ملاحظة) and press **Add note**. A note is dated and signed and can never be edited or deleted; it may be up to 2,000 characters.
4. **Clock — Audit log** (سجل التدقيق): every change made to the record, who made it and when.
Refusals from these icons: "A note says something. Write what is happening with this record." (the note was empty); "A note is at most 2,000 characters. Attach a longer text as a file."; "attachment_missing" (no file was chosen — choose one and press Attach again).

### Lists: search, View and pages — Logistics
- Every list has a search box, **Search this list** (ابحث في هذه القائمة): type part of a number, a supplier's name, a status or a date and press Enter. **Clear** (مسح) removes the search.
- Most lists have a **View** (العرض) box with a **Show** (عرض) button that narrows the list (for example to open records only).
- Search and View are two separate boxes: searching puts the list back on its default view, and choosing a view removes the search. Use one at a time.
- Long registers show 50 rows a page, with **Previous page** (الصفحة السابقة) and **Next page** (الصفحة التالية) at the foot.
- The row of tabs under the page title lists the other screens of the same menu heading that you are allowed to open.
- Blue numbers and names are links: an import number opens the import's page, a supplier its profile, a PD, B/L, container, port, warehouse, item or journal its own page.

### Saved and refused — Logistics
- After a successful save the page shows **Saved.** (تم الحفظ.).
- When the system refuses, a red box shows **That could not be saved.** (تعذّر الحفظ.) followed by the reason. Nothing was changed; correct what the sentence names and save again. The reasons are written in English. Each screen below lists its own under "Refusals".
- "Permission denied: '…' on '…' is not granted to this user." means your role lacks that permission — ask an administrator. "Out of scope: this user has no access to branch '…'." means the record belongs to a branch you are not allowed to work in.
- If you may not open a screen at all you see **Not available to you** (غير متاح لك): "You do not have permission to open this screen." Ask an administrator for access.
- Logistics documents are never deleted. A wrong one is cancelled, rejected or retired with a reason, and stays visible.

## Customs Pre-Declarations (التصاريح الجمركية المسبقة)
Path: Logistics → Customs — ASYCUDA → Customs Pre-Declarations   |   Arabic: اللوجستيات ← الجمارك — أسيكودا ← التصاريح الجمركية المسبقة
Address: /payables/pd (one PD: /payables/pd/<PD no.>?year=<registration year>)
Needs: `view` on `customs_pd` to open the list and a PD; `create` on `customs_pd` to register or re-register a PD; `edit_draft` on `customs_pd` to change a status, link a PD to an import, add a note or attach a file (attaching also needs `create` on `attachment`); `import` on `customs_pd` to see the **Update from ASYCUDA list** link; `print` on `customs_pd` for the PDF and `export` for Excel/Word.
What it is for: the register of every customs pre-declaration (PD) of every import, the soonest to expire first. A PD is the number customs issued in ASYCUDA for an import; the bank pays the supplier only against a PD that is validated and has not expired, so this screen is kept exactly as current as ASYCUDA.

### PD statuses and what each allows — Customs Pre-Declarations
A PD always has one status, shown as a coloured chip. Each status decides whether the bank may pay against the PD (the record's box **Bank may pay against it** (يجوز للبنك الدفع مقابله) says **Yes** (نعم) or **No** (لا)).
- **Submitted** (مقدَّم) — registered in ASYCUDA, waiting for customs. Does **not** release payment. The import counts as having a PD.
- **Pre-approved** (موافقة مبدئية) — customs pre-approved it. Does **not** release payment yet.
- **Validated** (مصادق عليه) — customs validated it. **Releases payment**: a payment application for the import passes its check **Validated PD** (تصريح مسبق معتمد) under "Checks before sending" (الفحوص قبل الإرسال), as long as the PD has not expired on the day of the application.
- **Partially written off** (مشطوب جزئيًا) — part of the goods cleared against it. **Still releases payment** until it expires.
- **Totally written off** (مشطوب كليًا) — everything cleared; the PD is settled with customs. Final. No further payment is released against it. When every standing PD of an import is totally written off (and every container is received), the import's landed cost can be locked.
- **Rejected** (مرفوض) — customs refused it. Final. No payment. The import stops until the PD is re-registered.
- **Expired (validated)** (منتهي (مصادق عليه)) and **Expired (partly written off)** (منتهي (مشطوب جزئيًا)) — set automatically the day after the expiry date for a Validated or a Partially written off PD. Final. No payment. Re-register it. (An Expired (partly written off) PD counts as finished for the import once nothing of the import is left in transit.)
Extra payment rules, whatever the status: the PD must not have passed its **Expires** date on the day the bank is asked to pay; and when the PD names a bank and the paying bank account belongs to a different bank, payment is refused. What the payment application then says: "No PD is registered for this import — the bank pays only against a validated PD."; "PD 9330 is Submitted — the bank pays only against a validated PD."; "PD 9330 expired on 2026-09-30 — the bank pays only against a validated PD."; "PD 9330 is registered with Bank A and the money would leave from Bank B — pay from an account of the PD's bank."
A final status (Totally written off, Rejected, either Expired) cannot be changed. A rejected or expired PD is replaced by **Re-register**; the old PD stays as customs left it, marked **Re-registered** (أُعيد تسجيله).

### How to register a PD — Customs Pre-Declarations
1. Open Logistics → Customs — ASYCUDA → Customs Pre-Declarations.
2. Press **Register PD** (تسجيل تصريح) at the top of the page.
3. Choose the **Import application** (معاملة الاستيراد), type the **PD no.** (رقم التصريح) exactly as ASYCUDA shows it, and enter **Registered** (تاريخ التسجيل) and **Expires** (ينتهي في) as ASYCUDA shows them.
4. Optionally choose the **Bank** (البنك) the PD is registered with, the **Status** (الحالة) if the PD is already further than Submitted, and a **Note** (ملاحظة).
5. Press **Register PD**. The new PD's own page opens. An import may have several PDs.

### How to find a PD — Customs Pre-Declarations
1. Type in **Search this list** — it looks in the PD number, import number, supplier's reference, supplier, bank, status, note, branch and the two dates.
2. Or choose a **View** (العرض) and press **Show** (عرض): **Open (not final)** (المفتوحة (غير النهائية)) — the default; **Expiring within 45 days** (تنتهي خلال 45 يومًا) — the number is the company's warning window; **Final or superseded** (النهائية أو المستبدلة); **Holding list — not linked to an import** (قائمة الانتظار — غير مرتبطة بمعاملة استيراد); **All** (الكل).
3. The list is sorted by expiry date, the soonest first. **Days left** (الأيام المتبقية) turns red inside the warning window.

### How to open a PD record and what it shows — Customs Pre-Declarations
1. Click the PD number in the list. The page is titled "PD <number>".
2. The boxes show the registration (see Fields). If the same number was registered in another year, a line "The same number was also registered in:" offers the other years.
3. The grid **Status history** (سجل الحالة) lists every status the PD has had: **Status**, **Date in ASYCUDA** (التاريخ في أسيكودا), **From** (المصدر — Entered by hand, ASYCUDA screenshot, ASYCUDA list, Expiry (automatic), Sheet import), **Note**, **Recorded by** (سجّله).
4. Under it, when the PD is linked to an import, **The import's B/Ls and containers** (بوالص الاستيراد وحاوياته) shows each container of the import with its status, ETA and the dates At port, Customs cleared, Port file sent, Received, and its warehouse.
5. Last, **Declarations against this PD** (البيانات الجمركية على هذا البيان المسبق) lists the customs declarations that name this PD; click a number to open one.
6. **Import tracking** (متابعة الاستيراد) at the foot opens the import's page.

### How to change a PD's status — Customs Pre-Declarations
1. Open the PD and press **Change status** (تغيير الحالة) at the foot (shown while the PD is not final).
2. Choose the **New status** (الحالة الجديدة), set **Date in ASYCUDA** (التاريخ في أسيكودا) to the date ASYCUDA shows for the change, choose **From** (المصدر): **Entered by hand** (أُدخل يدويًا) or **ASYCUDA screenshot** (لقطة شاشة أسيكودا), and add a **Note** if useful.
3. Press **Change status**. A new row appears in Status history.
To update many PDs at once from ASYCUDA's own list, use the screen Update from ASYCUDA instead.

### How to re-register a rejected or expired PD — Customs Pre-Declarations
1. Open the rejected or expired PD. Press **Re-register** (إعادة التسجيل) — shown only for a Rejected or Expired PD that has not been re-registered already.
2. Enter the new **PD no.**, **Registered**, **Expires**, the **Bank** (the old PD's bank is offered) and a **Note**.
3. Press **Re-register**. The new PD opens; its box **Re-registration of** (إعادة تسجيل لـ) names the old one, and the old one shows **Re-registered as** (أُعيد تسجيله برقم).

### How to link a PD from the holding list to an import — Customs Pre-Declarations
1. Choose the view **Holding list — not linked to an import** and press **Show**. These PDs came from the old sheet without an import; their Import column says **Not linked** (غير مرتبط).
2. Open the PD and press **Link to an import** (ربط بمعاملة استيراد).
3. Choose the **Import application** and press **Link to an import**. The import carries the PD from then on, with its status as it stands. A linked PD cannot be unlinked.

### How to print, attach a file or add a note — Customs Pre-Declarations
1. Open the PD. Use the four icons in the title bar (see "The four icons at the top of a record — Logistics").
2. Printer: the document "Customs Pre-Declaration" (بيان جمركي مسبق) as PDF, Excel or Word, in English or Arabic.
3. Paperclip: the ASYCUDA screenshot or the customs letter. The attachment is also written on the import's tracking.
4. Notes: a note added here also becomes the PD's latest **Note**, shown in the list's Note column and on the import's tracking.

### Fields — Customs Pre-Declarations
Register PD (and Re-register) form:
- **Import application** (معاملة الاستيراد) — required. Only open imports are offered (not cancelled, not closed), newest first, shown as number · supplier's reference · supplier. Not asked when re-registering (the new PD keeps the old one's import).
- **PD no.** (رقم التصريح) — required. "The ASYCUDA number, as customs issued it." Saved in capital letters. The same number may exist only once per registration year.
- **Registered** (تاريخ التسجيل) — required; defaults to today. The PD's first status is dated this day.
- **Expires** (ينتهي في) — required; must not be before Registered. "As ASYCUDA shows it — the validity is the customs office's, not computed." It drives Days left, the expiry warning and the automatic expiry.
- **Bank** (البنك) — optional. On Register PD only the banks the company holds an account at are offered; on Re-register every active bank. If given, payments against the PD must leave from an account of this bank.
- **Status** (الحالة) — optional on Register PD only; default **Submitted**. Offers the non-final statuses (Submitted, Pre-approved, Validated, Partially written off) for a PD entered late.
- **Note** (ملاحظة) — optional free text.
Change status form:
- **New status** (الحالة الجديدة) — required; any status other than the present one.
- **Date in ASYCUDA** (التاريخ في أسيكودا) — required; defaults to today; not before the registration date.
- **From** (المصدر) — **Entered by hand** (default) or **ASYCUDA screenshot**.
- **Note** (ملاحظة) — optional; becomes the PD's latest note.
Boxes on the PD record: **PD no.**; **Status** with its date; **Import application**; **Supplier** (المورد); **Bank** (with its SWIFT code); **Registered**; **Expires**; **Days left** (red at 45 or fewer; "—" when final); **Bank may pay against it** (Yes / No); **Re-registration of**; **Re-registered as**; **Payments against this PD** (المدفوعات مقابل هذا التصريح — each payment application with its status and amount); **Note**.
List columns: PD no., Import application (with the supplier's reference), Supplier, Bank, Registered, Expires, Days left, Status (with **Re-registered** under it when replaced), Note.

### After you save — Customs Pre-Declarations
- A PD is not approved by anyone and posts nothing: no journal, no stock movement, no payable. It is a record of what customs says.
- Registering writes the first Status history row, an event on the import's tracking ("PD … registered in ASYCUDA on …, valid until …") and re-works the import's stage.
- Every status change adds one history row (with where the news came from) and an event on the import's tracking; Totally written off, Rejected and Expired add their own line ("… rejected — re-register it").
- The daily check warns once on the import's tracking when a PD comes inside the warning window (45 days unless the company changed it), and on the day after the expiry date moves a Validated PD to Expired (validated) and a Partially written off PD to Expired (partly written off), with the source **Expiry (automatic)** (الانتهاء (تلقائي)).
- A Submitted or Pre-approved PD that passes its expiry date keeps its status; the import's tracking only gets a line saying it passed its expiry.
- Who acts next: the customs officer keeps the status current; once the PD is Validated, the accountant can send the import's payment application to the bank; once every PD is Totally written off and every container is received, the landed cost can be locked on the import's page.

### Refusals — Customs Pre-Declarations
- "… is not an import; only imports are declared to customs." — a PD can be registered or linked only on an import application.
- "… is cancelled." / "… is closed." — choose an open import.
- "Give the PD number as ASYCUDA shows it." — the PD no. was empty.
- "Give the registration date and the expiry date ASYCUDA shows." — a date is missing.
- "A PD registered on … cannot expire on …. Check the dates on the ASYCUDA screen." — Expires is before Registered.
- "PD … of 2026 is already registered. One registration, one row — change its status, or re-register it if customs rejected it or it expired." — that number already exists for that year; open it instead.
- "PD … is already Validated." — you chose the status it already has.
- "PD … is Rejected, which is final. Re-register it: the new PD supersedes this one, and this one stays as customs left it (§16.2)." — use **Re-register**.
- "PD … is Totally written off, which is final. Nothing follows a totally written-off PD." — nothing more to do on this PD.
- "Give the date ASYCUDA shows for the change." — the date was empty.
- "A status on … is before PD … was registered (…)." — the date is earlier than the registration date; correct it.
- "PD … is not linked to an import yet." — link it to its import before re-registering.
- "PD … has already been re-registered." — open the PD named in **Re-registered as**.
- "PD … is Submitted; only a rejected or expired PD is re-registered." — change its status first (for example to Rejected, if customs rejected it).
- "PD … is already linked to an import." — a PD is linked once.
- "A note says something." — the note was empty.
- "No PD '…', or it is outside the branches you may see." — wrong number, or the PD belongs to another branch.

## Customs Declarations (البيانات الجمركية)
Path: Logistics → Customs — ASYCUDA → Customs Declarations   |   Arabic: اللوجستيات ← الجمارك — أسيكودا ← البيانات الجمركية
Address: /logistics/customs-declarations (one declaration: /logistics/customs-declarations/<declaration no.>)
Needs: `view` on `customs_declaration` to open; `create` to raise one; `edit_draft` to edit a draft, add a note or attach a file (attaching also needs `create` on `attachment`); `submit` to move it forward (Submit to customs, Mark accepted, Mark assessed, Mark cleared); `reverse_cancel` to reject or cancel it; `print` for the PDF and `export` for Excel/Word.
What it is for: what the customs broker lodged with customs for each import — the declared value, duty, taxes and fees, the HS code, and the PD it clears against. The figures are **declared figures only**: they are never posted and are not money in the books. The duty actually paid arrives as a charge on the import; the record shows the two side by side.

### The steps of a customs declaration — Customs Declarations
A declaration moves forward one step at a time and never backwards:
- **Draft** (مسودة) — being written; every field can still be edited.
- **Submitted** (مقدَّم) — lodged with customs. From here on the figures are frozen.
- **Accepted** (مقبول) — customs accepted the lodgement and gave its own number (the Customs reference is required for this step).
- **Assessed** (مثمَّن) — customs assessed the duty.
- **Cleared** (مخلَّص) — the goods are cleared. Final.
Two ways out, each with a reason:
- **Rejected** (مرفوض) — customs rejected it; possible from Submitted, Accepted or Assessed. Final.
- **Cancelled** (ملغى) — the company withdrew it; possible from Draft, Submitted, Accepted or Assessed. Final.
A Cleared, Rejected or Cancelled declaration shows "This declaration is …; what it declared is the record." and cannot move again. If customs has it wrong, cancel it and raise another.

### How to raise a customs declaration — Customs Declarations
1. Open Logistics → Customs — ASYCUDA → Customs Declarations and press **New declaration** (بيان جديد).
2. Choose the **Import application** (طلب الاستيراد) and the date **Lodged on** (تاريخ التقديم).
3. Optionally type the **Customs reference** (مرجع الجمارك), the **HS code** (البند الجمركي (HS)), choose the **Currency** (العملة) and type the **Declared value**, **Declared duty**, **Declared taxes** and **Declared fees** as the declaration states them, and a **Note**.
4. Press **New declaration**. The draft opens with its own number (CDN-<branch>-<year>-<serial>).
5. To name the PD it clears against, press **Edit declaration** on the draft and choose the **PD** there (the New declaration window has no PD box).

### How to edit a draft declaration — Customs Declarations
1. Open the declaration while it is **Draft** and press **Edit declaration** (تعديل البيان).
2. Change the **PD** (البيان المسبق — the import's own PDs are offered, or **No PD yet** (لا بيان مسبق بعد)), **Lodged on**, **Customs reference**, **HS code**, **Currency** and the four declared amounts, and the **Note**.
3. Press **Save** (حفظ). After the draft is submitted nothing on it can be edited.

### How to move a declaration forward — Customs Declarations
1. Open the declaration. At its foot is the button for the next step only: **Submit to customs** (تقديم للجمارك), then **Mark accepted** (تأشير القبول), then **Mark assessed** (تأشير التثمين), then **Mark cleared** (تأشير التخليص).
2. Press it. Enter the date **On** (بتاريخ) — today is offered — and a **Note** if useful. For **Mark accepted** also enter the **Customs reference** if the declaration has none yet.
3. Press the same button in the window to confirm.

### How to reject or cancel a declaration — Customs Declarations
1. Open the declaration (not yet Cleared, Rejected or Cancelled).
2. To record that customs refused it: type the reason in the box **Reason** (السبب) beside **Rejected by customs** (مرفوض من الجمارك) and press that button (offered once it is Submitted).
3. To withdraw it: type the reason in the box beside **Cancel declaration** (إلغاء البيان) and press that button.
4. The reason is shown on the record in red. Neither step can be undone.

### How to compare declared with charged — Customs Declarations
1. Open the declaration. The grid **Declared versus charged** (المصرَّح به مقابل المحمَّل) lists the customs / ASYCUDA costs actually booked on the import: **Source**, **Charged on**, **Amount (IQD)**, **State** (**Locked** مقفل when a landed-cost lock has taken it in, **Not locked** غير مقفل otherwise) and **Note**.
2. The totals at the foot are **Declared duty, taxes and fees** (الرسوم والضرائب والأجور المصرَّح بها), **Charged (IQD)** (المحمَّل (د.ع)) and, when the declaration is in IQD, **Difference** (الفرق). For another currency the page says "Declared in USD; charged in IQD — compare by hand."
3. A difference is not an error: it is the question to ask the broker.

### How to find, open, print, attach or note a declaration — Customs Declarations
1. Search the list (declaration no., customs reference, status, HS code, currency, import, supplier's reference, supplier, PD no., date) or choose a **View**: **Open** (مفتوح — Draft, Submitted, Accepted, Assessed; the default), **Cleared** (مخلَّص), **Cancelled or rejected** (ملغى أو مرفوض), **All** (الكل); press **Show**.
2. Click the declaration number to open it. **Import tracking** (متابعة الاستيراد) at its foot opens the import.
3. The four icons in the title bar print the "Customs Declaration" (بيان جمركي), keep the lodgement and assessment papers, hold notes, and show the audit log (see "The four icons at the top of a record — Logistics").
4. The same declarations are also listed on the PD's page, on each container's page and counted on the Shipments screen.

### Fields — Customs Declarations
- **Import application** (طلب الاستيراد) — required when raising; open imports only. Cannot be changed afterwards.
- **PD** (البيان المسبق) — optional; chosen on **Edit declaration**. Must be a PD of the same import.
- **Lodged on** (تاريخ التقديم) — required; defaults to today. No later step may be dated before it.
- **Customs reference** (مرجع الجمارك) — optional on a draft; "The customs office's own number; required once accepted."
- **HS code** (البند الجمركي (HS)) — optional free text.
- **Currency** (العملة) — required; one of the active currencies of Currencies and Rates.
- **Declared value** (القيمة المصرَّح بها) — the customs value of the goods; optional on the draft but must be above zero to submit.
- **Declared duty** (الرسم المصرَّح به), **Declared taxes** (الضرائب المصرَّح بها), **Declared fees** (الأجور المصرَّح بها) — optional; blank means 0. Amounts are typed as digits with up to four decimals (commas allowed).
- **Declared duty, taxes and fees** (الرسوم والضرائب والأجور المصرَّح بها) — worked out: duty + taxes + fees (the declared value is not part of it).
- **Note** (ملاحظة) — optional.
- **On** (بتاريخ) — the date of a step; required; defaults to today.
- **Reason** (السبب) — required to reject or cancel.
- Shown only: **Declaration no.** (رقم البيان), **Status** with its date, **Supplier**, **Raised by** (أنشأه).
List columns: Declaration no., Customs reference, Lodged on, Import application, Supplier, PD (with the PD's status under it), Declared value, Declared duty, Status.

### After you save — Customs Declarations
- Nothing is posted and no stock moves at any step. The declaration is information beside the PD.
- Raising it and every step write an event on the import's tracking (for example "Customs declaration CDN-… cleared on …") and a line in the audit log.
- There is no approval step: whoever holds the forward permission submits it and marks it accepted, assessed and cleared as customs reports; rejecting and cancelling need the cancel permission.
- The status of the import's furthest-advanced live declaration is shown beside the import on In-Transit Inventory and Shipment Tracking; Shipments shows "N cleared of M".

### Refusals — Customs Declarations
- "… is not an import; only an import's goods are declared to customs." / "… is cancelled." / "… is closed; nothing more is declared on it." — choose an open import.
- "\"12,5x\" is not an amount." — type digits only, with at most four decimals.
- "USD is not an active currency. Choose one from Currencies and Rates." — pick a currency that is in use.
- "PD … belongs to another import. A declaration clears against its own import's PD." — choose a PD of this import.
- "CDN-… is submitted; what it declared is the record. Cancel it and raise another if customs has it wrong." — only a draft can be edited.
- "CDN-… declares no value. Enter what was declared before submitting it." — edit the draft and enter the Declared value.
- "Customs gives its own number when it accepts CDN-…. Enter it to mark the declaration accepted." — type the Customs reference.
- "accepted on … is before CDN-… was lodged (…)." — the step's date is earlier than Lodged on.
- "Say why CDN-… is cancelled: the reason is the record." — type the reason.
- "CDN-… is cleared; a cleared declaration is the record and does not move again." — final; raise a new declaration if needed.
- "CDN-… is draft; from there it goes to submitted, cancelled — not accepted." — steps are taken one at a time, in order.
- "No customs declaration '…', or it is outside the branches you may see." — wrong number or another branch.

## Update from ASYCUDA (التحديث من أسيكودا)
Path: Logistics → Customs — ASYCUDA → Update from ASYCUDA   |   Arabic: اللوجستيات ← الجمارك — أسيكودا ← التحديث من أسيكودا
Address: /payables/pd/asycuda (one reading: /payables/pd/asycuda/<reading no.>)
Needs: `import` on `customs_pd` to open the screen, read a list, correct its lines and apply it; applying also needs `edit_draft` on `customs_pd` for the PDs it changes; adding a note needs `edit_draft` on `customs_pd`; attaching a file needs `create` on `attachment`; `print` on `customs_pd` for the PDF and `export` for Excel/Word.
What it is for: bringing many PD statuses up to date in one go from ASYCUDA's own document list. The page is titled **Update from ASYCUDA list** (تحديث من قائمة أسيكودا). Each time the list is read it becomes a numbered **ASYCUDA reading** (قراءة أسيكودا), ASY-<year>-<serial>, kept with the file it came from. A reading shows, line by line, what it would change; nothing changes until it is applied.

### How to read the ASYCUDA list — Update from ASYCUDA
1. In ASYCUDA, export the document list as Excel or CSV (a PDF cannot be read).
2. Open Logistics → Customs — ASYCUDA → Update from ASYCUDA and press **Read the ASYCUDA list** (قراءة قائمة أسيكودا).
3. Choose the file under **The ASYCUDA report** (تقرير ASYCUDA) — .xlsx, .xls, .csv, .txt or .tsv; several files are read as one list — **or** paste the list into **List** (القائمة): one PD per line, the number, then the status as ASYCUDA writes it, then the date if shown, separated by tabs, commas or spaces.
4. Press **Show the difference** (عرض الفرق). The new reading opens. The chosen files are kept on it behind the paperclip.

### How to check a reading — Update from ASYCUDA
1. Open the reading (it opens by itself after reading; later, click its **Reading no.** in the list).
2. The grid **The list as ASYCUDA gave it** (القائمة كما أعطاها أسيكودا) has one row per line of the file: **Line** (السطر), **As ASYCUDA wrote it** (كما كتبها أسيكودا), **PD no.**, **ASYCUDA says** (في أسيكودا), **Date in ASYCUDA**, **Import application**, **When read** (عند القراءة — the PD's status when the list was read), **Now** (الآن — its status at this moment) and **What happens** (ما سيحدث).
3. Read **What happens** for each line: **Will be updated** (سيُحدَّث); **Already so** (كذلك أصلًا); **No such PD** (لا يوجد تصريح بهذا الرقم) — register the PD first; **Two PDs with this number** (تصريحان بهذا الرقم) — change it by hand on the right PD; **Final — re-register instead** (نهائي — أعد التسجيل بدلًا من ذلك); **Not read** (لم يُقرأ) — with the reason under it (for example a header line, or a status the system does not know).
4. The foot shows the number of **Changes** (التغييرات) and of lines **Not read**.

### How to correct a reading's lines by hand before applying — Update from ASYCUDA
Until a reading is applied, its lines can be corrected on the page.
1. Open the reading. In each row the **PD no.**, **ASYCUDA says** (the status) and **Date in ASYCUDA** are boxes you can change.
2. To correct a line, change its boxes: type the right PD number, choose the right status, or set the date.
3. To take a line out, choose **Remove this line** (حذف هذا السطر) in its status box.
4. To add a line the file missed, fill the last row, labelled **New line** (سطر جديد): the PD number, the status and (optionally) the date.
5. To repair a line that was **Not read**, type its PD number and choose its status.
6. Press **Save corrections** (حفظ التصحيحات). The difference is worked out again and the counts change. Under a corrected line the page keeps "Corrected by hand; the file said: …" (صُحّح يدوياً؛ في الملف:), and under an added line "Added by hand" (أُضيف يدوياً). Removed lines disappear; the other lines keep their numbers.
7. Nothing changes on any PD yet — saving corrections is not applying.

### How to apply a reading — Update from ASYCUDA
1. Open the reading and check it. If you corrected lines, press **Save corrections** first.
2. Press **Apply N changes** (تطبيق N تغييرات) at the foot (shown while the reading is not applied and has at least one change).
3. Every line marked Will be updated changes its PD's status, dated the line's date (today when the line has no date), with the source **ASYCUDA list** (قائمة أسيكودا) in the PD's Status history. The reading becomes **Applied** (مطبّقة) and shows who applied it and when; the lines now say **Updated** (تم التحديث).
4. **PD register** (سجل التصاريح) at the foot returns to Customs Pre-Declarations.
An applied reading can no longer be corrected or applied again. To act on what is left, read the list again.

### How to find a reading, print it, attach a file or add a note — Update from ASYCUDA
1. The list **ASYCUDA readings** (قراءات أسيكودا) shows the newest first. Search by reading number or file name, or filter **Status**: **All**, **Not applied** (غير مطبّقة), **Applied** (مطبّقة), then **Show**.
2. Click a **Reading no.** to open it.
3. The four icons in its title bar print the "ASYCUDA Reading" (قراءة أسيكودا), keep the export and any screenshot, hold notes, and show the audit log (see "The four icons at the top of a record — Logistics").

### Fields — Update from ASYCUDA
Read the ASYCUDA list window:
- **The ASYCUDA report** (تقرير ASYCUDA) — the file(s). "The document list as ASYCUDA exports it — Excel or CSV. Several files are read as one list." In a workbook with several sheets, the sheet with the most rows is read.
- **List** (القائمة) — the pasted list, used only when no file is chosen. Give a file or a list — one of the two is required.
Each line of a reading:
- **PD no.** (رقم التصريح) — letters, digits, "/" and "-", with at least one digit; saved in capitals. Matched to the standing PD with that number (one that has not been re-registered).
- **ASYCUDA says** (في أسيكودا) — one of the PD statuses, or **Remove this line**.
- **Date in ASYCUDA** (التاريخ في أسيكودا) — optional; when empty the change is dated the day it is applied.
Boxes on a reading: **Reading no.** (رقم القراءة), **Status** (Not applied / Applied), **Read** (القراءة — the date), **Read by** (قرأها), **From** (المصدر — the file names, or **Pasted in** ملصقة يدوياً), **Lines** (الأسطر), **Changes** (التغييرات), **Not read** (لم يُقرأ), **Applied on** (تاريخ التطبيق), **Applied by** (طبّقها).
List columns: Reading no., Read, Read by, From (with the number of files kept), Lines, Changes, Not read, Status, Applied on.

### After you save — Update from ASYCUDA
- Reading a list and saving corrections change no PD. They only store the reading and its difference; each is written in the audit log (a correction keeps both what the file said and what was typed).
- Applying changes the status of each PD marked Will be updated, exactly as Change status on the PD would: one Status history row each, an event on the import's tracking, and the import's stage re-worked. Lines that are Already so, No such PD, Two PDs with this number, Final or Not read are skipped.
- The difference is worked out again at the moment of applying, so a PD changed by hand in the meantime is treated as it stands then.
- A reading has two statuses only: **Not applied** (غير مطبّقة) and **Applied** (مطبّقة). No approval is involved; whoever may import may apply.

### Refusals — Update from ASYCUDA
- "asycuda_nothing_given" — neither a file nor a pasted list was given. Choose the ASYCUDA report or paste the list, then press Show the difference.
- "report.pdf is a .pdf and the document list is read from a workbook or a CSV. Export the list from ASYCUDA as Excel or CSV, or paste it below." — export it again in Excel or CSV.
- "… could not be read as a workbook: …" / "… has no rows in it." / "There is nothing in that list." — the file is damaged or empty; export it again.
- "That reading has been applied, so what it said is the record now. Read the list again to correct it." — an applied reading is closed.
- "Somebody changed this reading after you opened it. Look at it again, then make your correction." — reload the page and repeat your correction.
- "Line 4 needs a PD number. To take a line out, choose “Remove this line”." — the PD box was emptied.
- "Line 4: \"ABC\" is not a PD number." — a PD number has at least one digit and only letters, digits, "/" and "-".
- "Line 4: choose the status ASYCUDA gives for PD 9330." — the status box was left empty.
- "Line 4: \"2026-13-40\" is not a date." — correct the date.
- "The new line needs a PD number. …" / "The new line: choose the status ASYCUDA gives for PD …." — complete the New line row or leave it wholly empty.
- "Nothing was changed on the lines." — Save corrections was pressed with no change.
- "That would leave the reading with no lines. Read the list again instead." — every line was removed.
- "Line 4 would not read back as you entered it. Choose another status or ask master data to give it its own ASYCUDA label." — the chosen status cannot be told apart from another; choose a different one or ask an administrator.
- "That reading has already been applied. Read the list again to see what is left." — it can be applied once only.
- "A status on … is before PD … was registered (…)." — on applying, a line's date is earlier than its PD's registration date; nothing is applied. Correct that line's date, press Save corrections, then apply again.
- "Permission denied: 'edit_draft' on 'customs_pd' is not granted to this user." — you may read lists but not change PDs; ask an administrator.

## Customs Duties & Taxes (الرسوم والضرائب الجمركية)
Path: Logistics → Customs — ASYCUDA → Customs Duties & Taxes   |   Arabic: اللوجستيات ← الجمارك — أسيكودا ← الرسوم والضرائب الجمركية
Address: /logistics/customs-duties
Needs: `view` on `customs_duty`.
What it is for: a read-only register of every customs / ASYCUDA cost charged to an import, with whether the import's landed cost has taken it in. Nothing is entered here.

### How to read and filter the register — Customs Duties & Taxes
1. Open Logistics → Customs — ASYCUDA → Customs Duties & Taxes. The newest charge is first; 50 rows a page.
2. The title bar shows two totals in IQD over all live customs charges: **Not yet locked** (غير مقفل بعد) and **Locked** (مقفل).
3. Search (source number, note, type, import number, supplier's reference, supplier, currency), or choose **State** (الحالة): **All** (الكل), **Not locked** (غير مقفل), **Locked** (مقفل), **Withdrawn** (مسحوب), and press **Show** (عرض).
4. Click the import number to open the import, where charges are added, withdrawn and locked (its Landed cost section); click the journal number to open the lock's journal.

### Fields — Customs Duties & Taxes
Columns (all read-only):
- **Charged on** (تاريخ التحميل) — the day the charge was put on the import.
- **Import application** (طلب الاستيراد) and **Supplier** (المورّد).
- **Type** (النوع) — always **Customs / ASYCUDA** (جمارك / أسيكودا) on this screen.
- **Source** (المصدر) — the kind of document that carried the cost and its number (for example a broker's invoice line, or a journal).
- **Amount** (المبلغ) — in the charge's own currency; **Amount (IQD)** (المبلغ (د.ع)) — the same in dinars.
- **State** (الحالة) — **Not locked**: waiting for the import's landed cost to be locked; **Locked · N** (مقفل · N) with the lock's date: lock number N spread it over the goods; **Withdrawn**: taken off the import (hover to see why).
- **Journal** (القيد) — the journal the lock posted.
- **Customs status** (الحالة الجمركية) — the import's standing PDs, as "number · status".
- **Note** (ملاحظة) — what the charge is.

### After you save — Customs Duties & Taxes
Nothing is saved on this screen. A charge appears here when its document is posted or when it is added on the import's page, and its State changes to Locked when the landed cost is locked there. Customs charges are what a customs declaration's "Declared versus charged" grid compares against.

### Refusals — Customs Duties & Taxes
This screen refuses nothing because it changes nothing. If it shows **Not available to you**, ask an administrator for access to Customs Duties & Taxes.

## Customs Documents (المستندات الجمركية)
Path: Logistics → Customs — ASYCUDA → Customs Documents   |   Arabic: اللوجستيات ← الجمارك — أسيكودا ← المستندات الجمركية
Address: /logistics/customs-documents
Needs: `view` on `customs_pd`.
What it is for: a read-only list of every file attached to a PD, an ASYCUDA reading or a customs declaration, newest first. Files are attached on the record itself (its paperclip), never here.

### How to find and open a customs document — Customs Documents
1. Open Logistics → Customs — ASYCUDA → Customs Documents.
2. Search (file name, record number, import number, supplier, who uploaded it), or choose **Record** (السجل): **All records** (كل السجلات), **PD** (بيان مسبق), **ASYCUDA reading** (قراءة أسيكودا), **Customs declaration** (بيان جمركي), and press **Show**.
3. Click the file name to open the file in a new tab. Click the number under **Filed on** to open the record it belongs to (files are added there, behind its paperclip).

### Fields — Customs Documents
Columns (all read-only): **File** (الملف — with "v2", "v3" when it replaced an earlier version); **Record** (السجل — the kind of record); **Filed on** (مرفق بـ — the record's number); **Import application**; **Supplier**; **Uploaded** (رُفع — the date); **By** (بواسطة); **Size** (الحجم). Only the current version of each file is listed.

### After you save — Customs Documents
Nothing is saved here. A file appears as soon as it is attached on a PD, a reading or a declaration.

### Refusals — Customs Documents
None of its own. A file you may not read is refused when you click it; **Not available to you** means you lack access to the screen.

## Shipments (الشحنات)
Path: Logistics → Shipping → Shipments   |   Arabic: اللوجستيات ← الشحن ← الشحنات
Address: /logistics/shipments
Needs: `view` on `bill_of_lading`.
What it is for: a read-only overview with one row per import that has a Bill of Lading — its B/Ls, its containers counted as they arrive, the route, how far the slowest container has got, and where customs stands. It is the quick way to an import's shipment; the B/Ls and containers themselves are changed on their own screens.

### How to read and filter the register — Shipments
1. Open Logistics → Shipping → Shipments. Imports whose next container is due soonest come first; 50 rows a page.
2. Choose a **View** (العرض) and press **Show** (عرض): **Open** (مفتوح) — imports with at least one container not yet received (the default); **All containers in** (كل الحاويات وصلت); **All** (الكل).
3. Search by import number, supplier's reference, supplier, import stage, B/L number or container number.
4. Click the import number to open the import's page at its **Shipment & containers** (الشحن والحاويات) section; click a B/L number to open that B/L; click the supplier to open its profile.

### Fields — Shipments
Columns (all read-only):
- **Import application** (طلب الاستيراد) — the import's number, with the supplier's reference under it.
- **Supplier** (المورّد).
- **B/Ls** (البوالص) — the import's live B/L numbers.
- **Route** (المسار) — port of loading → port of discharge of each B/L.
- **Containers (received / total)** (الحاويات (مستلَمة / الكل)) — cancelled containers are not counted; "N late" (N متأخرة) appears under it when containers are late.
- **Next ETA** (أقرب وصول متوقع) — the soonest ETA among the containers not yet received.
- **Status** (الحالة) — the stage of the container that is furthest behind (a late container counts as the furthest behind).
- **Import stage** (مرحلة الاستيراد) — the stage the import itself has reached.
- **Customs (PDs)** (الجمارك (البيانات المسبقة)) — the import's standing PDs as "number · status".
- **Declarations** (البيانات الجمركية) — "N cleared of M" (N مخلَّص من M), not counting cancelled or rejected declarations.

### After you save — Shipments
Nothing is saved on this screen. A row appears when an import gets its first B/L and moves to **All containers in** when its last container is received.

### Refusals — Shipments
None of its own. **Not available to you** means you lack access to Shipments.

## Bills of Lading (بوالص الشحن)
Path: Logistics → Shipping → Bills of Lading   |   Arabic: اللوجستيات ← الشحن ← بوالص الشحن
Address: /payables/shipments (one B/L: /payables/shipments/<B/L no.>)
Needs: `view` on `bill_of_lading` to open; `create` on `bill_of_lading` to record a new B/L; `edit_draft` on `bill_of_lading` to add containers, edit the B/L, add a note or attach a file (attaching also needs `create` on `attachment`); `reverse_cancel` on `bill_of_lading` to cancel it; `edit_draft` on `shipment_container` for **Move all containers**; `print` on `bill_of_lading` for the PDF and `export` for Excel/Word.
What it is for: the B/Ls of every import, newest first, each with its containers counted as they arrive. A B/L may carry part of an import, and an import may have any number of B/Ls. Recording the first B/L of an import marks the import as shipped.

### How to record a new B/L — Bills of Lading
1. Open Logistics → Shipping → Bills of Lading and press **New B/L** (بوليصة شحن جديدة).
2. Choose the **Import application** (معاملة الاستيراد), type the **B/L no.** (رقم البوليصة) as the shipping line issued it, the **B/L date** (تاريخ البوليصة) and the **ETA** (الوصول المتوقع).
3. Optionally fill **Vessel** (السفينة), **Voyage** (الرحلة), **Shipping line** (خط الشحن), **Port of loading** (ميناء التحميل) and choose the **Port of discharge** (ميناء التفريغ).
4. Press **New B/L**. The B/L's own page opens.
5. Important: from this window the B/L is saved **without containers** — what is typed in **Size / type**, in the **Containers** box and the "Spread the import's lines equally…" tick is not saved. Add the containers next with **Add containers** on the B/L's page (see below).
6. Alternative: on the import's own page, the section **Shipment & containers** (الشحن والحاويات) has a **New B/L** button whose window includes the container table, so the B/L and its containers are saved together.

### How to add containers to a B/L — Bills of Lading
1. Open the B/L and press **Add containers** (إضافة حاويات) at the foot (shown while the B/L is not cancelled and its import is open).
2. The table has one row per container, as the B/L lists them. In the first row type the **Container no.** (رقم الحاوية), choose its **Size / type** (الحجم / النوع) and type its **Seal no.** (رقم الختم). Filling a row opens the next empty one; ✕ (**Remove this container** إزالة هذه الحاوية) drops a row. Pasting several numbers into one number box fills one row each.
3. Each further column is one model (item) of the import, in the unit it was ordered in. Type how many of that model each container carries — or leave a model's column empty in every row and what is left of it is **divided** (يُقسَّم) equally over the new containers.
4. Watch the foot of the table, **In these containers** (في هذه الحاويات): it shows what is typed for each model and **Left:** (المتبقي:) what is still to ship, and turns red with "More than the N left" (أكثر من المتبقي N) when too much is typed.
5. A number typed wrong is marked at once: "Not a container number (4 letters, 7 digits)" (ليس رقم حاوية (4 أحرف و7 أرقام)) or "Check digit should be N" (رقم التحقق يجب أن يكون N).
6. Press **Add containers**. Each container starts at the stage **Not loaded** (لم تُحمَّل) with the B/L's ETA.

### The container number and its check digit — Bills of Lading
- A container number is four letters and seven digits, for example MSCU1234566: three letters of the owner, then U, J, Z or R, then six digits and a last **check digit**.
- The check digit is calculated from the first ten characters (the international container standard, ISO 6346). If the last digit you typed is not the one the calculation gives, the number was mistyped somewhere — the screen says "Check digit should be N" and the save is refused.
- Spaces and dashes inside a number are ignored, and small letters become capitals.
- What to do: read the number again from the B/L. Do not simply replace the last digit with the suggested one unless the other ten characters are certainly right.
- The same number may be used again only after its earlier container has been received or cancelled.

### How to move all containers of a B/L to a stage — Bills of Lading
1. Open the B/L and press **Move all containers** (نقل كل الحاويات).
2. Choose the **Stage** (المرحلة): **On the sea** (في البحر), **At port** (في الميناء) or **Customs cleared** (مخلَّصة جمركيًا); set the **Date** (التاريخ) and an optional **Note**.
3. Press **Move all containers**. Every container of the B/L that is not yet received and has not reached that stage moves to it, each with its own dated row in its stage history. Containers already past the stage are left alone.

### How to correct or cancel a B/L — Bills of Lading
1. To correct it: open the B/L and press **Edit B/L** (تعديل البوليصة) — offered only while no container on it has been received. Change the **B/L no.**, **B/L date**, **ETA**, **Vessel**, **Voyage**, **Shipping line**, **Port of loading**, **Port of discharge** and press **Save** (حفظ).
2. Changing the ETA also moves the ETA of every container still on the B/L's old ETA; a container that was given its own ETA keeps it.
3. To cancel it: type the reason in **Why the B/L is cancelled** (سبب إلغاء البوليصة) and press **Cancel B/L** (إلغاء البوليصة) — also only while nothing on it has been received. Every container on it is cancelled with it. The B/L stays in the list marked **Cancelled** (ملغاة) and its number may be recorded again.
4. Once a container has been received the B/L is the record: explain a mistake with a note (the Notes icon).

### How to find, open, print, attach or note a B/L — Bills of Lading
1. Search the list by B/L number, vessel, voyage, shipping line, dates, port, import number, supplier's reference or supplier. The list has no View box; it shows 50 rows a page, newest B/L date first.
2. Click the B/L number. The page is titled "B/L <number>"; its grid lists the containers — click one to open the container.
3. The four icons in the title bar print the "Bill of Lading" (بوليصة الشحن), keep the scanned B/L and packing list, hold notes, and show the audit log (see "The four icons at the top of a record — Logistics"). **Import tracking** (متابعة الاستيراد) opens the import.

### Fields — Bills of Lading
New B/L / Edit B/L:
- **Import application** (معاملة الاستيراد) — required on New B/L; open imports only; cannot be changed later.
- **B/L no.** (رقم البوليصة) — required; saved in capitals; must be unique among B/Ls that are not cancelled.
- **B/L date** (تاريخ البوليصة) — required; defaults to today. Instalments of the import that fall due "against B/L" or "N days after B/L" are dated from the first B/L's date.
- **ETA** (الوصول المتوقع) — required ("Required: it is what tells you a container is late."); not before the B/L date. Copied to each container added.
- **Vessel** (السفينة), **Voyage** (الرحلة), **Shipping line** (خط الشحن) — optional free text.
- **Port of loading** (ميناء التحميل) — optional free text, as the B/L writes it.
- **Port of discharge** (ميناء التفريغ) — optional; chosen from the ports in use (see Ports & Routes).
- **Size / type** (الحجم / النوع), **Containers** (الحاويات) and the tick "Spread the import's lines equally over these containers (estimated — the warehouse confirms)" — shown on the New B/L window of this screen but not saved; use **Add containers**.
Add containers table, per row:
- **Container no.** (رقم الحاوية) — required in the first row; four letters, seven digits, the last digit checked.
- **Size / type** (الحجم / النوع) — optional; one of 20GP, 40GP, 40HC, 45HC, 20RF, 40RH, 20OT, 40OT, 20FR, 40FR, 20TK.
- **Seal no.** (رقم الختم) — optional.
- One quantity box per model — optional; never more in total than is left to ship of that model. Left empty in every row: divided equally (whole units, the last container takes the remainder) and the containers are marked **estimated** (تقديري) for the warehouse to confirm.
Move all containers: **Stage** (required), **Date** (required, today offered), **Note**.
Boxes on the B/L record: B/L no.; **Received** (المستلم) "X of Y received" (استُلم X من Y) — or **Status: Cancelled**; Import application; Supplier; B/L date; ETA; Vessel (vessel / voyage); Shipping line; Port of loading; Port of discharge; **Why it was cancelled** (سبب الإلغاء).
Containers grid on the record: Container no., Size / type, Seal no., ETA, **Planned** (المخطط), **Received** (المستلم), **Short** (الناقص), **Warehouse** (المستودع), **Status**.
List columns: B/L no., Import application, Supplier, B/L date, Vessel, Port of discharge, ETA, Received (X of Y received), Status (the stage of the container furthest behind, or Cancelled).

### After you save — Bills of Lading
- A B/L has no approval and posts nothing: no journal and no stock movement. It records the shipment.
- The first B/L of an import writes "B/L … issued on … — the import is now shipped" on the import's tracking, dates the import's B/L-triggered instalments, and re-works the import's stage.
- Adding containers writes the list of containers on the import's tracking; each container gets its own page under Containers.
- A B/L is "received" only when all its containers are: the box **Received** counts "X of Y received".
- Who acts next: the logistics officer moves the containers through their stages; the warehouse receives each one on the container's page.

### Refusals — Bills of Lading
- "Give the B/L number as the shipping line issued it." / "Give the B/L date." — a required box is empty.
- "Give the ETA: without it nobody is told when the containers are late." — enter the ETA (the New B/L window does not mark it, but it is required).
- "An ETA of … is before the B/L was issued on …." — correct one of the two dates.
- "B/L … is already recorded. One B/L, one record — cancel the wrong one to enter it again." — that number exists and is not cancelled.
- "… is not an import; only imports are shipped in containers." / "… is cancelled." / "… is cleared." — the import is not open.
- "'ABCD123' is not a container number: four letters (the owner code and U, J, Z or R) and seven digits, e.g. MSCU1234566." — retype the number.
- "MSCU1234567: its last digit is the check digit and should be 6 — check the number on the B/L." — the number is mistyped.
- "MSCU1234566 is listed twice." — remove the repeated row.
- "Already on a live B/L: MSCU1234566. A number recurs only after its container has been received (§17.2)." — that container is still on its way on another B/L.
- "ITEM-1 (BOX): 120 in these containers, but only 100 is left to ship of what was ordered." — reduce the quantities; a B/L cannot ship more than was ordered.
- "Enter at least one container." — Add containers was pressed with an empty table.
- "\"12x\" is not a quantity." — type digits only.
- "B/L … is cancelled." — nothing can be added to a cancelled B/L.
- "B/L … has received containers (…); it is the record now and is corrected by a note." — Edit B/L is closed once a container is received.
- "B/L … has received containers (…); it cannot be cancelled." / "Say why the B/L is cancelled." / "B/L … is already cancelled."
- "No container of this B/L can move to that stage." — every container is already at or past the chosen stage, or received.
- "No B/L or container '…', or it is outside the branches you may see." — wrong number or another branch.

## Containers (الحاويات)
Path: Logistics → Shipping → Containers   |   Arabic: اللوجستيات ← الشحن ← الحاويات
Address: /payables/containers (one container: /payables/containers/<container no.>)
Needs: `view` on `shipment_container` to open; `edit_draft` on `shipment_container` to change the stage or the ETA, record the port file, set what it carries, edit it, add a note or attach a file; `execute` on `shipment_container` to receive it; `reverse_cancel` on `shipment_container` to cancel it; `print` on `shipment_container` for the PDF of the container and of its receipt, `export` for Excel/Word; `create` on `goods_return` to claim a shortage (done on the import's page).
What it is for: every container on its own — where it is, how late, what it carries and where it was received. This is where the warehouse receives a container: the count of what came off it moves the goods out of transit into a real warehouse.

### Container stages — Containers
- **Not loaded** (لم تُحمَّل) — the starting stage when the container is added to a B/L.
- **On the sea** (في البحر) — it sailed; the date is kept as **Sailed** (أبحرت).
- **At port** (في الميناء) — it arrived at the port of discharge; kept as **At port** (في الميناء).
- **Customs cleared** (مخلَّصة جمركيًا) — customs released it; kept as **Customs cleared** (التخليص الجمركي). After this the **Port file sent** date can be recorded.
- **Late — ETA passed** (متأخرة — تجاوزت موعد الوصول) — set by the daily check, never by hand, when the ETA passes while the container is still Not loaded or On the sea. When it turns up, move it on to At port or Customs cleared.
- **Received** (مستلمة) — set only by the container receipt, when everything planned arrived whole.
- **Missing / damaged** (مفقودة / تالفة) — set only by the container receipt, when something was short, damaged or different from the plan. It counts as received.
A person moves a container forward only (skipping a stage is allowed); it never goes back. A wrong date is explained with a note. A **Cancelled** (ملغاة) container was taken off the B/L with a reason.

### How to find a container — Containers
1. Open Logistics → Shipping → Containers. The soonest ETA is first.
2. Choose a **View** (العرض) and press **Show**: **Not received yet** (لم تُستلم بعد) — the default; **Late** (متأخرة); **Received** (مستلمة); **Short or damaged** (ناقص أو تالف); **Cancelled** (ملغاة); **All** (الكل — everything except cancelled).
3. Or search by container number, B/L, import, supplier, port, status or warehouse.
4. **Days since ETA** (أيام منذ الموعد) shows a red number when the ETA has passed, "in N days" (بعد N يومًا) when it is still ahead, and "—" once received.

### How to open a container and what it shows — Containers
1. Click the container number (here, on its B/L, on Shipment Tracking or on a PD's page).
2. The boxes show the container, its B/L, import and supplier, its dates (one per stage, all kept), its warehouse and receipt, and **Customs status** (الحالة الجمركية): the import's PDs with their statuses.
3. The grid **What it carries** (ما تحمله) lists each model with **Planned** (المخطط), **Received** (المستلم), **Damaged** (التالف) and **Short** (الناقص).
4. Under it, **Stages** (المراحل) lists every stage change with its date, note and who recorded it (By hand, Container receipt, Daily check…), and **Customs** (الجمارك) lists the import's customs declarations with their status and clearance date.
5. If the same container number travelled before, "This number also travelled on:" links to its other trips.
6. **Import tracking** (متابعة الاستيراد) opens the import's page.

### How to change a container's stage, ETA or port file — Containers
1. Stage: open the container, press **Change stage** (تغيير المرحلة), choose the next **Stage** (only later stages are offered), set the **Date** and an optional **Note**, and press **Change stage**.
2. ETA: press **Change ETA** (تغيير موعد الوصول), enter the new **ETA** and an optional **Note**, and press **Change ETA**. The change is written on the import's tracking.
3. Port file: once the container has a Customs cleared date, a date box **Port file sent** (إرسال ملف الميناء) appears at the foot with the button **Port file sent** (أُرسل ملف الميناء). Set the date and press it. It is recorded once.

### How to set what a container carries — Containers
1. Open a container that is not yet received and press **What it carries** (ما تحمله).
2. In each row choose the **Model** (الموديل) from the import's order lines, adjust the **Description** (الوصف) and type the **Planned** (المخطط) quantity. Six rows are offered; leave unused rows empty.
3. Press **Save** (حفظ). Saving replaces the whole plan (the old one is kept in the history) and removes the "estimated" mark.
Do this when the plan was divided equally from the B/L ("Spread equally from the B/L — confirm what the container actually carries.") or when the grid says "No plan yet — enter what the container carries."
Two cautions: the window shows six rows only, so a container planned with more than six models would lose the models beyond the sixth when saved here; and it saves the quantities without a unit, so the plan is then counted in the item's base unit — if the import was ordered in another unit (for example boxes), type the quantities in base units.

### How to receive a container — Containers
1. Open the container and press **Receive container** (استلام الحاوية) (shown while it is neither received nor cancelled).
2. Choose the **Warehouse** (المستودع) the goods are put away in — only active, real warehouses of the import's branch are offered — and the date **Received** (الاستلام).
3. For each model, count what came off the container: **Received** (المستلم — what arrived in good order; the planned quantity is offered), **Damaged** (التالف — what arrived damaged; 0 is offered) and **Short** (الناقص — what was not there). Leave Short empty and it is worked out: planned − received − damaged.
4. If anything is short, damaged or different from the plan, say what happened in **What happened** (ما الذي حدث) — it is required then and opens the claim for purchasing. Add a **Note** if useful.
5. Press **Receive container**. Pressing it twice still makes one receipt.
6. The container becomes **Received** — or **Missing / damaged** if anything was not whole — and gets a **Container receipt** (إيصال استلام الحاوية) number, with its own printer icon beside it.

### What received, damaged and short mean — Containers
- **Received**: the units that arrived in good order. Only these move out of transit into the chosen warehouse and become available stock, at the cost the purchase invoice gave them.
- **Damaged**: units that arrived but are not accepted into stock. They stay in transit (owned, not available) until they are claimed from the supplier.
- **Short**: units the plan said were in the container and were not. They also stay in transit until claimed.
- For each line, Received + Damaged + Short must equal Planned. If more than planned arrived, Short must be empty.
- A container whose every line arrived whole (received = planned, nothing damaged or short) is **Received**; any other result is **Missing / damaged**, which also opens a hold on the import: "Claim: … arrived short or damaged — <what happened>".

### How to claim a shortage — Containers
Once **every** container of the import has been received, whatever the invoices bought and is still in transit (short or damaged) is claimed from the supplier in one step.
1. Open the import's page (**Import tracking** on the container) and go to **Quantities by model** (الكميات حسب الموديل). It shows for each model: **Ordered** (المطلوب), **In containers** (في الحاويات), Received, Damaged, Short, **Claimed** (المُطالَب به), **Still in transit** (ما زال في الطريق) and **Not yet shipped** (لم يُشحن بعد).
2. When every container is in and something is still in transit, the section explains it and offers **Claim the shortage** (المطالبة بالنقص). Press it.
3. Enter the **Claim date** (تاريخ المطالبة), optionally the **Supplier's reference** (مرجع المورد), and **What is claimed** (ما المُطالَب به) — for example "40 cartons short in MSCU1234566, seal intact; 6 damaged."
4. Press **Claim the shortage**. One purchase return per invoice is raised for everything still in transit, out of the transit warehouse, set against what the company owes the supplier. The first return's page opens: it is approved and posted there like any purchase return.
5. If more goods are still coming instead, do not claim: add the balance shipment as another container on a B/L.

### How to edit or cancel a container — Containers
1. To correct it (until it is received): press **Edit container** (تعديل الحاوية), change the **Container no.**, **Size / type** or **Seal no.**, and press **Save** (حفظ).
2. To take it off the B/L (until it is received): type the reason in **Why the container is cancelled** (سبب إلغاء الحاوية) and press **Cancel container** (إلغاء الحاوية). It stays visible in the **Cancelled** view.

### How to print, attach a file or add a note — Containers
1. Open the container and use the four icons in the title bar (see "The four icons at the top of a record — Logistics"): the printer gives the "Container" (حاوية) document; the paperclip keeps the delivery note and photos (also written on the import's tracking); notes and the audit log as usual.
2. To print the receipt, use the small printer beside the **Container receipt** number: it gives the "Container Receipt" (إيصال حاوية).

### Fields — Containers
Receive container window:
- **Warehouse** (المستودع) — required; an active warehouse of the import's branch that is not a transit or stage warehouse.
- **Received** (الاستلام) — the receipt date; required; today is offered. The stock moves on this date.
- Per model: **Planned** (shown), **Received** (المستلم), **Damaged** (التالف), **Short** (الناقص) — quantities, never below zero; Short may be left empty.
- **What happened** (ما الذي حدث) — required when anything is short, damaged or different from the plan. "Required when anything is short, damaged or different from the plan — it opens the claim for purchasing."
- **Note** (ملاحظة) — optional.
Change stage: **Stage** (required), **Date** (required), **Note**. Change ETA: **ETA** (required), **Note**. Port file: **Port file sent** date (required).
What it carries: **Model** (from the import's order lines), **Description**, **Planned** (above zero; no more of a model than is left of the order beside the other containers).
Edit container: **Container no.** ("Four letters and seven digits; the last digit is checked."), **Size / type**, **Seal no.**
Claim the shortage: **Claim date** (required, today offered), **Supplier's reference** (optional), **What is claimed** (required).
Boxes on the container record: Container no.; **Status** with its date; **B/L no.**; Import application; Supplier; Size / type; Seal no.; ETA; **Sailed** (أبحرت); **At port**; **Customs cleared**; **Port file sent**; **Received**; **Warehouse**; **Container receipt** (إيصال استلام الحاوية); **Customs status**; **What happened** (the receipt's reason); **Plan** (the "estimated" notice); **Why it was cancelled**.
List columns: Container no. (with size/type), B/L no., Import application, Supplier, Port of discharge, ETA, Days since ETA, Status, **Customs status** (the import's PDs), **Customs cleared**, Warehouse, **Planned / received** (المخطط / المستلم), **Damaged / short** (تالف / ناقص).

### After you save — Containers
- Stage, ETA and port-file changes post nothing; each is written on the import's tracking, and a stage change also re-works the import's stage.
- **Receiving** is the step that moves stock: the received units leave the transit warehouse and enter the chosen warehouse at the cost the purchase invoice gave them, dated the receipt date. No new payable is created — the invoice already booked the debt. A numbered container receipt (CREC-<branch>-<year>-<serial>) is kept.
- The container's status becomes Received or Missing / damaged; its B/L and the Shipments screen count it; when the last container is in, the import's tracking says "All containers in".
- A Missing / damaged receipt writes the variance on the import's tracking and opens a claim hold on the import for purchasing.
- **Claiming a shortage** raises purchase returns that still have to be approved and posted on their own page; posting them takes the goods out of the transit warehouse and sets their value against what the company owes the supplier, until the supplier's credit memo arrives. When nothing is left in transit the import can go on to clear.
- Next after the last receipt: once every PD is Totally written off, the landed cost can be locked on the import's page.

### Refusals — Containers
- "… has been received; its stages are closed." — a received container cannot change stage.
- "… is already past that. A container goes forward — not loaded, on the sea, at port, customs cleared; a wrong date is corrected by a note." — choose a later stage, or add a note.
- "Give the date of the stage." / "Give the new ETA." / "Give the date the port file was sent." — a date is empty.
- "… has arrived." — the ETA of a received container cannot be changed.
- "… is not customs cleared yet; its port file follows the clearance." — move it to Customs cleared first.
- "…'s port file was sent on …." — it is recorded once.
- "… has been received; its plan is closed." / "A container carries at least one model." / "Line 2: plan a quantity above zero." — fix the plan.
- "ITEM-1: 60 in this container, but only 40 is left of what was ordered beside the other containers." — the plans of all containers together cannot exceed the order.
- "… was received on …. One container, one receipt." — it has been received already.
- "'WH-X' is not an active warehouse." / "WH-X belongs to … and … to …. Receive into a warehouse of the import's branch." / "WH-X holds goods in transit. Receive into the warehouse the goods are put away in." — choose a real warehouse of the import's branch.
- "Give the date the container was received."
- "The container has no lines to receive. Load its plan first." — use **What it carries** first.
- "Quantities received, damaged and short are counted, so never below zero."
- "Received, damaged and short together make the planned quantity. Leave Short empty and it is worked out." — the three do not add up to the plan.
- "More than planned arrived, so nothing on that line is short. Leave Short empty."
- "What arrived is not what was planned. Say what happened — the reason opens the claim for purchasing (§18)." — fill **What happened**.
- "…'s invoice is not posted yet. The goods enter the books at the invoice's cost — post the invoice (CEO approval), then receive the container." — the import's purchase invoice must be posted before goods are received.
- "ITEM-1: 500 received, but the invoice's goods still in transit hold only 480. Receive what the invoice bought; an excess is the supplier's to invoice." — you counted more than the invoice bought; receive the invoiced quantity.
- "Line 2 names no item, so there is no stock to receive." — give the plan line its model.
- "The form carries no document id. Open the receipt form again and submit it once." — reload the page and receive again.
- "… is cancelled." — a cancelled container cannot be changed or received. "… is cleared." — the import is closed.
- "… has been received; it is the record now." / "… has been received; it cannot be cancelled." / "Say why the container is cancelled." / "… is already cancelled." / "… is already on a live B/L."
- Claiming: "… has 2 containers still to arrive. A shortage is claimed once every container is in — or add the balance shipment as another container."; "Nothing of … is left in transit: there is no shortage to claim."; "Say what is claimed and why — the supplier will ask."; "Give the date of the claim."; "ITEM-1: 30 base units are still in transit, which is not a whole number of BOX. Claim it from the Purchase Returns screen, line by line."

## Ports & Routes (الموانئ والمسارات)
Path: Logistics → Shipping → Ports & Routes   |   Arabic: اللوجستيات ← الشحن ← الموانئ والمسارات
Address: /logistics/ports (one port: /logistics/ports/<code>)
Needs: `view` on `port` to open; `create` on `port` to add a port; `configure` on `port` to edit, retire or bring back a port, add a note or attach a file (attaching also needs `create` on `attachment`); `print` on `port` for the PDF and `export` for Excel/Word.
What it is for: the list of ports a B/L can discharge at, and under it the routes the B/Ls have actually taken (port of loading → port of discharge). A port in use is offered in the **Port of discharge** box of a B/L; a retired one is not.

### How to add a port — Ports & Routes
1. Open Logistics → Shipping → Ports & Routes and press **New port** (ميناء جديد).
2. Type the **Name** (الاسم) as the shipping line writes it, and if known the **UN/LOCODE** (five letters, for example IQUQR) and the **Country** (الدولة — two letters, for example IQ).
3. Press **New port**. The code is given automatically (for example PRT-0003) and the port's profile opens.

### How to open a port's profile, edit, retire or bring it back — Ports & Routes
1. Click the port's **Code** (الرمز) in the list, or a port name in the routes table. The profile shows the port, the grid **B/Ls discharging here** (البوالص التي تُفرَّغ هنا) and the section **Containers on the way** (حاويات في الطريق).
2. To correct it press **Edit port** (تعديل الميناء), change **Name**, **UN/LOCODE** or **Country** and press **Save** (حفظ).
3. To stop it being offered to new B/Ls, type the reason in **Why the port is retired** (سبب إيقاف الميناء) and press **Retire port** (إيقاف الميناء). Its old B/Ls keep it. The profile then says "This port is retired: new B/Ls cannot choose it."
4. To use it again, type the reason in **Why it is back in use** (سبب إعادة استعماله) and press **Back in use** (إعادة الاستعمال).
5. The four icons in the title bar print the "Port" (ميناء) sheet, keep its papers (tariff sheet, agent's letter), hold notes and show the audit log.

### How to read the list and the routes — Ports & Routes
1. **View** (العرض): **In use** (مستعمل) — the default; **Retired** (موقوف); **All** (الكل); press **Show**. The search box looks in the port's code, name, LOCODE and country.
2. The second table, **Routes in use** (المسارات المستعملة), is read from the B/Ls and cannot be edited: each port of loading (as typed on the B/Ls) to each port of discharge, the shipping lines, how many B/Ls took it, how many containers are still on the way, and the last B/L date.

### Fields — Ports & Routes
- **Name** (الاسم) — required; must not repeat another port's name.
- **UN/LOCODE** — optional; exactly five letters, the first two being the country; must not repeat another port's.
- **Country** (الدولة) — optional; two letters. Left empty with a LOCODE given, it is taken from the LOCODE's first two letters.
- **Code** (الرمز) — given by the system; never changes.
- **Status** (الحالة) — **In use** (مستعمل) or **Retired** (موقوف).
List columns: Code, Name, UN/LOCODE, Country, **B/Ls** (البوالص — live B/Ls discharging there), **Containers on the way** (حاويات في الطريق — not yet received), **Last B/L** (آخر بوليصة — its date), Status.
Routes columns: **From** (من), **To** (إلى), **Shipping lines** (الخطوط الملاحية), B/Ls, Containers on the way, Last B/L.
Profile grid: B/L no., B/L date, ETA, Import application, Supplier, From, Containers, **Still to arrive** (لم تصل بعد).

### After you save — Ports & Routes
A port has no approval and posts nothing. A new or re-activated port is offered at once in the Port of discharge box of B/Ls; a retired one disappears from that box but stays on its old B/Ls. Ports are never deleted. Every change is in the port's audit log.

### Refusals — Ports & Routes
- "Give the port its name, as the shipping line writes it." — the name is empty.
- "'IQUQ' is not a UN/LOCODE: five letters, the country's two first (IQUQR)." — correct the LOCODE.
- "'IRQ' is not a two-letter country code." — use two letters.
- "LOCODE IQUQR is in IQ, not AE." — the country and the LOCODE disagree.
- "PRT-… is already …. One port, one row — reactivate it if it was retired." — a port with that name or LOCODE already exists (the message names it); open that port instead.
- "Say why … is retired: the reason is the record." / "Say why … is back in use." — type the reason.
- "… is already retired." / "… is in use already."
- "No port '…'." — wrong code.

## Freight & Shipping Costs (تكاليف الشحن والنقل)
Path: Logistics → Shipping → Freight & Shipping Costs   |   Arabic: اللوجستيات ← الشحن ← تكاليف الشحن والنقل
Address: /logistics/freight-costs
Needs: `view` on `freight_cost`.
What it is for: a read-only register of every freight, port, forwarding and other cost charged to an import, with whether the import's landed cost has taken it in. Nothing is entered here.

### How to read and filter the register — Freight & Shipping Costs
1. Open Logistics → Shipping → Freight & Shipping Costs. The newest charge is first; 50 rows a page.
2. The title bar shows two IQD totals over all live charges of these types: **Not yet locked** (غير مقفل بعد) and **Locked** (مقفل).
3. Search, or choose **State** (الحالة): **All**, **Not locked** (غير مقفل), **Locked** (مقفل), **Withdrawn** (مسحوب), and press **Show**.
4. Click the import number to open the import, where charges are added and the landed cost is locked.

### Fields — Freight & Shipping Costs
Columns (all read-only): **Charged on** (تاريخ التحميل); **Import application**; **Supplier**; **Type** (النوع) — **Freight** (شحن), **Port & forwarding** (ميناء وتخليص) or **Other** (أخرى — insurance and handling are recorded as Other); **Source** (المصدر — the kind of document and its number); **Amount** (in the charge's currency); **Amount (IQD)**; **State** (Not locked / Locked · N with the lock date / Withdrawn); **Journal** (the lock's journal); **Note**.

### After you save — Freight & Shipping Costs
Nothing is saved here. A charge appears when its document is posted or when it is added on the import's page; it becomes Locked when the landed cost is locked there, which is when it enters the cost of the goods.

### Refusals — Freight & Shipping Costs
None of its own. **Not available to you** means you lack access to Freight & Shipping Costs.

## Shipment Documents (مستندات الشحن)
Path: Logistics → Shipping → Shipment Documents   |   Arabic: اللوجستيات ← الشحن ← مستندات الشحن
Address: /logistics/shipment-documents
Needs: `view` on `bill_of_lading`.
What it is for: a read-only list of every file attached to a B/L, a container or an import application, newest first. Files are attached on the record itself (its paperclip), never here.

### How to find and open a shipment document — Shipment Documents
1. Open Logistics → Shipping → Shipment Documents.
2. Search (file name, B/L number, container number, import number, supplier, who uploaded it), or choose **Record** (السجل): **All records** (كل السجلات), **B/L** (بوليصة شحن), **Container** (حاوية), **Import application** (طلب استيراد), and press **Show**.
3. Click the file name to open it in a new tab; click the number under **Filed on** (مرفق بـ) to open the B/L, container or import it belongs to.

### Fields — Shipment Documents
Columns (all read-only): **File** (الملف, with "v2"… when it replaced an earlier version); **Record** (السجل); **Filed on** (مرفق بـ); **Import application**; **Supplier**; **Uploaded** (رُفع); **By** (بواسطة); **Size** (الحجم). Only the current version of each file is listed.

### After you save — Shipment Documents
Nothing is saved here. A file appears as soon as it is attached on a B/L, a container or an import.

### Refusals — Shipment Documents
None of its own. **Not available to you** means you lack access to the screen.

## In-Transit Inventory (المخزون قيد النقل)
Path: Logistics → In Transit → In-Transit Inventory   |   Arabic: اللوجستيات ← قيد النقل ← المخزون قيد النقل
Address: /logistics/in-transit (the old address /inventory/in-transit leads here)
Needs: `view` on `in_transit` to open the screen. The section Invoice Status Tracking shows only with `view` on `supplier_shipment`; its **Move to …** buttons need `execute` on `supplier_shipment`; the "Notify these users" list needs `configure` on `supplier_shipment`; the **Print / Export** menu needs `print` (PDF) or `export` (Excel/Word) on `supplier_shipment`.
What it is for: goods the company owns that are not yet in any real warehouse. The top part is read-only and shows, import by import and item by item, what is in transit, what has been received and what is on hand. The bottom part, **Invoice Status Tracking**, is where goods of ordinary (non-import) purchase invoices are moved stage by stage: In Process → On Board → At Port → In Bounded.

### How to read the figures — In-Transit Inventory
The page starts with **How to read the figures** (كيف تُقرأ الأرقام):
- **In transit** (قيد النقل) — booked by the posted purchase invoice into a transit warehouse and not yet received. Owned, counted in stock value, never on hand and never available.
- **Received** (المستلَم) — moved by a container receipt out of transit into a real warehouse, on the receipt's date.
- **On hand** (في اليد) — what of this import's received goods is still in those warehouses now (it goes down as they are sold or issued).
- **Available** (المتاح) — the item's figure on the Availability screen (Inventory), over every warehouse and reservation; nothing in transit ever increases it.
Example: 500 shipped and 300 received gives In transit 200, Received 300, On hand 300.

### How to see what is in transit for an import or an item — In-Transit Inventory
1. Open Logistics → In Transit → In-Transit Inventory.
2. In the first table, choose **View** (العرض): **Open** (مفتوح) — imports with something still in transit or a container still to arrive (the default) — or **All** (الكل) — every import with a posted invoice; press **Show** (عرض).
3. Or search by import number, supplier's reference, supplier, item code or name, branch or import stage. Rows with something in transit come first.
4. Read the row: the **In transit** quantity is highlighted when it is not zero, with the transit warehouses holding it under it; **On hand** lists the real warehouses holding the received goods.
5. Click the import to open its page, the item to open the item, a warehouse to open the warehouse.

### How to read the transit warehouses table — In-Transit Inventory
1. The second table, **Transit warehouses — the ledger's balance** (مخازن العبور — رصيد الدفتر), shows the stock ledger's own balance for each transit or stage warehouse and item, with **Available** always 0.
2. Under it a line compares that balance with the import rows above: "Every unit in a transit warehouse is accounted for by an import above." or "Stock in transit warehouses that no import's posted invoice put there — reported, not repaired:" followed by each item's **Ledger** (الدفتر), **Imports** (الاستيرادات) and **Difference** (الفرق).
3. A difference is information, not an error the screen repairs: it appears for goods of ordinary (non-import) invoices standing in the stage warehouses (they are followed in the section below), for old balances, or for goods moved into a transit warehouse by hand.
4. If this table is empty while the import rows above show quantities in transit, rely on the import rows and tell your administrator.

### How to move a non-import invoice's goods to the next stage — In-Transit Inventory
The section **Invoice Status Tracking — invoices that are not imports** (تتبع حالة الفواتير — فواتير ليست استيرادًا) lists purchase invoices whose goods were received into the In Process warehouse. An invoice enters it by itself when it is posted; imports never appear here (they are followed container by container).
1. Find the invoice. To narrow the list choose **Status** (الحالة): **All** (الكل), **In Process** (قيد التجهيز), **On Board** (على الباخرة), **At Port** (في الميناء), **In Bounded** (في المخزن الجمركي), and press **Search** (بحث).
2. At the end of the row press the button for the next stage: **Move to On Board** (نقل إلى على الباخرة), then **Move to At Port** (نقل إلى في الميناء).
3. For the last stage first choose, in the box beside the button, the real warehouse the goods are going into, then press **Move to In Bounded** (نقل إلى في المخزن الجمركي).
4. Each press moves all of that invoice's goods from the warehouse of the present stage to the warehouse of the next one, at the cost they already carry, and the column **Where the goods are** (موقع البضاعة) changes. After In Bounded the row has no button: the goods are ordinary stock and can be sold.
5. Stages are taken one at a time, forward only.

### How to choose who is notified when a status changes — In-Transit Inventory
1. At the foot of Invoice Status Tracking, under **Notify these users when a status changes** (إشعار هؤلاء المستخدمين عند تغيّر الحالة), tick the users who should be told. The list is per branch.
2. Press **Save** (حفظ). From then on every opened or moved shipment of the branch sends each of them a notification naming the invoice and the warehouse the goods are in (or moved from and to).

### How to print or export Invoice Status Tracking — In-Transit Inventory
1. Press **Print / Export** (طباعة / تصدير) at the top of the page (shown to people who may see Invoice Status Tracking and print or export it).
2. Choose the language and the format: PDF, Excel (.xlsx) or Word (.docx). The report "Invoice Status Tracking" (تتبع حالة الفواتير) follows the status filter in force.

### Fields — In-Transit Inventory
First table, by import and item (read-only):
- **Import application** (طلب الاستيراد) — with its posted invoice numbers under it.
- **Supplier** (المورّد); **Item** (الصنف) — with its base unit. All quantities are in the item's base unit.
- **Ordered** (المطلوب) — what the posted invoices bought.
- **In containers** (في الحاويات) — what the live containers plan to carry.
- **In transit** (قيد النقل) — what is still in transit warehouses; **Value (IQD)** (القيمة (د.ع)) — its value at invoice cost.
- **Received** (المستلَم) — what container receipts moved into real warehouses.
- **On hand** (في اليد) — what of that is still there.
- **Containers (open / total)** (الحاويات (مفتوحة / الكل)) — containers carrying this item not yet received / all.
- **Customs (PDs)** — the import's standing PDs with their statuses; **Declaration** (البيان الجمركي) — the status of its furthest-advanced customs declaration.
Second table (read-only): **Warehouse** (المخزن), **Stage** (المرحلة — On Process (Without SWIFT), In Process, On Board, At Port, or In transit), **Branch** (الفرع), **Item**, **In transit (ledger)** (قيد النقل (الدفتر)), **Available** (المتاح — always 0), **Value (IQD)**.
Invoice Status Tracking: **Reference** (المرجع — the purchase invoice number), **Invoice Date** (تاريخ الفاتورة), **Supplier Code** (رمز المورّد), **Supplier Name** (اسم المورّد), **Amount** (المبلغ — in IQD), **Where the goods are** (موقع البضاعة — the warehouse), **Status** (الحالة). The warehouse box for In Bounded lists the active main warehouses and is required.

### After you save — In-Transit Inventory
- The first two tables save nothing; they are read from the stock ledger each time.
- **Move to …** is a stock transfer: the invoice's own goods are issued from the present stage's warehouse and received into the next one on the same step, keeping their cost, supplier and age. Nothing is revalued and no payable changes.
- The four statuses in order: **In Process** (قيد التجهيز) → **On Board** (على الباخرة) → **At Port** (في الميناء) → **In Bounded** (في المخزن الجمركي). In the first three the goods are owned but not available; at In Bounded they are in the chosen real warehouse and available.
- Each move is written in the audit log and notifies the chosen users.
- An invoice that is reversed disappears from the list.

### Refusals — In-Transit Inventory
- "A shipment goes from in_process to on_board, one stage at a time. Goods do not un-ship." — the page was out of date; reload and press the button now shown.
- "These goods have arrived. A shipment ends when it is in bounded." — nothing more to move.
- "Choose the warehouse these goods are going into. In bounded is the stage where they stop being a shipment and start being stock somebody can pick." — pick the warehouse beside the button.
- "No warehouse is set up for on_board. Mark one on the Warehouses screen before moving a shipment into it." — no warehouse is marked for that stage; ask whoever maintains warehouses to mark one.
- "No warehouse '…'." — the chosen warehouse no longer exists.
- "Purchase invoice … is an import, followed on its bills of lading and containers. Move its containers on the import instead." — use Bills of Lading and Containers.
- "Purchase invoice … was reversed, so this shipment carries nothing. There is no stage to move it to."
- "No shipment '…'." — the row no longer exists; reload.

## Shipment Tracking (تتبع الشحنات)
Path: Logistics → In Transit → Shipment Tracking   |   Arabic: اللوجستيات ← قيد النقل ← تتبع الشحنات
Address: /logistics/shipment-tracking
Needs: `view` on `shipment_container`.
What it is for: a read-only board of every container on the way, the soonest ETA first — the stage it is at and since when, how late it is against its ETA, where customs stands, and what it is waiting for next. The actions themselves are done on the container's own page.

### How to read and filter the board — Shipment Tracking
1. Open Logistics → In Transit → Shipment Tracking.
2. Choose a **View** (العرض) and press **Show**: **Open** (مفتوح) — not yet received and not cancelled (the default); **Late** (متأخرة); **At port** (في الميناء); **Customs cleared** (مخلَّصة جمركيًا); **All** (الكل — also received and cancelled containers).
3. Or search by container number, B/L number, vessel, import number, supplier, status, port or warehouse.
4. Read **Next** (التالي) to see what each container waits for, then click the container number to open it and do that step.

### What the Next column tells you to do — Shipment Tracking
- **Load and sail** (التحميل والإبحار) — the container is Not loaded: when it sails, change its stage to On the sea.
- **Await arrival** (انتظار الوصول) — it is On the sea.
- **Chase the line — ETA passed** (مراجعة الخط — تجاوز الوصول المتوقع) — it is Late: ask the shipping line, then correct the ETA or move the stage on.
- **Clear customs** (التخليص الجمركي) — it is At port.
- **Send the port file** (إرسال ملف الميناء) — it is Customs cleared and the port file date is not recorded yet.
- **Receive into the warehouse** (الاستلام في المخزن) — it is Customs cleared and the port file was sent: the warehouse receives it.
- **Claim the shortage** (المطالبة بالنقص) — it was received Missing / damaged.
- "—" — nothing is left to do (received whole, or cancelled).

### Fields — Shipment Tracking
Columns (all read-only): **Container no.** (with its size/type and planned quantity); **B/L no.** (with the vessel); **Import application**; **Supplier**; **Port of discharge** (ميناء التفريغ); **Status** (the container's stage, or Cancelled); **Stage since** (منذ — the date of the present stage); **ETA**; **Delay** (التأخر — "N days late" متأخرة N يومًا in red, **On time** في الوقت, or "—" once received); **Customs (PDs)** (the import's PDs with their statuses, and under them the status of its customs declaration); **Customs cleared** (التخليص الجمركي — the date); **Port file** (ملف الميناء — the date it was sent); **Last update** (آخر تحديث — the date of the latest stage row, with its note); **Next** (التالي).

### After you save — Shipment Tracking
Nothing is saved on this screen. It changes as containers are added to B/Ls, move through their stages, get new ETAs and are received. A container becomes **Late** by itself, at the daily check, when its ETA passes while it is still Not loaded or On the sea.

### Refusals — Shipment Tracking
None of its own. **Not available to you** means you lack access to Shipment Tracking.

## Landed Costs (التكاليف الواصلة)
Path: Logistics → Landed Costs → Landed Costs   |   Arabic: اللوجستيات ← الكلفة الواصلة ← التكاليف الواصلة
Address: /logistics/landed-costs
Needs: `view` on `landed_cost_register`.
What it is for: a read-only register of every import that has a cost charged to it or a container received: its charges, whether its landed cost is locked and — if not — why, and what the goods finally cost. The lock itself is done on the import's page, which every row opens.

### How to read and filter the register — Landed Costs
1. Open Logistics → Landed Costs → Landed Costs. Imports with charges still waiting for a lock come first.
2. Choose a **View** (العرض) and press **Show**: **All** (الكل) — the default; **Ready to lock** (جاهز للقفل); **Waiting** (بالانتظار — waiting for PDs, for containers, or locked with late charges waiting); **Locked** (مقفل — at least one lock exists).
3. Or search by import number, supplier's reference, supplier, import stage or branch.
4. Read the **Lock** (القفل) column to see where each import stands (see the next block).
5. Click the import number: the import's page opens at its **Landed cost** (الكلفة الواصلة) section, where a person with the right permission adds charges and presses **Lock landed cost** (إقفال الكلفة الواصلة).

### What the Lock column means — Landed Costs
- **Nothing to lock** (لا شيء يُقفل) — no charge is waiting and nothing was locked yet.
- **Waiting: PDs not written off** (بانتظار شطب البيانات المسبقة) — charges are waiting, but not every PD of the import is Totally written off. Update the PDs.
- **Waiting: containers not all in** (بانتظار وصول كل الحاويات) — the PDs are done, but a container has not been received yet. Receive the containers.
- **Ready to lock** (جاهز للقفل) — every PD is Totally written off and every container is received: lock it on the import's page.
- **Locked** (مقفل) — locked, and no later charge is waiting.
- **Locked — late charges waiting** (مقفل — مصاريف متأخرة بالانتظار) — a charge arrived after the lock; allocate it on the import's page.
The column **Allocation** (التوزيع) says the same in one word: **Not allocated** (غير موزَّع), **Partly allocated** (موزَّع جزئيًا), **Allocated** (موزَّع).

### How to open a record — Landed Costs
1. Click the import's number in the **Import** column. The import's landed cost opens on a sheet of its own (address /logistics/landed-costs/<import number>; since 2026-10-06): header — **Import** (link), **Supplier** (link), **Branch**, **Amount (IQD)** (the charges), **State** (chip: Not locked / Locked / charges waiting), **Locks** (count), and the last lock's **Date** and **Journal**; the charges as the lines (Type, Source, Amount, State, Note); then the allocation preview, the final item cost, the locks, and the buttons **Add charge** (إضافة عبء), **Lock** / **Allocate late charges**, **Withdraw** — exactly as on the import application's Landed cost section, and they return to this sheet.
2. The title bar carries the four icons: print (the Final Cost), attachments (the freight, clearance and port bills, kept under the import's landed cost), notes, history (every charge added or withdrawn and every lock).

### Fields — Landed Costs
Columns (all read-only):
- **Import application** (طلب الاستيراد) — with the supplier's reference; **Supplier**.
- **Charges (IQD)** (المصاريف (د.ع)) — all live charges of the import other than the purchase itself, with their count under the amount; **Not locked** (غير مقفل) and **Locked** (مقفل) — the same split by state.
- **Lock** (القفل) and **Allocation** (التوزيع) — see the block above.
- **Customs (PDs)** — the import's standing PDs with their statuses.
- **Containers (received / total)**.
- **Into stock** (إلى المخزون) — how much of the locked charges went into the cost of stock still on hand at the lock; **Cost of sales** (كلفة المبيعات) — how much went to goods that had already left.
- **Received** (المستلَم) and **On hand** (في اليد) — quantities from the container receipts.
- **Final value (IQD)** (القيمة النهائية (د.ع)) — the received goods valued at their present unit cost: the invoice price plus every locked charge.
- **Last lock** (آخر قفل) — its date, with the journal it posted (click to open).

### After you save — Landed Costs
Nothing is saved on this screen. On the import's page, locking spreads the waiting charges over the goods the containers brought in: what is still on hand takes its share into its unit cost, what has already left takes it to cost of sales, and a journal is posted. This register and Cost Allocation then show the result.

### Refusals — Landed Costs
None of its own. On the import's page the lock answers, for example, "…'s landed cost is locked once every PD is totally written off (§20.1, condition 3)." or "…'s landed cost is locked once every container is received: it is spread over what the receipts brought in, and a container still to come would get no share of it." — this register's Lock column tells you which of the two is missing.

## Cost Allocation (توزيع الكلفة)
Path: Logistics → Landed Costs → Cost Allocation   |   Arabic: اللوجستيات ← الكلفة الواصلة ← توزيع الكلفة
Address: /logistics/cost-allocation
Needs: `view` on `cost_allocation`.
What it is for: a read-only trace of every landed-cost lock: which import, how much, on what basis, which stock layers it re-priced, how much went into stock and how much to cost of sales, and the journal that posted it.

### How to trace a lock — Cost Allocation
1. Open Logistics → Landed Costs → Cost Allocation.
2. The first table, **Locks** (الأقفال), lists every lock, newest first. Click **Lock N** (القفل N) to show only that lock's rows in the second table.
3. The second table, **Layer adjustments** (تعديلات الطبقات), has one row for each stock layer a lock touched. Search it by import number, supplier, item, warehouse, journal number, basis or lock date.
4. Click the import to open its Landed cost section, the journal number to open the journal, the item or the warehouse to open them.
5. To see all locks' rows again, reopen the screen from the menu.

### Fields — Cost Allocation
Locks table (read-only): **Lock** (القفل — its number within the import, with its note); **Date** (التاريخ); **Import application**; **Supplier**; **Basis** (الأساس — **By value** حسب القيمة, **By quantity** حسب الكمية, **By weight** حسب الوزن, **By volume** حسب الحجم or **Manual** يدوي); **Total (IQD)** (الإجمالي (د.ع)); **Into stock** (إلى المخزون); **Cost of sales** (كلفة المبيعات); **Journal** (القيد); **Layers** (الطبقات — how many layers it touched); **Charges** (المصاريف — how many charges it took in); **By** (بواسطة — who locked).
Layer adjustments table (read-only): **Lock** (with its date); **Import application**; **Item** (الصنف); **Warehouse** (المخزن); **Layer** (الطبقة — its date and sequence); **Layer qty (now left)** (كمية الطبقة (المتبقي الآن)) — the layer's original quantity and, in brackets, what is left of it now; **On hand at lock** (في اليد عند القفل); **Unit cost before** (كلفة الوحدة قبل) and **Unit cost after** (كلفة الوحدة بعد) the lock; **Unit cost now** (كلفة الوحدة الآن) — differs from "after" when a later lock re-priced the layer again; **Allocated (IQD)** (الموزَّع (د.ع)) — the charge share given to this layer; **Into stock**; **Cost of sales**; **Via** (عبر) — "followed a transfer from <warehouse>" when the stock had been moved before the lock; **Journal**.
The note at the top says: "What left a layer before the lock is shown as its cost-of-sales share; the departure records themselves arrive with the Inventory module."

### After you save — Cost Allocation
Nothing is saved on this screen. A lock and its rows appear here the moment the landed cost is locked on the import's page.

### Refusals — Cost Allocation
None of its own. **Not available to you** means you lack access to Cost Allocation.
