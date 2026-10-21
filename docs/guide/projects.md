# Projects — user guide

The Projects module (المشاريع) runs a project from its first contact to its close. Work flows in this order: **Project Initiation** takes a customer project — a direct sale or a tender — through its stages to the signed contract, where it becomes a project by itself; **Project Master** defines a project and releases it (and is where an internal or investment project is created directly); **WBS** breaks it into elements, activities and milestones and schedules them; **Cost Plan** and **Budgets** say what it should cost and how much may be spent; **Change Orders** move the contract value, the budget and the finish date after release.
While the work runs, purchases assigned to an element show on **Procurement** and **Project Costs**, stock is taken to an element on **Material Issues**, and **Progress** measures the work, the milestones and the hours.
**Billing** raises certificates to the customer and recognises revenue; **Forecast** shows the cost at completion; **Close** settles and closes the project; **Reports** prints the four project reports.
Project types, tolerance profiles, cost codes and the revenue-recognition method are kept in **Settings → Administration → Project Settings**.

## Concepts — Projects
Ideas every Projects screen shares: the project's statuses, its elements and cost codes, the four amounts, availability control, the two-person rule, the icons on a record, and how a purchase reaches a project. Each is a block of its own below; the screen blocks refer to them by name.

### Project statuses — Concepts — Projects
A project carries one status, shown as a coloured chip:
- **Created** (منشأ) — the draft. The definition and the baseline can still be edited; elements, activities, the cost plan and budget documents can be prepared. Nothing can be spent, issued, measured or billed yet.
- **Released** (مُطلق) — the working status. Purchases can be committed, costs posted, stock issued, progress measured, milestones reached, hours booked and certificates raised. The baseline is fixed from here on.
- **On hold** (موقوف مؤقتاً) — spending stops: no commitment, cost or material issue is accepted. The structure, the plan, budget documents, change orders and progress measurements can still be worked on.
- **Technically complete** (مكتمل فنياً) — the work is done. No commitment, cost line, material issue or new certificate is accepted: a cost is only ever taken on a Released project, so the last supplier invoices and the month's labour must be posted before this step. What still works: measuring progress, approving a draft certificate, running revenue recognition, the settlement and the close. The structure and the cost plan are fixed.
- **Closed** (مقفل) — final. Nothing more is posted and the record cannot be edited.

The moves between them (buttons on the project record, see Project Master):
1. **Release** (إطلاق): Created → Released. Needs the approve permission, by somebody other than the person who created the project.
2. **Put on hold** (إيقاف مؤقت): Released → On hold, with a reason. **Resume** (استئناف): On hold → Released, with a reason. Both need the submit permission.
3. **Technically complete** (إكمال فني): Released → Technically complete. Needs the approve permission; refused while any activity or milestone is still open.
4. **Reopen** (إعادة فتح): Technically complete → Released, once only, with a reason; never after the settlement is posted. Needs the approve permission.
5. **Close project** (إقفال المشروع): Technically complete → Closed, when every check on the Close screen is clear. Needs the approve permission.

### Elements, indicators and cost codes — Concepts — Projects
- A project is broken into **elements** (the work breakdown structure, WBS). The top element is the project itself; its code is the project code followed by `-1`. Children are numbered under their parent: `…-1.1`, `…-1.2`, `…-1.2.1`, to five levels at most. This numbering is the **coding mask**.
- Each element carries three switches that say what it may receive (column **May receive** — يستقبل):
  - **Planning element** (عنصر تخطيط), shown as *plan*: cost-plan lines and budget lines may be typed on it.
  - **Account-assignment element** (عنصر تعيين حسابي), shown as *costs*: purchases, costs, material issues and hours may be posted to it. An element without it refuses every posting.
  - **Billing element** (عنصر فوترة), shown as *billing*: billing-plan lines hang on it. Customer projects only.
- A **cost code** says what kind of cost it is. The delivered codes are MAT Materials (مواد), LAB Labour (عمالة), SUB Subcontract (مقاولة فرعية), EQP Equipment (معدات), OVH Overheads (مصاريف عامة), FEE Fees and permits (رسوم وتراخيص). They are kept in Project Settings. Every budget line, plan line, cost and commitment names an element and a cost code.
- A project **type** (Project Settings) has a kind: **customer** (billed to a customer; has a contract, a billing plan and revenue recognition), **internal** (cost only) or **investment** (its cost is settled to an asset under construction at the close).
- All amounts in Projects are in Iraqi dinar (IQD).

### Budget, committed, actual, available — Concepts — Projects
Four amounts appear on almost every Projects screen. They are worked out afresh each time a screen opens; nothing is stored, so they are never out of date.
- **Budget** (الموازنة) — what the element may spend. Once the original budget document is approved it is the sum of the approved budget documents (original + supplements − returns ± transfers). Before any budget document, the project's baseline budget sits on the top element.
- **Committed** (الملتزم به) — money promised but not yet spent: the open part of approved purchase orders and payables assigned to the element. It falls as invoices are posted against it, or when the order or payable is cancelled.
- **Actual** (الفعلي) — what has been spent: posted supplier invoices for services, material issues less returns, and posted labour.
- **Available** (المتاح) — Budget − Committed − Actual.
On a tree, a parent's row shows its own figures plus all its children's (rolled up); the top element is the whole project.
The budget by cost code (project record) adds **Forecast** (التوقع), the expected final figure for the code; it is not part of Available.

### Availability control (warning and stop lines) — Concepts — Projects
Every commitment, cost, material issue and month of labour that names an element is checked against the element's budget before it is accepted.
- The check uses the project's **tolerance profile** (ملف التسامح), which has two lines in percent of the budget. The delivered profile STANDARD warns at 90 % and stops at 100 %.
- The figure checked is (Committed + Actual + the new amount) ÷ Budget of the element. If the element itself carries no budget, the nearest parent that does is checked instead, with everything under it.
- **Warning line** (خط التحذير): when a posting first takes the element to or over the warning line, the element's responsible person and the project manager each get a notification (once per element per day). The posting is accepted.
- **Stop line** (خط الإيقاف): a posting that would take the element over the stop line is refused with "…the stop line of 100 % is reached…". A dinar over the line is over it. An element with no budget anywhere above it refuses every posting.
- The same stop percentage is then applied to the **cost code** across the whole project: the cost code must have a budget line on the project and room on it.
- Ways out of a stop: approve a supplement or a transfer on Budgets, approve a change order, or raise the stop line for that one element with a reason (WBS → Edit → Raise the stop line).
- The **Availability** (التوفر) column shows where an element stands: **Within budget** (ضمن الموازنة), **Warning line reached** (بلغ خط التحذير), **Stop line reached** (بلغ خط الإيقاف).

### Two people on every approval — Concepts — Projects
Projects documents are raised by one person and approved by another. The person who raised it is told "…somebody else approves it" or simply does not see the button.
- Releasing a project — not by the person who created it.
- Budget document — approved or rejected by somebody other than the person who raised it.
- Change order — two approvals (commercial and budget), neither by the person who raised it. One other person may give both.
- Progress measurement — approved by somebody other than the person who measured. This holds for a Super User too.
- Milestone reached — approved by somebody other than the person who reported it. This holds for a Super User too.
- Hours — approved by somebody other than the person who booked them.
- Certificate — approved (and posted) by somebody other than the person who raised it.
- Settlement — posted by somebody other than the person who drafted it.
A Super User may approve what they raised themselves on budget documents and change orders. For releasing a project, a certificate, hours and a settlement the rule also allows a Super User, but the screen does not show the button to the person who raised the record, so in practice another person presses it.

### The icons at the top of a record — Concepts — Projects
A Projects document page (budget document, change order, material issue, certificate) carries four icons in its title bar. The project record carries only the notes and the clock.
- **Printer — Print / Export** (طباعة / تصدير): opens a window with the copies on offer, in English and in العربية: **PDF**, **Excel (.xlsx)**, **Word (.docx)**. PDF needs the print permission on projects; Excel and Word need the export permission. With neither, the printer is not shown.
- **Paperclip — Attachments** (المرفقات): the files kept with the record, with who attached each and when, and the number of files on the icon. To add one: **Choose a file** (اختر ملفاً), then **Attach** (إرفاق). Up to 25MB; programs and archives are refused. Adding needs the edit-draft permission on projects and the create permission on attachments.
- **Notes** (الملاحظات): a table of When (متى), Who (من), Note (ملاحظة), newest first. Type in **Add note** (إضافة ملاحظة) and press **Add note**. A note is 1 to 2,000 characters, is dated and signed, and is never edited or deleted. Adding needs the edit-draft permission on projects.
- **Clock — Audit log** (سجل التدقيق): everything that happened to the record — who created, submitted, approved, rejected, posted or cancelled it, when, and what changed.

### How a purchase reaches a project — Concepts — Projects
Purchases are not typed in Projects; they arrive from Payables.
1. On a new purchase invoice (Payables) choose **Project element** (عنصر المشروع) and **Project cost code** (رمز تكلفة المشروع). The list offers active account-assignment elements of Created and Released projects. Project, element and cost code go together or not at all. An invoice raised against a purchase order takes the order's assignment.
2. When a purchase order assigned to an element is approved — or a payable without an order is opened — its amount in IQD becomes a **commitment** on the element. Available falls at once. This needs a Released project and passes availability control.
3. When the invoice is posted: services (and any price difference) become the project's **actual** cost and use up the commitment; only what exceeds the open commitment is checked again. Goods go into stock — they only settle the commitment, and become project cost when a Material Issue takes them to the element.
4. Cancelling the order or payable releases what is still open on the commitment. Reversing the invoice writes a negative cost line and opens the commitment again.
5. The Payables user who does these steps needs project permissions too: the post permission on projects to approve an assigned order, open an assigned payable, or post or reverse an assigned invoice; the edit-draft permission on projects to cancel an assigned order or payable. Without it the step is refused with "Permission denied: 'post' on 'project' is not granted to this user."
See Procurement for the commitments and Project Costs for the cost lines.

## Project Initiation (تأسيس المشاريع)
Projects → Projects & Planning → Leads   |   Arabic: المشاريع ← المشاريع والتخطيط ← العملاء المحتملون
Since 21 October 2026 the register of this screen is called **Leads** (العملاء المحتملون) in the menu: it lists the records at the first stage of their road. The same records past the first stage are on **Opportunities** (الفرص), and every record is a card on the **Pipeline Board** (لوحة المسار). One record keeps one number (PIN-…) from lead to project.
Address: /projects/initiation (one record: /projects/initiation/<initiation number>)
Needs: `view` on `project` to open; `create` to open a new record; `edit_draft` to fill the stages, add BOQ lines, log activities, move to the next stage and mark a record lost; `approve` to approve a tender's Go / No-Go and to confirm the signed contract
What it is for: The company's Project Guide. Every customer project starts here, before it is a project: you choose its type — a **Direct Sales Project** (مشروع بيع مباشر) or a **Tender Project** (مشروع مناقصة) — and walk the record through the six stages of that workflow, one at a time. When the contract is signed and confirmed, the record becomes an Active Project on Project Master by itself, carrying its Pre-Sales Form, its drawings and its approved BOQ. Nothing here posts to the books or moves stock.

### The two project types — Project Initiation
- **Direct Sales Project** — for direct customers and special projects: the Pre-Sales Form, the system type and an assessment of the customer's site. Stages 1 to 6: **1 Sales Lead** (عميل مبيعات محتمل) → **2 Opportunity and Pre-Sales Form** (الفرصة ونموذج ما قبل البيع) → **3 Site Survey Design** (مسح الموقع والتصميم) → **4 BOQ Costing** (تسعير جدول الكميات) → **5 Proposal Follow-up** (العرض والمتابعة) → **6 Contract Signing** (توقيع العقد).
- **Tender Project** — for formal tenders and government tender documents (ITB/RFP): submission deadlines, bid bonds and a compliance matrix. Stages 7 to 12: **7 Tender Lead** (مناقصة محتملة) → **8 Feasibility Review and Tender Qualification (Go / No-Go)** (مراجعة الجدوى وتأهيل المناقصة) → **9 Site Visit & Pre-Bid Meeting** (زيارة الموقع واجتماع ما قبل العطاء) → **10 Tender Design BOQ** (تصميم المناقصة وجدول الكميات) → **11 Compliance Matrix & Bidding** (مصفوفة المطابقة وتقديم العطاء) → **12 Submission & Award** (التقديم والإحالة).
- **Financed Customer (Renewable Energy Financing)** (عميل ممول — تمويل الطاقة المتجددة) — for a customer whose system a bank loan pays for. Its own seven stages, numbered 1 to 7 as the initiative's sheet numbers them: **1 Customer** (العميل: name, city, phone) → **2 Quotation Sent** (إرسال عرض السعر: agreed / refused) → **3 Bank Approval** (موافقة المصرف: approved / rejected) → **4 Loan — First Payment** (القرض — الدفعة الأولى: partially paid / pending) → **5 Installation** (التركيب: in progress / completed) → **6 Contract** (العقد: signed / pending) → **7 Loan — Fully Granted** (القرض — المنح الكامل: fully granted / pending). Each stage moves on only on its good outcome; under each stage on the record the strip says its outcome (Agreed, Approved, Partially paid …). When the loan is fully granted and the contract is on file, the record is converted into a project like the other two.
- The type is chosen once, when the record is opened, and cannot be changed afterwards.
- A record carries one status: **Open** (مفتوح) while it is being worked, **Converted to project** (تحوّل إلى مشروع) once its contract is confirmed, or **Lost** (خسارة) with its reason. A converted or lost record does not change again.

### How to open a new record — Project Initiation
1. Projects → Projects & Planning → Project Initiation, then press **New initiation** (تأسيس جديد). The button shows only with the create permission.
2. Choose the **Project type** (نوع المشروع): Direct Sales Project or Tender Project. The window describes both.
3. Type the **Project name** (اسم المشروع) and the **Customer name** (اسم العميل) — for a tender, the issuing entity (owner). Choose the **Owner** (المسؤول), the person who follows it; you by default.
4. Press **Create** (إنشاء). The record opens at its first stage with the next number of the series, PIN-<branch>-<year>-<serial>.
The record belongs to the branch you are working in.

### How to work a record through its stages — Project Initiation
1. Open the record from the list by its number.
2. The **Workflow** (مسار العمل) strip shows the six stages: a check on what is done, the current stage highlighted, the rest marked Pending.
3. Under it there is one section per stage the record has reached. Press **Edit** (تعديل) in a stage's section to fill its form, then **Save** (حفظ). A later stage's section appears when the record gets there; an earlier stage can still be corrected while the record is Open.
4. A note above the record says what the current stage still needs, for example "2 · Opportunity and Pre-Sales Form still needs: Site coordinates (GPS) · System type".
5. When nothing is missing, the button **Next stage: …** (المرحلة التالية) appears at the foot of the record. Press it to move on. Stages are completed in order; none can be skipped.
6. Files are added through the paperclip in the title of the stage they belong to (see "Fields — Project Initiation").
7. To record a call, a meeting, a site visit, a clarification or an addendum, press **Log activity** (تسجيل نشاط) under **Follow-up activities** (أنشطة المتابعة). An activity is kept as written; it is never edited or removed.
8. If the customer walks away, the proposal is refused or the tender is not awarded, type the reason beside **Mark lost** (تسجيل كخسارة) and press it.

### Fields — Project Initiation
Direct Sales:
- **1 Sales Lead** — Project name, Customer name, **Customer phone** (هاتف العميل), **Initial contact** (أول تواصل; the day the record was opened unless changed), **Lead source** (مصدر العميل: Referral, Existing customer, Website, Social media, Exhibition or event, Walk-in, Cold call, Partner or agent, Other), Note, and optionally the approved customer from the Customers list. Needed to move on: the name, the phone, the contact date and the lead source.
- **2 Opportunity and Pre-Sales Form** — site: **Site latitude / longitude (GPS)** in decimal degrees (like 33.312806), **Governorate** (المحافظة), **Area** (المنطقة), **Site type** (نوع الموقع: Land or Rooftop); contact person: name, **Job title**, **Phone**, Second phone, **Official email**; **System type** (نوع النظام): On-Grid, Off-Grid, Hybrid, BESS (Battery Energy Storage System) or Solar Pumping. All of these are needed to move on except the second phone. The paperclip in this section holds the **Customer documents** (وثائق العميل): engineering drawings, building and site maps, site photos, electrical load requirements and current electricity bills.
- **3 Site Survey Design** — **Survey date**, the box **Site data verified** (تم التحقق من بيانات الموقع), a note. The paperclip holds the final Single-Line Diagram (SLD) and layout; at least one file must be there to move on.
- **4 BOQ Costing** — the **Bill of Quantities (BOQ)** (جدول الكميات) in the record's own table. Press **Add BOQ line** (إضافة بند): the **Cost** (Material مواد, Shipping شحن or Installation تركيب), an optional item of the catalogue, a description, the quantity, the unit and the unit cost in IQD. **Remove** (حذف) on a row takes a line out. The foot shows the three costs and the BOQ total. At least one line with a cost is needed. Moving on approves the BOQ: it can no longer be changed.
- **5 Proposal Follow-up** — **Proposal reference**, **Proposal date**, **Proposal value (IQD)**, **Proposal status** (Draft, Sent, Negotiating, Accepted, Rejected). The printer in this section's title prints the technical and commercial proposal (PDF, Excel or Word, English or العربية): the customer, the site, the system asked for, the scope from the BOQ without its costs, and the proposal's value. The paperclip holds the proposal as sent. Only a proposal marked **Accepted** moves on to the contract.
- **6 Contract Signing** — **Contract reference**, **Signed on**, **Contract value (IQD)**, **Payment terms**, and the **Customer (approved)** from the Customers list. The paperclip holds the signed contract; at least one file is required.
Tender:
- **7 Tender Lead** — Project name, **Issuing entity (owner)**, **Tender reference no.**, **Submission deadline**, **Link to the tender documents (ITB/RFP)** (a web address beginning with http:// or https://); the paperclip holds the tender documents themselves. A link or an uploaded file is needed, with the reference and the deadline.
- **8 Go / No-Go** — **Qualification requirements**, **Bid bond (IQD)** (type 0 if the tender asks for none). The decision is made with the buttons **Approve Go** (اعتماد المشاركة) or **No-Go** (عدم مشاركة) by somebody with the approve permission. A No-Go needs its reason and ends the record as Lost.
- **9 Site Visit & Pre-Bid Meeting** — **Site visit date**, **Site visit minutes**, **Technical clarifications**. Addenda are logged as activities of the kind Addendum.
- **10 Tender Design BOQ** — the approved designs behind this section's paperclip, and the BOQ as in stage 4. Both are needed.
- **11 Compliance Matrix & Bidding** — **Bid price (IQD)**; the bank guarantee: **Guarantee bank**, **Guarantee no.**, **Guarantee amount (IQD)**, **Guarantee expiry**, **Guarantee status** (Requested, Issued, Released, Converted, Forfeited); and the **Compliance matrix** (مصفوفة المطابقة): press **Add compliance line**, type the clause and the requirement, and answer each line Compliant, Partially compliant, Not compliant or Not applicable with **Answer** (إجابة) on its row. Every line must be answered. Where a bid bond is asked, the guarantee's details are required and its status must be Issued.
- **12 Submission & Award** — **Submitted on**, **Submission reference**, **Award status** (Under evaluation, Awarded, Not awarded), **Awarded on**, and the guarantee's status, which must be Converted or Released where a bond was asked. Then the **Contract Signing** section, exactly as stage 6.

### How to confirm the contract and create the project — Project Initiation
1. At the last stage, fill the Contract Signing section and upload the signed contract. Link the approved customer: only customers that are approved and in use are offered; add or approve one on Customers first.
2. When nothing is missing, somebody with the approve permission — not the person who opened the record — sees **Confirm contract and create project** (تأكيد العقد وإنشاء المشروع).
3. In the window choose the **Project manager**, optionally the **Department**, the **Project start** and **Project finish** (the project's baseline dates), the **Billing method**, **Retention %**, **Advance recovery %**, and optionally a **Project code** (blank takes the next PRJ number).
4. Press the button. The project is created and released in one step and its record opens.

### After you save — Project Initiation
- A new record is Open at stage 1 (direct sale) or stage 7 (tender).
- Moving on from the BOQ stage records who approved the BOQ and when.
- Confirming the contract creates a project of the type Direct Sales Project or Tender Project with the status Released (active): its customer, its contract value, its baseline dates, and the BOQ total as its baseline budget. The project names the person who opened the initiation as its author and the person who confirmed the contract as the one who released it.
- The record becomes Converted to project and shows the project's code as a link. Nothing on it can be changed afterwards.
- The project's record on Project Master shows **Initiated from** (نشأ من التأسيس) with the initiation's number, and a section **Project initiation** (تأسيس المشروع) with the Pre-Sales Form's facts, every file of the initiation under **Drawings and documents** (المخططات والوثائق), and the approved BOQ. These are read from the initiation; they are not copies.
- Every save, stage move, decision and conversion is in the record's history (the clock icon).

### Refusals — Project Initiation
- "Stage N is not complete: …" — the stage still needs what the message lists; the note above the record says the same in words.
- "…has not reached that stage yet. Stages are completed in order, one at a time." — a later stage's form was sent before its turn.
- "…is converted; a decided record does not change again." / "…is lost…" — the record is closed.
- "The BOQ of … is approved; it no longer changes." — the record has left its BOQ stage.
- "You raised this record, so somebody else confirms the signed contract." — the two-person rule; a Super User alone is excepted.
- "… is not an approved customer in use. Approve it on its page under Customers first." — the customer is still a prospect, on hold or out of use.
- "A No-Go says why the company will not take part." / "A lost record says why…" — the reason is required.
- "A Direct Sales Project starts in Project Initiation and becomes a project when its contract is signed" — shown on Project Master if somebody tries to create a project of one of these two types by hand; the New project form does not offer them.
- "No project initiation '…', or it is outside the branches you may see." — the record belongs to another branch.

### The icons at the top of a record — Project Initiation
- **Printer** — the whole record (PDF, Excel, Word; English or العربية).
- **Paperclip** — general files of the record. Each stage that names documents has its own paperclip in its own title: Customer documents, SLD and layout, Proposal, Tender documents, Bid and guarantee, Signed contract.
- **Notes** — notes on the record; adding one needs the edit-draft permission.
- **Clock** — the record's history: who did what, and when.

## Project Master (الملف الرئيسي للمشروع)
Projects → Projects & Planning → Project Master   |   Arabic: المشاريع ← المشاريع والتخطيط ← الملف الرئيسي للمشروع
Address: /projects (a project's record: /projects/<project code>)
Needs: `view` on `project` to open; `create` to add a project; `edit_draft` to edit it, add elements and add notes; `approve` to release, technically complete, reopen and close; `submit` to put on hold and resume
What it is for: The register of every project — for a customer, internal or investment — with its budget, committed, actual and available amounts. A row opens the project record, where the project is edited and moved through its statuses, and where its structure, budget, costs and contract are read. (The Arabic page title reads سجل المشاريع.)

### How to find a project — Project Master
Projects → Projects & Planning → Project Master. The newest project is at the top; 25 rows per page.
2. To search, type part of the project code, its name or the customer's name in **Search this list** (ابحث في هذه القائمة) and press the magnifier. **Clear** (مسح) removes the search.
3. To filter, choose **Status** (الحالة) — All statuses (كل الحالات), Created, Released, On hold, Technically complete, Closed — and/or **Type** (النوع), then press **Filter** (تصفية).
4. Columns: Code (الرمز), Name (الاسم), Type (النوع), Customer (العميل), Project manager (مدير المشروع), Baseline finish (نهاية الأساس), Budget, Committed, Actual, Available (see "Budget, committed, actual, available"), Status.
5. Click the code to open the project record.

### How to create a project — Project Master
1. Press **New project** (مشروع جديد) at the top of the list. (The button shows only with the create permission.)
2. Choose the **Type** and fill in the form — see "Fields — Project Master".
3. Press **Create** (إنشاء).
4. The project record opens. The project is **Created** (منشأ) and its top element (project code + `-1`) already exists, named after the project, with the project manager as its responsible person.
5. Next: add elements (WBS), type the cost plan and the original budget, then have somebody else press **Release**.
The project belongs to the branch you are working in when you create it.

### Fields — Project Master
The New project form:
- **Type** (النوع) — required. One of the active project types; it decides whether the project is for a customer, internal or an investment. Cannot be changed later. The types Direct Sales Project and Tender Project are not offered here: a project of either is created by confirming the contract on Project Initiation.
- **Code** (الرمز) — optional. Leave blank for the next number in the PRJ series, or type a code the company already uses (letters, digits, hyphens, underscores; up to 32; stored in capitals). Must not already exist. Cannot be changed later.
- **Name** (الاسم) — required.
- **Customer** (العميل) — required for a customer project; must stay "— no customer (internal or investment) —" (— بلا عميل (داخلي أو استثماري) —) for the other kinds. Only active customers are listed. Cannot be changed later.
- **Project manager** (مدير المشروع) — required; an active user. Receives the budget warnings.
- **Department** (القسم) — optional.
- **Baseline start** (بداية الأساس) — required; today by default.
- **Baseline finish** (نهاية الأساس) — required; not before the start.
- **Baseline budget** (موازنة الأساس) — in IQD; 0 by default; not negative.
- **Contract value** (قيمة العقد) — customer projects only, in IQD; 0 by default. Ignored for other kinds.
- **Billing method** (طريقة الفوترة) — Milestone billing (فوترة بالمراحل), Progress billing (فوترة بالإنجاز), Time and material (وقت ومواد), Lump sum (مبلغ مقطوع). Customer projects only; shown on the contract for information — it does not change how certificates are raised. Cannot be changed later.
- **Retention %** (نسبة المحتجزات ٪) — the share of every certificate held back by the customer; 0 by default. Type 5 for 5 %. Cannot be changed later.
- **Advance recovery %** (نسبة استرداد الدفعة المقدمة ٪) — the share of every certificate taken back against an advance still outstanding; 0 by default. Cannot be changed later.
- **Tolerance profile** (ملف التسامح) — the warning and stop lines for availability control.
- **Description** (الوصف) — optional.
The baseline dates, baseline budget and contract value can be corrected while the project is Created; after release they are fixed and only a change order moves the revised figures.

### How to open and read a project record — Project Master
1. On the list (or on Contracts, WBS, Budgets…) click the project code. Address: /projects/<project code>.
2. The top window shows the definition: Code, Status, Type, Customer, Project manager, Branch (الفرع), Department, Baseline start, Baseline finish, Forecast finish (النهاية المتوقعة), Contract value, Baseline budget, Revised budget (الموازنة المعدلة), Tolerance profile, Created by (أنشأه), Released by (أطلقه), and — when they happened — Held (موقوف), Technically complete, Reopened (أُعيد فتحه), Closed by (أقفله), each with the person, the time and the reason. Customer, manager, branch and department are links to their own pages.
3. Under it, **Work breakdown structure** (هيكل تقسيم العمل): every element with Responsible (المسؤول), Planned start and finish, May receive, Budget, Committed, Actual, Available and Availability. Read-only here; elements are changed on WBS. The totals under the tree are the whole project's.
4. **Budget by element** (الموازنة حسب العنصر): Planned (المخطط), Original budget, Supplements, Returns, Transfers, Current budget, With children (مع الفروع), Assigned (المخصص — committed plus actual), Available, Stop line. The link **Cost Plan** opens the plan.
5. **Budget documents** (مستندات الموازنة) — the latest 20, with the link **New budget document** (مستند موازنة جديد).
6. **Change orders** (أوامر التغيير) — the latest 20, with the link **New change order** (أمر تغيير جديد) while the project is Released or On hold.
7. **Budget by cost code** (الموازنة حسب رمز التكلفة): Baseline budget, Change orders, Revised budget, Committed, Actual, Forecast, Available per cost code. Empty until the original budget is approved.
8. **Commitments and costs** (الالتزامات والتكاليف): every commitment (open or released) and every cost line.
9. **Contract** (العقد), customer projects only: Billing method, Contract value, Revised contract value (قيمة العقد المعدلة), Retention %, Retention held (المحتجزات المحجوزة), Advance recovery %, Advance outstanding (الدفعة المقدمة المتبقية), number of certificates and of change orders.
Note: on this page the field "Revised budget" in the top window and "Revised contract value" in the Contract table currently repeat the baseline figures. The revised figures are correct on a change order's Position table and on Billing → Contract balances.

### How to edit a project — Project Master
1. Open the project record and press **Edit** (تعديل). (Needs the edit-draft permission; not offered on a Closed project.)
2. Change what is needed: **Name**, **Project manager**, **Department**, **Tolerance profile**, **Forecast start** (البداية المتوقعة), **Forecast finish** (النهاية المتوقعة), **Description**.
3. While the project is still Created the form also offers **Baseline start**, **Baseline finish**, **Baseline budget** and **Contract value**.
4. Press **Save** (حفظ).
After release the form says: "The project is released: the baseline is written once. A change in scope, value or dates is a change order." Type, code, customer, billing method, retention % and advance recovery % are not on the form and cannot be changed.

### How to release, hold, resume, complete, reopen or close — Project Master
All of these are buttons in the action row of the project record; each shows only in the status it applies to and with the permission it needs (see "Project statuses").
1. **Release** (إطلاق) — on a Created project. The baseline start and finish must be filled in. Shown to somebody with the approve permission who did not create the project. The forecast dates start equal to the baseline.
2. **Put on hold** (إيقاف مؤقت) — on a Released project. Type the reason in the box "Why it is held" (سبب الإيقاف) first.
3. **Resume** (استئناف) — on a project On hold. Type "Why it resumes" (سبب الاستئناف) first.
4. **Technically complete** (إكمال فني) — on a Released project. First finish, reach or cancel every activity and milestone, post the last supplier invoices and the month's labour, and raise every certificate you still need: after this step no cost is taken and no certificate can be raised.
5. **Reopen** (إعادة فتح) — on a Technically complete project that has not been reopened before. Type "Why it reopens (once)" (سبب إعادة الفتح (مرة واحدة)) first.
6. **Close project** (إقفال المشروع) — on a Technically complete project. Type the "Closing note" (ملاحظة الإقفال) first. It succeeds only when every check on the Close screen is clear; otherwise the refusal lists what still stands. The Close screen shows the checks before you press.
Every move is written to the Audit log with the person, the time and the reason.

### How to add an element from the record — Project Master
1. Open the project record (Created, Released or On hold) and press **Add element** (إضافة عنصر).
2. Choose **Under** (تحت) — the parent element; the top element is preselected.
3. Fill in Code (optional), Name, Responsible, Planned start, Planned finish, Description and the three switches — the same fields as on WBS (see "Fields — WBS element").
4. Press **Save** (حفظ). The element appears in the tree.
To change or deactivate an element, or to add activities, press the **WBS** link in the action row.

### How to add a note or see the history — Project Master
1. Open the project record.
2. Press the **Notes** (الملاحظات) icon in the title bar, type the note under **Add note** (إضافة ملاحظة) and press **Add note**. Needs the edit-draft permission.
3. Press the clock, **Audit log** (سجل التدقيق), to see who created, released, held, resumed, completed, reopened and closed the project and every edit, with the old and new values.
The project record has no printer and no paperclip; use Reports to print project figures. See "The icons at the top of a record".

### After you save — Project Master
- A new project is **Created** (منشأ). Nothing is posted to the ledger by creating, editing or releasing a project.
- **Release** by a second person makes it **Released** (مُطلق); from then on purchases, material issues, progress, hours and certificates are accepted and the baseline is fixed.
- **Put on hold** → **On hold** (موقوف مؤقتاً); **Resume** → Released again.
- **Technically complete** → **Technically complete** (مكتمل فنياً); the next steps are on the Close screen: clear the checklist, draft and post the settlement, then close.
- **Close project** → **Closed** (مقفل), which is final.
- Who acts next: after creating — a second person with the approve permission releases; after technical completion — one person drafts the settlement and another posts it, then somebody with the approve permission closes.

### Refusals — Project Master
- "customer: a customer project names its customer" — the type is a customer type and no customer was chosen. Choose the customer.
- "customer: an internal project has no customer" (or "an investment project…") — a customer was chosen for a type that has none. Set Customer back to "— no customer —".
- "code: 'X' is already a project" — the typed code exists. Type another or leave it blank.
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — the typed code has other characters.
- "ends_on: is before the start" — the baseline finish is earlier than the baseline start.
- "contract_value: '…' is not an amount" / "baseline_budget: '…' is not an amount" — type a plain number, zero or more.
- "manager: names no active user" — the chosen manager has been deactivated.
- "baseline: the baseline dates are typed before release" — press Edit and fill Baseline start and Baseline finish, then release.
- "… was raised by you, so somebody else approves the contract and its baseline" — the creator tried to release. Ask another person with the approve permission.
- "status: … is on_hold; technical complete is allowed from active only" (and the like) — the move is not allowed from the current status. Check the status chip.
- "status: … still has open work: A0010, A0020 — finish, reach or cancel it first" — technical completion with open activities or milestones. Finish or cancel them on WBS, reach and approve milestones on Progress.
- "status: … is settled (PST-…); settled work is not reopened — rework is a new project" — reopening after the settlement was posted.
- "status: … was already reopened once (date); a second rework is a new project" — only one reopen is allowed.
- "close: … cannot be closed: …" followed by the list — see "Refusals — Close" for each item and its way out.
- "status: … is closed" — a Closed project cannot be edited.
- "reason: is required" / "note: is required" — type the reason or closing note in the box beside the button.
- "Permission denied: 'approve' on 'project' is not granted to this user." — your role lacks that permission; ask an administrator.

## Contracts (العقود)
Projects → Projects & Planning → Contracts   |   Arabic: المشاريع ← المشاريع والتخطيط ← العقود
Address: /projects/contracts
Needs: `view` on `project`
What it is for: A read-only list of the customer projects seen as contracts: who the customer is, the dates, the contract value, the budget and what has been spent. Nothing is created or changed here; a row opens the project record, where the Contract table shows retention and advance.

### How to read the list — Contracts
Projects → Projects & Planning → Contracts. Only projects whose type is the delivered "Customer project" type (code CUSTOMER) are listed.
2. Search by project code, name or customer name in **Search this list** (ابحث في هذه القائمة); filter by **Status** (الحالة) and press **Filter** (تصفية).
3. Columns:
   - **Code** (الرمز) — click it to open the project record.
   - **Name** (الاسم), **Customer** (العميل), **Project manager** (مدير المشروع).
   - **Baseline start** (بداية الأساس), **Baseline finish** (نهاية الأساس).
   - **Contract value** (قيمة العقد) — the baseline contract value typed on the project, in IQD.
   - **Budget** (الموازنة) — the budget of the whole project (see "Budget, committed, actual, available").
   - **Actual** (الفعلي) — the cost posted so far.
   - **Status** (الحالة) — Created, Released, On hold, Technically complete, Closed.
4. For the revised contract value, what has been certified and billed, retention held and advance outstanding, open Billing and choose the project (table **Contract balances**).
5. To change a contract value after release, raise a change order (Change Orders) with a **Contract change**.

## WBS (هيكل تقسيم العمل (WBS))
Projects → Projects & Planning → WBS   |   Arabic: المشاريع ← المشاريع والتخطيط ← هيكل تقسيم العمل (WBS)
Address: /projects/wbs (one project: /projects/wbs?project=<project code>)
Needs: `view` on `project` to open; `edit_draft` to add or change elements, activities and links and to schedule; `submit` as well to raise a stop line or record actual dates
What it is for: The work breakdown structure of one project — its elements with their amounts rolled up the tree — and, under the tree, the schedule: activities and milestones, the links between them, and the critical path.

### How to open a project's structure — WBS
Projects → Projects & Planning → WBS. The newest project that is not Closed is shown.
2. To see another, choose it in **Project** (المشروع) and press **Open** (فتح). (The list offers the 100 newest projects; older ones open from the project record's **WBS** link.)
3. Under the filter: the project's status chip and the link **Open the project record** (فتح سجل المشروع).
4. The tree. Columns: Code (الرمز, indented by level), Name (الاسم), Responsible (المسؤول), Planned start (البداية المخططة), Planned finish (النهاية المخططة), May receive (يستقبل: plan · costs · billing), Budget, Committed, Actual, Available, Availability (التوفر — with "raised to N %" when the stop line was raised for the element), Active (نشط) or inactive (معطّل), and **Edit** (تعديل) on each row.
5. **Schedule** (الجدول الزمني): one row per activity or milestone — Code, Name (a milestone shows its usage), Element, Duration (working days), Earliest start (أبكر بدء), Earliest finish (أبكر انتهاء), Latest finish (أبعد انتهاء), Float (days) (الفائض (أيام)), Critical (حرج) or Float (فائض), Actual (the actual start → finish; for a milestone the day it was reached), % complete, Status: Open (مفتوح), Done (منجز), Cancelled (ملغى). The title shows "finishes <date> · run N" (ينتهي … · الدورة N) or "Not scheduled yet" (لم يُجدول بعد).
6. **Links** (الروابط), when there are any: Predecessor (السابق), Successor (اللاحق), Link (الرابط), Lag (working days), **Unlink** (فك الربط).
The buttons and the Edit column show only with the edit-draft permission and while the project is Created, Released or On hold.

### How to add an element — WBS
1. Open the project on WBS and press **Add element** (إضافة عنصر).
2. In the window **New element** (عنصر جديد) choose **Under** (تحت) — the parent; the top element is preselected.
3. Leave **Code** blank for the next number under the parent, type the **Name**, and fill the rest — see "Fields — WBS element".
4. Press **Save** (حفظ). The element appears in the tree under its parent.
The same window opens from the project record's **Add element** button.

### Fields — WBS element
- **Under** (تحت) — required when adding. The parent element; only active elements of levels 1 to 4 are offered, because the structure is five levels deep at most. Not changeable later.
- **Code** (الرمز) — optional when adding. Blank gives the next number under the parent. A typed code must follow the coding mask: the parent's code, a dot, then a number from 1 to 9999 (under the top element `PRJ-…-1` a child is `PRJ-…-1.3`). Not changeable later.
- **Name** (الاسم) — required.
- **Responsible** (المسؤول) — an active user; the project manager by default. Receives the budget warning for this element.
- **Planned start** (البداية المخططة), **Planned finish** (النهاية المخططة) — optional dates; the finish is not before the start.
- **Description** (الوصف) — optional.
- **Planning element — costs may be planned here** (عنصر تخطيط — تُخطَّط التكاليف هنا) — ticked by default. Only planning elements appear in the Cost Plan and in the budget and change-order grids.
- **Account-assignment element — costs, commitments and issues may be posted here** (عنصر تعيين حسابي — تُرحَّل التكاليف والالتزامات والصرف هنا) — ticked by default. Only these elements are offered on purchase invoices, material issues and hours. It cannot be unticked once a cost has been posted to the element.
- **Billing element — certificates and the billing plan hang here** (عنصر فوترة — تُعلَّق الشهادات وخطة الفوترة هنا) — customer projects only; not ticked by default (the top element of a customer project is a billing element from the start). Only billing elements are offered when adding a billing-plan line.

### How to edit, deactivate or reactivate an element — WBS
1. On the element's row press **Edit** (تعديل). The window **Edit <code>** opens.
2. To change it: correct Name, Responsible, Planned start, Planned finish, Description or the three switches and press **Save** (حفظ).
3. To deactivate it (not offered for the top element): in the last part of the window read the note "A deactivated element keeps its history and receives nothing new. It is refused while it carries budget, costs or active children.", type the **Reason** (السبب) and press **Deactivate** (إلغاء التفعيل).
4. To bring it back: open **Edit** on the inactive row and press **Activate** (تفعيل).
An element is never deleted. A deactivated element shows "inactive" and is no longer offered for plans, budgets, purchases, issues, hours, activities or billing lines.

### How to raise the stop line for one element — WBS
Use this when a posting is refused because the element reached its stop line and the overspend is accepted for this element only (see "Availability control").
1. On the element's row press **Edit** (تعديل). The middle part of the window reads "The profile stops at N %. A project manager may raise the line to 110 %; beyond that the accounting manager raises it. The reason is recorded." (This part shows only with the submit permission.)
2. In **Stop line** (خط الإيقاف) type the new percentage of the element's budget, for example 105. It must be above the profile's stop line and at most 200.
3. Type the **Reason** (السبب) — required.
4. Press **Raise the stop line** (رفع خط الإيقاف). The Availability column now shows "raised to 105 %" (مرفوع إلى 105٪).
5. To go back to the profile's line: clear the **Stop line** box, type a reason and press the same button.
Above 110 % only a user with the accounting manager role (or a Super User) may raise the line. The line applies to the element whose budget is being checked — raise it on the element that carries the budget.

### How to add an activity or a milestone — WBS
1. Open the project on WBS and press **Add activity** (إضافة نشاط). The window **New activity or milestone** (نشاط أو معلم جديد) opens.
2. Choose the **Element** (العنصر) the work belongs to, type the **Name**, choose **Kind** (النوع): **Activity** (نشاط) or **Milestone** (معلم).
3. For an activity type the **Duration (working days)**. For a milestone choose its **Usage** (الاستخدام), and for a progress milestone the **Progress %**.
4. Press **Save** (حفظ). The row appears in the Schedule table with status Open.
5. Add links between activities and press **Schedule** to work out the dates (see the two blocks that follow).

### Fields — WBS activity
- **Element** (العنصر) — required; any active element of the project.
- **Code** (الرمز) — optional. Blank gives the next code in steps of ten (A0010, A0020, …). A typed code is up to 16 letters, digits, hyphens or underscores and must be new on the project.
- **Name** (الاسم) — required.
- **Kind** (النوع) — **Activity** (نشاط): work with a duration. **Milestone** (معلم): a point in time with no duration.
- **Duration (working days)** (المدة (أيام عمل)) — 1 by default; 1 to 3,650, counted in the project's calendar. Ignored for a milestone.
- **Usage** (الاستخدام) — required for a milestone:
  - **Billing** (فوترة) — a billing-plan line can fall due on it (Billing).
  - **Progress** (تقدم) — when it is reached and approved it records a progress measurement of the Progress % on its element.
  - **Date** (تاريخ) — a date to watch only.
- **Progress %** (نسبة التقدم) — required for a progress milestone: the element's percent complete when the milestone is reached, 0 to 100.
- **Not before** (ليس قبل) — optional: the earliest day the activity may start; for a milestone the day it stands at.
- **Responsible** (المسؤول) — optional; the element's responsible person when left blank.
Kind, Usage and the element cannot be changed after saving; cancel the row and add a new one instead.

### How to edit an activity, record what happened, or cancel it — WBS
1. In the Schedule table press **Edit** (تعديل) on an Open row. The window **Edit <code>** opens. (Done and Cancelled rows have no Edit.)
2. To change the plan: correct Name, Duration (working days), Progress % (progress milestones), Not before or Responsible and press **Save** (حفظ). Press **Schedule** afterwards to refresh the dates.
3. To record actual work (activities only, project Released, needs the submit permission): fill **Actual start** (البدء الفعلي) and **% complete** (% الإنجاز); when the work is finished fill **Actual finish** (الانتهاء الفعلي) too. Press **Record** (تسجيل). An actual finish sets 100 % and the status **Done** (منجز). Dates cannot be in the future.
4. To cancel: type the **Reason** (السبب) and press **Cancel it** (إلغاؤه). "A cancelled activity stays on the record and leaves the schedule; its links stop counting." A milestone already reported reached cannot be cancelled.
Milestones are not finished here: they are reported reached and approved on Progress.

### How to link activities — WBS
1. Press **Link activities** (ربط الأنشطة) (shown once the project has two or more activities). The window **New link** (رابط جديد) opens.
2. Choose the **Predecessor** (السابق) and the **Successor** (اللاحق).
3. Choose the **Link** (الرابط): **Finish → start** (انتهاء → بدء) — the successor starts after the predecessor finishes; or **Start → start** (بدء → بدء) — the successor starts after the predecessor starts.
4. Type the **Lag (working days)** (التأخير (أيام عمل)) — 0 by default; negative for a lead; within 365 days either way.
5. Press **Save** (حفظ). The link appears in the **Links** table.
6. To remove a link press **Unlink** (فك الربط) on its row. Press **Schedule** again afterwards.
A link that would make a loop, a second link between the same two activities, and a link to a cancelled activity are refused.

### How to schedule the project (critical path) — WBS
1. Press **Schedule** (جدولة) (shown once the project has an activity). The window **Schedule the project** (جدولة المشروع) opens.
2. Choose the **Calendar** (التقويم): one of the active working calendars, or leave "Sunday–Thursday, no holidays" (الأحد–الخميس، بلا عطل). The choice is saved on the project.
3. Optionally type a **Reason** (السبب) — it is kept with the milestone dates of this run.
4. Press **Schedule** (جدولة).
What it does: starting from the project's forecast start (or the baseline start, or today), it works out for every activity and milestone that is not cancelled the Earliest start, Earliest finish, Latest finish and Float (days), and marks the **Critical** (حرج) ones — the chain with no float that decides the finish. Actual dates already recorded are respected. The Schedule title then shows "finishes <date> · run N". Each run also saves every milestone's date; Progress and Reports show them side by side as the **Milestone trend**.
Run it again after any change to durations, links, "Not before" dates or the calendar — the dates do not move by themselves. The button is offered while the project is Created, Released or On hold.

### After you save — WBS
- Elements, activities, links and schedule runs post nothing to the ledger. Each change is recorded in the audit trail; schedule runs and calendar changes also show in the project's Audit log (clock on the project record).
- A new element is active at once and can be planned, budgeted and posted to according to its three switches.
- An activity is **Open** (مفتوح) until an actual finish is recorded (**Done** — منجز) or it is cancelled (**Cancelled** — ملغى). A milestone becomes Done when it is reported reached and approved on Progress.
- Technical completion of the project is refused while any activity or milestone is Open.
- A raised stop line takes effect on the next posting to that element.

### Refusals — WBS elements
- "status: … is closing; the structure is fixed" — elements can be added or changed only while the project is Created, Released or On hold.
- "code: '…' must begin with '<parent>.' under <parent> (the coding mask)" — the typed code does not start with the parent's code. Leave Code blank or follow the mask.
- "code: '…' must end in a number after '<parent>.'" — the last part must be a number from 1 to 9999.
- "code: the structure goes 5 levels deep at most" — choose a higher parent.
- "code: '…' is already an element of …" — the code is taken; leave it blank for the next number.
- "is_billing: an internal project bills nobody" (or "an investment project…") — the billing switch is for customer projects only.
- "planned_ends_on: is before the start" — correct the planned dates.
- "is_account_assignment: … already carries N cost row(s); it stays an account-assignment element" — costs were posted to it, so the switch cannot be removed.
- "reason: say why it is deactivated" — type the reason.
- "code: … carries costs, budget or active children; it cannot be deactivated" — deactivate the children first; an element with costs or budget stays active.
- "code: the level-1 element is the project itself" — the top element cannot be deactivated.
- "stop_percent: a raised stop line is above the profile's 100 %" — type a figure higher than the profile's stop line, or leave it blank to restore the profile's.
- "stop_percent: a stop line is 200 % at most".
- "stop_percent: above 110 % the accounting manager raises the line" — ask a user with the accounting manager role.
- "name: is required", "reason: is required" — fill the field named.

### Refusals — WBS activities, links and schedule
- "status: … is closing; its schedule is fixed" — activities and links are added only while the project is Created, Released or On hold.
- "usage: a milestone names its usage: billing, progress or date" — choose the Usage.
- "progress_percent: is required" / "a percentage is between 0 and 100" — a progress milestone needs its Progress %.
- "duration_days: an activity lasts between 1 and 3,650 working days" / "'…' is not a whole number of days".
- "code: … already has an activity A0010" / "code: use up to 16 letters, digits, hyphens or underscores".
- "status: A0010 is done; it is not changed" — only Open rows are edited.
- "status: … is on_hold; work is recorded on an active project" — actual dates need a Released project.
- "actual_start: work that has begun names the day it started" — fill Actual start when % complete is above 0 or a finish is given.
- "actual_finish: work at 100 % names the day it finished" — fill Actual finish, or type less than 100.
- "actual_finish: it finishes on or after it starts"; "an actual date is not in the future".
- "status: A0030 was reported reached; approve it or leave it" — a reached milestone cannot be cancelled.
- "status: billing-plan line 2 falls due on A0030; cancel the line first" — cancel the billing line on Billing, then the milestone.
- "dependency: A0010 → A0020 is already linked"; "A0010 cannot depend on itself"; "a cancelled activity is not linked".
- "dependency: the dependencies make a loop through A0010, A0020" — the new link would make the activities wait for each other. Remove or reverse one link.
- "lag_days: a lag is within a year either way".
- "schedule: … has no activity to schedule" — add an activity first.
- "schedule: a date before the project start" — a "Not before" or actual date is earlier than the project's forecast start. Correct the date, or move Forecast start (Edit on the project record).
- "calendar: working calendar … is deactivated" — choose another calendar.
- "status: … is closed" — a Closed project is not scheduled.

## Cost Plan (خطة التكاليف)
Projects → Projects & Planning → Cost Plan   |   Arabic: المشاريع ← المشاريع والتخطيط ← خطة التكاليف
Address: /projects/plan (one project: /projects/plan?project=<project code>)
Needs: `view` on `project` to open; `edit_draft` to create a version and type the plan
What it is for: What the project is expected to cost, by element, cost code and month, kept in versions (the original plan and each re-plan). The current version is the "Planned" figure on Progress (earned value) and "Plan" on Forecast. The plan limits nothing — spending is limited by the budget documents on Budgets.

### How to open the plan — Cost Plan
Projects → Projects & Planning → Cost Plan. The newest project that is not Closed is shown with its current version.
2. Choose another **Project** (المشروع) or an older **Version** (النسخة) and press **Open** (فتح). The current version is marked "current" (الحالية); an older one shows "an older version, kept as it was" (نسخة أقدم محفوظة كما كانت) and cannot be changed.
3. The table has one row per element and cost code, one column per month, and **Total** (المجموع) at the end; the last row totals each month. A dash means nothing is planned in that month.
4. With no version yet the page says "No plan yet — a version is created first." (لا خطة بعد — تُنشأ نسخة أولًا.)
The link **Open the project record** leads to the project; the project record shows the plan per element in its "Budget by element" table (column Planned).

### How to create the first plan or a re-plan — Cost Plan
1. Press **New version** (نسخة جديدة). The window **New plan version** (نسخة خطة جديدة) opens.
2. **Name** (الاسم) — required. For the first version "Original plan" (الخطة الأصلية) is suggested; for a re-plan type what it is (for example "Re-plan after change order 2").
3. **Note** (ملاحظة) — optional.
4. For a re-plan, **Start from version N** (ابدأ من النسخة N) is ticked: the new version starts as a copy of the current one. Untick it to start empty.
5. Press **Save** (حفظ). "A new version becomes the current one; older versions are kept as they were." Versions are numbered v0, v1, v2…
Allowed while the project is Created, Released or On hold.

### How to type the plan — Cost Plan
The two buttons show only on the current version.
To spread a total over several months:
1. Press **Spread over months** (توزيع على الأشهر). The window **Spread a total over months** (توزيع مجموع على الأشهر) opens.
2. Choose the **Element** (العنصر) — active planning elements only — and the **Cost code** (رمز التكلفة).
3. **First month** (الشهر الأول) and **Last month** (الشهر الأخير) — any day in the month will do; they start as the project's forecast (or baseline) start and finish.
4. **Total** (المجموع) — the amount in IQD for the whole range.
5. Press **Save** (حفظ). "The total is spread evenly from the first month to the last; the remainder lands on the last month so the sum is exact." Months in the range that already had a figure for this element and cost code are replaced.
To set or correct one month:
1. Press **Set a month** (تعيين شهر). The window **Set one month of the plan** (تعيين شهر واحد من الخطة) opens.
2. Choose **Element** and **Cost code**, pick any day of the month in **Month** (الشهر), type the **Amount** (المبلغ).
3. Press **Save** (حفظ). "The amount replaces what was there." Type 0 to empty a month.

### After you save — Cost Plan
- Nothing is posted and nothing needs approval. Each version and each change is recorded in the audit trail.
- The current version feeds the **Planned (BCWS)** column on Progress to the chosen day (whole earlier months, and the current month in proportion to the days gone), the **Plan** column on Forecast, and the **Planned** column of "Budget by element" on the project record.
- Older versions stay readable through the **Version** filter and are never changed.

### Refusals — Cost Plan
- "status: … is closing; the plan is not re-planned" — a new version is allowed only before technical completion.
- "name: is required" — name the version.
- "amount: a plan amount is not negative" — type zero or more.
- "total: '…' is not an amount" / "amount: '…' is not an amount" — type a plain number.
- "period: the plan ends before it starts" — the Last month is before the First month.
- The buttons **Spread over months** and **Set a month** are missing — you are looking at an older version (choose the current one and press Open), or there is no version yet (press New version), or the project is Technically complete or Closed, or you lack the edit-draft permission.
- The element you want is not in the list — it is not a planning element or it is inactive; tick "Planning element" on WBS.

## Budgets (الموازنات)
Projects → Projects & Planning → Budgets   |   Arabic: المشاريع ← المشاريع والتخطيط ← الموازنات
Address: /projects/budgets (new: /projects/budgets/new; one document: /projects/budgets/<number>)
Needs: `view` on `project` to open; `create` to raise a document; `edit_draft` to change a draft; `submit` to submit it; `approve` to approve or reject it
What it is for: The budget kept as documents — the original budget, supplements, returns and transfers between elements. Each is raised by one person and approved by another; an element's budget is the sum of the approved ones, and that budget is what availability control checks spending against.

### The four kinds and the statuses — Budgets
Kinds (**Kind** — النوع):
- **Original budget** (الموازنة الأصلية) — the first budget of the project, once only. Its approval writes the baseline per cost code. Amounts are positive.
- **Supplement** (إضافة) — adds budget to elements; the baseline stays. Amounts are positive.
- **Return** (إرجاع) — takes budget back from elements that will not need it. Typed as positive figures; kept as negative.
- **Transfer** (تحويل) — moves budget between elements: negative on the element that gives, positive on the one that receives; the lines sum to zero, so the project total does not change.
Statuses (**Status** — الحالة):
- **Draft** (مسودة) — being prepared; can be corrected.
- **Pending approval** (بانتظار الموافقة) — submitted; waits for a second person.
- **Approved** (معتمد) — counts in the budget from that moment.
- **Rejected** (مرفوض) — final, with its reason; it never counts. Raise a new document.
A budget document cannot be deleted or cancelled. Nothing is posted to the ledger; the budget is a limit, not an accounting entry.
Important: only cost codes that carry an amount in the approved **original** budget get a budget line on the project. A cost code that is missing from the original cannot be spent against later, even if a supplement adds budget for it (the posting is refused with "There is no budget line '…' on this project"). Put an amount on every cost code the project will use when typing the original budget.

### How to find a budget document — Budgets
Projects → Projects & Planning → Budgets. The newest document is at the top; 50 rows per page.
2. Search by document number, description or project name in **Search this list** (ابحث في هذه القائمة).
3. Filter by **Project** (المشروع — All projects / كل المشاريع), **Kind** (النوع — All kinds / كل الأنواع) and **Status** (الحالة), then press **Filter** (تصفية).
4. Columns: Number (الرقم), Project, Kind, Date (التاريخ), Description (الوصف), Lines (السطور), Amount (المبلغ — the sum of the lines; zero for a transfer, negative for a return), Raised by (رفعه), Approved by (اعتمده), Status.
5. Click the number to open the document; click the project code to open the project.

### How to raise a budget document — Budgets
1. Press **New budget document** (مستند موازنة جديد) on the list (or the link of the same name on the project record).
2. In **Project** (المشروع) type the project's code or part of its name, choose the **Kind** (النوع), and press **Choose** (اختر). Closed projects are not offered. If the hint says "More than one project matches — type more of its code or name." type more; "No project matches." means nothing fits.
3. The form shows Code, Name and Kind (read-only). Fill **Date** (التاريخ — required, today by default) and **Description** (الوصف — required, up to 500 characters).
4. The grid lists every active planning element with its **Current budget** (الموازنة الحالية) and **Available** (المتاح), and one column per active cost code. Type the amounts in IQD; leave a cell blank for nothing:
   - Original budget / Supplement: the amount to give each element and cost code.
   - Return: what is taken back, as a positive figure.
   - Transfer: negative on the giving element, positive on the receiving one, summing to zero.
5. Press **Create** (إنشاء). The document opens as a **Draft** with its number (PBD-…).
6. Check it, then press **Submit for approval** (إرسال للموافقة).
If the project already has an approved original and you chose Original budget, the page says "… already has its original budget — raise a supplement, a return or a transfer." Change the Kind and press Choose again.

### How to open, correct and submit a draft — Budgets
1. Click the document number on the list. The page shows: Number, Status, Kind, Project (link), Name, Date, Amount, Raised by, and — as they happen — Submitted by (قدّمه), Approved by (اعتمده), Rejected by (رفضه) with the reason, the Change order (أمر تغيير) that raised it, and the Description.
2. While it is a Draft (and you have the edit-draft permission) the lines show as the same grid as on the new page, with **Date** and **Description** above it. Correct the cells and press **Save** (حفظ).
3. Press **Submit for approval** (إرسال للموافقة). The status becomes **Pending approval**; the lines can no longer be changed.
4. Otherwise the lines show as a table: #, Element (العنصر), Cost code (رمز التكلفة), Description, Amount.
5. Under the document, **Budget by element** (الموازنة حسب العنصر) — "Approved documents only" (المستندات المعتمدة فقط) — shows per element: Original budget, Supplements (الإضافات), Returns (الإرجاعات), Transfers (التحويلات), Current budget, With children (مع الفروع), Assigned (المخصص) and Available.
6. The four icons in the title bar print the document (Budget Document — مستند الموازنة), attach files, add notes and show the Audit log — see "The icons at the top of a record".

### How to approve or reject a budget document — Budgets
1. Open a document that is **Pending approval**. You need the approve permission and must not be the person who raised it (a Super User may approve their own). The raiser sees instead: "You raised this document; somebody else approves it." (أنت من رفع هذا المستند؛ يعتمده شخص آخر.)
2. Check the lines and the "Budget by element" table.
3. Press **Approve** (موافقة). Or type the reason in the box "Why it is rejected" (سبب الرفض) and press **Reject** (رفض).

### After you save — Budgets
- **Create** → Draft. **Submit for approval** → Pending approval; a second person acts next. **Approve** → Approved. **Reject** → Rejected (final).
- On approval the budget of each element on the document changes at once: Budget and Available on Project Master, WBS, the project record and Forecast move, and availability control uses the new figure for the very next posting.
- Approving the **original** also writes the "Budget by cost code" lines of the project: for each cost code on the document, its total as the baseline and as the forecast.
- Supplements, returns and transfers change the current budget and the cost code's revisions; the baseline never moves.
- A change order approved twice raises and approves its own supplement, return or transfer; it appears here with the change order's number in its description.
- No journal is posted.

### Refusals — Budgets
- "kind: … already has its original budget; what follows is a supplement, a return or a transfer" — an original exists (draft, pending or approved). Raise another kind, or correct the existing draft.
- "lines: a budget document carries at least one line" — every cell was blank or zero. Type at least one amount.
- "lines: an original budget adds budget; a line that takes it is a return" (also for a supplement) — a negative figure was typed. Use a Return or a Transfer to take budget.
- "lines: a transfer moves budget between elements; its lines sum to zero" — the plus and minus figures do not cancel out.
- "lines: a transfer names the element that gives and the element that receives" — a transfer needs at least one negative and one positive cell.
- "line 2: '…' is not an amount" — type a plain number.
- "description: is required" / "is longer than 500 characters".
- "status: … is closed; its budget is history" — no documents on a Closed project.
- "status: PBD-… is submitted; only a draft is changed" / "only a draft is submitted" / "a submitted document is approved" — the document is not in the status the action needs.
- "approver: PBD-… was raised by you; somebody else approves it" — ask another person with the approve permission.
- "line 2: … has X unassigned; taking Y leaves it over its stop line" — a return or transfer takes more than the element has free (budget less committed and actual). Reject it and raise one for a smaller amount, or release commitments first.
- "baseline: MAT already carries a baseline of …; the baseline is written once" — the cost code already has a baseline on this project; the original cannot write it again. Reject the document and raise a supplement.
- "reason: is required" — type why it is rejected.

## Change Orders (أوامر التغيير)
Projects → Projects & Planning → Change Orders   |   Arabic: المشاريع ← المشاريع والتخطيط ← أوامر التغيير
Address: /projects/change-orders (new: /projects/change-orders/new; one record: /projects/change-orders/<number>)
Needs: `view` on `project` to open; `create` to raise a change order; `approve` to approve or reject it
What it is for: A change to a released project — its scope, the customer's contract value, the budget and the finish date — in one document. It takes two approvals by people other than its raiser; the second approval raises the budget document itself and moves the forecast finish. The baseline never moves; the revised figures sit beside it.

### How to find a change order — Change Orders
Projects → Projects & Planning → Change Orders. Newest first; 50 rows per page.
2. Search by number, description or project name in **Search this list** (ابحث في هذه القائمة); filter by **Project** (المشروع) and **Status** (الحالة — Draft / مسودة, Approved / معتمد, Rejected / مرفوض) and press **Filter** (تصفية).
3. Columns: Number (الرقم — with "· v2" for a later version), Project, Date, Description, **Contract change** (تغيير العقد), **Budget change** (تغيير الموازنة), **Schedule effect** (أثر الجدول — the revised finish date, or the number of days), **Approvals** (الاعتمادات — which of Commercial approval / Budget approval are in), Raised by (رفعه), Status.
4. Click the number to open the change order.

### How to raise a change order — Change Orders
1. Press **New change order** (أمر تغيير جديد) on the list (or the link of the same name on the project record).
2. In **Project** (المشروع) type the code or part of the name and press **Choose** (اختر). Only Released and On hold projects are offered; with none the page says "No released project to change." (لا مشروع مُطلق ليُغيَّر.)
3. Fill the form — see "Fields — Change Orders".
4. In the grid (one row per active planning element with its **Current budget**, one column per active cost code) type the budget the change adds on each element and cost code; a negative figure takes budget away. Leave it empty for a change that moves no budget.
5. Press **Create** (إنشاء). The change order opens as a **Draft** with its number (PVR-…).
6. Two approvals follow, by other people (next block). A change order cannot be edited after it is created: if it is wrong, have it rejected and raise a new one.

### Fields — Change Orders
- **Date** (التاريخ) — required; today by default.
- **Description** (الوصف) — required; up to 500 characters. What the change is.
- **Contract change** (تغيير العقد) — customer projects only. What the customer's contract value moves by, in IQD; negative for a reduction; blank for none. It raises the revised contract value, which every percentage line of the billing plan not yet billed then follows.
- **Schedule effect (days)** (أثر الجدول (أيام)) — a whole number of days added to the forecast finish; negative for earlier.
- **Revised finish** (النهاية المعدّلة) — a date, when the change sets one; it wins over the days.
- **Supersedes** (يحل محل) — shown when the project already has approved change orders: the approved change order this one follows up. It gives this one the next version number and links the two; the earlier one stays approved and its amounts stay counted, so type only the further change here.
- **Scope** (النطاق) — optional; what changes in the work, in a few lines.
- The grid — the budget moved per element and cost code:
  - all figures positive → the approval raises a **Supplement**;
  - all negative → a **Return**;
  - positive and negative summing to zero → a **Transfer**;
  - positive and negative that do not sum to zero are refused at the second approval — raise two change orders.

### How to approve or reject a change order — Change Orders
1. Open a **Draft** change order. You need the approve permission and must not be its raiser (a Super User may approve their own). The raiser sees: "You raised this document; somebody else approves it."
2. Read the fields, the lines under **Budget moved** (الموازنة المنقولة) and the **Position** (الموقف) table: Contract value, Budget and finish date as **Baseline** (الأساس) beside **Revised** (المعدّل).
3. Press **Approve commercially** (اعتماد تجاري) and/or **Approve budget** (اعتماد الموازنة). Each button disappears once that approval is in; the record shows who gave it and when. One person may give both.
4. To refuse it, type the reason in "Why it is rejected" (سبب الرفض) and press **Reject** (رفض).
5. A **Versions** (النسخ) table lists the change orders linked to this one through Supersedes.
The four icons in the title bar print it (Change Order — أمر التغيير), attach files, add notes and show the Audit log.

### After you save — Change Orders
- **Create** → **Draft** (مسودة). Nothing changes on the project yet.
- After the first approval it is still Draft, with one approval shown.
- With the second approval it becomes **Approved** (معتمد), and in the same step:
  - if it has lines, a budget document (supplement, return or transfer) is raised in the raiser's name, dated today, described "<change order number>: <description>", and approved; the record then links to it under **Budget document** (مستند موازنة);
  - the project's **Forecast finish** moves to the Revised finish, or by the Schedule effect days;
  - the revised contract value and the Budget change count from now on (Billing → Contract balances; the Position table).
- **Reject** → **Rejected** (مرفوض), final.
- No journal is posted. The baseline dates, baseline budget and baseline contract value never change.
- A change order that is still Draft, or Rejected, keeps the check "Change orders not approved" open on the Close screen; there is no cancel action for a change order.

### Refusals — Change Orders
- "status: … is draft; a change order needs a released project" — the project must be Released or On hold.
- "description: is required".
- "schedule_delta_days: is a whole number of days" — no decimals or text.
- "contract_delta: … has no customer contract to change" — a Contract change was typed on a project whose type is not the delivered "Customer project" type. Leave Contract change blank.
- "supersedes: … has no change order PVR-…" — the superseded number belongs to another project.
- "approver: PVR-… was raised by you; somebody else approves it" — ask another person with the approve permission.
- "approver: PVR-… already carries its commercial approval" (or "budget approval") — that approval is already in; give the other one.
- "status: PVR-… is approved" (or "is rejected") — it is no longer a Draft; nothing more can be done to it.
- "lines: PVR-… both adds and takes budget without netting to zero; raise it as two change orders" — reject it and raise one change order that adds and one that takes.
- "line 1: … has … unassigned; taking … leaves it over its stop line" — the change takes more budget from an element than it has free; reject it and raise a smaller one.
- "reason: is required" — type why it is rejected.

## Project Costs (تكاليف المشروع)
Projects → Execution & Progress → Project Costs   |   Arabic: المشاريع ← التنفيذ والتقدّم ← تكاليف المشروع
Address: /projects/costs
Needs: `view` on `project`
What it is for: A read-only register of the cost line items: every cost on every project with its element, cost code, source document and journal, and their sum beside the ledger's figure for the same project. Costs are not typed here — they arrive from posted purchase invoices, posted material issues and posted labour.

### How to read and filter — Project Costs
Projects → Execution & Progress → Project Costs. Newest cost first; 50 rows per page.
2. Filter and press **Filter** (تصفية):
   - **Project** (المشروع) — one project, or All projects (كل المشاريع).
   - **Element** (العنصر) — type an element's code; its children are included.
   - **Cost code** (رمز التكلفة) — one code, or All cost codes (كل رموز التكلفة).
   - **From** (من) and **To** (إلى) — the cost dates.
3. Or search by words of the description, the document number or the journal number in **Search this list** (ابحث في هذه القائمة).
4. Columns:
   - **Date** (التاريخ) — the day the cost was incurred (the invoice date, the issue date, the last day of the labour month).
   - **Project** — click to open the project record.
   - **Element**, **Cost code**.
   - **Kind** (النوع) — Invoice (فاتورة), Invoice reversed (فاتورة معكوسة), Material issue (صرف مواد), Material return (إرجاع مواد), Labour (عمالة).
   - **Description** (الوصف).
   - **Document** (المستند) — the purchase invoice number or the material issue number; click it to open that document.
   - **Journal** (القيد) — the journal entry number behind the cost.
   - **Amount** (المبلغ) — in IQD; negative for a reversal or a return.
5. The last row, **Total** (المجموع), is the sum of every line the filter matches, not only of the page shown.

### The comparison with the ledger — Project Costs
When exactly one **Project** is chosen and Element, Cost code and the search box are empty (dates may be set), a line appears above the table:
"Line items X · journal lines with the dimension Y" (بنود التكلفة X · سطور القيود بالبعد Y)
- **X** is the total of the project's cost lines for the period.
- **Y** is the net (debit less credit) of posted journal lines on expense accounts that carry this project, for the same period.
- When they are equal the line ends with "the two agree" (الرقمان متطابقان).
- When they differ it ends with "goods bought for the project are stock until a material issue takes them to the element" (البضائع المشتراة للمشروع مخزون حتى يأخذها صرف مواد إلى العنصر). Goods on a purchase invoice sit in stock and are not a project cost until a Material Issue takes them to an element; check Material Issues and the stock for the project's goods when the figures differ.
To correct a cost, correct its source: reverse the purchase invoice in Payables, or post a Return from project on Material Issues. A cost line itself cannot be edited or deleted.

## Procurement (مشتريات المشروع)
Projects → Execution & Progress → Procurement   |   Arabic: المشاريع ← التنفيذ والتقدّم ← مشتريات المشروع
Address: /projects/procurement
Needs: `view` on `project`
What it is for: A read-only register of the purchase orders and payables assigned to project elements, showing the commitment each one made, how much of it has turned into cost or stock, how much was given back, and what is still open. See "How a purchase reaches a project".

### How to read the list — Procurement
Projects → Execution & Progress → Procurement. Newest document first; 50 rows per page.
2. Choose a **Project** (المشروع) and press **Filter** (تصفية), or search by document number, supplier name or supplier reference in **Search this list** (ابحث في هذه القائمة).
3. Columns:
   - **Number** (الرقم) — click it to open the purchase order or the payable in Payables.
   - **Document** (المستند) — Purchase order (أمر شراء) or Payable (مستحق). A payable raised against a purchase order is not listed on its own: the order carries the commitment.
   - **Supplier Name** (اسم المورّد), **Date** (التاريخ).
   - **Project** (click to open the project record), **Element**, **Cost code**.
   - **Amount** (المبلغ) — the order's total (quantity × price of its lines), or the payable's amount in IQD.
   - **Committed** (الملتزم به) — what was promised against the element when the order was approved or the payable opened.
   - **Converted** (المحوَّل) — the part posted invoices have turned into project cost (services) or into stock (goods).
   - **Released** (المُفرَج عنه) — the open part given back when the document was cancelled.
   - **Open** (shown in Arabic as فتح) — Committed − Converted − Released: what still counts as Committed on the element.
   - **Status** (الحالة) — the order's status or the payable's stage.
4. With nothing assigned yet the list says "No order or payable is assigned to a project element yet." (لا أمر شراء ولا مستحق مخصص لعنصر مشروع بعد.)
An open amount here keeps the check "Open purchase orders and payables" open on the Close screen and blocks the settlement. Clear it by posting the remaining invoices or cancelling the order or payable in Payables.

## Material Issues (صرف المواد)
Projects → Execution & Progress → Material Issues   |   Arabic: المشاريع ← التنفيذ والتقدّم ← صرف المواد
Address: /projects/material-issues (one document: /projects/material-issues/<number>)
Needs: `view` on `project` to open; `create` to raise a document; `post` on `project` and `execute` on `inventory_movement` to post it; `edit_draft` to cancel a draft
What it is for: Taking stock from a warehouse to a project element — the moment bought goods become project cost — and bringing unused stock back. An issue leaves the warehouse at its FIFO cost (oldest stock first); a return comes back at the cost it went out at.

### How to find a material issue — Material Issues
Projects → Execution & Progress → Material Issues. Newest first; 50 rows per page.
2. Search by document number, project name or element code in **Search this list** (ابحث في هذه القائمة); filter by **Project** (المشروع) and **Status** (الحالة — Draft / مسودة, Posted / مرحّل, Cancelled / ملغى) and press **Filter** (تصفية).
3. Columns: Number (الرقم), Project, Element, Cost code, Warehouse (المخزن), Kind (النوع — Issue to project / صرف إلى المشروع, Return from project / إرجاع من المشروع), Date, Lines (السطور), Cost (التكلفة — filled once posted; negative for a return), Status.
4. Click the number to open the document.

### How to issue stock to a project — Material Issues
1. Press **New material issue** (صرف مواد جديد). The window says: "One item per document, as a stock transfer: the issue leaves the warehouse at FIFO cost when the document is posted; a return goes back at the cost typed."
2. Choose the **Element** (العنصر) and the **Cost code** (رمز التكلفة), and **Kind** (النوع) = **Issue to project** (صرف إلى المشروع).
3. Choose the **Warehouse** (المخزن), find the item in **Item Name** (اسم الصنف), type the **Quantity** (الكمية) and check the **Date** (التاريخ). Leave **Unit cost** empty.
4. Press **Create** (إنشاء). The document opens as a **Draft** with its number (PMI-…). Nothing has moved yet.
5. Check it and press **Post** (ترحيل). Needs the post permission on projects and the permission to move stock.
One document carries one item. For several items raise one document each. Pressing Create twice on the same form still gives one document.
Work in the project's own branch when you raise the document: the warehouse must belong to the branch of the project. A draft cannot be edited — if something is wrong, cancel it and raise a new one.

### How to return stock from a project — Material Issues
1. Press **New material issue** (صرف مواد جديد).
2. Choose the same **Element** and **Cost code** the stock was issued to, and **Kind** = **Return from project** (إرجاع من المشروع).
3. Choose the **Warehouse** it comes back to, the item and the **Quantity**.
4. Type the **Unit cost** (تكلفة الوحدة) — the cost per unit the stock went out at. Read it from the original issue: its Cost divided by its Quantity.
5. Press **Create**, then **Post** (ترحيل) on the document.
The stock comes back into the warehouse at that unit cost and the project's actual cost falls by quantity × unit cost.

### Fields — Material Issues
- **Element** (العنصر) — required. Active account-assignment elements, shown as "element code · name (project)". Projects that are Created are listed too, but the document is accepted only for a **Released** project.
- **Cost code** (رمز التكلفة) — required; the active cost codes (materials are usually MAT). The cost code must have a budget line on the project.
- **Kind** (النوع) — required: **Issue to project** (صرف إلى المشروع) or **Return from project** (إرجاع من المشروع).
- **Warehouse** (المخزن) — required; the active warehouses of the branch you are working in. It must be a warehouse of the project's branch, or the posting is refused.
- **Item Name** (اسم الصنف) — required; type to search and pick the item.
- **Quantity** (الكمية) — required; above zero.
- **Unit cost** (تكلفة الوحدة) — required for a return, in IQD, not negative. Ignored for an issue: an issue takes the cost of the stock layers it uses.
- **Batch** (الدفعة), **Serial number** (الرقم التسلسلي) — needed for an item that is tracked by batch or by serial number (the posting is refused without it); leave blank otherwise.
- **Date** (التاريخ) — required; today by default. It is the stock movement date and the posting date.
- **Description** (الوصف) — optional.

### How to open, post or cancel a document — Material Issues
1. Click the number on the list. The page shows Number, Status, Kind, Project (link), Name, Element, Cost code, Warehouse (link), Date, Cost, Raised by (رفعه), Posted by (رحّله), Cancelled by (ألغاه) with the reason, and the Description.
2. Lines: #, Item Code (رمز الصنف, a link to the item), Item Name, Quantity, Batch, Serial number, Unit cost — a posted issue shows "at layer cost" (بتكلفة الطبقة) — and Cost (filled once posted).
3. **Post** (ترحيل) — on a Draft, with the post permission.
4. To cancel a Draft: type the reason in "Why it is cancelled" (سبب الإلغاء) and press **Cancel** (إلغاء). Needs the edit-draft permission.
5. A Posted document cannot be cancelled or reversed. To undo an issue, post a **Return from project** for the same element, cost code and item.
6. The four icons in the title bar print it (Material Issue — صرف مواد), attach files, add notes and show the Audit log — see "The icons at the top of a record".

### After you save — Material Issues
- **Create** → **Draft** (مسودة): no stock movement, no cost.
- **Post** an issue → **Posted** (مرحّل). In one step:
  - the stock leaves the warehouse, oldest layers first, and the document's **Cost** becomes what those layers cost;
  - a cost line "Material issue" for that amount lands on the element and cost code (Actual rises, Available falls) — after passing availability control;
  - a journal is posted on the document date: debit the cost code's account (or, when the cost code names none, the account mapped for project material cost), credit the items' inventory account, carrying the project.
- **Post** a return → Posted: the stock is received back at the typed unit cost, a negative cost line "Material return" is written, and the journal runs the other way.
- **Cancel** → **Cancelled** (ملغى), with the reason; nothing was ever moved.
- A Draft left unposted blocks the project's settlement; post or cancel it.

### Refusals — Material Issues
- "status: … is draft; stock is issued to an active project" — the project is not Released. Have it released (or resumed) first.
- "Project … is 'on_hold': nothing can be issued to a project that is not active" (for a return: "stock cannot be returned to a project that is not active") — at posting; the project must be Released.
- "… / …: the element is not an account-assignment element — nothing posts to it" (or "the element is deactivated") — tick "Account-assignment element" on WBS, or choose another element.
- "line 1: a return names the unit cost the stock went out at" — type the Unit cost on a return.
- "line 1: the quantity is positive" / "'…' is not a quantity".
- "warehouse: there is no active warehouse '…'".
- "Cannot issue 10 of ITEM from WH: 4 is available. Negative inventory is prohibited without exception…" — not enough stock in that warehouse. Reduce the quantity, receive stock first, or issue from another warehouse (cancel this draft and raise a new one).
- "… / …: X is available and this needs Y — the stop line of 100 % is reached… Raise a supplement or a transfer, or have the stop line raised for this element with a reason." — the element has no budget left. See "Availability control".
- "MAT has X available and this needs Y… Raise a variation to increase the budget, or move the cost to a code that has room" — the cost code is out of budget across the project.
- "There is no budget line 'MAT' on this project." — that cost code was not in the project's approved original budget. Use a cost code that was.
- "Project … is '…': it is settled (PST-…); no further cost is taken." — the project's settlement is posted.
- "No accounting mapping is configured for the 'project_material_cost' line of 'projects.material_issue'…" — Finance must map the account in Accounting → General Ledger → Posting Mappings.
- "WH belongs to branch X, and this movement was raised under Y…" — the warehouse is not in the project's branch. Cancel the draft, switch to the project's branch and raise it again with one of that branch's warehouses.
- "ITEM is tracked by …, so this movement needs …" — the item needs its Batch or Serial number. Cancel the draft and raise it again with the field filled.
- "Permission denied: 'execute' on 'inventory_movement' is not granted to this user." — posting moves stock; ask an administrator for that permission or have a storekeeper post it.
- "status: PMI-… is posted; only a draft is cancelled — a posted issue is returned" — raise a Return from project instead.
- "reason: is required" — type why it is cancelled.

## Progress (التقدم)
Projects → Execution & Progress → Progress   |   Arabic: المشاريع ← التنفيذ والتقدّم ← التقدم
Address: /projects/progress (one project and day: /projects/progress?project=<project code>&as_of=<date>)
Needs: `view` on `project` to open; `edit_draft` to measure progress and cancel hours; `approve` to approve measurements, milestones and hours; `submit` to report a milestone reached; `create` to book hours; `post` on `project` and `view` on `employee_compensation` to post the month's labour
What it is for: How far the work has gone and what it is worth: earned value element by element to a chosen day, the progress measurements, the milestones and their trend, and the hours people worked on the project with the monthly labour posting.

### How to open and read earned value — Progress
Projects → Execution & Progress → Progress. The newest Released project is shown, as of today.
2. Choose the **Project** (المشروع) and the day in **As of** (حتى تاريخ), then press **Open** (فتح).
3. The table has one row per element; a parent's row is the sum of its own figures and its children's:
   - **Measured** (المقيس) — the element's own latest approved measurement up to the day.
   - **Budget** (الموازنة) — its current budget.
   - **Planned (BCWS)** (المخطط) — the current cost plan up to the day: whole earlier months, and the day's month in proportion to the days gone.
   - **Earned (BCWP)** (المكتسب) — approved percent × the element's own budget.
   - **Actual (ACWP)** (الفعلي) — the costs dated up to the day.
   - **% complete** (% الإنجاز) — Earned ÷ Budget.
   - **CPI** — Earned ÷ Actual. Below 1.00 the work costs more than it has earned. A dash while nothing is spent.
   - **SPI** — Earned ÷ Planned. Below 1.00 the work is behind the plan. A dash while nothing is planned to the day.
   - **EAC** (التقدير عند الإنجاز) — the estimate at completion: Actual + (Budget − Earned) ÷ CPI; with nothing spent, Actual + (Budget − Earned).
   - **VAC** (الفرق عند الإنجاز) — Budget − EAC; negative means an expected overrun.
4. Below the table: **Measurements** (القياسات), **Milestones** (المعالم), **Hours** (الساعات) and **Milestone trend** (اتجاه المعالم).
Only approved measurements count as earned. The Earned value report on Reports prints this table.

### How to measure progress — Progress
1. Press **Measure progress** (قياس التقدم). (Needs the edit-draft permission; the project must be Released, On hold or Technically complete.)
2. Choose the **Element** (العنصر) — any active element.
3. **Measured on** (تاريخ القياس) — required; today by default; not a future day.
4. **% complete** (% الإنجاز) — required; the element's cumulative percentage, 0 to 100.
5. **Note** (ملاحظة) — optional.
6. Press **Save** (حفظ). "Somebody other than you approves the measurement before it counts."
One measurement per element per day. A measurement cannot be edited or deleted; if it is wrong, leave it unapproved and measure again on another day — the latest approved measurement up to the "As of" day is the one that counts.

### How to approve a measurement — Progress
1. Open the project on Progress and find the row in **Measurements** (القياسات): Measured on (تاريخ القياس), Element, % complete, Measured by (قاسه), Approved by (اعتمده), Note ("From a milestone" — من معلم — when a progress milestone created it).
2. Press **Approve** (اعتماد) on the row. The button shows to a user with the approve permission who did not take the measurement — this applies to a Super User as well.
3. From then on the measurement counts in Earned, % complete, CPI, SPI and EAC, in the Forecast, and as the ceiling for certificates raised from measured progress (Billing).

### How to report a milestone reached and approve it — Progress
The **Milestones** (المعالم) table lists every milestone of the project: Code, Name, Element, Usage (الاستخدام), Progress % (نسبة التقدم), Scheduled (المجدول — its date from the last schedule run), Reached on (تاريخ البلوغ), Status.
1. On an Open milestone, set the day it was reached (today by default; not a future day) and press **Reached** (تم البلوغ). Needs the submit permission and a Released project. The status becomes **Reached — awaiting approval** (بُلغ — بانتظار الاعتماد).
2. A second person with the approve permission presses **Approve** (اعتماد) on the row. The person who reported it does not see the button — a Super User included.
3. The milestone becomes **Done** (منجز). Depending on its usage:
   - **Progress** (تقدم): a measurement of its Progress % is recorded on its element for the day it was reached, already approved (it replaces a measurement of that element on the same day).
   - **Billing** (فوترة): the billing-plan line that waits on it becomes Due on Billing.
   - **Date** (تاريخ): nothing else happens.
A milestone is added, changed or cancelled on WBS.

### How to book hours — Progress
1. Press **Book hours** (تسجيل ساعات). The window **Hours worked on an element** (ساعات عمل على عنصر) opens. (Needs the create permission. The button also shows on a Technically complete project, but hours booked then cannot be posted — book and post all hours while the project is Released.)
2. **Element** (العنصر) — required; active account-assignment elements.
3. **Employee** (الموظف) — required; an active employee.
4. **Worked on** (تاريخ العمل) — required; today by default; not a future day.
5. **Hours** (الساعات) — required; for example 7.5. More than 0 and at most 24; an employee's hours on one day, across all projects, cannot pass 24.
6. **Cost code** (رمز التكلفة) — required; LAB (Labour) by default.
7. **Note** (ملاحظة) — optional.
8. Press **Save** (حفظ). The line appears in the **Hours** table as **Booked** (مسجلة).
"Booked by one person, approved by another, and posted by Finance once the month has ended — at the base salary in force ÷ the calendar's working days ÷ 8."

### How to approve or cancel hours — Progress
The **Hours** (الساعات) table shows: Worked on (تاريخ العمل), Employee, Element, Cost code, Hours, Labour cost (تكلفة العمالة — filled once posted), Status.
Statuses: **Booked** (مسجلة) → **Approved** (معتمدة) → **Posted** (مرحّلة); or **Cancelled** (ملغاة).
1. To approve: press **Approve** (اعتماد) on a Booked line. Needs the approve permission; the button is not shown to the person who booked the hours.
2. To cancel a Booked or Approved line: type the reason in "Why it is cancelled" (سبب الإلغاء) and press **Cancel line** (إلغاء السطر). Needs the edit-draft permission.
3. A Posted line cannot be cancelled.
Hours that are Booked or Approved but not posted keep the check "Hours not posted" open on the Close screen and block the settlement; post the month or cancel the lines.

### How to post the month's labour — Progress
1. Open the project on Progress. Above the Hours table choose the **Month** (الشهر) — the twelve months before the current one are offered, last month first.
2. Press **Post the month's labour** (ترحيل عمالة الشهر). The button shows with the post permission on projects and the view permission on employee compensation. The month must have ended and the project must be Released: on a Technically complete project the button still shows, but the posting is refused.
3. What it does, for every **Approved** line of the project in that month:
   - the employee's hourly rate = the base salary in force at the month's end ÷ the working days of that month in the project's calendar ÷ 8;
   - labour cost = hours × rate; the line becomes **Posted** and shows its Labour cost;
   - one cost line "Labour <month>" (kind Labour) per element and cost code, dated the last day of the month, after passing availability control;
   - one journal dated the last day of the month: debit the cost code's account (or the account mapped for project labour), credit the labour absorption account, with a line per employee.
4. The run appears under the table in **Labour posted by month** (العمالة المرحّلة حسب الشهر): Month, Posted on (تاريخ الترحيل), Hours, Labour cost, Journal (القيد).
Hours approved after a run can be posted by running the same month again; only lines still Approved are picked up.

### The milestone trend — Progress
The last table, **Milestone trend** (اتجاه المعالم) — "Each milestone's date at every schedule run" — appears once the project has been scheduled at least once (WBS → Schedule).
- One row per milestone: Code, Name.
- One column per schedule run: **Run 1**, **Run 2**… (الدورة 1…) with the milestone's date in that run (the day it was reached, once it is).
- **Slip (days)** (الانزلاق (أيام)) — the latest date less the first date; a positive figure means the milestone has moved later.
Read across a row to see how a milestone's date moved from one schedule run to the next. The same table prints from Reports as "Milestone trend analysis".

### After you save — Progress
- A measurement is unapproved until a second person approves it; nothing is posted to the ledger by measuring or approving.
- A milestone: Open → Reached — awaiting approval → Done. Approval may record a measurement (progress milestone) or make a billing line Due (billing milestone).
- Hours: Booked → Approved → Posted. Only the monthly posting writes to the ledger and to the project's Actual.
- Measurements, their approval, hours and the monthly labour posting show in the project's Audit log (clock on the project record); milestone steps are recorded in the audit trail.

### Refusals — Progress
- "status: … is draft; progress is measured once it is released" — release the project first.
- "measured_on: … was already measured on <date>" — one measurement per element per day; choose another day.
- "measured_on: progress is measured on a day that has come" — no future dates.
- "percent_complete: a percentage is between 0 and 100".
- "You measured this progress, so somebody else approves it…" — ask another person with the approve permission.
- "status: … is on_hold; milestones are reached on an active project" — resume the project first.
- "status: A0030 is already reported reached or closed" / "is not waiting for approval".
- "approver: A0030 was reported reached by you; somebody else approves it".
- "status: … is on_hold; hours are booked on a released project" — resume the project first.
- "Project … is closing; nothing can be spent against a project that is not active" — the month's labour was posted on a Technically complete project. No cost is taken once a project is no longer Released: cancel the hours, or reopen the project (allowed once) and post them.
- "… / …: the element is not an account-assignment element — nothing posts to it" — choose another element or tick the switch on WBS.
- "employee: E-… is terminated" (or another status) — only active employees.
- "hours: a day holds more than 0 and at most 24 hours"; "An employee's day holds 24 hours; X are booked on <date> and this adds Y." — the employee's day is full across all projects.
- "approver: you booked these hours; somebody else approves them".
- "month: 2026-10 has not ended; its hours are posted at its end".
- "month: … has no approved hours in 2026-09 waiting to be posted" — approve the Booked lines first, or the month is already posted.
- "compensation: E-… has no compensation in force by <date>; HR records it before the hours are posted" — HR must record the employee's base salary.
- "Permission denied: 'view' on 'employee_compensation'…" — posting labour reads salaries; it needs that permission.
- The stop-line and cost-code refusals of "Availability control" also apply to the labour cost ("There is no budget line 'LAB' on this project." means LAB was not in the original budget).
- "No accounting mapping is configured for the 'project_labour' line of 'projects.timesheet'…" (or 'labour_absorption') — Finance maps the account in Accounting → General Ledger → Posting Mappings.

## Billing (الفوترة)
Projects → Billing & Close → Billing   |   Arabic: المشاريع ← الفوترة والإغلاق ← الفوترة
Address: /projects/billing (one project: /projects/billing?project=<project code>&period_end=<date>; one certificate: /projects/billing/<number>)
Needs: `view` on `project` to open; `edit_draft` to add or cancel billing-plan lines, cancel a draft certificate and attach files; `create` to raise a certificate; `approve` to approve and post a certificate; `post` to run revenue recognition
What it is for: Billing the customer of a customer project: the billing plan, the certificates raised from it or from measured progress, the contract's balances (certified, billed, retention, advance) and the period's revenue recognition. Internal and investment projects are not billed and do not appear here.

### How to open a project's billing — Billing
Projects → Billing & Close → Billing. The newest Released customer project is shown. With none the page says "There is no customer project to bill." (لا يوجد مشروع عميل للفوترة.)
2. Choose the **Project** (المشروع) — customer projects only — and, for revenue recognition, the **Period end** (نهاية الفترة; the last day of last month by default). Press **Open** (فتح).
3. Under the filter: the project's status, the link **Open the project record** and the customer's code and name.
4. **Billing plan** (خطة الفوترة) table: # (line number), Element, Description, Falls due (يستحق — the milestone or the date), Bills (يفوتر — "30 %" or Amount), Gross (الإجمالي), Due since (مستحق منذ), Status, Certificate (الشهادة — a link once billed), Actions.
   Line statuses: **Planned** (مخطط), **Due** (مستحق), **Billed** (مفوتر), **Cancelled** (ملغى).
5. **Certificates** (الشهادات): Certificate number (link), Certified on (تاريخ الشهادة), Raised from (صادرة عن — Billing plan / خطة الفوترة or Measured progress / التقدم المقاس), % complete, Gross, Retention (المحتجزات), Advance recovered (الدفعة المقدمة المستردة), Net (الصافي), Status, Journal (القيد).
6. **Contract balances** (أرصدة العقد) and **Revenue recognition** (الاعتراف بالإيراد) — see their own blocks.

### How to add or cancel a billing-plan line — Billing
1. Press **Add billing line** (إضافة سطر فوترة). The window **New billing-plan line** (سطر جديد في خطة الفوترة) opens. (Needs the edit-draft permission; not on a Closed project.)
2. **Element** (العنصر) — required; active billing elements only (tick "Billing element" on WBS if the list is empty).
3. **Description** (الوصف) — required; up to 200 characters.
4. **Falls due** (يستحق) — required: **On a billing milestone** (عند معلم فوترة) or **On a date** (في تاريخ).
5. **Billing milestone** (معلم الفوترة) — for a milestone line: a milestone of usage Billing that is not cancelled. One line per milestone.
6. **Due on** (يستحق في) — for a date line: the date.
7. **Bills** (يفوتر) — required: **Share of the contract** (نسبة من العقد) or **Amount** (مبلغ).
8. **Percentage or amount** (النسبة أو المبلغ) — required: a percentage of the contract (for example 30) or an amount in IQD.
9. Press **Save** (حفظ). The line is **Planned** — or **Due** at once if its date has come or its milestone is already reached and approved.
"A milestone line falls due when its billing milestone is reached and approved; a date line on its date. The plan never bills more than the contract value as it stands."
A percentage line always bills its share of the contract value as it stands (baseline plus approved change orders) on the day the certificate is raised.
To cancel a Planned or Due line: type the reason in "Why it is cancelled" (سبب الإلغاء) on its row and press **Cancel line** (إلغاء السطر). A Billed line cannot be cancelled. A line cannot be edited — cancel it and add a new one.

### How to raise a certificate from a due line — Billing
1. Open the project on Billing. The project must be **Released** (not On hold or Technically complete), and you need the create permission.
2. On a line whose status is **Due**, set the certificate date in the date box (today by default; not a future day and not before the day the line fell due).
3. Press **Raise certificate** (إصدار شهادة).
4. The certificate opens as a **Draft** with its number (PCT-…). The line becomes **Billed** and links to the certificate.
5. A second person approves the certificate (see "How to open, approve or cancel a certificate — Billing").
The gross is the line's amount, or its percentage of the contract value as it stands. Retention and advance recovery are worked out from the project's terms — see "What a certificate carries — Billing".

### How to certify measured progress — Billing
Use this when the contract is billed by progress rather than by a plan line.
1. Press **Certify progress** (شهادة بالتقدم). The window **Certificate from measured progress** (شهادة من التقدم المقاس) opens. (Needs the edit-draft and create permissions; the project must be Released.)
2. **Certified on** (تاريخ الشهادة) — required; today by default; not a future day.
3. **% complete** (% الإنجاز) — required: the cumulative percentage of the contract to bill up to, above 0 and at most 100. It may not exceed the approved measured progress on that date — the average of the latest approved measurement of each measured element (see Progress).
4. Press **Raise certificate** (إصدار شهادة).
"The certificate bills what the percentage reaches less what is already certified; retention is withheld and the advance recovered on the project's terms." Example: contract 100,000,000; 30 % certified before; typing 45 raises a certificate for 15,000,000 gross.

### What a certificate carries — Billing
Every certificate shows four amounts, worked out when it is raised from the terms typed on the project:
- **Gross** (الإجمالي) — what the certificate says the work is worth.
- **Retention** (المحتجزات) — Gross × the project's Retention %. Held back by the customer; it goes into the **Retention held** balance and is posted to its own receivable account.
- **Advance recovered** (الدفعة المقدمة المستردة) — Gross × the project's Advance recovery %, but never more than the **Advance outstanding** balance.
- **Net** (الصافي) — Gross − Retention − Advance recovered: what the customer is asked to pay now.
- **% complete** — the cumulative share of the contract certified, including this certificate.
All certificates together never exceed the contract value as it stands; raise a change order with a Contract change first if more is to be billed.
Limits of the screens today: there is no action to record an advance received from the customer, so Advance outstanding stays zero and Advance recovered is zero; and there is no action to release retention, so Retention held only grows (a draft certificate's retention is given back when the draft is cancelled). Retention still held keeps the check "Advance or retention outstanding" open on the Close screen.

### How to open, approve or cancel a certificate — Billing
1. Click the certificate number on Billing. The page shows: Certificate (number), Status, Raised from, Project (link), Name, Customer (link), Certified on, % complete, Billing-plan line (سطر خطة الفوترة), Journal (link, once posted), Raised by, Approved by; the totals Gross, Retention, Advance recovered, Net; and the lines **Retention and advance movements** (حركات المحتجزات والدفعة المقدمة).
2. To approve: press **Approve** (موافقة). Needs the approve permission; the button is not shown to the person who raised the certificate. Approval posts it in the same step.
3. To cancel a Draft: type the reason in "Why it is cancelled" (سبب الإلغاء) and press **Cancel** (إلغاء). Needs the edit-draft permission. The retention it withheld and the advance it recovered are given back, and its billing-plan line is **Due** again.
4. A **Posted** certificate cannot be cancelled or reversed on this screen.
5. The four icons in the title bar print it (Progress Certificate — شهادة الإنجاز), attach the signed measurement or the customer's acceptance, add notes and show the Audit log — see "The icons at the top of a record".
Statuses: **Draft** (مسودة) → **Posted** (مرحّل), or **Cancelled** (ملغى).

### After you save — Billing certificates
- **Raise certificate** → Draft. The retention and advance balances move at once; the ledger does not.
- **Approve** by a second person → **Posted**, with one journal on the certificate's own date:
  - debit the customer receivable, on the customer's account: Gross − Retention;
  - debit the retention receivable: Retention (when there is any);
  - credit project revenue: Gross.
  Every line carries the project and the customer. The advance recovered is not a journal line.
- A certificate is not a sales invoice: no invoice document is created in Receivables.
- The posted gross counts as **Billed** in Contract balances, in revenue recognition ("Billed to date") and on the Close screen.
- **Cancel** → Cancelled; the plan line is Due again.
- Draft certificates keep the check "Draft certificates" open on the Close screen.

### Contract balances — Billing
The table **Contract balances** (أرصدة العقد) — "Retention and the advance are balances of their own, not revenue" — shows for the chosen project:
- **Contract value (revised)** (قيمة العقد (المعدلة)) — the baseline contract value plus every approved change order's Contract change.
- **Certified** (المشهود به) — the gross of every certificate that is not cancelled (drafts included).
- **Billed (posted)** (المفوتر (المرحّل)) — the gross of posted certificates only.
- **Retention held** (المحتجزات المحجوزة) — retention withheld on certificates and not yet released.
- **Advance outstanding** (الدفعة المقدمة المتبقية) — advance received and not yet recovered.
The table is read-only.

### How to run revenue recognition — Billing
The section **Revenue recognition** (الاعتراف بالإيراد) shows, to the chosen Period end: Contract value (revised), Actual (ACWP), EAC (the Forecast's estimate at completion), **% complete by cost** (٪ الإنجاز بالتكلفة) = Actual ÷ EAC (at most 100 %), **Recognised to date** (المعترف به حتى التاريخ) = contract value × Actual ÷ EAC, **Billed to date** (المفوتر حتى التاريخ) = posted certificates to the day, and the difference: **To WIP (unbilled)** (إلى أعمال تحت التنفيذ (غير مفوترة)) when more is earned than billed, or **To deferred revenue** (إلى الإيراد المؤجل) when more is billed than earned.
1. Finance must first ratify the method on Project Settings. Until then the section says "The recognition method is not yet ratified by Finance… The figures are what would post; nothing posts until it is ratified on Project Settings." and there is no button.
2. Set **Period end** to the last day of an accounting period and press **Open**.
3. Press **Run recognition** (تشغيل الاعتراف). The button shows with the post permission, on a Released, On hold or Technically complete project, when that period has not been run yet.
4. What it posts: the earlier run still standing is reversed on the first day of this period; then the difference is posted on the period end — debit work in progress, credit revenue when earned is ahead; debit revenue, credit deferred revenue when billing is ahead. With no difference, no journal.
5. The run appears in **Recognition runs** (دورات الاعتراف بالإيراد): Period end, % complete by cost, Recognised to date, Billed to date, Adjustment (التسوية), Journal, Reversed on (عُكس في).
If the EAC is above the contract value the page warns: "…this is a loss contract. A provision for the loss is Finance's judgement and is not posted here." For a Created project: "Recognition starts once the project is released."

### Refusals — Billing plan and certificates
- "project: … is an internal project; only a customer project is billed".
- "wbs: … is not a billing element; the billing plan hangs on billing elements" — tick "Billing element" on WBS.
- "activity_code: is required" — a milestone line needs its Billing milestone. "due_on: is required" — a date line needs its date.
- "activity_code: A0030 already bills line 2; one line per milestone".
- "percent_of_contract: a percentage is above 0 and at most 100"; "amount: an amount line bills more than nothing".
- "billing_plan: the plan bills X and this line Y, above the contract value of Z" — the plan would bill more than the contract. Reduce the line, or raise a change order with a Contract change first.
- "status: line 2 is billed" — a billed line cannot be cancelled.
- "status: line 2 is planned; a certificate is raised from a due line" — the milestone is not reached and approved yet, or the date has not come.
- "certified_on: line 2 fell due on <date>; the certificate is not dated before it"; "a certificate is dated on a day that has come".
- "Project … is 'closing': certificates are raised against an active project." — after technical completion (or on hold) no certificate can be raised. Reopen (once) or resume the project, or cancel the line.
- "gross: X is certified and this adds Y, above the contract value of Z; a change order raises the contract before more is billed".
- "percent_complete: 40 % of the contract is X, and Y is already certified" — the percentage typed is not above what is already certified.
- "The certificate claims 40% against 25% of approved measured progress…" — measure and approve more progress on Progress first, or type a lower percentage.
- "approver: PCT-… was raised by you; somebody else approves it".
- "status: PCT-… is posted; only a draft certificate is cancelled" (or "…only a draft certificate is approved") — nothing more can be done to a Posted or Cancelled certificate here.
- "No accounting mapping is configured for the 'project_retention_receivable' line of 'projects.certificate'…" — Finance maps the account in Accounting → General Ledger → Posting Mappings.
- "Cannot post into <period>: the period is closed…" — the certificate's date falls in a closed period; cancel it and raise it with a date in an open period.

### Refusals — Billing revenue recognition
- "policy: the recognition method is not ratified by Finance (D-PM-1); nothing posts until it is — the figures show what would post" — ratify it on Project Settings.
- "status: … is not released; it has nothing to recognise".
- "status: … is settled (PST-…); its result stands and nothing more is recognised" — after the settlement is posted.
- "period_end: 2026-09-15 is not the last day of a period (September 2026 ends 2026-09-30)" — set Period end to the period's last day.
- "period_end: … is closed; recognition is posted before the close" — the accounting period is closed.
- "period_end: … is already recognised to 2026-09-30" — that period was run.
- "period_end: … is recognised to 2026-10-31; an earlier period is not run after a later one" — runs go forward in time only.
- "No accounting mapping is configured for the 'project_wip' line of 'projects.recognition'…" (or 'project_deferred_revenue') — Finance maps the account in Accounting → General Ledger → Posting Mappings.

## Forecast (التوقعات)
Projects → Billing & Close → Forecast   |   Arabic: المشاريع ← الفوترة والإغلاق ← التوقعات
Address: /projects/forecast (one project and day: /projects/forecast?project=<project code>&as_of=<date>)
Needs: `view` on `project` to open; `edit_draft` to type an estimate to complete
What it is for: A report of what the project will have cost when it is finished: per element the plan, the budget, what is committed, what is spent, the estimate to complete, the estimate at completion and the variance. The project manager may replace the formula's estimate to complete with a typed one. Revenue recognition on Billing uses this report's estimate at completion.

### How to read the report — Forecast
Projects → Billing & Close → Forecast. The newest Released project is shown, as of today.
2. Choose the **Project** (المشروع) and the day in **As of** (حتى تاريخ) and press **Search** (بحث).
3. One row per element; a parent's row includes its children. Columns:
   - **Plan** (الخطة) — the whole current cost plan of the element (all months).
   - **Budget** (الموازنة) — its current budget.
   - **Committed** (الملتزم به) — open commitments dated up to the day.
   - **Actual** (الفعلي) — costs dated up to the day.
   - **ETC** (التكلفة المتبقية) — the estimate to complete: what is still to be spent.
   - **EAC** (التقدير عند الإنجاز) — the estimate at completion = Actual + ETC.
   - **VAC** (الفرق عند الإنجاز) — Budget − EAC; negative means an expected overrun.
   - **ETC from** (مصدر التكلفة المتبقية) — **Formula (÷ CPI)** (المعادلة (÷ مؤشر أداء التكلفة)) or **Typed, <date>** (مُدخل، <التاريخ>).
4. The **Totals** (الإجماليات) row is the whole project (the top element).
5. The formula, for each element's own figures: the budget not yet earned, divided by the cost performance so far — (Budget − Earned) × Actual ÷ Earned; while nothing is both earned and spent, simply Budget − Earned; never below zero. Earned comes from approved progress measurements (Progress).
6. Under the report, **Typed estimates to complete** (التقديرات المدخلة للتكلفة المتبقية) lists every typed estimate: As of, Element, ETC, Reason (السبب), Raised by (رفعه). With none: "No estimate has been typed; the formula stands."

### How to type an estimate to complete — Forecast
1. Press **Set ETC** (تحديد التكلفة المتبقية). The window **Estimate to complete** (التكلفة المتبقية للإنجاز) opens. (Needs the edit-draft permission; the project must be Released, On hold or Technically complete.)
2. **Element** (العنصر) — required; any active element.
3. **As of** (حتى تاريخ) — required; today by default; not a future day. The estimate counts on reports dated on or after it.
4. **ETC** — required; the amount in IQD still to be spent on that element; zero or more.
5. **Reason** (السبب) — required.
6. Press **Save** (حفظ).
"The latest estimate dated on or before the report's day replaces the formula for that element; each is kept with its reason."
The typed figure replaces the formula for that element's own amounts only; its children keep their own estimates, which are added on top in the parent's row. An estimate cannot be edited or removed — type a newer one to replace it.

### After you save — Forecast
- A typed estimate needs no approval and posts nothing. It takes effect at once on every report dated on or after its As of day, and is written to the project's Audit log with its reason.
- The project's EAC changes with it, and with the EAC the "% complete by cost" and "Recognised to date" figures of revenue recognition on Billing — the next recognition run uses the new estimate.
- Earlier estimates stay listed under "Typed estimates to complete"; a report dated before the newest estimate still uses the one that was in force on that day.

### Refusals — Forecast
- "status: … is draft; the forecast is kept while it runs" — estimates are typed on a Released, On hold or Technically complete project.
- "as_of: an estimate is dated on a day that has come" — no future dates.
- "etc: an estimate to complete is not below zero".
- "etc: '…' is not an amount" — type a plain number.
- "reason: is required".
- The **Set ETC** button is missing — the project is Created or Closed, or you lack the edit-draft permission.

## Close (إغلاق المشروع)
Projects → Billing & Close → Close   |   Arabic: المشاريع ← الفوترة والإغلاق ← إغلاق المشروع
Address: /projects/close (one project: /projects/close?project=<project code>)
Needs: `view` on `project` to open; `approve` to mark technically complete, post a settlement and close the project; `create` to draft a settlement; `edit_draft` to cancel a draft settlement
What it is for: Ending a project in order: technical completion, the settlement of its cost (to an asset under construction for an investment project, to the result otherwise), and the close — with a checklist of everything that still stands in the way.

### How to open and read the checklist — Close
Projects → Billing & Close → Close. The newest Technically complete project is shown; if there is none, the newest Released one.
2. Choose the **Project** (المشروع) and press **Open** (فتح).
3. Under the filter: the status, the link **Open the project record**, and how the project settles: "Customer project — settles to the result" (مشروع عميل — يُسوّى إلى النتيجة), "Internal project — settles to the result" (مشروع داخلي — يُسوّى إلى النتيجة) or "Investment project — settles to the asset under construction" (مشروع استثماري — يُسوّى إلى أصل قيد الإنشاء).
4. The title counts what is left: "3 things stand in the way" or "nothing stands in the way" (لا شيء يعترض).
5. The checklist has ten rows with **Check** (الفحص), **Status** — **Clear** (خالٍ) or **Open** (قائم) — and **What stands** (ما هو قائم), the detail of an open check. See "The ten checks — Close".
6. Under it, once the project is Technically complete: **What the settlement would move** (ما ستنقله التسوية) and the **Settlement** (التسوية) table.
The order of work: while still Released, post the last supplier invoices and the month's labour and raise the last certificates → Technically complete → clear what is left (approve draft certificates, cancel unused billing lines, hours and open orders) → draft the settlement → a second person posts it → Close project.

### The ten checks — Close
1. **Open purchase orders and payables** (أوامر شراء ومستحقات مفتوحة) — "N purchase order(s) are still open." Cancel the order or payable in Payables (the Open column on Procurement shows which). An invoice that brings service cost to the project is only taken while the project is Released.
2. **Stock issued and not settled** (مخزون مصروف غير مسوّى) — "N stock item(s) issued to the project have not come back." Counts material-issue cost lines not yet settled. It clears when the settlement is posted.
3. **Cost not billed or settled** (تكاليف غير مفوترة أو مسوّاة) — "X of cost has not been billed." The project's cost lines not yet settled. It clears when the settlement is posted.
4. **Change orders not approved** (أوامر تغيير غير معتمدة) — "N variation(s) are waiting for approval." Every change order that is not Approved counts: Draft ones (give them their two approvals) and Rejected ones. The screens have no action to cancel a change order, so a rejected one keeps this check open — report it to the system administrator.
5. **Advance or retention outstanding** (دفعة مقدمة أو محتجزات قائمة) — "X of advance and Y of retention are unresolved." Both balances must be zero. The screens have no action to release retention, so retention withheld on posted certificates keeps this check open — report it to the system administrator.
6. **Open activities and milestones** (أنشطة ومعالم مفتوحة) — "open work: A0010, A0020". Record the actual finish or cancel on WBS; reach and approve milestones on Progress.
7. **Billing-plan lines not billed** (أسطر خطة فوترة غير مفوترة) — "N billing-plan line(s) are neither billed nor cancelled". Cancel the lines on Billing (a certificate can only be raised while the project is Released).
8. **Draft certificates** (شهادات مسودة) — "N certificate(s) are still drafts". Approve or cancel them on Billing.
9. **Hours not posted** (ساعات غير مرحّلة) — "N timesheet line(s) are not yet posted or cancelled". Cancel the lines on Progress. Posting the month's labour works only while the project is Released, so post it before technical completion (or reopen the project, which is allowed once).
10. **Settlement posted** (ترحيل التسوية) — "the settlement is not posted". Draft and post the settlement on this screen.

### How to mark a project technically complete — Close
1. Open a Released project on Close and press **Technically complete** (إكمال فني). (Needs the approve permission.) The same button is on the project record.
2. In the window **Technically complete** (إنجاز فني) type an optional **Note** (ملاحظة).
3. The window says: "No new commitment or issue is accepted after this; the cost of work already done, the final billing and the settlement still are." In practice the system is stricter than that note — see below.
4. Press **Technically complete** (إكمال فني). The status becomes **Technically complete** (مكتمل فنياً).
Before pressing, while the project is still Released:
- every activity must be Done or Cancelled and every milestone reached and approved, or cancelled;
- post the last supplier invoices and the month's labour — no cost line is taken on a project that is not Released;
- raise every certificate you still need — afterwards a draft certificate can still be approved, but a new one cannot be raised.
If something was missed, the project can be reopened once (project record → Reopen), as long as the settlement is not posted.

### How to draft, post or cancel the settlement — Close
The table **What the settlement would move** (ما ستنقله التسوية) previews it as of today: **Settles to** (تُسوّى إلى) — **Asset under construction** (أصل قيد الإنشاء) or **The result (P&L)** (النتيجة (الأرباح والخسائر)); **Cost rows not settled** (أسطر تكلفة غير مسوّاة); **Cost in the ledger** (التكلفة في الدفتر); **Billed to date**; **Recognition still standing** (اعتراف بالإيراد قائم). For an investment project a second table lists **The accounts the settlement credits** (الحسابات التي تقيّدها التسوية دائنة): Account (الحساب), Department, Moved (المنقول).
1. On a Technically complete project press **Draft settlement** (مسودة تسوية). (Needs the create permission; the button is hidden while the project already has a settlement that is not cancelled.)
2. **Settled on** (تاريخ التسوية) — required; today by default; not a future day. Date it on or after the project's last cost: only cost lines dated up to this day are settled.
3. **Note** (ملاحظة) — optional. Press **Save** (حفظ). The settlement appears in the **Settlement** table as a **Draft** with its number (PST-…).
4. A second person with the approve permission presses **Post** (ترحيل) on its row. The button is not shown to the person who drafted it.
5. To cancel a Draft: type the reason in "Why it is cancelled" (سبب الإلغاء) and press **Cancel** (إلغاء). Needs the edit-draft permission. A new one can then be drafted.
The Settlement table shows: Number, Settled on, Settles to, Cost in the ledger, Billed to date, Status (Draft / مسودة, Posted / مرحّل, Cancelled / ملغى), Journal (the settlement's and the recognition reversal's numbers), Raised by.
One settlement per project. A posted settlement cannot be cancelled or reversed, and the project can no longer be reopened.

### How to close the project — Close
1. Open the Technically complete project on Close. When every one of the ten checks is **Clear**, the button **Close project** (إغلاق المشروع) appears. (Needs the approve permission.)
2. Press it. In the window **Close the project** (إغلاق المشروع) type the **Note** (ملاحظة) — required.
3. Read: "Closed is final: the project and its elements refuse every posting from now on."
4. Press **Close project** (إغلاق المشروع). The status becomes **Closed** (مقفل).
The project record also has a Close project button (with a "Closing note" box) that shows as soon as the project is Technically complete; pressed too early it answers with the list of what still stands.

### After you save — Close
- **Technically complete** → the project refuses commitments, cost lines (supplier invoices with service cost, the month's labour), material issues and new certificates.
- **Draft settlement** → Draft; nothing is posted. A second person acts next.
- **Post** the settlement → **Posted**:
  - investment project: one journal on the Settled on date — debit the asset under construction (the mapped account), credit each expense account the project's cost was posted to, for the project's net cost in the ledger. The asset itself is capitalised afterwards by Finance.
  - customer or internal project: no cost journal — the cost stays in the result. If a revenue-recognition run is still standing it is reversed on the Settled on date, so work in progress and deferred revenue are cleared.
  - both: every cost line dated up to Settled on is marked settled (checks 2 and 3 clear), and the project takes no further cost.
- **Close project** → **Closed**, final. The record can no longer be edited and nothing more is posted.
- Technical completion, reopening and the close show in the project's Audit log (clock on the project record); the settlement's steps are recorded in the audit trail.

### Refusals — Close
- "status: … still has open work: A0010, A0020 — finish, reach or cancel it first" — at technical completion; see check 6.
- "status: … is active; a project is settled once it is technically complete" — mark it technically complete first.
- "settled_on: a settlement is dated on a day that has come" — no future date.
- "settlement: … already has settlement PST-… (draft); one per project" — post or cancel the existing one.
- "settlement: … still has cost on its way — 2 open commitment(s), 1 draft material issue(s), 3 timesheet line(s) not yet posted or cancelled; settle once it has arrived or been released" — clear what is named: cancel the open orders or payables in Payables (see Procurement), cancel the draft material issues, cancel the hours on Progress. To post any of them instead, the project must be reopened (allowed once), because nothing is posted to a project that is not Released.
- "approver: PST-… was drafted by you; somebody else posts it".
- "settlement: …'s cost in the ledger is -X; a negative cost is not capitalised" — an investment project whose expense is net negative; Finance must correct the entries first.
- "No accounting mapping is configured for the 'project_auc' line of 'projects.settlement'…" — Finance maps the asset-under-construction account in Accounting → General Ledger → Posting Mappings.
- "status: PST-… is posted; only a draft is cancelled".
- "close: … cannot be closed: …" followed by the open checks — work through "The ten checks — Close".
- "Project … is closing; nothing can be spent against a project that is not active" — a cost (labour, an invoice) was posted to a Technically complete project. Reopen the project (once) to post it, or cancel the source.
- "status: … is active; close is allowed from closing only" — the project is not Technically complete.
- "note: is required" — type the closing note.
- "reason: is required" — type why the settlement is cancelled.

## Reports (التقارير)
HR → Talent & Requests → Reports   |   Arabic: المشاريع ← المواهب والطلبات ← التقارير
Address: /projects/reports
Needs: `view` on `project` to open; `print` on `project` for the PDF copy; `export` on `project` for the Excel and Word copies
What it is for: The four project reports for one project, on screen and as a file. Read-only. The printed or exported copy carries exactly the figures the screen shows.

### How to run and print a report — Reports
HR → Talent & Requests → Reports. The newest Released project and the Cost report are shown.
2. Choose the **Project** (المشروع) and the **Report** (التقرير):
   - **Cost report (hierarchy)** (تقرير التكاليف (الهيكل))
   - **Line items** (بنود التكاليف)
   - **Milestone trend analysis** (تحليل اتجاه المعالم)
   - **Earned value** (القيمة المكتسبة)
3. Set **As of** (حتى تاريخ) — used by the Earned value report. For Line items press **Search** once, then **From** (من) and **To** (إلى) appear for the cost dates.
4. Press **Search** (بحث). The table is drawn; parents are shown above their indented children, and the last row is **Totals** (الإجماليات).
5. To print or export, open **Print / Export** (طباعة / تصدير) at the top and pick **PDF**, **Excel (.xlsx)** or **Word (.docx)** under English or العربية — the language of the copy is chosen there, whatever language your screen is in. The file downloads with the filters you set.
The menu shows only the formats you are allowed: PDF needs the print permission on projects; Excel and Word need the export permission.

### What each report shows — Reports
- **Cost report (hierarchy)** — printed as "Project Cost Report (Hierarchy)" (تقرير تكاليف المشروع (الهيكل)). One row per element in tree order: Element, Name, Budget, Committed, Actual, Available — each row its own figures plus its children's. Totals = the whole project. It always shows the position now; As of does not change it. The same figures as the tree on WBS.
- **Line items** — "Project Line Items" (بنود تكاليف المشروع). Every cost line of the project: Date, Element, Cost code, Kind (Invoice, Invoice reversed, Material issue, Material return, Labour), Description, Number (the invoice or material-issue number), Journal, Amount; Totals = the sum. Limited by From and To. The same lines as Project Costs for that project.
- **Milestone trend analysis** — "Milestone Trend Analysis" (تحليل اتجاه المعالم). One row per milestone: Code, Name, Status (Open, Done, Cancelled), its date at each schedule run (Run 1, Run 2…), Reached on (تاريخ البلوغ), Slip (days). Empty ("No milestones." — لا توجد معالم.) when the project has none.
- **Earned value** — "Earned Value Report" (تقرير القيمة المكتسبة). One row per element to the As of day: Element, Name, Budget, Planned (BCWS), Earned (BCWP), Actual (ACWP), % complete, CPI, SPI, EAC, VAC; Totals = the whole project. The same figures as the table on Progress; the columns are explained in "How to open and read earned value — Progress".
A very long Line items list should be narrowed with From and To before exporting: a file carries a limited number of rows and the export says so when it is passed.

## Project Settings (إعدادات المشاريع)
Path: Settings → Administration → Project Settings   |   Arabic: الإعدادات ← الإدارة ← إعدادات المشاريع
Address: /administration/project-settings
Needs: `view` on `project_setting` to open; `configure` on `project_setting` to add, deactivate or reactivate a row and to ratify the recognition method
What it is for: The set-up the Projects module reads: project types, tolerance profiles (the warning and stop lines), cost codes, and the revenue-recognition method that Finance ratifies. Rows are added and deactivated here; nothing is deleted.

### How the screen is laid out — Project Settings
Four windows, one under the other, each a table with the form to add a row under it (the forms show only with the configure permission):
1. **Project types** (أنواع المشاريع) — Code, Name (English), Name (Arabic), Kind, Active. Delivered: CUSTOMER Customer project (مشروع لعميل), INTERNAL Internal project (مشروع داخلي), INVESTMENT Investment project (مشروع استثماري).
2. **Tolerance profiles** (ملفات التسامح) — Code, names, Warn at % of budget, Stop at % of budget, Active. Delivered: STANDARD, warn at 90 %, stop at 100 %.
3. **Cost codes** (رموز التكلفة) — Code, names, Posts to account, Active. Delivered: MAT, LAB, SUB, EQP, OVH, FEE.
4. **Revenue recognition** (الاعتراف بالإيراد) — the method and whether it is ratified.
An existing row cannot be edited on this screen: its names, kind, percentages or account stay as saved. To change them, add a new row with a new code and deactivate the old one. A code cannot be reused.
In the **Active** (فعّال) column a user without the configure permission sees ✓ for an active row and — for an inactive one.

### How to add a project type — Project Settings
1. In **Project types**, under "New project type" (نوع مشروع جديد), type the **Code** (الرمز) — letters, digits, hyphens or underscores; it cannot be changed later.
2. Type **Name (English)** (الاسم (إنجليزي)) — required — and **Name (Arabic)** (الاسم (عربي)) — optional; the Arabic name is shown to Arabic users.
3. Choose the **Kind** (الصنف) — required:
   - **Customer — billed to a customer** (لعميل — يُفوتَر للعميل): needs a customer; has billing elements, a billing plan, certificates and revenue recognition.
   - **Internal — cost only, settles to the result** (داخلي — تكلفة فقط، يُسوَّى إلى النتيجة).
   - **Investment — settles to a fixed asset** (استثماري — يُسوَّى إلى أصل ثابت): at the close its cost moves to the asset under construction.
4. Press **Save** (حفظ). The type is offered at once in the New project form.
Note: two things recognise only the delivered type with the code CUSTOMER — the Contracts list, and the Contract change of a change order. A project of another customer-kind type is billed normally on Billing but is not listed on Contracts and refuses a Contract change.

### How to add a tolerance profile — Project Settings
1. In **Tolerance profiles**, under "New tolerance profile" (ملف تسامح جديد), type the **Code**, **Name (English)** (required) and **Name (Arabic)**.
2. **Warn at % of budget** (تحذير عند ٪ من الموازنة) — required; 90 by default. Above zero and not above the stop line.
3. **Stop at % of budget** (إيقاف عند ٪ من الموازنة) — required; 100 by default. At most 200. A stop line above 100 lets every element of the projects using this profile overspend up to that percentage.
4. Press **Save** (حفظ).
"Availability control reads the project's profile: at the warning line the responsible person and the project manager are told; at the stop line the commitment or posting is refused."
The profile is chosen on each project (New project form, or **Edit** on the project record). See "Availability control (warning and stop lines)".

### How to add a cost code — Project Settings
1. In **Cost codes**, under "New cost code" (رمز تكلفة جديد), type the **Code**, **Name (English)** (required) and **Name (Arabic)**.
2. **Posts to account** (يُرحَّل إلى حساب) — optional. A postable expense or asset account. When it is filled, a material issue or a month's labour posted with this cost code debits this account; when it is empty, the account mapped for project material cost or project labour is used.
3. Press **Save** (حفظ). The cost code becomes a column in the budget and change-order grids and a choice on the Cost Plan, material issues, hours and purchase invoices.
Remember that a project can spend against a cost code only if the code carried an amount in the project's approved original budget.

### How to deactivate or reactivate a row — Project Settings
1. In the **Active** column of the row, type the **Reason** (السبب) and press **Deactivate** (تعطيل).
2. To bring it back press **Activate** (تفعيل) on the same row.
What deactivating does:
- A deactivated **type** is no longer offered for new projects. Take care: existing projects of that type then refuse new or edited WBS elements ("type: project type '…' is deactivated") until the type is activated again.
- A deactivated **tolerance profile** is no longer offered on the project forms; projects already using it keep its lines.
- A deactivated **cost code** disappears from the grids and lists; a document naming it is refused ("cost code … is deactivated").
Every change is written to the audit trail with the reason.

### How to ratify the revenue-recognition method — Project Settings
1. In **Revenue recognition** the table shows the code DEFAULT, the **Method** (الطريقة) — "Percentage of completion, cost to cost, at period end" (نسبة الإنجاز، التكلفة إلى التكلفة، في نهاية الفترة) — and **Ratified** (المصادقة): **Not ratified** (غير مصادق عليها) or **Ratified** (مصادق عليها) with who ratified it and their note.
2. Read the note: recognised revenue to date is the contract value × actual cost ÷ estimate at completion; the period journal posts the difference from what was billed to work in progress or deferred revenue and is reversed next period. "Nothing posts until Finance ratifies the method."
3. In **Reason** (السبب) type the decision this rests on — for example the Finance committee minute. Required.
4. Press **Ratify the method** (المصادقة على الطريقة).
From then on **Run recognition** is offered on Billing. Ratifying is done once: the form disappears afterwards and there is no action to undo it.

### After you save — Project Settings
- A new type, tolerance profile or cost code is active at once; nothing needs approval and nothing is posted.
- Deactivating and reactivating take effect at once and are written to the audit trail with the reason.
- Ratifying the recognition method takes effect at once for every customer project: **Run recognition** appears on Billing for users with the post permission.

### Refusals — Project Settings
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — the code has a space or another character.
- "code: '…' is already a project type" (or "is already a profile", "is already a cost code") — the code exists, active or not. Existing rows cannot be edited; choose a new code.
- "name_en: is required" — type the English name.
- "kind: is customer, internal or investment" — choose the Kind.
- "percent: warn is above zero, at most the stop line, and the stop line is at most 200" — correct the two percentages.
- "reason: say why it is deactivated" — type the reason before pressing Deactivate.
- "policy: the recognition method was ratified on <date>" — it is already ratified.
- "note: is required" — type the decision before pressing Ratify the method.
- "Permission denied: 'configure' on 'project_setting' is not granted to this user." — ask an administrator for the permission.

## Opportunities (الفرص)
Projects → Projects & Planning → Opportunities   |   Arabic: المشاريع ← المشاريع والتخطيط ← الفرص
Address: /projects/opportunities
Needs: `view` on `project`
What it is for: The second step of Leads → Opportunities → Projects. It lists every Project Initiation record that is past the first stage of its road and is not yet a project: a direct sale from the Pre-Sales Form on, a tender from Go / No-Go on, a financed customer from the quotation on. A lost record stays here with its reason. A record converted into a project leaves this list and is on Project Master. The page refreshes by itself (the green **Live** badge, مباشر) when somebody changes a record.

### How to find a client — Opportunities
1. Type part of the number, the customer's name, the phone or the city in the search box.
2. Narrow it with **Type**, **Stage** and **Status** (Open or Lost), then press **Filter**.
3. Click the number to open the record; everything is done there.

### Fields — Opportunities
- **Number** — the record's PIN- number; the same number it had as a lead.
- **Stage** — the stage it stands at, numbered as its road numbers it.
- **City**, **Owner**, **Value** (the contract, else the quotation or proposal, else the bid price), **Last update** (newest first), **Status**.

## Pipeline Board (لوحة المسار)
Projects → Projects & Planning → Pipeline Board   |   Arabic: المشاريع ← المشاريع والتخطيط ← لوحة المسار
Address: /projects/pipeline
Needs: `view` on `project`
What it is for: Every client as a card with its own number, in the column where it stands — **Leads**, **Opportunities**, **Projects** (converted in the last 30 days) and **Lost** (lost in the last 30 days). Choose a **Type** and the columns become that road's stages (for a financed customer: Customer, Quotation Sent, Bank Approval, Loan — First Payment, Installation, Contract, Loan — Fully Granted). The board updates by itself every few seconds when anything on it moves, so it can stay open on a screen. It only shows; every change is made on the record.

### How to watch your own clients — Pipeline Board
1. Choose **Owner → Mine** and press **Filter**.
2. Leave the page open: a card moves to its new column by itself when the record moves.
3. Click a card's number to open the record.

## Updates on a record (التحديثات)
Every Project Initiation record has an **Updates** section under its stages: each change — opened, a stage's form saved and what it changed (the customer's answer, the bank's answer, the loan, the installation), moved to the next stage, a note, a BOQ line, lost or converted — with who did it and when, newest first. The record page refreshes by itself when somebody else changes it (the green **Live** badge); it does not refresh while you are typing or have a window open — the badge turns amber and the page catches up when you are done.
