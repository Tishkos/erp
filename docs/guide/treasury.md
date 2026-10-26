# Treasury & Banking — user guide

Treasury & Banking (الخزينة والبنوك) is the heading of the Accounting module (المحاسبة) that records what happens to the company's own money. The bank and cash accounts themselves are master records kept under Accounting → Master Data — Banking; the screens here work on them.
Work flows in this order: money is moved between the company's own accounts (Internal Transfers), borrowed from a bank and repaid (Bank Loans), or put into an account by hand (Manual Deposits). At the end of a period each bank account is agreed with the bank's own statement (Bank Reconciliation).
Three screens only read: Payments & Receipts (every movement of money with the document behind it), Bank and Cash Reporting (each account's opening, in, out and closing) and Cash Forecast (what the accounts hold and what is expected in and out).
Every balance on these screens is read from the general ledger in Iraqi dinars (IQD). A foreign-currency amount is turned into dinars at the rate kept on Accounting → Master Data — Financial → Currencies and Rates for the document's date; nobody types a rate on these documents, except the bank's own rate on a cross-currency transfer.

## Concepts — Treasury & Banking (الخزينة والبنوك)
Path: Accounting → Treasury & Banking   |   Arabic: المحاسبة ← الخزينة والبنوك
What it is for: the ideas the Treasury & Banking screens share — the icons on a record, approval by a second person, posting and reversal, the saved / refused banners, and the rule that a bank or cash account can never go below zero.

### The icons at the top of a record — Treasury & Banking
- **Printer** — opens **Print / Export** (طباعة / تصدير): the record as a file, in **English** or **العربية**, as **PDF**, **Excel (.xlsx)** or **Word (.docx)**. PDF needs the `print` permission on the record's object; Excel and Word need `export`. A format you may not take is not offered.
- **Paperclip** — **Attachments** (المرفقات): the files kept with the record (the bank's advice, the signed voucher, the statement file, the loan contract). To add one: open the paperclip, press **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Up to 25MB; programs and archives are refused. The number on the icon is how many files are attached.
- **Notes** — **Notes** (الملاحظات): a list of When (متى) / Who (من) / Note (ملاحظة), newest first. Type a note and press **Add note** (إضافة ملاحظة). A note is dated and signed and can never be edited or deleted.
- **Clock** — **Audit log** (سجل التدقيق): every step taken on the record, who took it and when.
Which records carry which icons: a Bank Reconciliation record and an Internal Transfer record carry all four. A Bank Loan record carries the paperclip and the clock only (it has no printed copy and no notes icon). A Manual Deposit record carries the paperclip and the clock, and also lists its audit log under the document.

### Approval by a second person — Treasury & Banking
An Internal Transfer, a Manual Deposit and a Bank Loan are each raised by one person and approved by another. The person who raised the document does not get the **Approve** (اعتماد) button, and the system refuses if they try: "… was raised by you; somebody else approves it." (transfer, deposit) or "… the person who entered a loan cannot approve it" (loan). A Super User may approve a transfer or a loan they raised themselves. Approving does not post anything; posting is a separate step with its own permission.

### Posting and reversal — Treasury & Banking
Posting writes the journal entry to the general ledger. Nothing reaches the ledger before the posting step (**Post** ترحيل on a transfer or deposit; **Record disbursement**, **Pay instalment**, **Pay commission**, **Make early settlement** on a loan; **Post adjustment** on a reconciliation). A posted document is never edited. A posted Internal Transfer is corrected with **Reverse** (عكس), which writes a mirror journal and keeps both; a corrected transfer is then raised afresh. The posting date must fall in an accounting period that is open: a transfer dated in a closed period is refused when it is raised, and any posting into a closed period is refused with "Cannot post into <period>: …".

### Saved and refused banners — Treasury & Banking
After every action the screen comes back with a banner. **Saved.** (تم الحفظ.) means the action went through. **That could not be saved.** (تعذّر الحفظ.) is followed by the reason in a sentence — the sentences are quoted under each screen's "Refusals" heading. "Permission denied: '<verb>' on '<object>' is not granted to this user." means your role lacks that permission; ask an administrator (Settings → Administration → Roles / Permissions). "Out of scope: this user has no access to branch '<code>'." means the record belongs to a branch you are not assigned to.

### A bank or cash account can never go below zero — Treasury & Banking
Rule: no posting, from any screen, may leave a bank account or a cash account holding less than nothing. The balance checked is the account's balance in the general ledger, in dinars, counting every posted and reversed journal. Both sides of a transfer are weighed together when the action is saved.
The refusal you see under **That could not be saved.** (تعذّر الحفظ.) is:
"<Account name> (<account code>) would hold -<amount> IQD, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it."
An earlier check gives a similar refusal when a transfer is raised or a payment is checked against what the account can actually pay out (its balance less money already promised to approved transfers and payments):
"<account code> holds <available> and this needs <required>. Paying anyway would either bounce at the bank or create an overdraft nobody arranged (§17)."
What to do:
1. Open Accounting → Treasury & Banking → Bank and Cash Reporting and read the account's **Closing balance** (الرصيد الختامي), or Cash Forecast → **Where the money stands** for **Available (IQD)** (المتاح).
2. If money that really arrived has not been recorded yet, record it first: a customer receipt, a Manual Deposit, a loan disbursement, or an Internal Transfer into the account — and post it.
3. Or pay from another account that holds the money (a loan instalment and an early settlement let you choose **Paid from** يُدفع من).
4. Or lower the amount.
5. Check the dates: the balance counts everything posted, so a payment cannot be posted before the receipt that funds it has been posted.
A reversal that only takes back what its original put in is allowed; a reversal that would truly overdraw the account is refused the same way.

### Foreign currency and the exchange rate — Treasury & Banking
The ledger is kept in dinars. An amount in another currency is valued at the accounting rate in force on the document's date (the latest rate dated on or before it; if every rate is later, the earliest one). If the currency has no rate at all the action is refused: "No <currency> exchange rate has been published yet, so this cannot be valued. Add one in Accounting → Master Data → Currencies and Rates." Every posting also records a US-dollar equivalent, so at least one USD rate must exist even when the document is in dinars.

## Bank Reconciliation (التسوية البنكية)
Path: Accounting → Treasury & Banking → Bank Reconciliation   |   Arabic: المحاسبة ← الخزينة والبنوك ← التسوية البنكية
Address: /treasury/bank-reconciliation  (a record: /treasury/bank-reconciliation/<statement number>)
Needs: `view` on `bank_reconciliation` to open the list and a record. `create` on `bank_statement` for New statement and Add line; `import` on `bank_statement` for Paste lines; `approve` on `bank_statement` for Close statement; `create` on `bank_reconciliation` for Start reconciliation; `edit_draft` on `bank_reconciliation` for Suggest matches; `execute` for Confirm and Match ticked items; `approve` for Post adjustment and Agree reconciliation; `reverse_cancel` for Reopen. `create` on `attachment` to attach a file; `create` on `bank_statement` to add a note.
What it is for: holding the bank's own statement beside the books, line by line, and agreeing the two balances. One record is one bank statement together with its reconciliation; the record is known by the statement's number. Only bank accounts have statements — a cash account is agreed by counting it.

### How to enter a new bank statement — Bank Reconciliation
1. Open Accounting → Treasury & Banking → Bank Reconciliation.
2. Press **New statement** (كشف جديد).
3. Choose the **Bank account** (الحساب المصرفي), type the **Period from** (الفترة من) and **Period to** (الفترة إلى), and the bank's own **Opening balance** (الرصيد الافتتاحي) and **Closing balance** (الرصيد الختامي). **Statement reference** (مرجع الكشف) is optional.
4. Press **Create statement** (إنشاء الكشف). The system gives the statement its number and opens its record with the status **Statement being entered** (الكشف قيد الإدخال).
5. Add the lines on the record — typed or pasted (see the next two tasks).

### How to open a statement record and read it — Bank Reconciliation
1. In the list, click the **Statement no.** (رقم الكشف). The reconciliation's own number is shown under it once reconciliation has started.
2. The boxes at the top show: Statement no., Status, Bank account (opens the account's profile), G/L account (opens the ledger account), Period, Statement reference, Opening balance, Closing balance, Entered by; and, once reconciliation has started, Reconciliation no. (رقم المطابقة), **Balance in the books** (الرصيد في الدفاتر), **Deposits in transit** (إيداعات في الطريق), **Unpresented payments** (مدفوعات لم تُقدَّم), **Difference** (الفرق), Prepared by (أعدّها) and Agreed by (اعتمدها). After a reopening, **Reopened (n)** shows who reopened it and why.
3. The grid **Statement lines** (سطور الكشف) lists every line: #, Booking date, Value date, Reference (with the description under it), Counterparty, Amount, and **Match** (المطابقة): Unmatched (غير مطابَق), Suggested (مقترح) or Matched (مطابَق) with the match number.
4. Under the document: **Rows that could not be read** (صفوف تعذّرت قراءتها) when a pasted file had unreadable rows; **Matches** (المطابقات); and **Still unmatched** (ما زال غير مطابَق).
5. The printer, paperclip, notes and clock icons are at the top of the record (see "The icons at the top of a record — Treasury & Banking").

### How to type a statement line — Bank Reconciliation
1. On a statement whose status is **Statement being entered**, press **Add line** (إضافة سطر).
2. Fill in **Booking date** (تاريخ القيد), choose **Direction** (الاتجاه) — **Money in** (وارد) or **Money out** (صادر) — and type the **Amount** (المبلغ) as a positive figure. **Value date** (تاريخ الاستحقاق), **Reference** (المرجع), **Counterparty** (الطرف المقابل) and **Description** (الوصف) are optional.
3. Press **Add line**. Repeat for each line of the bank's statement.

### How to paste the bank's file — Bank Reconciliation
1. On a statement whose status is **Statement being entered**, press **Paste lines** (لصق السطور).
2. Paste the bank's rows into **Statement lines** (سطور الكشف). The first row must name the columns; the columns read are: booking_date, value_date, amount_iqd, reference, counterparty, description, bank_reference. Only booking_date and amount_iqd are required. Columns are separated by commas, or by tabs when the first row contains a tab (a copy from a spreadsheet).
3. Dates are written YYYY-MM-DD. Money out is a negative amount; money in is positive. A missing value date is taken as the booking date.
4. Press **Paste lines**. Every readable row becomes a statement line. A row that cannot be read is kept, with the reason, under **Rows that could not be read** — it is not added to the statement, so type it by hand with **Add line**.
5. Pasting the same file a second time adds nothing: a line already held is recognised and skipped.

### How to close a statement — Bank Reconciliation
1. When every line is in, press **Close statement** (إغلاق الكشف).
2. The statement closes only if the opening balance plus all the lines equals the closing balance. If it does, the status becomes **Ready to reconcile** (جاهز للمطابقة) and no more lines can be added.
3. If it does not add up, the refusal says by how much it is out; find the missing or mistyped line and add it, then press **Close statement** again.

### How to reconcile: suggest and confirm matches — Bank Reconciliation
1. On a statement that is **Ready to reconcile**, press **Start reconciliation** (بدء المطابقة). The status becomes **Reconciling** (قيد المطابقة), the reconciliation gets its own number, and the boxes show the balance in the books at the period's last day and the difference.
2. Press **Suggest matches** (اقتراح المطابقات). The system pairs a statement line with a ledger entry only when the amounts are exactly equal and the dates are no more than five days apart. Each pair appears under **Matches** with **Why** (السبب) — amount, reference, counterparty, days apart — and a confidence percentage. Nothing is agreed yet: the state is **Suggested** (مقترحة).
3. Read each suggestion and press **Confirm** (تأكيد) on the ones that are right. Your name goes on the match and its state becomes **Confirmed** (مؤكدة); the statement line shows **Matched**.

### How to match by hand — Bank Reconciliation
1. In **Still unmatched**, tick the bank's line(s) — rows named **Bank line** (سطر المصرف) — and the ledger item(s) that are the same money — rows named **Deposit in transit** (إيداع في الطريق) or **Unpresented payment** (دفعة لم تُقدَّم), each with its journal number, which opens the journal.
2. Press **Match ticked items** (مطابقة المحدَّد). One bank line may be matched to several ledger items and the other way round, as long as the two sides total exactly the same.
3. The match is recorded as **Confirmed** with the reason "Matched by hand".

### How to post an adjustment for a bank fee, interest or a returned payment — Bank Reconciliation
1. A line on the bank's statement that the books never recorded cannot be matched; it has to be recorded. While the status is **Reconciling**, press **Post adjustment** (ترحيل تسوية).
2. Choose the **Statement line** (سطر الكشف), the **Other account** (الحساب المقابل) — the expense, income or other ledger account the line belongs to (control accounts are not offered) — and, if the account needs one, the **Department** (القسم). Type the **Description** (الوصف) — it is required.
3. Press **Post adjustment**. A journal is posted, dated the line's booking date, and the statement line is matched to it at once; the match shows **Adjustment** (تسوية).

### How to agree (finalise) a reconciliation — Bank Reconciliation
1. Work until **Difference** is zero, every statement line is **Matched**, and no match is still **Suggested**.
2. Press **Agree reconciliation** (اعتماد المطابقة). The status becomes **Reconciled** (مطابَق); your name is recorded as Agreed by, and the statement can no longer be changed.
3. Ledger items left under **Still unmatched** are not errors: they are deposits in transit and unpresented payments — entries the books have and the bank has not shown yet — and they are the explanation of the difference between the two balances.

### How to reopen an agreed reconciliation — Bank Reconciliation
1. On a **Reconciled** record, type the **Reason for reopening** (سبب إعادة الفتح) and press **Reopen** (إعادة الفتح).
2. The status goes back to **Reconciling**. Every match returns to **Suggested** and must be confirmed again with **Confirm**, and the reconciliation must balance again before **Agree reconciliation**.
3. The record shows **Reopened (n)** with who reopened it and the reason; each reopening is counted and kept in the audit log.

### How to search and filter the list — Bank Reconciliation
1. Type in the search box and press **Search** (بحث): it looks in the statement number, the reconciliation number, the account code and name, and the statement reference. **Clear** (مسح) removes the search.
2. **View** (العرض): **All statements** (كل الكشوف), **Not yet reconciled** (غير مطابَقة بعد) or **Reconciled** (مطابَقة). **Bank account**: **Any account** (أي حساب) or one account. Press **Filter** (تصفية).
3. Columns: Statement no., Bank account, Period, Closing balance, **Unmatched / lines** (غير المطابَق / السطور), Difference, Status. Fifty rows to a page, newest period first.

### Fields — Bank Reconciliation
New statement (كشف جديد):
- **Bank account** (الحساب المصرفي) — required. Only active bank accounts are offered, shown as name (code) · currency. The statement takes the account's currency.
- **Statement reference** (مرجع الكشف) — optional; the bank's own reference for the statement.
- **Period from** (الفترة من) / **Period to** (الفترة إلى) — required dates. The statement number is taken from the year of Period to, and the balance in the books is read at Period to.
- **Opening balance** (الرصيد الافتتاحي) — required; as the bank states it. May be negative.
- **Closing balance** (الرصيد الختامي) — required; as the bank states it. The statement closes only when the lines add up to it.
Add line (إضافة سطر):
- **Booking date** (تاريخ القيد) — required; defaults to the first day of the period.
- **Value date** (تاريخ الاستحقاق) — optional; left empty it is the booking date. It may not be before the booking date.
- **Direction** (الاتجاه) — required: **Money in** (وارد) or **Money out** (صادر).
- **Amount** (المبلغ) — required, positive, up to four decimal places; commas and spaces are ignored. Zero is refused.
- **Reference** (المرجع), **Counterparty** (الطرف المقابل), **Description** (الوصف) — optional; reference and counterparty are what the suggested matching compares with the ledger entry.
Paste lines (لصق السطور):
- **Statement lines** (سطور الكشف) — required; the pasted text, first row naming the columns (see "How to paste the bank's file").
Post adjustment (ترحيل تسوية):
- **Statement line** (سطر الكشف) — required; one of the lines not yet matched.
- **Other account** (الحساب المقابل) — required; a posting account that is not a control account.
- **Department** (القسم) — optional; an active department.
- **Description** (الوصف) — required; what the difference actually was.
Reopen (إعادة الفتح):
- **Reason for reopening** (سبب إعادة الفتح) — required.
Figures on the record:
- **Balance in the books** (الرصيد في الدفاتر) — the ledger balance of the account's G/L account at the period's last day.
- **Deposits in transit** (إيداعات في الطريق) — unmatched ledger entries that put money in.
- **Unpresented payments** (مدفوعات لم تُقدَّم) — unmatched ledger entries that took money out.
- **Difference** (الفرق) — closing balance + deposits in transit − unpresented payments − balance in the books. It must be zero to agree the reconciliation.
- **Days** (الأيام) in Still unmatched — how old the ledger item is at the period's last day.

### After you save — Bank Reconciliation
Statuses, in order: **Statement being entered** (الكشف قيد الإدخال) → **Ready to reconcile** (جاهز للمطابقة) after Close statement → **Reconciling** (قيد المطابقة) after Start reconciliation → **Reconciled** (مطابَق) after Agree reconciliation. Reopen takes a Reconciled record back to Reconciling.
Entering a statement, adding lines, closing it, suggesting, confirming and matching post nothing to the ledger. Only **Post adjustment** posts a journal, dated the statement line's booking date: for money in, the bank's G/L account is debited and the other account credited; for money out, the other account is debited and the bank's G/L account credited. The journal can be opened from the match.
The statement's number and the reconciliation's number are given by the system from their numbering series.

### Refusals — Bank Reconciliation
- ""<text>" is not an amount." — the figure typed is not a number with at most four decimals. Retype it; a line's amount is typed positive and the direction chosen separately.
- "Statement line <n>: the amount is zero. …" — a line of nothing is not a transaction; leave it out.
- "Statement line <n>: the value date (<date>) is before the booking date (<date>). …" — correct the dates; the value date cannot be earlier.
- "The pasted statement has no "booking_date" column. Its first row names the columns." (or "amount_iqd") — add a first row with the column names and paste again.
- Under Rows that could not be read: "booking_date is not a date (YYYY-MM-DD).", "amount_iqd is not an amount.", "value_date is not a date (YYYY-MM-DD)." — fix the row and type it with Add line.
- "The statement opens at <opening>, closes at <closing>, and its lines move <movement> — which is <difference> out. A statement that does not add up is a statement with a line missing, …" — on Close statement. Find the missing or wrong line. The screen has no way to remove a line once added, so check each line before adding it.
- "Statement <no> has not been closed. …" — press Close statement before Start reconciliation.
- "A match needs at least one line on each side. …" — tick at least one bank line and at least one ledger item.
- "The statement side of this match totals <x> and the ledger side totals <y>. … If the difference is a bank charge or a fee, post it as an adjustment and match that too" — the ticked items are not equal; tick the right items, or post the fee as an adjustment.
- "An adjustment needs a description (§17). …" — type what the line was.
- "<reconciliation no> still has <n> statement line(s) neither matched nor adjusted (§17). …" — on Agree reconciliation. Match or adjust every bank line.
- "The reconciliation is out by <amount> and §17 will not let it be finalised. Either the difference is a real item — a bank charge, interest, a returned payment — in which case post the adjustment and match it, or something is missing, …" — the difference is not zero; there is no override.
- "<reconciliation no> has <n> suggested match(es) nobody has confirmed (§17). …" — press Confirm on each suggested match (or match those lines by hand) first.
- "Reopening a finalised reconciliation needs a reason (§17, §5.4). …" — type the reason.
- "Reconciliation <no> is '<status>': …" — the action does not fit the record's status (for example matching after it was agreed); reopen it first if a correction is needed.
- An adjustment that takes money out can also meet the rule "… would hold … IQD, and a bank or cash account cannot hold less than nothing. …" — see "A bank or cash account can never go below zero — Treasury & Banking".

## Internal Transfers (التحويلات الداخلية)
Path: Accounting → Treasury & Banking → Internal Transfers   |   Arabic: المحاسبة ← الخزينة والبنوك ← التحويلات الداخلية
Address: /treasury/transfers  (a record: /treasury/transfers/<transfer number>)
Needs: `view` on `bank_cash_account` to open the list and a record; `create` on `bank_cash_account` for New transfer; `approve` on `bank_cash_account` for Approve (and you must not be the person who raised it, unless you are a Super User); `post` on `bank_cash_account` for Post; `post` on `bank_cash_account` together with `reverse_cancel` on `journal_entry` for Reverse. `create` on `attachment` to attach a file; `create` on `bank_cash_account` to add a note.
What it is for: moving the company's own money between its own accounts — bank to bank, bank to cash, cash to bank, cash to cash — including between two currencies. One person raises the transfer, another approves it, then it is posted.

### How to raise a transfer — Internal Transfers
1. Open Accounting → Treasury & Banking → Internal Transfers and press **New transfer** (تحويل جديد).
2. Choose **From account** (من الحساب) and **To account** (إلى الحساب). Only active bank and cash accounts are offered, shown as name (code) · currency.
3. Check the **Transfer date** (تاريخ التحويل) — today by default — and type the **Amount sent** (المبلغ المرسل) in the source account's currency.
4. If the two accounts are in different currencies, also type the **Amount received** (المبلغ المستلم) or the **Exchange rate** (سعر الصرف), or both (see "How to transfer between two currencies").
5. Optionally type the **Bank reference** (المرجع المصرفي) and the **Purpose** (الغرض).
6. Press **Create transfer** (إنشاء التحويل). The system gives it a number and opens its record with the status **Draft** (مسودة). Pressing the button twice does not create two transfers.

### How to transfer between two currencies — Internal Transfers
1. Raise the transfer as usual; **Amount sent** is in the source account's currency.
2. State what the bank gave: type **Amount received** (in the destination's currency), or the **Exchange rate**, or both. When one account is in dinars the rate is dinars per one unit of the other currency. If only the two amounts are typed, the rate is worked out from them; if only the rate is typed, the amount received is worked out from it.
3. If both are typed they must agree; otherwise the transfer is refused and tells you what the rate gives.
4. On posting, each side is valued in dinars at the ledger's own rate for the transfer date (from Currencies and Rates). What the bank's rate gave beyond or short of that is posted as **Exchange gain** (ربح صرف) or **Exchange loss** (خسارة صرف); the record's journal lines show it before posting.

### How to approve a transfer — Internal Transfers
1. Somebody other than the person who raised it opens the transfer from the list (click the **Transfer no.** رقم التحويل).
2. Check the accounts, the date and the amounts, and the journal lines at the foot.
3. Press **Approve** (اعتماد). The status becomes **Approved** (معتمد). From now until it is posted, the amount is counted as promised and is taken off the source account's available balance.

### How to post a transfer — Internal Transfers
1. Open an **Approved** transfer and press **Post** (ترحيل).
2. The journal is posted, dated the transfer date, and the status becomes **Posted** (مرحّل). The **Journal** (القيد) box now shows the journal number, which opens the journal.

### How to reverse a posted transfer — Internal Transfers
1. Open the **Posted** transfer. Type the **Reason for reversing** (سبب العكس) and press **Reverse** (عكس).
2. A mirror journal is posted, dated today (today's accounting period must accept postings). The status becomes **Reversed** (معكوس); the record shows **Reversal journal** (قيد العكس) and **Reversed because** (سبب العكس).
3. The transfer keeps every figure it had. If the money should still move, raise a new, correct transfer.

### How to open a record, search and filter — Internal Transfers
1. In the list, click the **Transfer no.** to open the record. The boxes show: Transfer no., Status, Transfer date, From account and To account (each opens the account's profile), Amount sent, Amount received, Exchange rate (between two currencies), Bank reference, Journal, Reversal journal, Raised by (أنشأه), Approved by (اعتمده), Posted by (رحّله), Purpose, Reversed because.
2. The grid **Journal** (القيد) shows the lines the transfer makes: the destination account debited, the source account credited, each with its G/L account, the amount **In its currency** (بعملته), and **Debit (IQD)** / **Credit (IQD)**; between two currencies a third line shows the exchange gain or loss. When the currency has no rate yet the dinar columns show "—".
3. Search box: looks in the transfer number, both accounts' codes and names, the bank reference and the purpose.
4. **View** (العرض): **All transfers** (كل التحويلات), **Not yet posted** (غير مرحّلة بعد — Draft and Approved), **Posted** (مرحّلة), **Reversed** (معكوسة). **Account**: **Any account** (أي حساب) or one account (as source or destination). Press **Filter** (تصفية).
5. List columns: Transfer no., Transfer date, From account, To account, Amount sent, Amount received, Status. Fifty rows to a page, newest first.

### Fields — Internal Transfers
- **From account** (من الحساب) — required; an active bank or cash account. The money must be there: the amount is checked against the account's balance less what is already promised.
- **To account** (إلى الحساب) — required; a different active bank or cash account. A cash account with a cash limit may not be taken above it.
- **Transfer date** (تاريخ التحويل) — required; today by default. It is the journal's date and may not fall in a closed period.
- **Amount sent** (المبلغ المرسل) — required, more than zero, in the source account's currency; up to four decimals, commas and spaces ignored.
- **Amount received** (المبلغ المستلم) — only between two currencies; in the destination's currency. Between accounts of the same currency it is the amount sent.
- **Exchange rate** (سعر الصرف) — only between two currencies; dinars per unit of the other currency; left empty it is read off the two amounts. Typing a rate when both accounts share a currency is refused.
- **Bank reference** (المرجع المصرفي) — optional; the bank's reference for the movement.
- **Purpose** (الغرض) — optional free text, shown on the record.
- **Reason for reversing** (سبب العكس) — required when reversing.

### After you save — Internal Transfers
Statuses: **Draft** (مسودة) → **Approved** (معتمد), by somebody other than the raiser → **Posted** (مرحّل) → possibly **Reversed** (معكوس).
Draft and Approved post nothing. An approved transfer holds its amount against the source account's available balance.
Posting writes one journal dated the transfer date: debit the destination account's G/L account, credit the source account's G/L account, both in dinars at the ledger rate of that date; between two currencies the difference is credited to exchange gain or debited to exchange loss.
Reversing writes the mirror of that journal and links the two. The screen has no edit, cancel or delete for a transfer: check a draft carefully before it is approved.

### Refusals — Internal Transfers
- "The money is already in that account. Choose a different destination." — From and To are the same account.
- "<code> is inactive. Reactivate it under Master Data, or choose another account." — reactivate the account on Master Data — Banking, or choose another.
- "State the amount that leaves the source account; it must be more than nothing." — type the amount sent.
- ""<text>" is not an amount." — retype the figure: digits, at most four decimals.
- "<period> is closed; a transfer cannot be dated in it." — choose a date in an open period.
- "<A> is held in <currency> and <B> in <currency>. §17 allows the transfer through an approved FX conversion, and the rate is part of the approval — state it, …" — between two currencies, type the amount received or the exchange rate.
- "<A> and <B> are both held in <currency>, so there is no conversion to rate." — clear the Exchange rate box.
- "At <rate>, <currency> <sent> is <currency> <x>, not <y>. Correct the rate or the amount received." — the rate and the amount received disagree; correct one, or clear one.
- "A rate is more than nothing." — the rate typed is zero.
- "<code> holds <available> and this needs <required>. Paying anyway would either bounce at the bank or create an overdraft nobody arranged (§17)." — the source account does not hold enough after its other promises. See "A bank or cash account can never go below zero — Treasury & Banking".
- "<code> would hold <amount>, above its cash limit of <limit> (§17). … bank the excess, or have the limit raised." — the receiving cash account has a cash limit; transfer less, or raise the limit on Master Data — Banking → Cash Accounts.
- "<transfer no> was raised by you; somebody else approves it." — another user with the approve permission must approve.
- "A reversal says why the transfer was wrong; give a reason." — type the reason.
- "No <currency> exchange rate has been published yet, so this cannot be valued. Add one in Accounting → Master Data → Currencies and Rates." — add the rate, then try again.
- "No accounting mapping is configured for the 'exchange_gain' line of 'treasury.bank_transfer' …" (or 'exchange_loss') — the exchange gain/loss account is not mapped; set it on Accounting → General Ledger → Posting Mappings, then post again.
- "<Account name> (<code>) would hold -<amount> IQD, and a bank or cash account cannot hold less than nothing. …" — at posting or reversal; see "A bank or cash account can never go below zero — Treasury & Banking".
- "Cannot post into <period>: …" / "Journal <no> has already been reversed." — the period of the posting (or of today, for a reversal) is not open, or the journal was already reversed.

## Bank Loans (القروض المصرفية)
Path: Accounting → Treasury & Banking → Bank Loans   |   Arabic: المحاسبة ← الخزينة والبنوك ← القروض المصرفية
Address: /treasury/loans  (new loan: /treasury/loans/new; a record: /treasury/loans/<loan number>)
Needs: `view` on `bank_loan` to open the list and a record; `create` on `bank_loan` for New loan and Send for approval; `edit_draft` on `bank_loan` for Edit schedule, for attaching files and for cancelling a draft; `approve` on `bank_loan` for Approve, Return to draft and Save shares; `post` on `bank_loan` for Record disbursement, Pay instalment, Pay commission and Make early settlement; `reverse_cancel` on `bank_loan` to cancel an approved loan.
What it is for: the register of every bank loan — what the bank lends, what it costs, when it is repaid, what is still owed and which imports it funded. A loan is entered from the bank's letter, approved by a second person, drawn down when the money arrives, and repaid instalment by instalment or settled early.

### How to enter a new loan — Bank Loans
1. Open Accounting → Treasury & Banking → Bank Loans and press **New loan** (قرض جديد). A full page opens.
2. Choose the **Bank** (البنك). If it is not in the list, choose **Another bank — I will type its name** (مصرف آخر — سأكتب اسمه) and type the **Bank name** (اسم المصرف) and, if known, **SWIFT / BIC**; the bank is added to the Banks register together with the loan.
3. Type the **Loan / facility reference** (رقم القرض / التسهيل), choose **Proceeds land in** (حساب إيداع المبلغ) — the bank account the money will arrive in — and the **Loan currency** (عملة القرض).
4. Type the **Principal** (أصل القرض). The **Proceeds** (صافي المبلغ) line shows at once what **Lands in the account**, what is **Owed to the bank** and the **Commission kept**.
5. Fill in the commission: **Commission stated as** (طريقة احتساب العمولة) and its figure, and **Commission taken** (طريقة استيفاء العمولة).
6. Fill in the interest: **Interest % a year** (الفائدة % سنويًا), **Interest type**, and **Interest calculated**.
7. Fill in the repayment: **Principal repayment** (طريقة سداد الأصل), **Instalments** (عدد الأقساط), **Repaid** (السداد) and **First instalment due** (استحقاق القسط الأول); and a **Grace period** (فترة السماح) if the bank gives one.
8. Press **Update schedule** (تحديث الجدول) to see the **Repayment schedule** (جدول السداد) worked out from these terms: one row per instalment with due date, principal, interest and total, and a totals row.
9. Choose the **Purpose** (الغرض) and leave or clear the tick **Capitalise the commission into the imports the loan funds** (رسملة العمولة على الاستيرادات التي يمولها القرض).
10. Press **Create loan** (إنشاء القرض). The loan gets its number and opens as a **Draft** (مسودة).
11. On the record, check the schedule against the bank's letter. What is saved is the schedule worked out from the terms; the first instalment's interest can differ from the preview. Correct any row with **Edit schedule** (see the next task) before sending the loan for approval. Choose a regular rhythm (monthly, quarterly, semi-annually, annually) on this page; irregular dates are typed afterwards with **Edit schedule**.

### How to edit the schedule of a draft loan — Bank Loans
1. Open the loan while its status is **Draft** and press **Edit schedule** (تعديل الجدول).
2. Each row is one instalment: **Due date** (تاريخ الاستحقاق), **Principal**, **Interest** and **Commission** (the commission column is for a commission spread over the instalments). Retype what the bank's letter says.
3. The principal of all rows must total exactly the loan's principal (shown as **Principal total** إجمالي الأصل), and due dates must run forward.
4. Press **Save the schedule** (حفظ الجدول). Once the loan is sent on and approved, the schedule is fixed.

### How to send a loan for approval, approve it or return it — Bank Loans
1. The person who entered it opens the draft and presses **Send for approval** (إرسال للموافقة). The status becomes **Pending approval** (بانتظار الموافقة). The loan is checked first: it must have a principal, a complete schedule whose rows match the number of instalments, forward-running dates, a schedule that repays the principal exactly, an active currency and an open account.
2. A second person opens it and presses **Approve** (موافقة). The status becomes **Approved** (موافق عليه). A draft may also be approved directly, without sending, by somebody other than the person who entered it.
3. If the loan's value in dinars is above the receiving account's approval limit — or the account has no limit set — only a user holding the CEO role (or a Super User) can approve it.
4. To send it back instead, the approver types **What should be changed** (ما الذي يجب تعديله) and presses **Return to draft** (إعادة إلى المسودة). Nothing has been posted; the accountant corrects it and sends it again.

### How to record the drawdown (disbursement) — Bank Loans
1. When the bank has sent the money, open the **Approved** loan and press **Record disbursement** (تسجيل الصرف).
2. Type the **Date received** (تاريخ الاستلام) — today by default — and the **Bank reference** (مرجع البنك) of the credit; both are required. The note in the window says how much the account receives and what the loan liability is.
3. Press **Record disbursement**. The journal is posted and the status becomes **Disbursed** (تم الصرف). From now the loan can fund payment applications and be repaid.

### How to pay an instalment — Bank Loans
1. Open a **Disbursed** loan and press **Pay instalment** (دفع قسط).
2. Choose the **Instalment** (القسط) — the earliest unpaid one is offered first; instalments are repaid in order.
3. Choose **Paid from** (يُدفع من): the loan's own account by default, or any other active bank or cash account that holds the money.
4. Type the **Date paid** (تاريخ الدفع) and the **Bank reference** (required) and press **Pay instalment**.
5. The journal is posted dated the day paid; the row in the schedule shows **Paid** (مدفوع) with the date and reference, and the payment appears in the list under **Loan summary**. When the principal outstanding reaches nothing and no instalment still asks for money, the loan becomes **Fully repaid** (مسدد بالكامل) by itself.

### How to settle a loan early, in full or in part — Bank Loans
1. Open a **Disbursed** loan and press **Make early settlement** (سداد مبكر).
2. Choose **Paid from** and the **Paid on** date (تاريخ الدفع).
3. **Principal paid** (الأصل المدفوع) is filled with the whole principal outstanding. Leave it to settle the loan; type less to pay only part.
4. **Interest accrued** (الفوائد المستحقة) is filled with the interest since the last payment (or since the disbursement), counted by days over 365 on the principal outstanding; retype it if the bank asks for a different figure. Type the bank's **Early settlement fee** (رسم السداد المبكر) if it charges one, and the **Bank reference** (required). The window shows the **Settlement total** (إجمالي السداد) as you type.
5. Press **Make early settlement**.
6. Paying all of the principal outstanding marks every remaining instalment paid and the loan becomes **Fully repaid**. Paying part keeps the loan **Disbursed**: the unpaid instalments keep their due dates and are worked out again on the smaller balance, and the payment is listed as **Extra principal** (دفعة إضافية). An instalment already past its due date must be paid as an instalment first.

### How to pay a commission the bank charges separately — Bank Loans
1. The button **Pay commission** (دفع العمولة) appears only when the loan's commission is taken as **Paid separately** (تُدفع منفصلة), is more than zero, has not been paid yet, and the loan is Approved or Disbursed.
2. Press it, type the **Date paid** and the **Bank reference** (both required) and press **Pay commission**.
3. The commission is posted out of the loan's own bank account, and the record shows **Commission paid** (دفع العمولة) with the date and reference.

### How a loan is allocated to imports — Bank Loans
1. A loan is drawn on from Transfers & Applications → Payment Applications: a payment application names the loan that funds it. The loan must be in the application's currency, the application must be paid from the account the loan's money landed in, and the loan must have enough **Left to fund** (المتاح للتمويل).
2. When the payment application is approved, its amount is drawn on the loan. The loan must be **Disbursed** by then; otherwise the approval is refused and asks you to record the disbursement first.
3. On the loan record, **What it funded** (ما موّله القرض) lists each draw: the payment application (opens it) with its status, the import (opens it), **Drawn** (المسحوب), **Commission share** (حصة العمولة) and **State** (الحالة) — **Drawn** (مسحوب) or **Released** (مُعاد) with the reason. The heading shows the total drawn and what is left to fund.
4. Each draw carries a share of the loan's commission: commission × amount drawn ÷ principal (**By amount used** حسب المبلغ المستخدم — the method every loan entered on the New loan page has). When the commission is capitalised, that share is added to the import's landed cost as a bank-commission charge; otherwise it is expensed.
5. If the payment application is rejected or cancelled, its draw is released back to the loan and its commission share is withdrawn from the import.
6. **Save shares** (حفظ الحصص) is offered only on a loan whose **Commission shared** (توزيع العمولة) is **As typed** (كما يُكتب): the shares are typed per draw and may not total more than the commission.

### How to cancel a loan — Bank Loans
1. A **Draft** or an **Approved** loan (money not yet arrived) can be cancelled: type **Why it is cancelled** (سبب الإلغاء) and press **Cancel loan** (إلغاء القرض). A loan that is **Pending approval** is first returned to draft.
2. A loan whose money has arrived cannot be cancelled — it is repaid. A loan whose separate commission has been paid, or that a live payment application names, cannot be cancelled either.

### How to open a loan record and read it — Bank Loans
1. In the list, click the **Loan no.** (رقم القرض).
2. Boxes: Loan no., Status, Bank, Proceeds land in (opens the bank account), Principal, Commission (percentage · amount · how it is taken), **Net proceeds** (صافي المبلغ المستلم), **Commission booked** (قيد العمولة — Capitalised into the funded imports / Expensed), Interest % a year, **Commission shared**, Repaid (rhythm · number of instalments), **Maturity** (تاريخ الاستحقاق النهائي), **Disbursed** (date · reference, or Not yet), Commission paid, Entered by, Approved by, and the cancellation reason if any.
3. Grid **Repayment schedule**: #, Due date, Principal, Commission, Interest, Total, Status — **Upcoming** (قادم), **Due** (مستحق — due within the warning window, seven days unless changed), **Overdue** (متأخر — past its due date and unpaid), **Paid** (مدفوع) — and when and with which reference it was paid. An instalment inside a grace period that asks for nothing stays Upcoming.
4. Foot of the window: **Outstanding** (المتبقي), **Repaid** (المسدد), **Left to fund** (المتاح للتمويل).
5. **What it funded** — see "How a loan is allocated to imports".
6. **Loan summary** (ملخص القرض): Original principal, Principal repaid, Outstanding principal, Interest paid, Fees paid, Total paid, Repaid on, Instalments left; and the list of every payment made — Paid on, Kind (**Instalment** قسط, **Extra principal** دفعة إضافية, **Early settlement** سداد مبكر), Principal, Interest, Fees, Total, Bank reference.
7. The paperclip (**Contract, schedule, bank letters** العقد، الجدول، كتب البنك) and the clock (audit log) are at the top of the record. There is no printer and no notes icon on a loan.

### How to search and filter the list — Bank Loans
1. Search box: looks in the loan number, the bank's name, the account code, the currency, the status and the principal.
2. **View** (العرض): **All loans** (كل القروض — the default, repaid and cancelled ones included), **Open** (المفتوحة — Draft, Pending approval, Approved, Disbursed), **Overdue** (المتأخرة — disbursed loans with an unpaid instalment past its due date), **Repaid or cancelled** (المسددة أو الملغاة). Press **Show** (عرض).
3. Columns: Loan no., Bank, Account, Principal, Outstanding, **Next due** (الاستحقاق التالي — date and amount of the next unpaid instalment, with a red **Overdue** متأخر flag), Status. Fifty rows to a page, newest first.

### Fields — Bank Loans
New loan page (قرض جديد):
- **Bank** (البنك) — required; an active bank from Master Data — Banking → Banks, or **Another bank — I will type its name**, which asks for **Bank name** (required; added to the bank register with the loan) and **SWIFT / BIC** (optional).
- **Loan / facility reference** (رقم القرض / التسهيل) — optional; the bank's own reference.
- **Proceeds land in** (حساب إيداع المبلغ) — required; an active bank account (not a cash account). The disbursement is posted into it and payments funded by the loan are paid from it.
- **Loan currency** (عملة القرض) — the currency the debt is owed in; any active currency from Currencies and Rates; defaults to the receiving account's currency. It may differ from the account's currency.
- **Principal** (أصل القرض) — required; what the bank lends, in the loan currency.
- **Proceeds** (صافي المبلغ) — shown, not typed: **Lands in the account** (يصل إلى الحساب), **Owed to the bank** (المستحق للمصرف), **Commission kept** (العمولة المحتجزة). When the loan currency differs from the account's, **Expected proceeds** (المبلغ المتوقع) shows the rate of the expected disbursement day and the converted amount.
- **Expected disbursement** (تاريخ الصرف المتوقع) — the day the bank says it will send the money; today by default. The Cash Forecast shows the drawdown on this day.
- **Commission stated as** (طريقة احتساب العمولة) — **A percentage of the principal** (نسبة من الأصل; then **Commission %** نسبة العمولة %, default 0), **A fixed amount** (مبلغ ثابت; then **Commission amount** مبلغ العمولة), or **No commission** (بلا عمولة). The commission must be less than the principal.
- **Commission taken** (طريقة استيفاء العمولة) — **Deducted at disbursement** (تُخصم عند الصرف — the bank keeps it out of the money it sends, so less lands in the account), **Paid separately** (تُدفع منفصلة — paid later with Pay commission), or **Spread over instalments** (موزعة على الأقساط — an equal share rides on each instalment).
- **Other bank fees** (رسوم مصرفية أخرى) — optional amount, kept on the loan as information.
- **Interest % a year** (الفائدة % سنويًا) — optional; empty means the loan carries no interest.
- **Interest type** (نوع الفائدة) — **Fixed** (ثابتة) or **Variable** (متغيرة). Variable requires **Reference rate** (المعدل المرجعي, e.g. SOFR); **Spread %** (الهامش %) is optional.
- **Interest calculated** (احتساب الفائدة) — **On the reducing balance** (على الرصيد المتناقص — on what is still owed, by days over 365) or **Flat on the original principal** (ثابتة على أصل القرض — on the whole principal for the whole term, split equally).
- **Principal repayment** (طريقة سداد الأصل) — **Equal principal** (أقساط أصل متساوية), **Equal instalments** (أقساط متساوية — the same total each time), **Bullet — all at the end** (دفعة واحدة في النهاية), or **Custom schedule** (جدول خاص — laid out as equal principal, to be retyped with Edit schedule).
- **Instalments** (عدد الأقساط) — required, at least 1; default 4.
- **Repaid** (السداد) — **Monthly** (شهريًا), **Quarterly** (كل ثلاثة أشهر, the default), **Semi-annually** (نصف سنوي), **Annually** (سنوي), **On dates I type** (في تواريخ أحددها).
- **First instalment due** (استحقاق القسط الأول) — required date; the later due dates follow the rhythm.
- **Grace period** (فترة السماح) — **None** (لا توجد), **Principal only** (الأصل فقط — instalments inside the grace carry no principal), **Interest only** (الفائدة فقط — their interest is carried to the first instalment after the grace), **Principal and interest** (الأصل والفائدة). **Grace period until** (فترة السماح حتى) — required when a grace period is chosen.
- **Purpose** (الغرض) — Working capital (رأس مال عامل), Import financing (تمويل استيراد, the default), Equipment purchase (شراء معدات), Project financing (تمويل مشروع), Construction (إنشاءات), General corporate purposes (أغراض عامة), Other (غير ذلك).
- **Commission treatment** (معالجة العمولة) — tick **Capitalise the commission into the imports the loan funds**; ticked by default. Ticked: the commission is carried to the cost of the imports the loan funds. Unticked: it is booked as commission expense.
Record disbursement: **Date received** (تاريخ الاستلام, required, today by default), **Bank reference** (مرجع البنك, required).
Pay instalment: **Instalment** (القسط, required), **Paid from** (يُدفع من, required, the loan's account by default), **Date paid** (تاريخ الدفع, required), **Bank reference** (required).
Pay commission: **Date paid** (required), **Bank reference** (required).
Make early settlement: **Paid from** (required), **Paid on** (required), **Principal paid** (required; default the principal outstanding; never more than it), **Interest accrued** (default the accrual; empty uses the accrual), **Early settlement fee** (optional), **Bank reference** (required).
Edit schedule: per row **Due date**, **Principal**, **Interest**, **Commission**.
Return to draft: **What should be changed** (required). Cancel loan: **Why it is cancelled** (required).

### After you save — Bank Loans
Statuses: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) after Send for approval → **Approved** (موافق عليه), by somebody other than the person who entered it → **Disbursed** (تم الصرف) after Record disbursement → **Fully repaid** (مسدد بالكامل) when nothing is left. **Cancelled** (ملغى) from Draft or Approved, with a reason. A loan pending approval can be returned to Draft.
What is posted, each in dinars at the rate of its own date:
- Entering, sending, approving, returning, cancelling: nothing.
- Record disbursement, dated the date received: debit the receiving bank account with the net amount; debit the commission (if deducted at disbursement) to the funded imports' cost or to commission expense; credit the loan liability with the whole principal.
- Pay instalment, dated the date paid: debit the loan liability with the principal; debit loan interest; debit a spread commission; credit the account paid from with the total.
- Pay commission: debit the funded imports' cost or commission expense; credit the loan's bank account.
- Make early settlement: debit the loan liability with the principal paid; debit loan interest; debit the early-settlement fee to commission expense; credit the account paid from.
Revaluation: the loan record has no revaluation button. For a loan owed in a foreign currency, the liability is taken off the books at the dinar value it was carried at, and the difference from the rate on the day of each repayment or settlement is posted with that payment as exchange gain or loss.
Each instalment paid or settlement is also written on the log of every import the loan funds.

### Refusals — Bank Loans
- "Name the bank, or choose one already in the register." / "'<code>' is not an active bank." — choose an active bank or type the new bank's name.
- "<code> is a cash account; a loan's proceeds land in a bank account." / "<code> is closed; no loan lands in it." — choose an open bank account.
- "State the principal the bank lends." — type the principal.
- "The commission is less than the principal, and never negative." — correct the commission.
- "A commission "<text>" is not a percentage." / "An interest rate of <x>% is not a loan's." — a percentage is a number below 100 with at most four decimals.
- "'<currency>' is not a currency Finance has defined. Add it on Currencies & Rates." — add or reactivate the currency first.
- "A variable rate follows a published one. Name it as the letter does." — type the Reference rate.
- "A grace period runs to a date. Say when it ends." — fill Grace period until.
- "The grace period covers every instalment: nothing would repay the principal." / "The grace period (<date>) ends before the loan starts (<date>)." — shorten or correct the grace period.
- "Give the first instalment's due date." / "A loan is repaid in at least one instalment." — fill the date and the number of instalments.
- "The first instalment (<date>) falls before the loan starts (<date>)." — on the New loan page the first due date must not be before the expected disbursement date.
- "A custom schedule names each of its <n> due dates; 0 given." — shown when **Repaid** is **On dates I type** on the New loan page, which has nowhere to type the dates. Choose a regular rhythm, create the loan, then retype the dates with Edit schedule.
- "<loan no>: the instalments repay <x> of a <y> principal — short by <z>." (or "over by") — the schedule's principal column must total the principal exactly.
- "<loan no>: due dates run forward; instalment <n> is not after <n-1>." / "<loan no>: instalment <n> repays nothing." / "… has a negative amount." — correct the row in Edit schedule.
- "<loan no> is <status>; its schedule was fixed when it was approved." — the schedule can only be edited while Draft.
- "<loan no> says <n> instalments and its schedule has <m>. Lay the schedule out again, or change the count." — on Send for approval.
- "<loan no>: the person who entered a loan cannot approve it (§5.2)." — a second person approves.
- "<loan no> is <amount> IQD, above <account>'s approval limit of <limit>; the CEO approves it." (the limit reads "nothing (no limit has been set)" when the account has none) — a user holding the CEO role or a Super User must approve, or the account's approval limit is set on Master Data — Banking.
- "Say what should be changed. A return without a reason is not an answer." — type the reason.
- "Give the date the money arrived." / "Give the bank's reference for the credit (the advice or statement line)." — on Record disbursement.
- "<loan no> is <status>; only a disbursed loan is repaid." / "… only a disbursed loan is settled." — record the disbursement first.
- "Instalment <n> of <loan no> is still unpaid; instalments are repaid in order." — pay the earlier instalment first.
- "Instalment <n> of <loan no> was paid on <date>." — it is already paid.
- "<date> is before the loan was disbursed (<date>)." — the paid date cannot be before the disbursement.
- "Give the bank's reference for the debit." / "Give the bank's reference for the settlement." — the reference is required.
- "<code> is closed; name an open account to pay <loan no> from." — choose an active account in Paid from.
- "<loan no> has <currency> <x> outstanding; <y> is more than is owed." — pay no more than the principal outstanding.
- "Instalment <n> of <loan no> was due on <date>; pay it before paying early." — pay the late instalment, then make the part-payment.
- "<loan no>'s commission is <how it is taken>; it is not paid on its own." / "<loan no>'s commission was paid on <date>." — Pay commission applies once, and only to a commission paid separately.
- "Say why <loan no> is cancelled." — type the reason.
- "<loan no> cannot become cancelled: its money has arrived — a disbursed loan is repaid, not cancelled." — repay or settle it instead.
- "<loan no>'s commission was paid on <date>; a loan already charged for is not cancelled." — it cannot be cancelled.
- "<application nos> is funded by <loan no>; cancel or re-fund them first." — cancel those payment applications or fund them otherwise, then cancel the loan.
- "<loan no> is <status>; its money has not arrived, so it funds nothing yet. Record the disbursement first." — when a payment application naming the loan is approved.
- "<loan no> is in <currency>; this payment is in <currency>." / "<loan no>'s money is in <account>; a payment it funds is paid from there." / "<loan no> has <currency> <x> left to fund; this payment is <currency> <y>." — the payment application must match the loan's currency and account and fit what is left to fund.
- "The shares total <x>, more than the <y> commission." — on Save shares.
- "No <currency> exchange rate has been published yet, …" — add the rate on Currencies and Rates.
- "No accounting mapping is configured for the '<role>' line of 'treasury.loan_disbursement' …" (or 'treasury.loan_repayment', 'treasury.loan_commission') — the ledger account for that line (loan liability, loan interest, bank commission, exchange gain or loss) is not mapped; set it on Accounting → General Ledger → Posting Mappings.
- "<Account name> (<code>) would hold -<amount> IQD, and a bank or cash account cannot hold less than nothing. …" — the account paid from does not hold the instalment or settlement; choose another account in **Paid from**, or fund it first. See "A bank or cash account can never go below zero — Treasury & Banking".

## Manual Deposits (إيداعات يدوية)
Path: Accounting → Treasury & Banking → Manual Deposits   |   Arabic: المحاسبة ← الخزينة والبنوك ← إيداعات يدوية
Address: /treasury/deposits  (a record: /treasury/deposits/<deposit number>)
Needs: `view` on `bank_cash_account` to open the list and a record. The **Cash deposit** button shows with `create` on `bank_cash_account`, and saving it also needs `create` on `other_receipt`; the **Bank deposit** button needs `create` on `other_receipt`. Approve needs `approve` on `other_receipt` and you must not be the person who raised the deposit; Post needs `post` on `other_receipt`. (For a cash-to-bank transfer listed here, approve and post are checked on `bank_cash_account`.) `create` on `attachment` to attach a file.
What it is for: money put into one of the company's accounts by hand that is not a customer paying an invoice — an owner's capital, a refund, the sale of something. A **Cash deposit** puts the money into a cash account; a **Bank deposit** puts it into a bank account; each is credited to the ledger account that says where it came from. Cash taken from a cash account to a bank account is an Internal Transfer; such transfers are also listed in this register.

### How to record a cash deposit — Manual Deposits
1. Open Accounting → Treasury & Banking → Manual Deposits and press **Cash deposit** (إيداع نقدي).
2. Choose **Into cash account** (إلى حساب نقدي) — only active cash accounts are offered.
3. Choose the **Credit account** (الحساب الدائن) — the ledger account the money came from (control accounts are not offered).
4. Type **Paid in by** (المودِع), the **Amount** (المبلغ) and the **Deposit date** (تاريخ الإيداع, today by default). **Reference** (المرجع) and **Note** (ملاحظة) are optional.
5. Press **Create deposit** (إنشاء الإيداع). The deposit gets its number and opens as a **Draft**.

### How to record a bank deposit — Manual Deposits
1. Press **Bank deposit** (إيداع مصرفي).
2. Choose **Into bank account** (إلى الحساب المصرفي) — only active bank accounts are offered — and the **Credit account** (الحساب الدائن).
3. Type **Paid in by**, the **Amount** and the **Deposit date**. **Bank reference** (المرجع المصرفي) and **Note** are optional.
4. Press **Create deposit**. The deposit opens as a **Draft**.

### How to approve and post a deposit — Manual Deposits
1. Somebody other than the person who raised it opens the deposit (click the **Deposit no.** رقم الإيداع) and presses **Approve** (اعتماد). The status becomes **Approved** (معتمد).
2. A user with the post permission presses **Post** (ترحيل). The journal is posted, dated the deposit date, and the status becomes **Posted** (مرحّل); the **Journal** (القيد) box shows the journal number, which opens the journal.
3. To keep the bank's slip with the deposit, open the paperclip at the top of the record, **Choose a file**, **Attach**.

### How to open a record, search and filter — Manual Deposits
1. Click the **Deposit no.** in the list. The record shows: Deposit no., Status, Deposit date, Source, the account it went into with its currency, From (who paid it in), Credit account, Bank reference, Journal, Note; one line with the amount; then the audit log.
2. Search box: looks in the deposit number, the receiving account's code and name, the credit account's code and name, who paid it in, and the reference.
3. **View** (العرض): **All deposits** (كل الإيداعات), **Not yet posted** (غير مرحّلة بعد), **Posted** (مرحّلة). Press **Filter** (تصفية).
4. Columns: Deposit no., Deposit date, the account it went into, Source (المصدر), From (من), Amount, Status. Fifty rows to a page, newest first.

### Fields — Manual Deposits
- **Into cash account** (إلى حساب نقدي) / **Into bank account** (إلى الحساب المصرفي) — required; the active cash account (cash deposit) or bank account (bank deposit) that receives the money. Its G/L account is debited on posting.
- **Credit account** (الحساب الدائن) — required; a posting account from the Chart of Accounts that is not a control account (a customer's money is a Customer Receipt; a supplier's refund goes through the supplier's account). It is credited on posting.
- **Paid in by** (المودِع) — required; who handed the money over.
- **Amount** (المبلغ) — required, more than zero, up to four decimals; commas and spaces are ignored. The figure is posted to the ledger as typed, in dinars; this screen makes no currency conversion.
- **Deposit date** (تاريخ الإيداع) — required; today by default; it is the journal's date.
- **Reference** (المرجع) on a cash deposit / **Bank reference** (المرجع المصرفي) on a bank deposit — optional; the slip or the bank's reference.
- **Note** (ملاحظة) — optional.

### After you save — Manual Deposits
Statuses: **Draft** (مسودة) → **Approved** (معتمد), by somebody other than the raiser → **Posted** (مرحّل). The list's "Not yet posted" view shows Draft and Approved.
Draft and Approved post nothing. **Post** writes one journal dated the deposit date: debit the G/L account of the cash or bank account that received the money, credit the Credit account. If the receiving account is a cash account with a cash limit, the posting is refused when it would take the cash above the limit.
The record offers only Approve and Post; it has no edit, cancel or reverse button.

### Refusals — Manual Deposits
- "State the amount deposited." — the amount is empty, zero or not a number.
- "A cash deposit goes into a cash account; choose one." / "A deposit goes into a bank account; choose one." — the account chosen is not of the right kind, or is no longer active.
- "A receipt needs to say who paid it in (§17). …" — fill **Paid in by**.
- "<code> is closed, so nothing can be received into it." — choose an active account.
- "<code> is the control account for the <customer / supplier / …> subledger, and an Other Receipt cannot credit one (§16). Money from a customer is a Customer Receipt, which allocates to their invoices; money from a supplier refund belongs on their account through a credit memo. …" — choose another credit account, or use the right document.
- "<deposit no> was raised by you; somebody else approves it." — a second person approves.
- "Other receipt <no> is '<status>': a receipt posts once it has been approved." — approve it first.
- "<code> would hold <amount>, above its cash limit of <limit> (§17). … bank the excess, or have the limit raised." — on posting into a cash account; bank the excess with an Internal Transfer, or raise the limit on Master Data — Banking → Cash Accounts.
- "Permission denied: 'create' on 'other_receipt' is not granted to this user." — you can see the Cash deposit button but your role cannot create the deposit; ask for the permission.
- "Cannot post into <period>: …" — the deposit date is in a period that is not open.

## Expense Payments (مدفوعات المصاريف)
Path: Accounting → Treasury & Banking → Expense Payments   |   Arabic: المحاسبة ← الخزينة والبنوك ← مدفوعات المصاريف
Address: /treasury/expense-payments (list) · /treasury/expense-payments/new · /treasury/expense-payments/<payment number> (EXV-…)
Needs: `view` on `expense_payment` to open; `create` to write one; `approve` and `post` to approve and post it; `edit_draft` to cancel a draft; `reverse_cancel` to reverse a posted one; `print` / `export` for copies. Whoever keeps Manual Deposits or Supplier Payments keeps Expense Payments.
What it is for: A general expense paid straight from a bank or cash account with no supplier invoice — rent, fuel, a courier, a government fee. The mirror of a Manual Deposit: the money leaves an account and is charged to the expense account named. A customer is paid by a Customer Payment, a supplier by a Supplier Payment.

### How to pay an expense — Expense Payments
1. Open Accounting → Treasury & Banking → Expense Payments and press **New expense payment** (دفع مصروف جديد).
2. Type **Paid to** (المستفيد) — who was paid — and pick the **Expense account** (حساب المصروف); expense accounts are listed first, and control accounts are never offered.
3. Pick the **Bank/Cash account** the money leaves (its name shows its currency) and check the **Date**.
4. Type the **Amount** (المبلغ) in that account's currency and **What it is for** (الغرض). Optionally the **Department** (القسم) — needed when the expense account asks for one —, the **Payment method**, a **Reference** and a **Note**.
5. Press **Create** (إنشاء). It gets its number (EXV-…) and opens as a **Draft**.

### How to approve and post an expense payment — Expense Payments
1. Somebody other than whoever wrote it opens the draft and presses **Approve and post** (اعتماد وترحيل). A super user may approve their own.
2. Status: **Posted**. The money has left the account and the expense is in the ledger.

### Fields — Expense Payments
- **Paid to** (المستفيد) — required; free text.
- **Expense account** (حساب المصروف) — required; an approved posting account that is not a control account.
- **Bank/Cash account** — required; the payment is in that account's currency. **In dinars** (بالدينار) is worked out at the date's rate and fixed when it posts.
- **Amount** (المبلغ) — required, above zero. **What it is for** (الغرض) — required. **Department**, **Payment method**, **Reference**, **Note** — optional.
- **How it posts** (كيف تُرحَّل): Debit the expense account / Credit the account it leaves.

### After you save — Expense Payments
- **Draft** → **Approved** → **Posted** → **Reversed**; a draft or approved one can be **Cancelled** with a reason. Never deleted.
- On posting: Debit the expense account (with its department) / Credit the bank or cash account's ledger account, in that account's currency. It is listed on Payments & Receipts as "Expense payment".
- **Reverse** (عكس), with a reason, mirrors the journal today.

### Refusals — Expense Payments
- "<code> is the control account for the <kind> subledger, and an Expense Payment cannot debit one. …" — choose an expense account.
- "<number> was written by you; somebody else approves it."
- "Say who was paid …" / "Say what the expense is for." / "Say why the payment is cancelled." / "Say why the payment is reversed."
- "There is no USD rate for <date> …" — enter the day's rate under Currencies and Rates first.
- A bank account below zero refuses the payment (the bank rule C-20): fund it first.

## Payments & Receipts (المدفوعات والمقبوضات)
Path: Accounting → Treasury & Banking → Payments & Receipts   |   Arabic: المحاسبة ← الخزينة والبنوك ← المدفوعات والمقبوضات
Address: /treasury/payments-receipts
Needs: `view` on `bank_account`. The Print / Export menu needs `print` (PDF) or `export` (Excel, Word) on `bank_account`.
What it is for: a read-only register of every movement of money on every bank and cash account, each with the document that moved it. Nothing is paid or received here: customer receipts are made in Receivables, supplier payments in Payables, transfers and deposits in Treasury; this screen shows what their postings did to the money.

### How to read the register — Payments & Receipts
1. Open Accounting → Treasury & Banking → Payments & Receipts. It opens on this year, from 1 January to today.
2. Each row is one posted line on a bank or cash account: **Date** (التاريخ), **Document** (المستند — the document's number, which opens its record; under it the journal number, which opens the journal, and the kind of document), **Account** (الحساب — opens the bank or cash account), **Party** (الطرف — the customer or supplier, opening their profile, or the line's description when there is no party), **Movement** (الحركة), **In (IQD)** (وارد) and **Out (IQD)** (صادر).
3. **Movement** is **Receipt** (قبض) for money in, **Payment** (دفع) for money out, **Transfer in** (تحويل وارد) or **Transfer out** (تحويل صادر) for the two halves of an Internal Transfer; a line that is the mirror of a reversed movement also says **Reversal** (عكس).
4. Amounts are in dinars, as the ledger holds them; when the line was entered in another currency, that amount is shown under the dinar figure.
5. The **Totals** (المجاميع) row sums money in and money out over everything the filters chose, across all pages — not only the fifty rows shown.
6. The kinds of document named: Customer receipt, Supplier payment, Supplier advance, Internal transfer, Manual deposit, Bank loan, Payroll, Expense claim, Employee advance, Cash advance, Reconciliation adjustment.

### How to filter, search and export — Payments & Receipts
1. **From** (من) and **To** (إلى) — the posting dates to show.
2. **View** (العرض): **All movements** (كل الحركات), **Money in** (الوارد — transfers left out), **Money out** (الصادر — transfers left out), **Between own accounts** (بين حسابات الشركة — transfers only).
3. **Account** (الحساب): **Any account** (أي حساب) or one bank or cash account. Press **Filter** (تصفية).
4. Search box: looks in the journal number, the description, the account code and name, the party's code and name, and the document number.
5. **Print / Export** (طباعة / تصدير) at the top gives the register, with the filters as set, in English or Arabic as PDF, Excel or Word.

### Fields — Payments & Receipts
This screen has no form; its only inputs are the filters:
- **From** (من) — start date; default 1 January of the current year.
- **To** (إلى) — end date; default today.
- **View** (العرض) — which movements; default all.
- **Account** (الحساب) — one account or any; default any.

### After you save — Payments & Receipts
Nothing is saved on this screen. It reads posted (and reversed) journals only: a draft or approved document that has not been posted does not appear. Its totals in and out are the same lines Bank and Cash Reporting adds up as money in/out plus transfers in/out.

### Refusals — Payments & Receipts
- **Not available to you** (غير متاح لك) — "You do not have permission to open this screen." — shown instead of the register — your role lacks `view` on `bank_account`.
- **No money moved in this period.** (لم تتحرك أموال في هذه الفترة.) — not a refusal: nothing was posted on a bank or cash account between the two dates with the chosen filters; widen the dates or clear the filters.

## Bank and Cash Reporting (تقرير البنوك والنقد)
Path: Accounting → Treasury & Banking → Bank and Cash Reporting   |   Arabic: المحاسبة ← الخزينة والبنوك ← تقرير البنوك والنقد
Address: /treasury/reporting
Needs: `view` on `bank_account`. The Print / Export menu needs `print` (PDF) or `export` (Excel, Word) on `bank_account`.
What it is for: a read-only report of every active bank and cash account — what it opened the period with, what came in, what went out, what was only moved between the company's own accounts, and what it closes at. The closing balance is the ledger balance of the account's G/L account; it is not stored or typed anywhere.

### How to read the report — Bank and Cash Reporting
1. Open Accounting → Treasury & Banking → Bank and Cash Reporting. It opens on this year, from 1 January to today.
2. One row per account: **Account** (الحساب — name and code), **Type** (النوع — **Bank** بنك or **Cash** نقد), **Currency** (العملة), **Opening balance** (الرصيد الافتتاحي — the balance on the day before From), **Money in** (الوارد) and **Money out** (الصادر — real money entering or leaving the company in the period), **Transfers in** (تحويلات واردة) and **Transfers out** (تحويلات صادرة — Internal Transfers between the company's own accounts, kept apart so they are not mistaken for income or spending), **Closing balance** (الرصيد الختامي — opening plus everything in the period) and **Last movement** (آخر حركة — the last day anything moved, at any time).
3. All figures are in dinars, as the ledger holds them. The **Totals** (الإجماليات) row adds the accounts shown.
4. An account marked **No G/L account** (بلا حساب أستاذ) has no ledger account behind it and cannot post; re-link it on Master Data — Banking.

### How to see one account's transactions — Bank and Cash Reporting
1. Click the account's name in the table (or choose it in the **Account** picker and press **Show**).
2. A second table, **Transactions — <account>** (الحركات), opens underneath, oldest first: **Date**, **Reference** (the journal number — click it to open the journal), **Movement** (**Receipt** مقبوض, **Payment** مدفوع, **Transfer in**, **Transfer out**, or **Journal** قيد for anything else), **Customer / Supplier** (العميل / المورّد), **Description**, **Raised by** (أدخله), **Approved by** (اعتمدها — empty when the approval was given on the document rather than on the journal), **Money in**, **Money out** and the running **Balance** (الرصيد).
3. The first row is the opening balance on the From date; the last row gives the totals in and out and the closing balance.

### How to filter and export — Bank and Cash Reporting
1. **From** (من) and **To** (إلى) — the period.
2. **Type** (النوع): **Bank and cash** (البنوك والنقد), **Bank** or **Cash**.
3. **Account** (الحساب): type part of the name or code to find one account.
4. Press **Show** (عرض).
5. **Print / Export** (طباعة / تصدير) gives the report, with the filters as set, in English or Arabic as PDF, Excel or Word.

### Fields — Bank and Cash Reporting
This screen has no form; its only inputs are the filters:
- **From** (من) — default 1 January of the current year. The opening balance is measured on the day before it.
- **To** (إلى) — default today. The closing balance is the ledger balance on this day.
- **Type** (النوع) — bank, cash or both; default both.
- **Account** (الحساب) — one account; choosing one also opens its transactions.

### After you save — Bank and Cash Reporting
Nothing is saved on this screen. It reads posted (and reversed) journals on the G/L account each bank or cash account is linked to. Only active accounts are listed. A document that is still a draft or only approved has not moved any money here yet.

### Refusals — Bank and Cash Reporting
- **Not available to you** (غير متاح لك) — "You do not have permission to open this screen." — shown instead of the report — your role lacks `view` on `bank_account`.
- **No bank or cash accounts are set up yet.** (لا توجد حسابات بنكية أو نقدية بعد.) — not a refusal: create the accounts on Accounting → Master Data — Banking → Bank Accounts / Cash Accounts, or clear the filters.
- **Nothing moved in this account over this period.** (لم تتحرك أي مبالغ في هذا الحساب خلال هذه الفترة.) — the account has no posted movement between the two dates.

## Cash Forecast (توقعات التدفقات النقدية)
Path: Accounting → Treasury & Banking → Cash Forecast   |   Arabic: المحاسبة ← الخزينة والبنوك ← توقعات التدفقات النقدية
Address: /treasury/cash-forecast
Needs: `view` on `bank_cash_account`. The Print / Export menu needs `print` (PDF) or `export` (Excel, Word) on `bank_cash_account`.
What it is for: a read-only report of what the accounts hold now and what is expected to come in and go out from here, read from the open documents — nothing is stored, so it is always current.

### How to read the forecast — Cash Forecast
1. Open Accounting → Treasury & Banking → Cash Forecast. It opens from today to ninety days ahead, grouped by week.
2. **Forecast by period** (التوقعات حسب الفترة): one row per period with **Opening** (الافتتاحي), **Coming in** (الوارد), **Going out** (الصادر) and **Closing** (الختامي). The first opening is the real balance of all bank and cash accounts on the day before From; each period opens where the last one closed. The foot shows the opening and the closing of the whole range. Periods in which nothing is expected are not listed.
3. **Where the money stands** (موقف الأموال), as at the day before From: one row per **Currency** (العملة) with the number of **Accounts** (الحسابات), their **Balance (IQD)** (الرصيد) and **Available (IQD)** (المتاح). Available is the balance less money already promised: approved transfers not yet posted, approved payment batches not yet sent, and payment applications approved or sent to the bank and not yet confirmed. Currencies are listed apart, not added into one figure.
4. **Forecast by source** (التوقعات حسب المصدر): the same periods split by **Source** (المصدر), with Coming in, Going out and **Net** (الصافي).
5. **What the forecast draws on** (ما تعتمد عليه التوقعات): each source and whether it is **Included** (مشمول) or **Not read yet** (لم يُقرأ بعد), so a zero is never mistaken for "nothing is due".

### What each source is — Cash Forecast
- **Supplier invoices due** (فواتير مورّدين مستحقة) — open supplier invoices, on their due dates (money out). Included.
- **Customer invoices due** (فواتير عملاء مستحقة) — open customer invoices, on their due dates (money in). Included.
- **Payroll** (الرواتب) — approved and posted payroll runs still to be paid, on their pay date; totals only. Included.
- **Capital calls** (طلبات رأس المال) — unmet capital calls, on their due date. Included.
- **Loan instalments** (أقساط القروض) — bank-loan instalments still to be paid, on their due date; an instalment inside a grace period that asks for nothing is left out. Included.
- **Loan drawdowns** (سحوبات القروض) — approved loans on their expected disbursement date, at the net amount that will arrive. Included.
- **Project commitments** (التزامات المشاريع) and **Transfer funding** (تمويل التحويلات) — shown as **Not read yet**: the forecast does not include them.
A paid document is no longer in the forecast: its money is already in the balance.

### How to change the range and export — Cash Forecast
1. Set **From** (من) and **To** (إلى) and choose **Group by** (التجميع حسب): **Day** (اليوم), **Week** (الأسبوع) or **Month** (الشهر).
2. Press **Run** (عرض). The closing balance at the end of the range is the same whichever grouping is chosen.
3. **Print / Export** (طباعة / تصدير) gives the forecast, with the range as set, in English or Arabic as PDF, Excel or Word.

### Fields — Cash Forecast
This screen has no form; its only inputs are the filters:
- **From** (من) — required; default today.
- **To** (إلى) — required; default ninety days after From.
- **Group by** (التجميع حسب) — Day, Week or Month; default Week.

### After you save — Cash Forecast
Nothing is saved on this screen. The balances come from the general ledger; the expected movements come from documents that are open on the day the report is run. Run it again after posting or paying to see the change.

### Refusals — Cash Forecast
- **Not available to you** (غير متاح لك) — "You do not have permission to open this screen." — shown instead of the report — your role lacks `view` on `bank_cash_account`.
- **Nothing expected in this period.** (لا شيء متوقع في هذه الفترة.) — not a refusal: no open document falls due between the two dates.
- **No active bank or cash accounts.** (لا حسابات مصرفية أو نقدية فعّالة.) — create or reactivate the accounts on Accounting → Master Data — Banking.
