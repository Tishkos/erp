# HR — user guide

The HR module keeps one record per person and everything that hangs on it. Work flows in this order:
a person enters the register (**Employees**, a hire from **Recruitment**, or a new user ticked "Also an employee") and is seated in the structure (**Departments**, **Positions**);
their salary and pay components are set on the employee record; each day is recorded on **Attendance** and time off is asked and decided on **Leave Management**;
once a month **Payroll** computes a run from those facts, and it is approved, posted to the ledger and paid; **Advances & Loans** are recovered through that payroll, and **Employee Requests** carry expense claims, trips, letters and other requests;
**Performance** and **Documents** complete the person's file; **Dashboard** and **Reports** read it all; **HR Settings** (under Settings → Administration) holds the pay components, leave types, working calendars, review cycles and reminder limits everything else reads.

## Concepts — HR

Ideas shared by every HR screen. Each screen's own block refers to these by name.

### Where the HR screens are — HR
- Top menu **HR** → heading **Human Resources** (الموارد البشرية). In Arabic the module button also reads "HR".
- The screens, in menu order: **Dashboard** (لوحة المعلومات) /hr/dashboard, **Employees** (الموظفون) /hr/employees, **Departments** (الأقسام) /hr/departments, **Positions** (المناصب) /hr/positions, **Attendance** (الحضور) /hr/attendance, **Leave Management** (إدارة الإجازات) /hr/leave, **Payroll** (الرواتب) /hr/payroll, **Advances & Loans** (السلف والقروض) /hr/advances, **Recruitment** (التوظيف) /hr/recruitment, **Performance** (الأداء) /hr/performance, **Employee Requests** (طلبات الموظفين) /hr/requests, **Documents** (المستندات) /hr/documents, **Reports** (التقارير) /hr/reports.
- **HR Settings** (إعدادات الموارد البشرية) is not in the HR menu: it is under **Settings** (الإعدادات) → **Administration** (الإدارة) → **HR Settings**, address /administration/hr-settings.
- Every HR list screen shows a row of tabs under its title with the other HR screens you are allowed to open; a screen you may not view is not offered.
- A menu item or tab appears only if you are allowed to view that screen. Opening the address without that right shows **Not available to you** (غير متاح لك): "You do not have permission to open this screen."

### Who does what (roles and permissions) — HR
The system decides by permission, not by job title. As delivered (an administrator can change this on the Roles screen):
- **HR Officer** — keeps the register: may view, create and edit drafts on employees, organisation, leave, attendance, advances, equipment, recruitment, reviews, requests and documents; reads HR Settings and the HR reports. Sees no salary.
- **HR Manager** — everything the HR Officer does, plus: suspends, ends and links employees; reads and sets salary and pay components; changes HR Settings; decides leave and cancels granted leave; prepares and sends payroll runs; endorses advances; opens vacancies and hires; signs off reviews; decides employee requests.
- **Accounting Manager** (Finance) — reads employees, salary, leave, attendance; approves, posts, pays and reverses payroll; approves and pays advances and records cash repayments; reimburses expense claims.
- **CEO** — reads most HR records and may approve a payroll run.
- **The person** (an employee whose record is linked to a sign-in) and **their manager** get a few rights without any permission: see "The manager link — HR".
- A **Super User** passes every permission check.
Needs: each screen's own "Needs" line names the exact permission for each action.

### The manager link — HR
- An employee record has a **Manager** (المدير) field naming another employee. If that manager's own employee record is linked to a sign-in, the system treats that signed-in user as "the manager" of the person.
- The manager, through this link alone (no permission needed), may: approve or refuse the person's leave; endorse or refuse the person's advance or loan; approve or refuse the person's employee request; is the default reviewer of the person's performance review.
- The manager and the person can open the person's own leave requests, advances and employee requests.
- If a person has no manager, or the manager has no sign-in, the HR managers are told instead and decide with their permission.
- Set or change the manager on the employee record: **Move** (نقل) → **Manager** (المدير).

### Maker-checker (who may not decide) — HR
The person who raised something, and the person it is about, never decide it:
- **Leave** — not decided by whoever entered the request, nor by the person on leave. This holds for a Super User too.
- **Advances & Loans** — endorsed and approved by neither the requester nor the person; the approver is also not the endorser. Holds for a Super User too.
- **Employee Requests** — decided by neither the asker nor the person; a person never reimburses their own claim or issues their own letter. Holds for a Super User too.
- **Performance** — signed off by neither the reviewer nor the person reviewed. Holds for a Super User too.
- **Payroll** — approved by neither the preparer nor the sender. Exception written into the system: a **Super User may approve a run they prepared or sent**.
When you are the blocked person the screen shows a note such as "You asked for this, endorsed it, or it is yours; somebody else takes the next step." and the button is not drawn.

### The icons at the top of a record (printer, paperclip, notes, clock) — HR
In the title bar of an HR record there are up to four small icons:
- **Printer — Print / Export** (طباعة / تصدير): opens a window with the copy in **English** and **العربية**, each as **PDF**, **Excel (.xlsx)** and **Word (.docx)**. PDF needs the right to print that kind of record, Excel and Word the right to export it; a format you may not take is not offered. A payslip, an employee document, a performance review and an employee request can also be printed by the person they are about. Pressing Ctrl+P on a payroll run or a payslip prints the same sheet. A copy taken before the record reached its final step (for example a leave request not yet approved, an advance not yet paid out) carries the mark "DRAFT / NOT POSTED" (مسودة / غير مرحّل).
- **Paperclip — Attachments** (المرفقات): the files kept on the record, with a count; click a file's name to open it. To add one: press the paperclip → **Choose a file** (اختر ملفاً) → **Attach** (إرفاق). Up to 25MB; programs and archives are refused: "<file> was not accepted: files ending .zip are not accepted", "…it is <N>MB; the limit is 25MB.", "…it is named .pdf but its content is image/png. The name and the file disagree." Attaching needs the right to create attachments and that the record is still open for files (each screen says when).
- **Speech mark — Notes** (الملاحظات): what people have said about the record — When (متى), Who (من), Note (ملاحظة), newest first. To add one: press the icon → type in **Add note** (إضافة ملاحظة) → **Add note**. A note is dated, signed and can never be edited or deleted; at most 2,000 characters. Adding needs the right to edit drafts of that kind of record.
- **Clock — Audit log** (سجل التدقيق): everything that happened to the record — who, when, what changed.
Which records have which: advance, leave request, payroll run, vacancy, applicant, review, employee request and document have all four. The employee record has Notes and the clock. A payslip has the printer only (its papers, notes and history are the run's). Department and Position records have an **Audit log** link that jumps to the log at the foot of the page.
Needs: printer — `view` plus `print` (PDF) or `export` (Excel, Word) on the record's object; paperclip — `create` on `attachment`; notes — `edit_draft` on the record's object (`recruitment` for a vacancy or an applicant); the clock needs nothing more than opening the record.

### Lists: search, View filter, pages — HR
- The HR registers (Employees, Departments, Positions, Leave Management, Payroll, Advances & Loans, Recruitment, Performance, Employee Requests, Documents) have a search box (**Search this list** — ابحث في هذه القائمة) and **Clear** (مسح). It finds the record number and the person's number and name; each screen's block says what else.
- Under it a **View** (العرض) filter chooses one status (some screens add a second filter), then **Filter** (تصفية).
- Leave Management, Payroll, Advances & Loans, Recruitment, Performance, Employee Requests and Documents show 50 rows a page; **Previous page** (الصفحة السابقة) / **Next page** (الصفحة التالية) move between pages, and what waits for somebody is listed first. Employees, Departments and Positions show every row on one page.
- You see only people and records of the branches you work in.
- Click the number in the first column (Reference — المرجع) to open a record. **Back to list** (العودة إلى القائمة) returns.

### Messages and refusals common to every HR screen — HR
- After a successful save the page shows **Saved.** (تم الحفظ.).
- A refused save shows **That could not be saved.** (تعذّر الحفظ.) followed by the reason. The reason is in English in both languages and often starts with the field's internal name, for example "hire_date: must be a day, written YYYY-MM-DD".
- "Permission denied: '<action>' on '<object>' is not granted to this user." — you lack that permission; ask an administrator to grant it to your role.
- "Out of scope: this user has no access to branch '<code>'." — the record belongs to a branch you do not work in.
- "<field>: is required" — a required box was left empty. "<field>: must be a day, written YYYY-MM-DD" — a date is missing or mistyped.
- "Not a decimal value: "1,500,000"" — an amount was typed with commas or letters; type digits only (1500000).
- Numbers (EMP-…, LVE-…, PAY-…) are given by the system when you save; they cannot be typed or changed. Nothing in HR is deleted: records are cancelled, ended, withdrawn or deactivated with a reason.

### Posting to the ledger — HR
Three HR actions write a journal entry, and one more for each payment:
- **Payroll → Post**: one journal dated the last day of the month (salary expense and employer cost by department; deductions owed; advances recovered; net pay owed to the people). **Payroll → Pay**: one journal per payment (net pay owed → the bank or cash account). **Payroll → Reverse**: the run's journal mirrored, dated today.
- **Advances & Loans → Pay out**: employee advances ← the bank or cash account. **Repaid in cash**: the reverse.
- **Employee Requests → Reimburse**: each expense line to its expense account, by the person's department ← the bank or cash account (and the trip's advance, when the claim settles one).
Refusals that come from the ledger, the same on all of them:
- "No accounting mapping is configured for the '<line>' line of '<event>'… Configure the mapping in Accounting Mapping" — Accounting has not yet said which account that line posts to. Ask the accountant to map it, then repeat the action.
- "No accounting period covers <date>, so nothing can be posted on that date yet. Open the year first: Accounting → General Ledger → Accounting Periods, then "Open a year"."
- "Cannot post into <period>: the period is closed…" — the date falls in a closed period; use a date in an open period, or ask Finance.
- "<account> (<code>) would hold <amount> IQD, and a bank or cash account cannot hold less than nothing. Deposit or draw the money first, or pay from an account that holds it." — the chosen account does not hold enough money.
All HR money is in Iraqi dinars; paying accounts offered are the active IQD bank and cash accounts.

### Morning reminders — HR
Once a day, in the morning, the system checks the HR records and sends an in-app notification, each case once:
- a contract or daily engagement ending within the limit → the HR managers;
- a leave request waiting longer than the limit → whoever may decide it;
- near the year end, unused leave that will not carry over (leave types marked "Warn before it lapses") → the HR managers and the person;
- an advance or loan behind its recovery schedule → the HR managers, once a month;
- an open vacancy past its closing day → the HR managers;
- an employee document expiring within the limit, or expired → the HR managers and the person.
The limits (days) are set on Settings → Administration → HR Settings → **Limits for the morning sweep** (حدود المراجعة الصباحية).

## Dashboard (لوحة المعلومات)
Path: HR → Human Resources → Dashboard   |   Arabic: HR ← الموارد البشرية ← لوحة المعلومات
Address: /hr/dashboard
Needs: `view` on `hr_report` to open it. The Payroll cost band also needs `view` on `payroll_run`; the Advances & Loans band needs `view` on `employee_advance`; "Reviews in progress" counts only with `view` on `performance_review`; "Documents expiring" counts only with `view` on `employee_document`.
What it is for: A read-only page titled **HR Dashboard** (لوحة الموارد البشرية): the people and what waits for HR today. Nothing is typed here; every figure is a link to the screen that proves it. Figures count only the branches you work in.

### How to read the bands — Dashboard
1. Open HR → Human Resources → Dashboard. The subtitle shows today's date.
2. Band **People** (الأشخاص), with the link **Open Employees** (فتح الموظفين):
   - **Headcount** (عدد الموظفين) — employees whose status is Active or Suspended. Click → Employees.
   - **Joined this month** (انضموا هذا الشهر) — hire date from the 1st of this month to today. Click → Reports, Headcount.
   - **Left this month** (غادروا هذا الشهر) — end date from the 1st of this month to today. Click → Reports, Headcount.
   - **On leave today** (في إجازة اليوم) — people with an approved leave that covers today. Click → Leave Management.
   - A small table: **Department** (القسم) and its **Headcount**, largest first.
3. Band **Waiting** (بالانتظار):
   - **Leave to decide** (إجازات تنتظر القرار) — leave requests waiting for a decision. Click → Leave Management filtered to those.
   - **Requests open** (طلبات مفتوحة) — employee requests waiting for a decision, plus approved expense claims not yet reimbursed and approved letters not yet issued. Click → Employee Requests.
   - **Open vacancies** (شواغر مفتوحة). Click → Recruitment, open ones.
   - **Reviews in progress** (تقييمات جارية) — reviews that are Draft or Rated in an open cycle. Click → Performance.
   - **Documents expiring** (مستندات تنتهي) — valid documents whose expiry date is within the warning limit or already past. Click → Documents, expiring.
   A figure above zero for leave, requests and documents is shown as a warning.
4. Band **On leave today** (drawn only when somebody is): **Employee** (الموظف) — the number opens the leave request — **Leave** (الإجازة), **Until** (حتى). Link **Open Leave Management** (فتح إدارة الإجازات).
5. Band **Payroll cost** (كلفة الرواتب) (only with the payroll permission, and only when a run was posted): the last six months that have posted or paid runs — **Month** (الشهر), **People** (الأشخاص), **Gross pay** (إجمالي الأجر), **Employer cost** (كلفة صاحب العمل). A month opens the payroll register for it. Link **Open the payroll register** (فتح سجل الرواتب).
6. Band **Advances & Loans** (السلف والقروض) (only with the advances permission): **Still owed** (المتبقي) — everything still to come back on advances and loans that were paid out. Link **Open unsettled advances** (فتح السلف غير المسوّاة).

### Refusals — Dashboard
- **Not available to you** (غير متاح لك) — you lack the right to view HR reports (see Needs). Ask an administrator.
- A band is missing — that is not an error: the Payroll cost and Advances bands need their own permissions, and "On leave today" is drawn only when someone is on leave.

## Employees (الموظفون)
Path: HR → Human Resources → Employees   |   Arabic: HR ← الموارد البشرية ← الموظفون
Address: /hr/employees   (a record: /hr/employees/<employee number>, for example /hr/employees/EMP-HQ-0001)
Needs: `view` on `employee` to open the list and a record; `create` on `employee` for New employee. On the record: `edit_draft` on `employee` for Edit details, Move and adding a note; `administer` on `employee` for Suspend, Reinstate, End employment and Link sign-in; `view` on `employee_compensation` to see Compensation and Pay components and `create` on `employee_compensation` to add rows to them; `view` on `leave_request` to see the leave sections and `administer` on `leave_request` for an opening balance or correction; `view` on `attendance` for the month; `view` on `payroll_run` for payslips; `view` on `employee_advance` for advances; `view` on `employee_asset` for equipment, `create` on it to hand out and `edit_draft` on it to take back; `view` on `performance_review`, `employee_document`, `employee_request` and `recruitment` for those sections.
What it is for: One record per person — who works here, in which branch, department and position, under which manager, with every dated change kept as history. The record is also the place where the person's salary, pay components, leave balances, equipment and everything else HR holds about them is read.

### How to find an employee — Employees
1. Open HR → Human Resources → Employees.
2. Type part of the number or name in **Search this list** (ابحث في هذه القائمة) and press Enter; **Clear** (مسح) empties it. The search looks in every column of the list.
3. Or narrow the list: **View** (العرض) → **All** (الكل), **Active** (الفعّالون), **Suspended** (الموقوفون), **Ended** (المنتهون); **Department** (القسم) → one department; then **Filter** (تصفية).
4. Columns: Reference (المرجع), Name (الاسم), Department (القسم), Position (المنصب), Manager (المدير), Hire date (تاريخ التعيين), Employment (نوع التوظيف), Status (الحالة).
5. Click the number in the first column to open the person's record.
Needs: `view` on `employee`. You see only employees of the branches you work in.

### How to add an employee — Employees
1. Open HR → Human Resources → Employees and press **New employee** (موظف جديد).
2. Fill **Full name (English)** (required), choose the **Department** (required), the **Hire date** (required, today by default) and the **Employment** kind; the other boxes are optional (see "Fields — Employees").
3. Press **Create** (إنشاء).
4. The record opens with **Saved.** The system has given the number (EMP-<branch>-<serial>), set the status to **Active** (فعّال) and written the first history rows. The employee belongs to the branch you are working in.
5. Next, on the same record: add the address and emergency contact with **Edit details**, set the salary under **Compensation**, and link a sign-in if the person uses the system.
Needs: `create` on `employee`. The button is not shown without it.

### How a new user becomes an employee — Employees
1. When an administrator creates a user under Settings → Administration → Users → **New user** (مستخدم جديد), the box **Also an employee** (موظف أيضاً) is ticked by default.
2. With it ticked, saving the user also creates an employee record, linked to that sign-in: name = the user's display name, branch = the user's default branch, department = **Employee's department** (قسم الموظف) or, left empty, the first department ticked for the user, position = **Employee's position** (منصب الموظف) if chosen, hire date = today, employment = Permanent.
3. HR then completes the rest (national ID, manager, salary…) on the employee record.
4. Untick the box for a sign-in that is not a person on the staff (a service account, an auditor).
Needs: `create` on `app_user` (the Users screen); no HR permission is needed for this.

### How to open an employee record and what it shows — Employees
1. Open HR → Human Resources → Employees and click the employee's number.
2. Top window **Employees** with the number: Reference, Status, Full name (English), Full name (Arabic), National ID, Date of birth, Phone, Branch, Department, Position, Manager, Hire date, **Hired from** (عُيّن من — the application, when the person came through Recruitment), Employment, **Contract ends** (نهاية العقد — when set), End date and End reason (when ended), **Sign-in** (حساب الدخول — the linked user's e-mail or "— not linked —"), Address, Emergency contact.
3. Under it, the lines **History** (السجل): Effective (من تاريخ), What changed (ما تغيّر), Before (قبل), After (بعد), Reason (السبب), Recorded (سُجّل), By (بواسطة). One row per dated change: Hired, Branch, Department, Position, Manager, Status, Employment, Contract end, Employment ended, "Salary (see compensation)" (that the salary changed — never the figure), "Pay component <code>".
4. At the foot of that window, the buttons you are allowed: **Edit details** (تعديل البيانات), **Move** (نقل), **Suspend** (إيقاف), **Reinstate** (إعادة), **End employment** (إنهاء الخدمة), **Link sign-in** (ربط حساب الدخول).
5. Below, one window each, shown only if you hold the permission to see it: **Compensation** (التعويضات), **Pay components** (مكوّنات الراتب), **Payslips** (قسائم الراتب), **Advances & loans** (السلف والقروض), **Equipment held** (العُهد), **Performance reviews** (تقييمات الأداء), **Documents** (المستندات), **Requests** (الطلبات), **Leave <year>** (الإجازات), **Leave requests** (طلبات الإجازة), **Attendance <month>** (الحضور).
6. Numbers in those windows (payslip, run, advance, review, document, request, leave request) are links to their own records.
7. In the title bar: the **Notes** icon and the **Audit log** clock (see "The icons at the top of a record — HR").
8. For a person whose employment has ended, a line at the top says what is still open: "Clearance: N items are still out, and X is still owed on advances."
Needs: `view` on `employee`; each lower window needs its own `view` permission (see the Needs line of this screen).

### How to correct personal details — Employees
1. Open the employee record and press **Edit details** (تعديل البيانات).
2. Change Full name (English) (required), Full name (Arabic), National ID, Date of birth, Phone, Emergency contact, Address.
3. Press **Save** (حفظ).
These are corrected in place: the change is kept in the Audit log (clock icon) but adds no History row.
Needs: `edit_draft` on `employee`.

### How to move an employee (department, position, manager, employment, contract end) — Employees
1. Open the employee record and press **Move** (نقل). The button is not shown for a person whose employment has ended.
2. Change only what moves: **Department** (القسم), **Position** (المنصب), **Manager** (المدير), **Employment** (نوع التوظيف), **Contract ends** (نهاية العقد). Leave a field as it is to keep it. Choosing "— none —" clears the position or the manager; emptying Contract ends clears it.
3. Set **Effective from** (يسري من) — the day the change takes effect (today by default) — and optionally a **Reason** (السبب).
4. Press **Save** (حفظ). Each field that changed becomes one dated History row with its before and after.
Needs: `edit_draft` on `employee`.

### How to suspend, reinstate or end an employment — Employees
1. Open the employee record.
2. **Suspend** (إيقاف) — shown for an Active person: type the reason in the box beside the button (required), press **Suspend**. Status becomes **Suspended** (موقوف).
3. **Reinstate** (إعادة) — shown for a Suspended or Ended person: optionally type a reason, press **Reinstate**. Status becomes **Active** (فعّال) again; an end date and end reason are cleared.
4. **End employment** (إنهاء الخدمة) — press it, set **End date** (تاريخ الانتهاء, today by default) and **End reason** (سبب الانتهاء, required), press **End employment**. Status becomes **Ended** (منتهٍ).
5. Each change is a dated History row (Status; and "Employment ended" for an end).
What it changes elsewhere: a Suspended person is left out when a payroll run is computed, and is not offered for a new leave request, advance or document. An Ended person keeps the record and history, can no longer be named as a manager, gets no leave, advance or equipment, and only a letter can be requested for them; their last month's pay is computed up to the end date.
Needs: `administer` on `employee`.

### How to link a sign-in to an employee — Employees
1. Open the employee record and press **Link sign-in** (ربط حساب الدخول).
2. In **Sign-in** (حساب الدخول) choose the user account (only active accounts not yet linked to anybody are offered). Choose the blank entry "— not linked —" to unlink.
3. Press **Save** (حفظ).
Why it matters: the link is what makes "the person" and "the manager" work — a linked person can open their own payslips, leave, advances, requests, documents and reviews and add their word to a review; a linked manager decides their people's leave, advances and requests.
Needs: `administer` on `employee`.

### How to set or change a salary — Employees
1. Open the employee record and go to the window **Compensation** (التعويضات). It lists every salary row: Effective from, Base salary, Paid by, Bank / account, Note, Recorded, By.
2. Under **New compensation row** (صف تعويض جديد) fill: **Effective from** (يسري من, required), **Base salary (IQD)** (الراتب الأساسي, required, digits only), **Paid by** (طريقة الدفع): **Bank transfer** (تحويل بنكي) or **Cash** (نقداً); for a bank transfer choose the **Bank** (البنك, required) and give the **Account number** (رقم الحساب) and/or **IBAN**; optional **Note** (ملاحظة).
3. Press **Save** (حفظ).
4. A change is always a new dated row; earlier rows stay. Nothing is overwritten.
What payroll takes: for a month, the row with the latest "Effective from" on or before that month's last day — for the whole month. The pay method on that row decides whether the person is paid in the bank payment or the cash payment of the run. A person with no row in force stops the run from being sent ("No salary in force for …").
Needs: `view` on `employee_compensation` to see the window, `create` on `employee_compensation` to add a row. The form is not shown for a person whose employment has ended.

### How to give one person their own pay component figure, or take a component off them — Employees
1. Open the employee record and go to the window **Pay components** (مكوّنات الراتب). When it is empty, the components' default values from HR Settings apply ("No figure of their own").
2. Under **Set a component** (تحديد مكوّن) choose the **Component** (المكوّن) — only components that are a fixed amount, a % of base, or typed on the run are offered.
3. Set **Effective from** (يسري من) and type **Amount or %** (المبلغ أو النسبة): dinars a month for a fixed component (for example a housing allowance), a percentage 0–100 for a % component. Optional **Note** (ملاحظة).
4. To take the component off the person (an exemption, an allowance that ended), tick **Take it off from that day** (إيقافه من ذلك اليوم) instead of typing an amount. A component that is typed on the run can only be taken off.
5. Press **Save** (حفظ). A new dated row is added; it shows the amount, the percentage, or **Stopped** (موقوف).
What payroll takes: for each component, the person's latest row effective on or before the month's last day; with no row, the component's default.
Needs: `view` on `employee_compensation` to see, `create` on `employee_compensation` to set.

### How to give an opening leave balance or correct a balance — Employees
1. Open the employee record and go to the window **Leave <year>** (الإجازات). The two year links in its title move to the previous and next year.
2. The table shows, per leave type: **Carried in** (مُرحَّل), **Entitlement** (الاستحقاق), **Adjustments** (التسويات), **Taken** (المأخوذ), **Waiting** (بانتظار القرار), **Balance** (الرصيد). A type with no yearly days shows **Not limited** (غير مقيَّد).
3. Under **Opening balance or correction** (رصيد افتتاحي أو تصحيح) choose the **Leave type** (نوع الإجازة), the **Year** (السنة), type the **Days** (الأيام) — for example 7.5, or -2 to take days away — choose the **Kind** (النوع): **Opening balance** (رصيد افتتاحي) or **Correction** (تصحيح), and write the **Reason** (السبب, required).
4. Press **Save** (حفظ). The row is added to Adjustments; the balance is never typed over.
Needs: `view` on `leave_request` to see the window, `administer` on `leave_request` to add the row.

### How to hand out equipment and take it back — Employees
1. Open the employee record and go to the window **Equipment held** (العُهد).
2. To hand out, under **Hand something out** (تسليم عهدة): **What it is** (ما هي) → **An item** (مادة) or **A fixed asset** (أصل ثابت). For a fixed asset choose it in **Fixed asset** (الأصل الثابت) — only assets nobody holds are offered; for an item describe it in **Item** (المادة, required for an item). Optional **Serial number** (الرقم التسلسلي); **Handed out** (تاريخ التسليم, required, not in the future); **Condition out** (الحالة عند التسليم). Press **Hand out** (تسليم).
3. To take back: in the item's row set the return date, type the **Condition back** (الحالة عند الإرجاع) and press **Returned** (أُعيدت).
4. The title of the window counts what is still out. For a leaver, what is still out appears in the clearance line at the top of the record.
Needs: `view` on `employee_asset` to see; `create` on `employee_asset` to hand out; `edit_draft` on `employee_asset` to take back. Nothing is handed out to a person whose employment has ended.

### How to read a person's attendance, leave requests, payslips and other history — Employees
1. Open the employee record and scroll to the window you need.
2. **Attendance <month>** (الحضور): choose the **Month** (الشهر — this month and the twelve before) and press **Show** (عرض). The title counts present, absent and on-leave days; each row is a day with its Weekday, Status — **Present** (حاضر), **Absent** (غائب), **On leave** (في إجازة, with the leave request's number), **Holiday** (عطلة), **Rest day** (يوم راحة), **Not recorded** (غير مسجَّل) — In, Out and Note.
3. **Leave requests** (طلبات الإجازة): the person's last 20 requests with From, To, Days and Status.
4. **Payslips** (قسائم الراتب): the last 24 — Reference, Month, Run, Gross, Deductions, Net pay, Status: **Issued** (صادرة), **Paid** (مصروفة), **Reversed** (معكوسة).
5. **Advances & loans**: Kind, Amount, Still owed, Status. **Performance reviews**: Cycle, Reviewer, Overall, Status. **Documents**: Type, Title, Expires on, Status. **Requests**: Kind, Subject, Amount, Status.
6. Click any number to open that record.
Needs: `view` on `attendance`, `leave_request`, `payroll_run`, `employee_advance`, `performance_review`, `employee_document`, `employee_request` respectively.

### Fields — Employees
New employee (موظف جديد):
- **Full name (English)** (الاسم الكامل (إنجليزي)) — required. The name used across the system and on payroll.
- **Full name (Arabic)** (الاسم الكامل (عربي)) — optional; shown instead of the English name when the screen is in Arabic.
- **Department** (القسم) — required; active departments only. Decides the department that payroll charges the person's cost to.
- **Position** (المنصب) — optional ("— none —"); active positions only.
- **Manager** (المدير) — optional ("— none —"); an active employee. Decides who approves the person's leave, advances and requests (see "The manager link — HR").
- **Hire date** (تاريخ التعيين) — required; today by default. Leave entitlement and the first month's pay are counted from it.
- **Employment** (نوع التوظيف) — required: **Permanent** (دائم, the default), **Contract** (عقد), **Daily** (يومي).
- **Contract ends** (نهاية العقد) — optional; for a contract or daily engagement. Must not be before the hire date. The HR managers are told before it ends; leave cannot run past it.
- **Phone** (الهاتف), **National ID** (الرقم الوطني), **Date of birth** (تاريخ الميلاد) — optional.
Edit details adds: **Emergency contact** (جهة اتصال للطوارئ) and **Address** (العنوان) — optional.
Set by the system and not typed: the employee number, the Branch (the branch you are working in when you create the record), the Status.
Move: **Effective from** (يسري من) — required, today by default; **Reason** (السبب) — optional, shown on the History rows.
Compensation: **Effective from**, **Base salary (IQD)** — required, a monthly figure, not negative; **Paid by** — Bank transfer (default) or Cash; **Bank** — required for a bank transfer; **Account number**, **IBAN**, **Note** — optional (the bank details are ignored for Cash).

### After you save — Employees
- Statuses of a person: **Active** (فعّال) → **Suspended** (موقوف) → back to Active with Reinstate; **Ended** (منتهٍ) with End employment (Reinstate also brings an ended person back).
- Every move, status change, salary change and pay-component change is a dated row in **History**; corrections to personal details are in the Audit log only.
- The record is the source other HR screens read: Attendance lists the person in their branch from the hire date; Leave Management counts entitlement from the hire date; Payroll takes the department, the salary row in force, the pay components and the pay method; the Manager field routes approvals.
- Nothing on this screen posts to the ledger.

### Refusals — Employees
- "full_name_en: is required" — the English name is empty.
- "hire_date: must be a day, written YYYY-MM-DD" — the hire date is empty or mistyped (the same message appears for any other date box, with that box's name).
- "contract_end_date: cannot be before the hire date <date>" — give a later contract end or clear it.
- "employment_kind: must be permanent, contract or daily".
- "manager: an employee cannot be their own manager" — choose another manager.
- "manager: has left the company" — the chosen manager's employment has ended; choose an active person.
- "status: has left the company; reinstate first" — a move was tried on an ended person. Reinstate, then move.
- "reason: say why the employment ended" — End employment needs its reason.
- "user: is already linked to <employee number>" — that sign-in belongs to another employee; unlink it there first. "user: names no user account" — the account no longer exists.
- "base_salary_iqd: cannot be negative"; "bank: name the bank the salary is paid into" — choose the bank, or switch Paid by to Cash; "Not a decimal value: "…"" — type the salary in digits only, no commas.
- "component: <name> is read from the salary, not set per person" (also "…from the day sheet…", "…from the advances and loans…") — base salary, absence and advance recovery are computed; they cannot be set here.
- "component: <name> is typed on each month's run; a person can only be taken off it" — tick "Take it off from that day", or type the figure on the payroll run instead.
- "component: <name> is deactivated"; "amount: cannot be negative"; "amount: a percentage of the base cannot exceed 100".
- "days: an adjustment of nothing changes nothing" — a leave adjustment of 0; "days: "…" is not a number of days" — use a number such as 7.5 or -2; "year: must be a year".
- "description: is required" — an item handed out needs to say what it is; "fixed_asset: is required" — choose the fixed asset.
- "<asset code> is held by <employee number>; it is returned before it is handed out again."
- "<employee number> has left; nothing more is handed out to them."
- "handed_out_on: <date> has not come yet"; "returned_on: cannot be before it was handed out (<date>)"; "returned_on: <date> has not come yet".
- When creating a user with **Also an employee** ticked: "alsoEmployee: an employee works at a branch — give the user a branch, or untick "Also an employee""; "alsoEmployee: an employee belongs to a department — choose the employee's department, or untick "Also an employee""; "branch: the employee is kept in branch <code>, which you do not work in — untick "Also an employee" and HR will add the person".
- "Permission denied: 'administer' on 'employee' is not granted to this user." (or another action) — see the Needs line of this screen.

## Departments (الأقسام)
Path: HR → Human Resources → Departments   |   Arabic: HR ← الموارد البشرية ← الأقسام
Address: /hr/departments   (a record: /hr/departments/<code>, for example /hr/departments/DEP-0003). The old address /hr/organisation opens this screen.
Needs: `view` on `org_structure` to open the list and a record. `create` on `department` for New department; on the record `configure` on `department` for Edit and `administer` on `department` for Deactivate and Reactivate.
What it is for: Every department with its people and its seats (positions). A department here is the company's one department list — the same one the ledger uses for its department dimension and that users are scoped to.

### How to read the list and open a department — Departments
1. Open HR → Human Resources → Departments.
2. Columns: Code (الرمز), Name (الاسم), **Parent department** (القسم الأعلى), **Manager** (المدير), **Headcount** (عدد الموظفين — people in the department whose employment has not ended), **Seats** (المناصب — active positions of the department), **Vacant** (شاغرة — active positions nobody holds), Status: **Active** (نشط) / **Inactive** (غير نشط).
3. Search with **Search this list**; filter with **View** (العرض) → All (الكل) / Active (نشط) / Inactive (غير نشط) → **Filter** (تصفية).
4. Click the code to open the department's record. It shows: Code, Status, Name, Parent department, Manager, Headcount, Seats, Vacant, **Sub-departments** (الأقسام الفرعية); the lines **Seats** (المناصب) — each position in reporting order (a report is indented under the seat it reports to) with **Reports to** (يتبع إلى) and **Held by** (يشغله: the holders' names, or **Vacant** — شاغر); a last line **No position yet** (بلا منصب بعد) names people of the department who have no position; then the window **People** (الموظفون): Reference, Name, Position, Branch, Hire date, Status; then the Audit log.
5. Position titles open the position's record; people's names and numbers open the employee record.
The **Manager** shown is the department manager set on the master-data Departments screen (/master-data/departments); it cannot be changed on this HR screen.
Needs: `view` on `org_structure`.

### How to add a department — Departments
1. Open HR → Human Resources → Departments and press **New department** (قسم جديد).
2. Type the **Name** (الاسم, required). Optionally choose the **Parent department** (القسم الأعلى); "None — top level" (لا شيء — مستوى أعلى) makes it a top-level department.
3. Press **Create** (إنشاء). The system gives the code (DEP-<serial>) and opens the record.
Needs: `create` on `department`.

### How to rename, re-parent, deactivate or reactivate a department — Departments
1. Open the department's record.
2. **Edit** (تعديل): change the **Name** or the **Parent department**, press **Save** (حفظ).
3. **Deactivate** (إلغاء التفعيل): type the reason in the box beside the button ("Why — this is kept in the audit trail", required) and press it. The department turns **Inactive** and is no longer offered when choosing a department for a new employee, a move, a position or a vacancy; its people and history stay.
4. **Reactivate** (إعادة التفعيل): press it on an inactive department.
Needs: `configure` on `department` to edit; `administer` on `department` to deactivate or reactivate.

### Fields — Departments
- **Name** (الاسم) — required.
- **Parent department** (القسم الأعلى) — optional; an active department other than itself. Shown in the list and as Sub-departments on the parent.
- **Code** (الرمز) — given by the system when you save; cannot be typed or changed.
- Headcount, Seats, Vacant and Manager are read, not typed: people are placed in a department on the employee record, seats are created on HR → Positions.

### After you save — Departments
- A new department is Active at once and can be chosen on Employees, Positions, Recruitment, Attendance and Performance.
- A department has only two states, Active and Inactive; it is never deleted. Nothing posts to the ledger.

### Refusals — Departments
- "name: is required".
- "parentCode: cannot be the department itself" — choose another parent.
- "parentCode: is not a known department".
- "reason: is required to deactivate a department" — type why.
- "Permission denied: 'create' on 'department' is not granted to this user." — department rows are shared with Finance; ask an administrator.

## Positions (المناصب)
Path: HR → Human Resources → Positions   |   Arabic: HR ← الموارد البشرية ← المناصب
Address: /hr/positions   (a record: /hr/positions/<code>, for example /hr/positions/POS-0004)
Needs: `view` on `org_structure` to open the list and a record. `configure` on `hr_setting` for New position, Edit, Deactivate and Reactivate.
What it is for: The seats of the organisation: each position has a title, a department, the position it reports to, and the people who hold it. People are seated in a position on their employee record; a vacancy in Recruitment is always for a position.

### How to read the list and open a position — Positions
1. Open HR → Human Resources → Positions.
2. Columns: Code (الرمز), **Position** (المنصب — the title), **Department** (القسم), **Reports to** (يتبع إلى), **Held by** (يشغله — how many people hold it), Status Active / Inactive.
3. Filter with **View** (العرض) → All (الكل), Active (نشط), **Vacant** (شاغر — active and held by nobody), Inactive (غير نشط); and **Department** (القسم); then **Filter** (تصفية). Search with **Search this list**.
4. Click the code to open the record: Code, Status, Title (English), Title (Arabic), Department (a link), Reports to (a link), Held by; the lines **Held by** (يشغله) — Reference, Name, Branch, Hire date, Status of each person seated in it, or **Vacant** (شاغر); the window **Positions that report to it** (المناصب التابعة له); then the Audit log.
Needs: `view` on `org_structure`.

### How to add a position — Positions
1. Open HR → Human Resources → Positions and press **New position** (منصب جديد).
2. Type the **Title (English)** (المسمى (إنجليزي), required) and optionally the **Title (Arabic)** (المسمى (عربي)).
3. Choose the **Department** (القسم, required) and, if it reports to another seat, **Reports to** (يتبع إلى); leave "Nobody — top of the department" (لا أحد — أعلى القسم) for the top seat.
4. Press **Create** (إنشاء). The system gives the code (POS-<serial>) and opens the record.
5. To seat someone in it: open the person under Employees → **Move** (نقل) → **Position**.
Needs: `configure` on `hr_setting` (as delivered: the HR Manager and the system administrator).

### How to change, deactivate or reactivate a position — Positions
1. Open the position's record.
2. **Edit** (تعديل): change the titles, the Department or Reports to; press **Save** (حفظ).
3. **Deactivate** (إلغاء التفعيل): type the reason in the box beside the button (required) and press it. The position is no longer offered for new employees, moves or vacancies; people already seated keep it.
4. **Reactivate** (إعادة التفعيل): press it on an inactive position.
Needs: `configure` on `hr_setting`.

### Fields — Positions
- **Title (English)** (المسمى (إنجليزي)) — required.
- **Title (Arabic)** (المسمى (عربي)) — optional; shown when the screen is in Arabic.
- **Department** (القسم) — required; the department whose seat it is.
- **Reports to** (يتبع إلى) — optional; another position. It draws the reporting order on the department's record. It does not decide who approves a person's leave — that is the **Manager** on the employee record.
- **Code** (الرمز) — given by the system; cannot be typed or changed.

### After you save — Positions
- A position is Active or Inactive; it is never deleted. It counts as **Vacant** while no person whose employment is still running holds it.
- A new position can be chosen at once on Employees (New employee, Move) and Recruitment (New vacancy). Nothing posts to the ledger.

### Refusals — Positions
- "title_en: is required".
- "department: names no department '<code>'".
- "reports_to: a position cannot report to itself"; "reports_to: names no position '<code>'".
- "reason: say why it is deactivated".
- "Permission denied: 'configure' on 'hr_setting' is not granted to this user." — creating and changing positions is an HR-settings right.

## Attendance (الحضور)
Path: HR → Human Resources → Attendance   |   Arabic: HR ← الموارد البشرية ← الحضور
Address: /hr/attendance
Needs: `view` on `attendance` to open the sheet; `create` on `attendance` to record or correct a day.
What it is for: The day sheet of one branch: for each person, whether they were present or absent on a day, with optional in and out times. Leave, rest days and public holidays are not typed here — they are read from the leave requests and the working calendar. Payroll reads this sheet for absences.

### How to record a day's attendance — Attendance
1. Open HR → Human Resources → Attendance.
2. In the filter line choose the **Branch** (الفرع — only branches you work in), optionally a **Department** (القسم; "All departments" — كل الأقسام), and the **Day** (اليوم — today by default); press **Show** (عرض).
3. The sheet lists everyone who works in that branch on that day (hired on or before it, employment not ended before it), by department. Its title shows the day and branch and "N of M recorded" (سُجّل N من M).
4. For each person choose **Recorded** (المسجَّل): **Present** (حاضر) or **Absent** (غائب). Leaving it at "—" leaves that person's day as it was.
5. For a present person you may type **In** (الدخول) and **Out** (الخروج) times and a **Note** (ملاحظة). Times typed for an absent person are not kept.
6. Press **Save the sheet** (حفظ الكشف). Only the rows you changed are written.
A person on approved leave is shown as **On leave** (في إجازة) with the leave request's number and type, and their row cannot be recorded. A day in the future can be read but not recorded.
Needs: `create` on `attendance`. Without it the sheet is read-only.

### How to correct a day already recorded — Attendance
1. Open HR → Human Resources → Attendance, choose the same Branch and **Day**, press **Show** (عرض).
2. Change the person's **Recorded** value between Present and Absent, or the times or note.
3. Press **Save the sheet** (حفظ الكشف). The day's audit entry keeps the before and after of each changed person.
A recorded day can be switched between Present and Absent but cannot be set back to "not recorded". A day that was wrongly marked absent because the person was on leave is fixed by an approved leave request: the leave wins over the sheet.
Needs: `create` on `attendance`.

### How a day reads (leave, the sheet, the calendar) — Attendance
The column **The day reads** (حالة اليوم) shows what the day was, decided in this order:
1. **On leave** (في إجازة) — an approved leave request covers the day and the day is a working day. This wins even over an absence recorded earlier (a sick note that arrives late excuses it).
2. **Present** (حاضر) or **Absent** (غائب) — what the sheet recorded.
3. **Holiday** (عطلة) — a public holiday of the working calendar.
4. **Rest day** (يوم راحة) — not a working day of the calendar.
5. **Not recorded** (غير مسجَّل) — a working day nobody recorded.
The working calendar of a year is the calendar for that year on Settings → Administration → HR Settings → Working calendars; with no calendar for the year, working days are Sunday to Thursday with no holidays. When the chosen day is a rest day or a holiday the page says so at the top ("<day> is a rest day on the working calendar."); people can still be recorded on it.
What payroll does with it: a working day recorded **Absent** is deducted; a working day **Not recorded** is paid as worked; an absence recorded on a rest day or holiday costs nothing; approved unpaid leave is deducted and paid leave is not.

### Fields — Attendance
Filter line:
- **Branch** (الفرع) — one of your branches; your current branch by default.
- **Department** (القسم) — optional; narrows the sheet to one department.
- **Day** (اليوم) — the date; today by default.
Each row of the sheet:
- Reference (المرجع) — the employee number, a link to the employee record; Name (الاسم); Department (القسم).
- **The day reads** (حالة اليوم) — read-only; see "How a day reads".
- **Recorded** (المسجَّل) — Present (حاضر) or Absent (غائب); "—" changes nothing.
- **In** (الدخول), **Out** (الخروج) — optional times (hours and minutes); Out cannot be earlier than In; kept only for Present.
- **Note** (ملاحظة) — optional.

### After you save — Attendance
- There is no approval and no status flow: the sheet is saved as recorded, and each save writes one audit entry for the day with what changed.
- The person's month appears on their employee record (Employees → the person → **Attendance <month>**).
- Approving a leave request writes nothing onto the sheet, so cancelling that leave later simply makes the day read what the sheet recorded.
- Nothing posts to the ledger; the month's payroll run reads the sheet when it is computed.

### Refusals — Attendance
- "day: <date> has not come yet; attendance is recorded for a day that has happened" — choose today or an earlier day.
- "status: <employee number> is on leave that day (<leave number>); cancel the leave to record the day otherwise" — the approved leave is the fact; if the leave is wrong, cancel it on Leave Management first.
- "check_in (<employee number>): "<text>" is not a time (HH:MM)" — type the time as 08:30.
- "check_out (<employee number>): cannot be before the check-in".
- "employee: does not work in <branch> on <day>" — the person was not employed in that branch on that day; reload the sheet.
- "Permission denied: 'create' on 'attendance' is not granted to this user."

## Leave Management (إدارة الإجازات)
Path: HR → Human Resources → Leave Management   |   Arabic: HR ← الموارد البشرية ← إدارة الإجازات
Address: /hr/leave   (a record: /hr/leave/<request number>, for example /hr/leave/LVE-HQ-2026-000012)
Needs: `view` on `leave_request` to open the list; `create` on `leave_request` for New leave request. On a record: Edit and Send for decision — the person themself, or `edit_draft` on `leave_request`; Approve and Refuse — the person's manager (through the manager link, no permission needed) or `approve` on `leave_request`, and never whoever entered the request nor the person on leave; Cancel — a draft or waiting request by the person or with `edit_draft`, an approved leave only with `administer` on `leave_request`. Files need `create` on `attachment`; a note needs `edit_draft` on `leave_request`; the printed copy needs `print` (PDF) or `export` (Excel, Word) on `leave_request`. A record page opens for users of the record's branch, the person and the person's manager.
What it is for: Leave requests: each is counted in working days on the working calendar, checked against the person's balance of that leave type, and decided by the person's manager or an HR manager. An approved request is what makes the days read "On leave" on Attendance and what payroll reads for unpaid leave.

### How to find leave requests — Leave Management
1. Open HR → Human Resources → Leave Management.
2. Search by request number, employee number or name in **Search this list**.
3. Filter: **View** (العرض) → **Waiting for decision** (بانتظار القرار), **Approved** (موافق عليها), **Draft** (مسودة), **Refused** (مرفوضة), **Cancelled** (ملغاة); **Leave type** (نوع الإجازة) → one type; then **Filter** (تصفية).
4. Columns: Reference (المرجع), Employee (الموظف), Leave type (نوع الإجازة), From (من), To (إلى), Days (الأيام), Status (الحالة). Requests waiting for a decision come first, then drafts.
5. Click the number to open the request.
Needs: `view` on `leave_request`.

### How to enter a leave request — Leave Management
1. Open HR → Human Resources → Leave Management and press **New leave request** (طلب إجازة جديد).
2. Choose the **Employee** (الموظف — active employees) and the **Leave type** (نوع الإجازة).
3. Set **From** (من) and **To** (إلى) — both today by default; the same date twice is a one-day leave.
4. Tick **First day is a half day** (اليوم الأول نصف يوم) and/or **Last day is a half day** (اليوم الأخير نصف يوم) if so. Optionally type the **Reason** (السبب).
5. Press **Create** (إنشاء). The request opens as a **Draft** (مسودة) with its number (LVE-<branch>-<year>-<serial>) and its days counted; the lines show every day of the span and how it counts.
6. If the leave type needs a paper (a sick note), attach it with the paperclip icon before sending.
7. Press **Send for decision** (إرسال للقرار).
Needs: `create` on `leave_request` to see the New button; `edit_draft` on `leave_request` (or being the person) to send.

### How to change a draft leave request — Leave Management
1. Open the request (status Draft) and press **Edit** (تعديل).
2. Change the **Leave type**, **From**, **To**, the half-day ticks or the **Reason**; the employee cannot be changed.
3. Press **Save** (حفظ). The days are counted again.
Only a draft can be changed. A request already sent is cancelled and asked again.
Needs: the person themself, or `edit_draft` on `leave_request`.

### How to attach a sick note or other paper — Leave Management
1. Open the leave request.
2. Press the paperclip icon in the title bar → **Choose a file** (اختر ملفاً) → **Attach** (إرفاق).
3. A leave type marked "Needs attachment" on HR Settings cannot be sent until at least one file is attached; a draft of such a type shows the reminder "<type> needs its paper (a sick note) attached below before it is sent." (the file goes behind the paperclip icon at the top of the record).
Files can be added while the request is a draft, waiting or approved — not once it is refused or cancelled.
Needs: `create` on `attachment`, and being able to see the request.

### How to send a leave request for decision — Leave Management
1. Open the draft request and press **Send for decision** (إرسال للقرار).
2. The system counts the days again and checks: the person is employed over those days; the days do not overlap another request of theirs that is waiting or approved; the paper is attached if the type needs one; the balance is enough.
3. Status becomes **Waiting for decision** (بانتظار القرار). The person's manager is notified; when the person has no manager with a sign-in (or the manager is the one who entered the request), the HR managers are notified instead.
Needs: the person themself, or `edit_draft` on `leave_request`.

### How to approve or refuse a leave request — Leave Management
1. Open the request (status Waiting for decision). The HR Dashboard figure "Leave to decide" and the View filter "Waiting for decision" list them.
2. To approve: press **Approve** (موافقة), optionally type a **Decision note** (ملاحظة القرار), press **Approve**. The balance is checked once more at that moment.
3. To refuse: type the reason in the box **Why it is refused** (سبب الرفض, required) beside the button and press **Refuse** (رفض).
4. The requester and the person are notified of the decision.
Who may decide: the person's manager (the Manager on the employee record, when that manager has a sign-in) or anyone holding the approve permission (as delivered, the HR Manager). Never the user who entered the request, and never the person on leave — not even a Super User. The buttons are not drawn for someone who may not decide.
Needs: the manager link, or `approve` on `leave_request`.

### How to cancel a leave request — Leave Management
1. Open the request.
2. Type the reason in the box **Why it is cancelled** (سبب الإلغاء, required) beside the button and press **Cancel** (إلغاء).
3. A **Draft** or **Waiting** request can be cancelled by the person or by HR. An **Approved** leave can be cancelled only by someone with the administer permission (as delivered, the HR Manager): its days go back to the balance, the days read what the attendance sheet recorded again, and the requester and the person are notified.
A refused or cancelled request cannot be cancelled again.
Needs: the person or `edit_draft` on `leave_request` (draft, waiting); `administer` on `leave_request` (approved).

### How leave days are counted — Leave Management
- Only working days of the working calendar are taken: rest days and public holidays inside the span count nothing. The record's lines show each day as **Working day** (يوم عمل), **Rest day — not taken** (يوم راحة — لا يُحتسب) or **Public holiday — not taken** (عطلة رسمية — لا تُحتسب) and the days it takes (1, 0.5 or 0).
- A half day at the first or last day counts 0.5; a one-day request with either half-day box ticked is 0.5 day.
- A span that crosses the new year draws on each year's balance for the days that fall in it.
- The calendar is the year's working calendar on HR Settings; with none for the year, Sunday to Thursday with no holidays.
- If the calendar changes after a request was sent, the record says "Counted X days when sent; the calendar now counts Y."

### How balances, entitlement and carry-over work — Leave Management
- **Entitlement** (الاستحقاق): the leave type's "Days / year" for a full year. In the year a person joined or left it is days × months served ÷ 12, rounded to the nearest half day; the joining month counts when the hire date is on or before the 15th, the leaving month when the end date is on or after the 15th.
- **Carried in** (مُرحَّل): what was left at the end of the previous year, never more than the type's "Carry-over" and never less than zero. Days above the carry-over are lost at the year end; a type marked "Warn before it lapses" notifies the HR managers and the person before that.
- **Adjustments** (التسويات): opening balances and corrections entered on the employee record (Employees → the person → Leave → Opening balance or correction).
- **Taken** (المأخوذ): approved days that fall in the year. **Waiting** (بانتظار القرار): days of requests sent and not yet decided.
- **Balance** (الرصيد) = Carried in + Entitlement + Adjustments − Taken. What a new request may still take is the Balance less what is Waiting. A type with "May go below zero by" N days may go N days below zero.
- A leave type with 0 days a year (as delivered: Unpaid leave) is **Not limited** (غير مقيَّد): no balance is checked.
- As delivered the types are Annual leave (30 days a year, 10 carry over, paid), Sick leave (30 days, no carry-over, paid, needs a paper, may go 5 days below zero) and Unpaid leave (not limited, unpaid). They are changed on Settings → Administration → HR Settings → Leave types.
- Where to read a balance: the leave request's field **Balance <year>** ("N days, M waiting"), the employee record's **Leave <year>** window, and HR → Reports → Leave balances.

### Fields — Leave Management
New leave request / Edit:
- **Employee** (الموظف) — required; an active employee. Cannot be changed after the request is created.
- **Leave type** (نوع الإجازة) — required; an active leave type.
- **From** (من) — required; the first day. Not before the hire date.
- **To** (إلى) — required; the last day; not before From, and not after the day the employment or contract ends.
- **First day is a half day** (اليوم الأول نصف يوم), **Last day is a half day** (اليوم الأخير نصف يوم) — optional ticks.
- **Reason** (السبب) — optional.
On the record (read-only): Reference, Status, Employee (a link), **Manager** (المدير), Leave type, From, To (with "half day" — نصف يوم), **Days** (الأيام), **Balance <year>** (الرصيد), **Requested by** (طلبها), **Sent for decision** (أُرسلت للقرار), **Decided by** (قرّرها), **Decision note** (ملاحظة القرار), **Cancelled by** (ألغاها), **Why it is cancelled** (سبب الإلغاء), Reason.
Decision: **Decision note** — optional when approving, required (as the reason) when refusing. Cancel: the reason is required.

### After you save — Leave Management
- **Draft** (مسودة) → **Waiting for decision** (بانتظار القرار) → **Approved** (موافق عليها) or **Refused** (مرفوضة). A draft or waiting request may become **Cancelled** (ملغاة); an approved one too, by the HR Manager.
- Next to act: on a draft, the person or HR (send); on a waiting request, the manager or an HR manager (decide).
- From the approval on, the days read **On leave** on Attendance and on the employee's month, the days count as Taken in the balance, and the month's payroll run deducts the days of an unpaid leave type (paid leave costs nothing).
- Nothing posts to the ledger from this screen.

### Refusals — Leave Management
- "<from> to <to> has no working day in it — rest days and public holidays are not taken as leave." — choose days that include a working day.
- "to_date: cannot be before the first day".
- "<employee number> has left the company; leave cannot be requested for them."
- "<employee number> was hired on <date>; leave cannot start before that."
- "<employee number>'s employment ends on <date>; leave cannot run past it." — shorten the leave or correct the contract end on the employee record.
- "leave_type: <code> is no longer in use" — the type was deactivated; choose another.
- "These days overlap <request number> (<from> to <to>), which is already asked for or granted." — change the dates or cancel the other request.
- "<type> needs its paper (a sick note) attached to <request number> before it is sent." — attach the file with the paperclip, then send again.
- "days: <N> days of <type> in <year> asked, <M> remain — at most <X> can be granted" (with "(and <K> may be borrowed)" when the type may go below zero) — shorten the leave, use another leave type, or have HR correct the balance on the employee record.
- "<request number> is <status>; only a draft is changed — cancel it and ask again." / "…only a draft is sent."
- "The person who asked for <request number> cannot decide it (maker-checker)." — somebody else must decide: the manager or another HR manager.
- "<name> cannot decide their own leave."
- "Only <manager's name> (the manager) or an HR manager decides <request number>."
- "<request number> is <status>; only a submitted request is decided."
- "decision_note: is required" — a refusal needs its reason. "cancel_reason: is required".
- "<request number> is refused already." / "…cancelled already."
- "Permission denied: 'administer' on 'leave_request' is not granted to this user." — only an HR manager cancels a leave that was already approved.

## Payroll (الرواتب)
Path: HR → Human Resources → Payroll   |   Arabic: HR ← الموارد البشرية ← الرواتب
Address: /hr/payroll   (a run: /hr/payroll/<run number>, for example /hr/payroll/PAY-HQ-2026-0003; a payslip: /hr/payroll/payslips/<payslip number>)
Needs: `view` on `payroll_run` to open the list and a run. New payroll run: `create` on `payroll_run` and `view` on `employee_compensation`. On a run — Edit, Compute again and the typed figures: `edit_draft` on `payroll_run` and `view` on `employee_compensation`; Send for approval: `submit` on `payroll_run` and `view` on `employee_compensation`; Approve: `approve` on `payroll_run`; Send back: `approve` (a run waiting for approval) or `post` (an approved run); Post: `post`; Pay: `execute`; Reverse: `reverse_cancel`; Cancel: `edit_draft` (draft), `approve` (waiting), `post` (approved). Files: `edit_draft` on `payroll_run` and `create` on `attachment`; a note: `edit_draft` on `payroll_run`; printed copy: `print` / `export` on `payroll_run`. A payslip opens for the payroll's readers and for the person it pays.
What it is for: One run per branch per month. The run is computed from facts — each person's salary in force, their pay components, the attendance sheet and approved leave, and what their advances have due — then sent, approved by somebody else, posted to the ledger (which issues the payslips) and paid from a bank or cash account. As delivered: the HR Manager prepares and sends, the Accounting Manager or the CEO approves, the Accounting Manager posts, pays and reverses.

### How to find payroll runs — Payroll
1. Open HR → Human Resources → Payroll.
2. Search by run number, branch code or month (YYYY-MM) in **Search this list**.
3. Filter with **View** (العرض): **Pending approval** (بانتظار الموافقة), **Approved** (معتمد), **Draft** (مسودة), **Posted** (مرحّل), **Paid** (مصروف), **Reversed** (معكوس), **Cancelled** (ملغى) → **Filter** (تصفية).
4. Columns: Reference (المرجع), Branch (الفرع), Month (الشهر), Pay date (تاريخ الصرف), People (الأشخاص), Gross (الإجمالي), Deductions (الاستقطاعات), Net pay (صافي الراتب), Status (الحالة). Runs waiting for approval come first, then approved, then drafts.
5. Click the number to open the run.
Needs: `view` on `payroll_run`.

### How to prepare a month's payroll run — Payroll
1. Before you start: every person to be paid needs a salary row on their employee record (Employees → the person → Compensation), and the month's attendance and leave should be recorded.
2. Open HR → Human Resources → Payroll and press **New payroll run** (مسير رواتب جديد).
3. Choose the **Branch** (الفرع) and the **Month** (الشهر — this month or one of the eleven before). Optionally set the **Pay date** (تاريخ الصرف; left empty it is the month's last day) and a **Note** (ملاحظة).
4. Press **Compute the run** (احتساب المسير). The run opens as a **Draft** (مسودة) with its number (PAY-<branch>-<year>-<serial>) and one line per person the branch employed in that month.
5. Read the notes at the top of the draft: "No salary in force for …" names people without a salary row (record it on the employee, then **Compute again**); "N working days of M people are not on the day sheet; an unrecorded day is paid as worked." tells you the attendance sheet is incomplete.
6. Type the manual figures (overtime, income tax…) in the window **Typed on the run** and press **Save the typed figures**.
7. Press **Send for approval** (إرسال للاعتماد).
Who is on a run: everyone of that branch hired on or before the month's last day whose employment had not ended before the month began, except people whose status is Suspended when the run is computed.
Needs: `create` on `payroll_run` and `view` on `employee_compensation` (the run is a sheet of salaries).

### How a payslip line is computed — Payroll
For each person the run reads the facts at the month's end and computes, every figure rounded to the whole dinar:
- **Working days** (أيام العمل): the month's working days on the working calendar. The line's **Days** (الأيام) shows "days employed / working days" — a person who joined or left in the month is paid for their part.
- **Base salary**: the monthly salary in force × days employed ÷ working days.
- **Absence deduction**: the daily rate (salary ÷ working days) × (working days recorded Absent on the attendance sheet + days of approved unpaid leave), never more than the base paid. A working day nobody recorded is paid as worked.
- **Fixed amount** components (for example an allowance): the person's own figure from their employee record, or the component's default, for the days employed. With no figure of their own and a default of 0, the component is left out.
- **% of base** components (for example social security): the person's own rate, or the default rate, of the base actually earned (base paid less the absence).
- **Typed on the run** components (for example overtime, income tax): exactly what is typed on the run's line, with its note.
- **Advances and loans due**: what the person's paid-out advances and loans have due by that month, taken last and never more than what is left of the pay; what cannot be taken stays owed and is due again next month.
- A component stopped for a person on their employee record ("Take it off from that day") is left out for them.
- **Gross** (الإجمالي) = all earnings; **Deductions** (الاستقطاعات) = all deductions; **Net pay** (صافي الراتب) = Gross − Deductions; **Employer cost** (كلفة صاحب العمل) = the components the company pays on top (not part of the net pay).
The components, their kind, calculation and default are set on Settings → Administration → HR Settings → Pay components. As delivered: Base salary, Housing allowance and Transport allowance (fixed, default 0), Overtime (typed), Absence deduction, Social security — employee share (5% of base), Advance and loan recovery, Income tax (typed), Social security — employer share (12% of base, employer cost).

### How to type overtime, tax and other manual figures — Payroll
1. Open the draft run. The window **Typed on the run** (المدخل يدويًا في المسير) lists one row per person and one column per component whose calculation is "Typed on the run".
2. Type the amounts in dinars (digits only; 0 for none) and, in **Note** (ملاحظة), why — a figure above zero is refused without its note. The note of a row explains that row's typed figures.
3. Press **Save the typed figures** (حفظ الأرقام المدخلة). The run is computed again with them, so the totals are always the sum of the components.
Only a draft can be typed on; the typed figures survive **Compute again**.
Needs: `edit_draft` on `payroll_run` and `view` on `employee_compensation`.

### How to compute a draft again, or change its pay date — Payroll
1. Open the draft run.
2. **Compute again** (إعادة الاحتساب) recomputes every line from today's facts — use it after a salary row was added, attendance was completed, a leave was approved or an advance was paid or repaid. What was typed stays.
3. **Edit** (تعديل) changes the **Pay date** (تاريخ الصرف, required) and the **Note** (ملاحظة); press **Save** (حفظ).
Nothing else on a run can be typed: a wrong figure is corrected at its source (the employee's salary, the attendance sheet, the leave, the component) and the run computed again.
Needs: `edit_draft` on `payroll_run` and `view` on `employee_compensation`.

### How to send, approve or send back a payroll run — Payroll
1. Preparer: open the draft and press **Send for approval** (إرسال للاعتماد). The run is computed once more; status becomes **Pending approval** (بانتظار الموافقة) and the people who may approve are notified.
2. Approver: open the run and press **Approve** (اعتماد). Status becomes **Approved** (معتمد) and the people who may post are notified.
3. To return it instead: type the reason in the box **Why it goes back** (سبب الإعادة, required) and press **Send back** (إعادة). The run returns to **Draft**, the reason is shown on it as **Sent back** (أُعيد), and the preparer is notified. An approved run can also be sent back, by whoever may post it.
Who may approve: someone holding the approve permission who neither prepared nor sent the run. If you prepared or sent it you see "You prepared or sent this run; somebody else approves it." and no Approve button. A Super User is the one exception and may approve their own run.
Needs: `submit` on `payroll_run` to send; `approve` on `payroll_run` to approve or to send back a waiting run; `post` to send back an approved run.

### How to post a payroll run — Payroll
1. Open the approved run and press **Post** (ترحيل).
2. The system writes one journal entry dated the last day of the month, gives every line its payslip number (PSL-<branch>-<year>-<serial>), records the advances it recovered on the people's advances, and notifies every person who has a sign-in that their payslip is issued.
3. Status becomes **Posted** (مرحّل). The run shows **Posted by** (رحّله) and a link to the **Journal entry** (القيد اليومي). From here the lines cannot change.
What the journal says: debit salary expense for each earning (the base less its absence) and each employer cost, by the person's department; credit each deduction and employer cost where it is owed; credit employee advances for what was recovered; credit the net pay owed to the people.
Needs: `post` on `payroll_run`.

### How to pay a posted payroll run — Payroll
1. Open the posted run and press **Pay** (صرف).
2. Choose the **Pay method** (طريقة الدفع) — **Bank transfer** (تحويل مصرفي) or **Cash** (نقدًا); each is offered with the net amount still unpaid by that method.
3. Choose **From account** (من الحساب): a bank account for a bank transfer, a cash account for cash.
4. Set **Paid on** (تاريخ الصرف الفعلي — today by default, not a future day) and optionally a **Reference** (المرجع).
5. Press **Pay** (صرف). One payment pays every unpaid line of that pay method and writes one journal entry (net pay owed → the account). It appears in the window **Payments** (الدفعات).
6. Repeat for the other pay method if the run has both. When all the net pay has left, status becomes **Paid** (مصروف); until then it stays Posted and the paid lines are marked "paid" (مصروف).
A person's pay method comes from the salary row in force (Employees → Compensation → Paid by). A posted run whose pay date has passed shows "The pay date, <day>, has passed and the net pay has not all left."
Needs: `execute` on `payroll_run`.

### How to reverse or cancel a payroll run — Payroll
1. **Cancel** (إلغاء) — for a run that is Draft, Pending approval or Approved: type the reason in **Why it is cancelled** (سبب الإلغاء, required) and press **Cancel**. Status becomes **Cancelled** (ملغى).
2. **Reverse** (عكس) — for a **Posted** run from which nothing has been paid: type the reason in **Why it is reversed** (سبب العكس, required) and press **Reverse**. The run's journal is mirrored by a reversal entry dated today, what it recovered on advances is owed again, and status becomes **Reversed** (معكوس). Its payslips stay as issued and say the run was reversed.
3. After a cancel or a reverse the month is free: prepare a new run for the same branch and month.
A run that has been paid from (even partly) cannot be reversed; the correction goes into next month's run.
Needs: Cancel — `edit_draft` (draft), `approve` (waiting) or `post` (approved) on `payroll_run`; Reverse — `reverse_cancel` on `payroll_run`.

### How to open and print a payslip — Payroll
1. From a posted run: in the lines **People** (الأشخاص), click the number in the **Payslip** (قسيمة الراتب) column. From a person: Employees → the person → **Payslips**.
2. The payslip shows: Reference, Status — **Issued** (صادرة), **Paid** (مصروفة) or **Reversed** (معكوسة) — Employee, Department, Position (الوظيفة), Month, **Payroll run** (مسير الرواتب), Pay date, **Paid on** (the day and reference of the payment), Pay method, Bank account, **Base salary** (الراتب الأساسي), Days, **Present** (الحضور), **Absent** (الغياب), **Paid leave** (إجازة مدفوعة), **Unpaid leave** (إجازة بدون راتب), Employer cost.
3. Its lines **Components** (المكوّنات): Component, Kind — Earning (استحقاق), Deduction (استقطاع), Employer cost (كلفة صاحب العمل) — **Basis** (الأساس: the days or the percentage), Amount, Note. Totals: Gross, Deductions, Net pay.
4. Press the printer icon for PDF, Excel or Word in English or Arabic, or print the page with Ctrl+P.
An employee whose record is linked to their sign-in can open their own payslips (and only theirs) from the notification "Your payslip … is issued" or by the payslip's address, and print them, without any payroll permission.
Needs: `view` on `payroll_run`, or being the person the payslip pays.

### How to print a run, attach the signed sheet, or add a note — Payroll
1. Open the run.
2. Printer icon → the run's sheet as PDF, Excel or Word, in English or Arabic; Ctrl+P prints the same sheet.
3. Paperclip icon → **Choose a file** → **Attach** (for example the signed salary sheet or the bank's transfer confirmation). Files can be added until the run is cancelled.
4. Speech-mark icon → **Add note**. Clock icon → the audit log.
Needs: `print` / `export` on `payroll_run` for copies; `edit_draft` on `payroll_run` and `create` on `attachment` for files; `edit_draft` on `payroll_run` for notes.

### Fields — Payroll
New payroll run:
- **Branch** (الفرع) — required; one of your branches. One live run per branch per month.
- **Month** (الشهر) — required; this month or one of the eleven before it. A month that has not begun cannot be prepared.
- **Pay date** (تاريخ الصرف) — optional; the day people are due to be paid. Left empty, the month's last day. Not before the month's first day. Used for the overdue warning and shown on payslips.
- **Note** (ملاحظة) — optional.
On the run (read-only): Reference, Status, Branch, Month, Pay date, **Working days** (أيام العمل), **People** (الأشخاص), **Gross**, **Deductions**, **Net pay**, **Employer cost**, **Paid** (المصروف — net pay already paid), **Prepared by** (أعدّه), **Computed** (وقت الاحتساب), **Sent by** (أرسله), **Approved by** (اعتمده), **Posted by** (رحّله), **Journal entry** (القيد اليومي), **Sent back** (أُعيد), **Reversed by** (عكسه), **Reversal entry** (قيد العكس), **Why it is reversed**, **Cancelled by** (ألغاه), **Why it is cancelled**, Note.
Lines **People**: Employee, Department, **Days** (employed / working), **Absent** (الغياب), **Unpaid leave** (إجازة بدون راتب), Gross, Deductions, Net pay, **Pay method**, **Payslip**.
Window **Components** (المكوّنات — "What the journal is built from"): Component, Kind, People, Amount for the whole run.
Pay dialog: **Pay method** — required; **From account** — required, an active IQD account of the matching type; **Paid on** — required, not in the future; **Reference** — optional.

### After you save — Payroll
- **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Approved** (معتمد) → **Posted** (مرحّل) → **Paid** (مصروف). Side exits: **Cancelled** (ملغى) before posting; **Reversed** (معكوس) after posting and before any payment; Send back returns a waiting or approved run to Draft.
- Who acts next: Draft — the preparer (send); Pending approval — an approver who is not the preparer or sender; Approved — Finance (post); Posted — Finance (pay each pay method).
- Ledger: nothing until **Post** (one journal dated the month's last day). Each **Pay** writes one journal dated its "Paid on". **Reverse** writes the mirror journal dated today.
- Posting issues the payslips and records advance recoveries; an advance fully recovered becomes Settled.
- A run cancelled or reversed does not block the month; any other status does.

### Refusals — Payroll
- "<month> has not begun; a month's pay is prepared once it has."
- "<branch> already has <run number> (<status>) for <month>; open it, or reverse or cancel it to run the month again."
- "pay_date: cannot be before the month it pays (<date>)".
- "Permission denied: 'view' on 'employee_compensation' is not granted to this user." — preparing, computing and sending a run needs the right to read salaries.
- "<run number> is <status>; only a draft is computed again or typed on."
- "<employee number> <component>: '<text>' is not an amount in dinars" — type digits only.
- "<employee number>: <component> of <amount> needs its note — what it is for." — fill the row's Note.
- "<component code> is not typed on the run; it is computed."
- "<run number> has nobody on it; <branch> employed nobody in <month>."
- "<employee numbers> has no salary in force by <date>; record it on the employee, then send <run number>." — add the salary row (Employees → the person → Compensation) with an Effective from on or before the month's last day.
- "<employee numbers>: the deductions are more than the pay; correct the typed figures."
- "You prepared <run number>; somebody else approves it (maker-checker)."
- "<run number> is <status>; it cannot become <status>." — the action does not fit the run's status (for example posting a run that is not approved).
- "<run number> comes to nothing; there is nothing to post." / "<run number> does not balance; compute it again before posting."
- "<run number>: the advances of one of its people changed after it was computed; send it back to draft and compute it again." — an advance of one of the people was repaid in cash or settled by an expense claim after the run was computed: Send back, Compute again, then send and approve again.
- "<run number> is <status>; a posted run is paid."
- "paid_on: <date> has not come yet; record the payment the day the money leaves".
- "account: choose the bank or cash account the pay leaves"; "<account> is deactivated."; "<account> holds <currency>; salaries are paid in dinars (D-HR-2)."
- "<account> is a cash account; bank transfers leave a bank account." / "<account> is a bank account; cash is paid from a cash account."
- "<run number> has nothing left to pay by <method>."
- "<run number> has been paid from; a paid run is not reversed. Correct it in next month's run."
- "reason: is required" / "note: is required" — Cancel, Reverse and Send back need their reason.
- From the ledger when posting or paying: "No accounting mapping is configured for the '<line>' line of 'hr.payroll_run'…" (ask Accounting to map salary expense, employer cost, withholding, net pay or employee advances), "Cannot post into <period>: the period is closed…", "No accounting period covers <date>…", "<account> … cannot hold less than nothing…" — see "Posting to the ledger — HR".

## Advances & Loans (السلف والقروض)
Path: HR → Human Resources → Advances & Loans   |   Arabic: HR ← الموارد البشرية ← السلف والقروض
Address: /hr/advances   (a record: /hr/advances/<advance number>, for example /hr/advances/EADV-HQ-2026-00007)
Needs: `view` on `employee_advance` to open the list; `create` on `employee_advance` for New advance or loan. On a record — Send for endorsement: the person, or `edit_draft` on `employee_advance`; Endorse: the person's manager (the manager link, no permission needed) or `approve` on `employee_advance`; Approve: `post` on `employee_advance`; Refuse: whoever may take the step it waits on; Pay out and Repaid in cash: `execute` on `employee_advance`; Cancel: the person, whoever entered it, or `edit_draft`. Files: `create` on `attachment`; a note: `edit_draft` on `employee_advance`; printed copy: `print` / `export` on `employee_advance`. A record page opens for users of its branch, the person and the person's manager.
What it is for: Money lent to an employee — a salary advance (comes back in one instalment) or a loan (up to 60 monthly instalments). It is endorsed by the person's manager or an HR manager, approved by Finance, paid out from a bank or cash account, and recovered from the person's pay month by month; it can also be repaid in cash or settled by an expense claim of a trip. (Petty-cash advances are a different screen in Treasury.) As delivered: HR enters, the manager or the HR Manager endorses, the Accounting Manager approves, pays out and records repayments.

### How to find advances and loans — Advances & Loans
1. Open HR → Human Resources → Advances & Loans.
2. Search by advance number, employee number or name. Filter with **View** (العرض): **Pending approval** (بانتظار الموافقة — waiting to be endorsed), **Endorsed** (مؤيَّدة), **Approved** (معتمد), **Paid out** (مصروفة), **Settled** (مسوّى), **Draft** (مسودة), **Rejected** (مرفوض), **Cancelled** (ملغى) → **Filter** (تصفية).
3. Columns: Reference (المرجع), Employee (الموظف), Kind (النوع), Amount (المبلغ), Instalments (الأقساط), First recovery month (شهر الاسترداد الأول), **Recovered** (المسترد), **Still owed** (المتبقي), Status (الحالة). What waits for somebody comes first.
4. Click the number to open the record.
Needs: `view` on `employee_advance`.

### How to enter an advance or a loan — Advances & Loans
1. Open HR → Human Resources → Advances & Loans and press **New advance or loan** (سلفة أو قرض جديد).
2. Choose the **Employee** (الموظف — active employees) and the **Kind** (النوع): **Salary advance** (سلفة راتب) or **Loan** (قرض).
3. Type the **Amount** (المبلغ) in whole dinars, the number of **Instalments** (الأقساط — 1 for a salary advance, 2 to 60 for a loan), the **First recovery month** (شهر الاسترداد الأول, as YYYY-MM; next month by default) and the **Reason** (السبب, required).
4. Press **Create** (إنشاء). The record opens as a **Draft** (مسودة) with its number (EADV-<branch>-<year>-<serial>) and its **Schedule** (الجدول) month by month.
5. Press **Send for endorsement** (إرسال للتأييد). Status becomes **Pending approval** and the person's manager (or, without one, the HR managers) is notified.
A draft cannot be edited: if something is wrong, cancel it with a reason and enter it again.
Needs: `create` on `employee_advance` to enter; the person, or `edit_draft` on `employee_advance`, to send.

### How to endorse, approve or refuse an advance — Advances & Loans
1. Open the record.
2. **Endorse** (تأييد) — on a record waiting for endorsement: press it, optionally type a **Note** (ملاحظة), press **Endorse**. Status becomes **Endorsed** (مؤيَّدة) and those who may approve are notified. Who: the person's manager through the manager link, or an HR manager.
3. **Approve** (اعتماد) — on an endorsed record: press it. Status becomes **Approved** (معتمد); the person, the requester and those who pay are notified. Who: Finance (the approve step uses the posting permission).
4. **Refuse** (رفض) — at either step: type the reason in **Why it is refused** (سبب الرفض, required) and press **Refuse**. Status becomes **Rejected** (مرفوض); it is final.
Nobody endorses or approves an advance they asked for or that is their own, and the approver is not the endorser; in that case the page says "You asked for this, endorsed it, or it is yours; somebody else takes the next step." This holds for a Super User too.
Needs: the manager link or `approve` on `employee_advance` to endorse; `post` on `employee_advance` to approve.

### How to pay out an approved advance — Advances & Loans
1. Open the approved record and press **Pay out** (صرف).
2. Choose the **Bank or cash account** (الحساب المصرفي أو النقدي) the money leaves, set **Paid on** (تاريخ الصرف — today by default, not a future day) and optionally a **Reference** (المرجع).
3. Press **Pay out** (صرف). A journal entry is written on that date (employee advances ← the account), status becomes **Paid out** (مصروفة), the record shows the account and the **Journal entry** (القيد اليومي) as links, and the person is notified.
From now the advance is recovered by payroll from its first recovery month.
Needs: `execute` on `employee_advance`.

### How an advance is recovered through payroll — Advances & Loans
- The **Schedule** (الجدول) on the record lists each month with its **Instalment** (القسط), what is **Due by then** (المستحق حتى حينه) and what was **Recovered** (المسترد) in that month. Every instalment is the amount ÷ instalments rounded down to the whole dinar; the last one takes the rest.
- Each month's payroll run deducts, as the component "Advance and loan recovery", what is due by that month less what has already come back — so a month in which nothing was recovered is caught up in the next — never more than is still owed and never more than the person's pay leaves.
- The deduction becomes real when the run is **posted**: a row **Payroll** (الرواتب) with the run's number appears in the window **What came back** (ما استُرد). If the run is reversed, a negative row **Payroll reversed** (عكس الرواتب) puts the amount back as owed.
- When everything is back, status becomes **Settled** (مسوّى) by itself.
- A paid-out advance behind its schedule shows "Recoveries are behind the schedule since <month> …"; the HR managers are also notified once a month.
- The person's employee record lists their advances with what each still owes; a leaver's record shows what is still owed in the clearance line.

### How to record a cash repayment — Advances & Loans
1. Open the paid-out record and press **Repaid in cash** (سداد نقدي).
2. Type the **Amount** (المبلغ — the whole amount still owed is offered; never more than that), choose the **Bank or cash account** the money goes into, set **Repaid on** (تاريخ السداد, not a future day) and optionally a **Reference**.
3. Press **Repaid in cash**. A journal entry is written (the account ← employee advances), a row **Cash** (نقدًا) appears in **What came back**, and the advance becomes **Settled** when nothing is owed.
If a payroll run for the same person was computed before the repayment and not yet posted, compute that run again — it would otherwise refuse to post.
Needs: `execute` on `employee_advance`.

### How to cancel an advance — Advances & Loans
1. Open the record (Draft, Pending approval, Endorsed or Approved — not yet paid out).
2. Type the reason in **Why it is cancelled** (سبب الإلغاء, required) and press **Cancel** (إلغاء). Status becomes **Cancelled** (ملغى).
An advance already paid out cannot be cancelled: it is recovered through payroll or repaid in cash.
Needs: the person, the one who entered it, or `edit_draft` on `employee_advance`.

### How to print, attach files and add notes — Advances & Loans
1. Open the record. Printer icon → the copy as PDF, Excel or Word in English or Arabic.
2. Paperclip icon → **Choose a file** → **Attach** (for example the signed agreement or the receipt). Files can be added until the advance is refused or cancelled.
3. Speech-mark icon → **Add note**; clock icon → the audit log.
Needs: `print` / `export` on `employee_advance`; `create` on `attachment`; `edit_draft` on `employee_advance` for notes.

### Fields — Advances & Loans
New advance or loan:
- **Employee** (الموظف) — required; an active employee.
- **Kind** (النوع) — required: **Salary advance** (سلفة راتب, the default) or **Loan** (قرض).
- **Amount** (المبلغ) — required; whole dinars, more than zero.
- **Instalments** (الأقساط) — 1 by default; must be 1 for a salary advance; 1 to 60 for a loan.
- **First recovery month** (شهر الاسترداد الأول) — written YYYY-MM; the month after the current one by default. The first month payroll deducts an instalment.
- **Reason** (السبب) — required.
On the record (read-only): Reference, Status, Employee, Kind, Amount, Instalments, First recovery month, **Recovered** (المسترد), **Still owed** (المتبقي), **Asked by** (طلبها), **Endorsed by** (أيّدها), **Approved by** (اعتمدها), **Refused by** (رفضها), **Paid by** (صرفها), **Paid on** (تاريخ الصرف), **Bank or cash account**, **Journal entry**, **Cancelled by** (ألغاها), **Why it is cancelled**, **Note** (the endorsement or refusal note), Reason.
Window **What came back** (ما استُرد): Month, **How** (الطريقة) — Payroll (الرواتب), Payroll reversed (عكس الرواتب), Cash (نقدًا), Expense claim (مطالبة مصاريف) — Reference, Amount, Journal entry, Recorded.
Pay out / Repaid in cash: **Bank or cash account** — required, an active IQD account; the date — required, not in the future; **Reference** — optional; **Amount** (repayment) — required, more than zero and not more than is owed.

### After you save — Advances & Loans
- **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Endorsed** (مؤيَّدة) → **Approved** (معتمد) → **Paid out** (مصروفة) → **Settled** (مسوّى). **Rejected** (مرفوض) from waiting or endorsed; **Cancelled** (ملغى) any time before it is paid out. On the employee record the same statuses read: Draft, Waiting for endorsement, Endorsed, Approved, Paid out, Settled, Refused, Cancelled.
- Who acts next: Draft — HR or the person (send); Pending approval — the manager or an HR manager (endorse); Endorsed — Finance (approve); Approved — Finance (pay out); Paid out — payroll each month, or a cash repayment.
- Ledger: **Pay out** posts a journal on the paid-on date (employee advances ← bank or cash). **Repaid in cash** posts the reverse. Recovery by payroll is part of the payroll run's own journal; settlement by an expense claim is part of the claim's journal.

### Refusals — Advances & Loans
- "<employee number> is <status>; an advance is lent to somebody still working." — the person is suspended or has left.
- "amount: '<text>' is not an amount in dinars" — digits only, no commas.
- "The amount must be more than nothing." / "The amount is lent in whole dinars."
- "A salary advance comes back in one instalment; several instalments make it a loan." — set Kind to Loan, or Instalments to 1.
- "An advance is recovered in 1 to 60 monthly instalments."
- "first_recovery_month: is a month, written YYYY-MM".
- "reason: is required".
- "<advance number> was asked by you or is yours; somebody else endorses it."
- "You asked for, endorsed or are the person on <advance number>; somebody else approves it."
- "<advance number> was asked by you or is yours; somebody else decides it." — you cannot refuse it either.
- "note: is required" — a refusal needs its reason.
- "<advance number> is <status>; it cannot become <status>." — the action does not fit the status (for example cancelling a paid-out advance).
- "paid_on: <date> has not come yet; record the payment the day the money leaves"; "repaid_on: <date> has not come yet".
- "account: choose the bank or cash account the money moves through"; "<account> is deactivated."; "<account> holds <currency>; advances are lent in dinars (D-HR-2)."
- "<advance number> is <status>; only a paid advance is repaid."
- "A repayment of nothing repays nothing."
- "<advance number> has <amount> IQD still owed; <amount> IQD is more than remains (H6)." — type at most what is owed.
- "Permission denied: 'post' on 'employee_advance' is not granted to this user." — approval belongs to Finance; 'execute' — paying out and repayments belong to Finance.
- From the ledger when paying out or repaying: "No accounting mapping is configured for the 'employee_advance' line…", closed or missing period, "<account> … cannot hold less than nothing…" — see "Posting to the ledger — HR".

## Recruitment (التوظيف)
Path: HR → Human Resources → Recruitment   |   Arabic: HR ← الموارد البشرية ← التوظيف
Address: /hr/recruitment   (a vacancy: /hr/recruitment/<vacancy number>, for example /hr/recruitment/VAC-HQ-2026-0002; an applicant: /hr/recruitment/applicants/<applicant number>)
Needs: `view` on `recruitment` to open the list, a vacancy and an applicant. `create` on `recruitment` for New vacancy, Add applicant and attaching files (with `create` on `attachment`). `edit_draft` on `recruitment` to edit or cancel a draft vacancy, to move an applicant on, to edit an applicant and to add notes. `approve` on `recruitment` to Open, Amend and Close a vacancy and to Hire; a hire also needs `create` on `employee`, because it creates the employee record. Printed copies: `print` / `export` on `recruitment`.
What it is for: Vacancies for positions, the people who applied to each, the stages they pass through, and the hire that turns an applicant into an employee. As delivered: HR officers draft vacancies and work the applicants; the HR Manager opens, amends and closes vacancies and hires.

### How to find vacancies — Recruitment
1. Open HR → Human Resources → Recruitment. The register is titled **Vacancies** (الشواغر).
2. Search by vacancy number, position code or title, or words of the description.
3. Filter with **View** (العرض): **Open** (مفتوح), **Draft** (مسودة), **Filled** (مكتمل), **Closed** (مغلق), **Cancelled** (ملغى) → **Filter** (تصفية).
4. Columns: Reference (المرجع), Position (المنصب), Department (القسم), Employment kind (نوع التوظيف), **Hired / wanted** (المعيّنون / المطلوب), **Applicants (open / all)** (المتقدمون (المفتوح / الكل)), Opens on (يفتح في), Closes on (يغلق في), Status (الحالة). Open vacancies come first, then drafts.
5. Click the number to open the vacancy; its lines are its applicants, and each applicant's number opens the applicant.
Needs: `view` on `recruitment`.

### How to create and open a vacancy — Recruitment
1. Open HR → Human Resources → Recruitment and press **New vacancy** (شاغر جديد).
2. Choose the **Position** (المنصب — active positions; create the position first on HR → Positions if it does not exist). **Department** (القسم) may be left at "The position's department" (قسم المنصب).
3. Type the **Headcount** (العدد المطلوب — how many people are wanted, 1 to 500), choose the **Employment kind** (نوع التوظيف), set **Opens on** (يفتح في, today by default) and optionally **Closes on** (يغلق في), and write the **Description** (الوصف, required — what the job is and whom it needs).
4. Press **Create** (إنشاء). The vacancy opens as a **Draft** (مسودة) with its number (VAC-<branch>-<year>-<serial>), in the branch you are working in.
5. While it is a draft: **Edit** (تعديل) changes any of those fields; **Cancel** (إلغاء) with a reason in the **Reason** (السبب) box drops it.
6. The HR Manager presses **Open** (فتح). Status becomes **Open** (مفتوح) and applicants can be added.
Needs: `create` on `recruitment` to create; `edit_draft` on `recruitment` to edit or cancel the draft; `approve` on `recruitment` to open.

### How to amend or close an open vacancy — Recruitment
1. Open the vacancy (status Open).
2. **Amend** (تعديل الشاغر): change the **Headcount** (never fewer than already hired) or the **Closes on** day, press **Save** (حفظ). Bringing the headcount down to the number already hired fills the vacancy.
3. **Close** (إغلاق): type the reason in the **Reason** (السبب) box (required) and press **Close**. Status becomes **Closed** (مغلق) and every applicant still in the pipeline is set to Rejected with the note "<vacancy number> was closed: <reason>".
4. An open vacancy past its closing day shows "Past its closing day (<day>): give it a later one, or close it with its reason."; the HR managers are also notified.
Needs: `approve` on `recruitment`.

### How to add an applicant — Recruitment
1. Open the vacancy (it must be Open) and press **Add applicant** (إضافة متقدم).
2. Type the **Full name (English)** (required), and optionally the **Full name (Arabic)**, **Phone** (الهاتف), **E-mail** (البريد الإلكتروني), **Source** (المصدر — where they heard of it: a referral, a job board, a walk-in) and a **Note** (ملاحظة).
3. Press **Create** (إنشاء). The applicant opens with a number (APL-<branch>-<year>-<serial>) at the stage **Applied** (تقدّم).
4. File the CV or letters with the paperclip icon on the applicant's page.
Needs: `create` on `recruitment` (and `create` on `attachment` for the files).

### How to move an applicant through the stages — Recruitment
1. Open the applicant (from the vacancy's lines) and press **Move on** (نقل للمرحلة التالية).
2. Choose the **Stage** (المرحلة): a later stage — **Screening** (الفرز), **Interview** (المقابلة), **Offer** (عرض) — or **Rejected** (مرفوض) or **Withdrawn** (انسحب). A stage may be skipped; an applicant never moves back.
3. Type a **Note** (ملاحظة); it is required when they are rejected or withdraw.
4. Press **Move on**. The move is added to the lines **Stages** (المراحل) with When, From, To, By and Note. Moving to **Offer** notifies the people who may hire.
5. **Edit** (تعديل) on the applicant corrects the name, phone, e-mail or source without moving them.
An applicant who is Hired, Rejected or Withdrawn is closed: no more moves or edits.
Needs: `edit_draft` on `recruitment`.

### How to hire an applicant — Recruitment
1. Open the applicant. They must be at the stage **Offer** (عرض) and their vacancy must still be Open.
2. Press **Hire** (تعيين). The caption says where the employee will be created: the vacancy's position, department and branch.
3. Set the **Hire date** (تاريخ التعيين, today by default) and the **Employment kind** (the vacancy's by default); optionally choose the **Manager** (المدير) and type the **National ID** (الرقم الوطني), **Date of birth** (تاريخ الميلاد) and **Contract ends** (ينتهي العقد).
4. Press **Hire**. In one step: an employee record is created (with the applicant's names and phone) and linked to the applicant; the applicant's stage becomes **Hired** (عُيّن); the vacancy's Hired count goes up; the chosen manager is notified.
5. When the last wanted person is hired, the vacancy becomes **Filled** (مكتمل) and every applicant still in its pipeline is set to Rejected with the note "<vacancy number> is filled".
6. Continue on the new employee record (the applicant shows it as **Employee**): set the salary, link a sign-in. The employee record shows **Hired from** with the application.
Needs: `approve` on `recruitment` and `create` on `employee`.

### How to print, attach files and add notes — Recruitment
1. On a vacancy or an applicant: printer icon → PDF, Excel or Word in English or Arabic.
2. Paperclip icon → **Choose a file** → **Attach**. On a vacancy (for example the approved requisition) while it is Draft or Open; on an applicant (CV, letters) at any time.
3. Speech-mark icon → **Add note**; clock icon → the audit log.
Needs: `print` / `export` on `recruitment`; `create` on `recruitment` and on `attachment` for files; `edit_draft` on `recruitment` for notes.

### Fields — Recruitment
New vacancy / Edit (draft):
- **Position** (المنصب) — required; an active position.
- **Department** (القسم) — optional on a new vacancy: left empty, the position's own department.
- **Headcount** (العدد المطلوب) — required; a whole number 1 to 500; 1 by default.
- **Employment kind** (نوع التوظيف) — required: Permanent (دائم, default), Contract (عقد), Daily (يومي). It is the default kind of the people hired.
- **Opens on** (يفتح في) — required; today by default.
- **Closes on** (يغلق في) — optional; not before Opens on. Past it, the vacancy is flagged overdue.
- **Description** (الوصف) — required.
On the vacancy (read-only): Reference, Status, Branch, Position, Department, **Holding the position now** (يشغل المنصب الآن — active employees seated in that position today), Headcount, **Hired** (المعيّنون), Employment kind, Opens on, Closes on, **Created by** (أنشأه), **Opened by** (فتحه), **Closed by** (أغلقه), **Reason** (السبب), Description; totals Headcount, Hired, **In the pipeline** (قيد المتابعة).
Applicant: **Full name (English)** — required; **Full name (Arabic)**, **Phone**, **E-mail** (must look like an e-mail address), **Source**, **Note** — optional.
Hire: **Hire date** — required; **Employment kind** — required; **Manager** — optional ("No manager yet" — بلا مدير بعد); **National ID** — optional, must not already belong to an employee; **Date of birth**, **Contract ends** — optional.

### After you save — Recruitment
- Vacancy: **Draft** (مسودة) → **Open** (مفتوح) → **Filled** (مكتمل) when as many are hired as wanted, or **Closed** (مغلق) with a reason; a draft may be **Cancelled** (ملغى). Filled, Closed and Cancelled are final.
- Applicant stages: **Applied** (تقدّم) → **Screening** (الفرز) → **Interview** (المقابلة) → **Offer** (عرض) → **Hired** (عُيّن); from any open stage → **Rejected** (مرفوض) or **Withdrawn** (انسحب) with a note.
- Who acts next: Draft vacancy — the HR Manager (open); Open — HR (add and move applicants); an applicant at Offer — the HR Manager (hire).
- A hire creates the employee in HR → Employees. Nothing posts to the ledger.

### Refusals — Recruitment
- "position: <code> is deactivated; a vacancy is for a position in use".
- "A vacancy is for 1 to 500 people."
- "closes_on: cannot be before the opening day <date>".
- "description: is required"; "reason: is required" (cancel, close).
- "<vacancy number> is <status>; only a draft is changed."
- "<vacancy number> is <status>; it cannot become <status>." — for example opening a vacancy that is not a draft.
- "<vacancy number> is <status>; only an open vacancy is amended."
- "<vacancy number> has already hired <N>; the headcount cannot be fewer."
- "<vacancy number> is <status>; applicants are added while it is open."
- "full_name_en: is required"; "email: '<text>' is not an e-mail address".
- "<applicant number> is <stage>; the application is closed." / "…their application is closed."
- "<applicant number> is at <stage>; an applicant moves forward, never back to <stage>."
- "Say why <applicant number> is rejected." / "…is withdrawn." — type the note.
- "<applicant number> is at <stage>; a hire is an offer accepted." — move them to Offer first.
- "<vacancy number> is <status>; a hire is made against an open vacancy." — the page shows "<vacancy number> is no longer open; an offer on it cannot become a hire."
- "<vacancy number> has hired all <N> it wanted." — raise the headcount with Amend first.
- "national_id: is already <employee number>'s — one record per person; move them instead" — the person is already an employee: move the existing employee instead of hiring again.
- "hire_date: must be a day, written YYYY-MM-DD"; "contract_end_date: cannot be before the hire date <date>"; "manager: has left the company".
- "Permission denied: 'approve' on 'recruitment' is not granted to this user." — opening, amending, closing and hiring are the HR Manager's. "Permission denied: 'create' on 'employee'…" — the hirer must also be allowed to create employees.

## Performance (الأداء)
Path: HR → Human Resources → Performance   |   Arabic: HR ← الموارد البشرية ← الأداء
Address: /hr/performance   (a review: /hr/performance/<review number>, for example /hr/performance/REV-HQ-2026-00012). In Arabic the page itself is titled تقييم الأداء.
Needs: `view` on `performance_review` to open the list; `create` on `performance_review` for Start a cycle's reviews and New review. On a review — set goals (titles, targets, weights): the reviewer, or `edit_draft` on `performance_review`; rate the goals and Finish the rating: the reviewer only (no permission needed); Change reviewer: `edit_draft`; Reopen: the reviewer, or `approve` on `performance_review`; Sign off: `approve`, and never the reviewer nor the person reviewed; Cancel: `approve`; Add my word: the person reviewed. Files: `create` on `attachment`; notes: `edit_draft` on `performance_review`. A review page opens for HR (with the view permission, in the review's branch), for the person and for the reviewer. Review cycles are made, opened and closed on HR Settings (`configure` on `hr_setting`).
What it is for: Performance reviews by cycle. Each review is one person's, for one cycle, by one reviewer: goals with weights that make 100, a rating of 1 to 5 on each, an overall rating computed from them, a sign-off by HR, and the person's own word.

### How to find reviews — Performance
1. Open HR → Human Resources → Performance. The register is titled **Reviews** (التقييمات).
2. Search by review number, employee number or name. Filter with **Cycle** (الدورة — "Every cycle" كل الدورات) and **View** (العرض): **Rated** (مُقيَّم), **Draft** (مسودة), **Signed off** (معتمد), **Cancelled** (ملغى) → **Filter** (تصفية).
3. Columns: Reference (المرجع), Employee (الموظف), Cycle (الدورة), Reviewer (المقيِّم), **Goals** (الأهداف — how many), **Weight** (الوزن — the goals' total %), **Overall** (الإجمالي), Status (الحالة). Rated reviews (waiting for sign-off) come first.
4. Click the number to open the review.
Needs: `view` on `performance_review`.

### How to start the reviews of a cycle — Performance
1. A review cycle must be open. If none is, the page says "No review cycle is open. Open one on HR Settings." — create and open it under Settings → Administration → HR Settings → Review cycles.
2. For everybody at once: press **Start a cycle's reviews** (بدء تقييمات الدورة), choose the **Cycle** (الدورة) and optionally one **Department** (القسم; "Every department" كل الأقسام), press **Start a cycle's reviews**. One review is created for each person of your branch (Active or Suspended, hired on or before the cycle's end) who has none in that cycle, with their manager as reviewer. The page then says "N reviews started." and lists anyone "Passed over — no manager who signs in".
3. For one person (or for those passed over): press **New review** (تقييم جديد), choose the **Cycle**, the **Employee** (الموظف) and the **Reviewer** (المقيِّم) — left at "Their manager" (مديره), the person's manager reviews them — and press **Create** (إنشاء).
4. Each review opens as a **Draft** (مسودة) with its number (REV-<branch>-<year>-<serial>); the reviewer is notified.
A person has at most one review per cycle.
Needs: `create` on `performance_review`.

### How to set the goals of a review — Performance
1. Open the draft review. The lines **Goals** (الأهداف) are a grid you type into; two empty rows are always offered at the end (up to 10 goals).
2. For each goal type the **Goal** (الهدف — its title), optionally the **Target** (المستهدف), and the **Weight** (الوزن) as a whole percentage from 1 to 100.
3. To add a goal, type it in an empty row; to remove one, clear its title.
4. Press **Save goals** (حفظ الأهداف). The total **Weight** is shown at the foot of the window; while it is not 100 the page says "The goals' weights make N; they must make 100 before the review is rated." The total may never exceed 100.
Goals can be changed only while the review is a draft.
Needs: being the reviewer, or `edit_draft` on `performance_review` (HR sets titles, targets and weights; only the reviewer rates).

### How to rate a review and finish it (the reviewer) — Performance
1. Open the draft review you are the reviewer of.
2. In the goals grid choose a **Rating** (التقدير) for every goal — **1 · Unsatisfactory** (غير مُرضٍ), **2 · Needs improvement** (يحتاج إلى تحسين), **3 · Meets expectations** (يلبّي التوقعات), **4 · Exceeds expectations** (يفوق التوقعات), **5 · Outstanding** (متميّز) — and optionally a **Comment** (تعليق) per goal. Press **Save goals** (حفظ الأهداف).
3. Press **Finish the rating** (إنهاء التقييم), optionally type the **Reviewer's comment** (تعليق المقيِّم), and press **Finish the rating**.
4. The weights must make exactly 100 and every goal must be rated. The **Overall** (الإجمالي) is computed as the weighted average — the sum of weight × rating, divided by 100 — to two decimals; it is never typed.
5. Status becomes **Rated** (مُقيَّم). The person is notified that their review is written, and the HR managers that it waits for sign-off. The cycle must still be open.
Needs: being the review's reviewer. Nobody else — not HR, not a Super User who is not the reviewer — can rate or finish it.

### How to sign off, reopen or cancel a review — Performance
1. **Sign off** (اعتماد) — on a Rated review: press it, optionally type a **Sign-off note** (ملاحظة الاعتماد), press **Sign off**. Status becomes **Signed off** (معتمد); the person and the reviewer are notified. A signed-off review can no longer change (except the person's own word).
2. **Reopen** (إعادة فتح) — on a Rated review: type the reason in **Why it goes back** (سبب الإعادة, required) and press **Reopen**. It returns to **Draft**, the overall rating is cleared, and the reviewer is notified to correct it.
3. **Cancel** (إلغاء) — on a Draft or Rated review (the person left, the wrong cycle): type the **Reason** (السبب, required) and press **Cancel**. Status becomes **Cancelled** (ملغى).
4. **Change reviewer** (تغيير المقيِّم) — on a Draft: choose another **Reviewer** and press **Save** (حفظ); the new reviewer is notified.
Who signs off: an HR manager who is neither the reviewer nor the person reviewed. If you are one of them the page says "You wrote this review or it is yours; another HR manager signs it off."
Needs: `approve` on `performance_review` to sign off or cancel; the reviewer or `approve` to reopen; `edit_draft` to change the reviewer.

### How to read your own review and add your word (the employee) — Performance
1. Open your review from the notification or by its address (your employee record must be linked to your sign-in). While it is still a draft you see "Your review is being written; you will be told when it is rated."
2. Once it is **Rated** or **Signed off**, press **Add my word** (إضافة كلمتي), type **The person's word** (كلمة الموظف) and press **Add my word**.
3. Your word is given once and kept with the review; it cannot be changed afterwards. The reviewer is notified.
4. The printer icon gives you your own copy.
Needs: being the person the review is about; no permission.

### Fields — Performance
New review:
- **Cycle** (الدورة) — required; only open cycles are offered.
- **Employee** (الموظف) — required; a person whose status is Active or Suspended.
- **Reviewer** (المقيِّم) — optional; any active user. Left at "Their manager" (مديره), the person's manager through the manager link. A person never reviews themself.
Goals grid: **Goal** (الهدف) — the title, required for a row to count; **Target** (المستهدف) — optional; **Weight** (الوزن) — required, whole number 1–100, all weights together at most 100 and exactly 100 to finish; **Rating** (التقدير) — 1 to 5, the reviewer only; **Comment** (تعليق) — optional, the reviewer only.
On the review (read-only): Reference, Status, Employee, Cycle, **Period** (الفترة), Reviewer, **Overall** (الإجمالي), **Created by** (أنشأه), **Rated by** (قيّمه), **Signed off by** (اعتمده), **Sign-off note**, **Cancelled by** (ألغاه), **Reason**, **Reviewer's comment** (تعليق المقيِّم), **The person's word** (كلمة الموظف). Totals: Weight, Overall.

### After you save — Performance
- **Draft** (مسودة) → **Rated** (مُقيَّم) → **Signed off** (معتمد). Rated → Draft with Reopen. Draft or Rated → **Cancelled** (ملغى). Signed off and Cancelled are final.
- Who acts next: Draft — HR and the reviewer (goals), then the reviewer (rate and finish); Rated — an HR manager (sign off), and the person may add their word.
- A review can be rated and signed off only while its cycle is open; if it is not, the page says "Cycle <code> is not open; the review waits until it is." A cycle can be closed only when every review in it is signed off or cancelled.
- The person's reviews are listed on their employee record. Nothing posts to the ledger.

### Refusals — Performance
- "<cycle> is <status>; reviews are written while their cycle is open." — open the cycle on HR Settings (a closed cycle cannot be reopened).
- "<employee number> has left; a review is for somebody still working."
- "<employee number> already has <review number> in <cycle>." — open that review instead.
- "reviewer: <employee number> has no manager with a sign-in; name the reviewer" — choose a Reviewer in the New review dialog.
- "A person does not review themself."; "reviewer: names nobody who signs in".
- "<review number> is <status>; its goals change while it is a draft." — reopen it first.
- "Goal <N>: the weight is a whole number from 1 to 100."; "Goal <N>: the rating is 1 to 5."
- "The goals' weights make <N>; they may not make more than 100."; "A review has at most 10 goals."
- "Only the reviewer rates <review number>."; "Only the reviewer comments on a goal of <review number>."
- "<review number> is rated by its reviewer." — only the reviewer can finish the rating.
- "A review is rated on its goals; it has none."; "The goals' weights make <N>; they must make 100."; "Goal <N> (<title>) is not rated."
- "<review number> is <status>; it cannot become <status>." — for example signing off a draft.
- "You wrote or are the person on <review number>; somebody else signs it off."
- "Only <name> adds their word to <review number>."; "<review number> is <status>; the person adds their word once it is written."; "Your word on <review number> is already given."
- "<review number> is <status>; its reviewer changes while it is a draft."
- "reason: is required" (Reopen, Cancel); "comment: is required" (Add my word).
- "Permission denied: 'approve' on 'performance_review' is not granted to this user." — sign-off and cancelling are the HR Manager's.

## Employee Requests (طلبات الموظفين)
Path: HR → Human Resources → Employee Requests   |   Arabic: HR ← الموارد البشرية ← طلبات الموظفين
Address: /hr/requests   (a record: /hr/requests/<request number> — ECLM-… an expense claim, TRV-… a trip, LTR-… a letter, ERQ-… another request)
Needs: `view` on `employee_request` to open the list; `create` on `employee_request` for New request. On a record — Edit, Save (a claim's expenses) and Send for approval: the person, whoever entered the request, or `edit_draft` on `employee_request`; Approve and Refuse: the person's manager (the manager link, no permission needed) or `approve` on `employee_request`, never the asker nor the person; Reimburse (a claim): `execute` on `employee_request`, never the person themself; Issue the letter: `edit_draft` on `employee_request`, never the person themself; Open an advance (a trip): `create` on `employee_advance`; Cancel: a draft or waiting request by the person, the asker or `edit_draft`, an approved claim or letter with `approve`. Files: `create` on `attachment`; notes: `edit_draft` on `employee_request`. A record page opens for HR (the view permission, in the record's branch), the person and the person's manager; the person may also print it.
What it is for: Four kinds of request in one register: an **Expense claim** (مطالبة مصاريف), a **Travel** request (سفر), a **Letter** (خطاب) and an **Other request** (طلب آخر). Each is asked, sent, and approved or refused by the manager or HR. Then a claim is reimbursed by Finance (posting to the ledger), a letter is issued by HR and printed, and an approved trip may open an advance; a trip and an other request end at their approval.

### How to find requests — Employee Requests
1. Open HR → Human Resources → Employee Requests.
2. Search by request number, subject, employee number or name.
3. Filter: **Kind** (النوع — "Every kind" كل الأنواع, Expense claim, Travel, Letter, Other request) and **View** (العرض): **Pending approval** (بانتظار الموافقة), **Approved** (معتمد), **Draft** (مسودة), **Reimbursed** (مُسدَّد), **Issued** (صادر), **Rejected** (مرفوض), **Cancelled** (ملغى) → **Filter** (تصفية).
4. Columns: Reference (المرجع), Kind (النوع), Employee (الموظف), Subject (الموضوع), Asked on (تاريخ الطلب), Amount (المبلغ — a claim's total, or a trip's estimated cost), Status (الحالة). Requests waiting for a decision come first, then approved ones.
5. Click the number to open the request.
Needs: `view` on `employee_request`.

### How to enter a request — Employee Requests
1. Open HR → Human Resources → Employee Requests and press **New request** (طلب جديد).
2. Choose the **Kind** (النوع) and the **Employee** (الموظف), type the **Subject** (الموضوع, required) and optionally the **Details** (التفاصيل).
3. For a trip, fill the part **For a trip** (للسفر): **Destination** (الوجهة), **From** (من), **To** (إلى) — all three are needed for a Travel request — and the **Estimated cost** (الكلفة التقديرية) in dinars if an advance may be wanted.
4. For a letter, fill the part **For a letter** (للخطاب): the **Letter** type — **Employment letter** (خطاب تأييد عمل), **Experience letter** (شهادة خبرة), **Other letter** (خطاب آخر) — and **Addressed to** (موجّه إلى).
5. Press **Create** (إنشاء). The request opens as a **Draft** (مسودة) with a number in its kind's own series. The trip and letter boxes are ignored for the other kinds.
6. For an expense claim, now type the expenses on the record (see "How to fill an expense claim"). Then press **Send for approval** (إرسال للاعتماد).
For a person whose employment has ended only a letter can be asked.
Needs: `create` on `employee_request`.

### How to fill an expense claim — Employee Requests
1. Open the draft claim (number ECLM-…). Its lines **Expenses** (المصاريف) are a grid you type into; three empty rows are always offered.
2. At the top of the grid: **Subject** (الموضوع, required); **Trip** (الرحلة) — optional: an approved trip of the same person ("No trip" بلا رحلة otherwise); **Details** (التفاصيل).
3. For each expense: **Spent on** (تاريخ الصرف — the date, not in the future), **Expense category** (فئة المصروف), **What for** (الغرض) and the **Amount** (المبلغ) in dinars.
4. To add an expense type it in an empty row; to remove one, clear its row. Press **Save** (حفظ). The **Total claimed** (مجموع المطالبة) is the sum of the lines. A claim has at most 50 lines.
5. If the page says "Some of these expenses want their receipts: attach them below before sending the claim.", attach the receipts with the paperclip icon at the top of the record.
6. Press **Send for approval** (إرسال للاعتماد).
Naming the trip matters: when the claim is reimbursed, what the trip's advance still owes is settled from the claim first and only the rest is paid.
Needs: the person, whoever entered the request, or `edit_draft` on `employee_request`.

### How to change a draft, send it, or cancel it — Employee Requests
1. Open the draft. For a trip, a letter or an other request press **Edit** (تعديل), change the Subject, Details and the trip's or letter's fields, press **Save** (حفظ). For a claim, change the grid and press **Save**. The kind and the employee cannot be changed.
2. Press **Send for approval** (إرسال للاعتماد). Status becomes **Pending approval** (بانتظار الموافقة); the person's manager is notified, or — without a manager who signs in, or when the manager entered it — those who may approve requests.
3. To drop a request: type the reason in the **Reason** (السبب) box (required) and press **Cancel** (إلغاء). A draft or waiting request can be cancelled by the person, the asker or HR; an approved claim or letter (not yet reimbursed or issued) only by an HR manager. An approved trip or other request is final and cannot be cancelled.
Needs: the person, the asker, or `edit_draft` on `employee_request`; `approve` on `employee_request` to cancel after approval.

### How to approve or refuse a request — Employee Requests
1. Open the request (status Pending approval).
2. To approve: press **Approve** (اعتماد), optionally type a **Note** (ملاحظة), press **Approve**.
3. To refuse: type the reason in **Why it is refused** (سبب الرفض, required) and press **Refuse** (رفض). Status becomes **Rejected** (مرفوض); it is final.
4. The person and the asker are notified. After approval, Finance is notified of a claim to reimburse and HR of a letter to issue.
Who may decide: the person's manager through the manager link, or someone with the approve permission (as delivered, the HR Manager). Never the user who entered the request and never the person it is for — the page then says "You asked for this request or it is yours; somebody else decides it." This holds for a Super User too.
Needs: the manager link, or `approve` on `employee_request`.

### How to reimburse an approved expense claim — Employee Requests
1. Open the approved claim and press **Reimburse** (تسديد).
2. If the claim names a trip, the dialog says "What the advance of <trip> still owes is settled from this claim first; only the rest is paid."
3. Choose the **Bank or cash account** (الحساب المصرفي أو النقدي) the money leaves. Leave it at "None — the advance takes it all" (لا شيء — السلفة تستوعبها كلها) only when the trip's advance owes at least the whole claim.
4. Set **Reimbursed on** (تاريخ التسديد — today by default, not a future day) and optionally a **Reference** (المرجع). Press **Reimburse**.
5. One journal entry is written on that date: each expense line to its category's own expense account (or, when the category has none, the account Accounting mapped for employee expenses), by the person's department; the part that settles the trip's advance to employee advances; the rest from the chosen account. Status becomes **Reimbursed** (مُسدَّد); the record shows **Settled against the advance** (المسوّى من السلفة), the account and the journal as links; the person is notified. When part of the claim settled the trip's advance, a row "Expense claim" appears in that advance's window What came back.
Nobody reimburses their own claim.
Needs: `execute` on `employee_request` (as delivered, the Accounting Manager).

### How a trip gets its advance — Employee Requests
1. Enter a Travel request with an **Estimated cost**, send it and have it approved.
2. On the approved trip press **Open an advance** (فتح سلفة). The button is shown only when the trip has an estimate and no advance yet.
3. A salary advance is created as a draft for the estimate (rounded up to the whole dinar), in one instalment, with the reason "Travel <trip number>: <destination>", and its page opens under Advances & Loans. It then goes through the advance's own steps: send for endorsement, endorse, approve, pay out.
4. If no expense claim settles it, payroll recovers it from the second month after the trip ends.
5. The trip's record shows the **Advance** (السلفة) as a link and, in its lines **Claims settling this trip** (المطالبات التي تسوّي هذه الرحلة), every claim that names it.
Needs: `create` on `employee_advance`.

### How to issue and print a letter — Employee Requests
1. Open the approved letter request and press **Issue the letter** (إصدار الخطاب).
2. The box **Letter** (الخطاب) is filled with a text composed, in English, from the employee record: name, number, position, department, hire date and the company's name (an experience letter also gives the end date; an Other letter starts with the salutation only). Change it as needed — or replace it with the Arabic text.
3. Press **Issue the letter**. Status becomes **Issued** (صادر); the text is kept exactly as issued and shown in the record's lines; the person is notified.
4. Press the printer icon: an issued letter prints as the letter itself, with signature lines.
Nobody issues a letter about themself. Before approval the lines say "The letter is issued once the request is approved."
Needs: `edit_draft` on `employee_request` (HR).

### How to print, attach files and add notes — Employee Requests
1. Open the request. Printer icon → the copy in English or Arabic.
2. Paperclip icon → **Choose a file** → **Attach** (receipts, tickets, papers). Files can be added while the request is a draft, waiting or approved — not once it is reimbursed, issued, refused or cancelled.
3. Speech-mark icon → **Add note**; clock icon → the audit log.
Needs: `create` on `attachment` for files; `edit_draft` on `employee_request` for notes. The person the request is for may print it without any permission.

### Fields — Employee Requests
New request / Edit:
- **Kind** (النوع) — required; chosen once: Expense claim (the default), Travel, Letter, Other request.
- **Employee** (الموظف) — required; chosen once.
- **Subject** (الموضوع) — required, up to 200 characters.
- **Details** (التفاصيل) — optional. For an Other request this is the request itself.
- **Destination** (الوجهة), **From** (من), **To** (إلى) — required for a Travel request; To not before From.
- **Estimated cost** (الكلفة التقديرية) — optional, dinars; needed if an advance is to be opened.
- **Letter** (الخطاب) — the letter type; Employment letter by default. **Addressed to** (موجّه إلى) — optional; left empty the letter starts "To whom it may concern".
Claim lines: **Spent on** — required, not in the future; **Expense category** — required, one of the active expense categories (the same list Payables uses); a category may demand a receipt; **What for** — required; **Amount** — required, more than zero. **Trip** — optional, an approved trip of the same person.
Reimburse: **Bank or cash account** — an active IQD account, required unless the trip's advance takes the whole claim; **Reimbursed on** — required, not in the future; **Reference** — optional.
On the record (read-only): Reference, Status, Kind, Employee, Subject, **Total claimed** (مجموع المطالبة) and **Trip** (a claim); Destination, **Dates** (التواريخ), Estimated cost, **Advance** (a trip); Letter type, Addressed to (a letter); **Asked by** (طلبه), **Approved by** (اعتمده) or **Refused by** (رفضه), **Reimbursed by** (سدّده), **Reimbursed on** (تاريخ التسديد), Bank or cash account, **Settled against the advance**, **Journal entry**, **Issued by** (أصدره), **Cancelled by** (ألغاه), **Reason**, **Note**, Details.

### After you save — Employee Requests
- Every kind: **Draft** (مسودة) → **Pending approval** (بانتظار الموافقة) → **Approved** (معتمد) or **Rejected** (مرفوض). **Cancelled** (ملغى) from draft or waiting (and from an approved claim or letter).
- Expense claim: Approved → **Reimbursed** (مُسدَّد). Letter: Approved → **Issued** (صادر). Travel and Other request end at Approved.
- Who acts next: Draft — the asker or the person (send); Pending approval — the manager or an HR manager; an approved claim — Finance (reimburse); an approved letter — HR (issue); an approved trip — HR may open its advance.
- Ledger: only **Reimburse** posts — one journal on the reimbursed-on date (expenses by the person's department ← the bank or cash account, and ← employee advances for the part that settles the trip's advance).
- A claim's lines cannot change once it is sent.

### Refusals — Employee Requests
- "<employee number> has left; only a letter is asked for a leaver."
- "subject: is required".
- "destination: is required"; "travel_from: must be a day, written YYYY-MM-DD"; "travel_to: cannot be before <date>" — a Travel request needs its destination and both dates.
- "estimated: '<text>' is not an amount in dinars".
- "travel_request: <number> is not a trip" / "…is somebody else's trip" / "…is <status>; a claim settles an approved trip".
- "category: line <N> names no expense category ''" — choose the category of that line; "category: line <N>: <name> is deactivated".
- "spent_on: must be a day, written YYYY-MM-DD" — a line has no date; "spent_on: line <N>: <date> has not come yet"; "amount: line <N> claims nothing"; "amount: '<text>' is not an amount in dinars"; "description: is required" — fill What for.
- "A claim has at most 50 lines."
- "<request number> is <status>; only a draft is changed."
- "<request number> claims nothing; add what was spent."
- "<request number>: <category> wants its receipt — attach it before sending the claim." — attach the receipt with the paperclip, then send.
- "<request number> was asked by you or is yours; somebody else decides it."
- "Say why <request number> is refused."
- "<request number> is <status>; it cannot become <status>." — the action does not fit the status or the kind (for example cancelling an approved trip).
- "reason: is required" — a cancellation needs its reason.
- "<request number> is yours; somebody else reimburses it."
- "paid_on: <date> has not come yet; record the payment the day the money leaves".
- "account: choose the bank or cash account the money leaves" — the trip's advance does not cover the whole claim, so an account is needed; "<account> is deactivated."; "<account> holds <currency>; claims are reimbursed in dinars (D-HR-2)."
- "<request number> is about you; somebody else issues it."; "text: is required" — the letter has no text.
- "<request number> already has its advance."; "<request number> has no estimated cost to advance."; "<request number> is <status>; an advance is opened for an approved trip."; "<employee number> is <status>; an advance is lent to somebody still working."
- From the ledger when reimbursing: "No accounting mapping is configured for the 'employee_expense' line of 'hr.expense_claim'…" (the expense category has no expense account of its own and Accounting has not mapped one), closed or missing period, "<account> … cannot hold less than nothing…" — see "Posting to the ledger — HR".

## Documents (المستندات)
Path: HR → Human Resources → Documents   |   Arabic: HR ← الموارد البشرية ← المستندات
Address: /hr/documents   (a record: /hr/documents/<document number>, for example /hr/documents/EDOC-HQ-00015)
Needs: `view` on `employee_document` to open the list; `create` on `employee_document` for New document, Renew and attaching the scan (with `create` on `attachment`); `edit_draft` on `employee_document` for Edit, Withdraw and notes. A document page opens for HR (the view permission, in the document's branch) and for the person the document belongs to, who may also print it.
What it is for: Every person's papers on file — contract, national ID, passport, residence and work permits, certificates, licences, equipment hand-over forms — each with its number, dates and scan. A document is never deleted: it is renewed by a new record or withdrawn with a reason. Documents about to expire are flagged and notified.

### How to find documents and see what is expiring — Documents
1. Open HR → Human Resources → Documents. The subtitle says how many days before expiry a document is raised.
2. Search by document number, title, the paper's own number, employee number or name.
3. Filter: **Type** (النوع — "Every type" كل الأنواع) and **View** (العرض): **Expiring** (تنتهي قريبًا), **Expired** (منتهية), **Valid** (سارية), **Renewed** (مجدَّدة), **Withdrawn** (مسحوبة) → **Filter** (تصفية).
4. Columns: Reference (المرجع), Employee (الموظف), Type (النوع), Title (العنوان), Number (الرقم), Issued on (تاريخ الإصدار), Expires on (تاريخ الانتهاء), **Files** (الملفات — how many scans are attached), Status (الحالة). Valid documents with an expiry date come first, the soonest expiry at the top.
5. The Status of a valid document shows its expiry: **No expiry** (بلا انتهاء), **Valid** (سارية), **Expiring** (تنتهي قريبًا — the expiry is within the warning days), **Expired** (منتهية). Others show **Renewed** (جُدّدت) or **Withdrawn** (مسحوبة).
6. Click the number to open the document.
Needs: `view` on `employee_document`.

### How to file a document — Documents
1. Open HR → Human Resources → Documents and press **New document** (مستند جديد).
2. Choose the **Employee** (الموظف — active employees) and the **Type** (النوع): Contract (عقد), National ID (البطاقة الوطنية), Passport (جواز السفر), Residence permit (إقامة), Work permit (إجازة عمل), Certificate (شهادة), Licence (رخصة), Equipment hand-over (محضر تسليم معدات), Other (أخرى).
3. Optionally type the **Title** (العنوان), the paper's own **Number** (الرقم), **Issued on** (تاريخ الإصدار), **Expires on** (تاريخ الانتهاء) and a **Note** (ملاحظة).
4. Optionally choose the **Scan** (المرفق) — a photograph or PDF of the paper, up to 25MB.
5. Press **Create** (إنشاء). The document opens with its number (EDOC-<branch>-<serial>), status Valid, and the scan filed behind its paperclip.
6. A scan that arrives later is added on the document's page: paperclip icon → **Choose a file** → **Attach**.
Needs: `create` on `employee_document`; `create` on `attachment` for the scan.

### How to correct, renew or withdraw a document — Documents
1. Open the document. Its lines list all the person's papers of the same type, each renewal in turn, with links.
2. **Edit** (تعديل) — a valid document only: correct the **Title**, **Number**, **Issued on**, **Expires on** or **Note**; press **Save** (حفظ). The type and the employee cannot be changed.
3. **Renew** (تجديد) — when the person brings the new paper: press it, type the new paper's Number, Issued on and Expires on (the title is carried over), press **Renew**. A new document record is created and opens — attach the new scan there. The old one becomes **Renewed** (جُدّدت) and shows **Renewed by** (جُدّد بـ); the new one shows **Renews** (يجدّد).
4. **Withdraw** (سحب) — filed in error or returned to its holder: type the reason in **Why it is withdrawn** (سبب السحب, required) and press **Withdraw**. Status becomes **Withdrawn** (مسحوبة); it is final.
5. A document that is expiring or expired shows "Expires on <day>: ask for the renewed one." or "Expired on <day>: renew it with the new paper.", and **Days left** (الأيام المتبقية) counts down (negative once past).
Needs: `edit_draft` on `employee_document` to edit or withdraw; `create` on `employee_document` to renew.

### How expiry warnings work — Documents
- The warning period is the limit "Warn of a document's expiry (days before)" on Settings → Administration → HR Settings (30 days as delivered).
- A valid document whose expiry date is within that many days reads **Expiring**; past the date it reads **Expired**. Both are counted in the HR Dashboard figure "Documents expiring" and listed by the View filters Expiring and Expired.
- Each morning the system notifies the HR managers and the person (if they have a sign-in) about each such document, once per document and expiry date. Documents of people whose employment has ended are not raised.
- Renewing or withdrawing the document, or correcting its expiry date, clears the warning.

### How to print, attach and add notes — Documents
1. Open the document. Printer icon → the record's copy in English or Arabic.
2. Paperclip icon → the scan(s); add one with **Choose a file** → **Attach** while the document is valid. Click a file's name to open it.
3. Speech-mark icon → **Add note**; clock icon → the audit log.
Needs: `create` on `employee_document` and on `attachment` for scans; `edit_draft` on `employee_document` for notes.

### Fields — Documents
- **Employee** (الموظف) — required; an active employee; chosen once.
- **Type** (النوع) — required; Contract by default; chosen once.
- **Title** (العنوان) — optional when filing; left empty it is filled with the type's name in English (for example "work permit"). Required when editing.
- **Number** (الرقم) — optional; the paper's own number (passport number, contract reference).
- **Issued on** (تاريخ الإصدار) — optional; not in the future.
- **Expires on** (تاريخ الانتهاء) — optional; not before Issued on. Without it the document has no expiry and is never flagged.
- **Note** (ملاحظة) — optional.
- **Scan** (المرفق) — optional file.
On the record (read-only): Reference, Status, Employee, Type, Title, Number, Issued on, Expires on, **Days left** (الأيام المتبقية), **Renews** (يجدّد), **Renewed by** (جُدّد بـ), **Filed by** (حفظه), **Withdrawn by** (سحبه), **Why it is withdrawn** (سبب السحب), Note.

### After you save — Documents
- **Valid** (سارية — shown by its expiry: No expiry, Valid, Expiring, Expired) → **Renewed** (جُدّدت) when a renewal replaces it, or **Withdrawn** (مسحوبة). Renewed and Withdrawn records are kept as they were and cannot be edited.
- The person's documents are listed on their employee record. Nothing posts to the ledger.

### Refusals — Documents
- "expires_on: cannot be before <date>" — the expiry is before the issue date.
- "issued_on: <date> has not come yet".
- "<document number> is <status>; it is kept as it was." — a renewed or withdrawn document cannot be edited or withdrawn.
- "<document number> is <status>; only a valid document is renewed."
- "reason: is required" — withdrawing needs its reason.
- "<file> was not accepted: …" — the scan was refused (too large, an archive or program, or its name and content disagree); choose a PDF or an image.
- "Permission denied: 'create' on 'employee_document' is not granted to this user." / "'edit_draft' …".

## Reports (التقارير)
Path: HR → Human Resources → Reports   |   Arabic: HR ← الموارد البشرية ← التقارير
Address: /hr/reports
Needs: `view` on `hr_report` to open the screen; that is enough for Headcount and Leave balances. Payroll register also needs `view` on `payroll_run`; Unsettled advances also needs `view` on `employee_advance` — a report you may not read is not in the list. Print / Export needs `print` (PDF) or `export` (Excel, Word) on the same object as the report.
What it is for: Four read-only reports — headcount, leave balances, the payroll register and unsettled advances — shown on screen and printed or exported exactly as shown. Nothing is typed or saved here. Figures cover the branches you work in.

### How to run a report and print or export it — Reports
1. Open HR → Human Resources → Reports.
2. Choose the **Report** (التقرير): **Headcount** (عدد الموظفين), **Leave balances** (أرصدة الإجازات), **Payroll register** (سجل الرواتب) or **Unsettled advances** (السلف غير المسوّاة).
3. Press **Search** (بحث) once so that the report's own filter boxes appear, set them, and press **Search** again.
4. The table shows the rows; reports with money or counts end with a **Totals** (الإجماليات) row.
5. To take a copy press **Print / Export** (طباعة / تصدير) at the top and choose **English** or **العربية**, then **PDF**, **Excel (.xlsx)** or **Word (.docx)**. The copy carries the same filters and rows as the screen.
Needs: `view` on `hr_report` (plus the report's own permission, see Needs above).

### Headcount report: filters and columns — Reports
- Filters: **From** (من) and **To** (إلى). By default To is today and From is 1 January of that year.
- Columns: **Branch** (الفرع), **Department** (القسم), **Position** (المنصب — "No position" بلا منصب for people without one), **Headcount** (العدد), **Joined** (انضموا), **Left** (غادروا).
- **Headcount** = people employed on the To date (hired on or before it, employment not ended by it). **Joined** = hire date inside the period. **Left** = end date inside the period.
- People are counted where they are now (their current branch, department and position). A row appears only if somebody in it was employed at some time in the period. The last row totals the three figures.

### Leave balances report: filters and columns — Reports
- Filter: **Year** (السنة — this year by default).
- One row per person (status Active or Suspended) and per active leave type: **Employee** (الموظف), **Department** (القسم), **Leave** (الإجازة), **Carried in** (المرحَّل), **Entitlement** (الاستحقاق), **Adjustments** (التعديلات), **Taken** (المأخوذ), **Asked** (المطلوب — days waiting for a decision), **Available** (المتاح — the balance less what is asked).
- The figures are the same as on the employee record's Leave window (see "How balances, entitlement and carry-over work — Leave Management"). There is no totals row: days of different leave types do not add up.

### Payroll register report: filters and columns — Reports
- Filter: **Month** (الشهر), typed as YYYY-MM (this month by default).
- Rows: every line of the payroll runs of that month that are Approved, Posted or Paid — draft, waiting, cancelled and reversed runs are left out. Columns: **Run** (الدورة), **Branch**, **Employee**, **Department**, **Payslip** (قسيمة الراتب), **Gross** (الإجمالي), **Deductions** (الاستقطاعات), **Net** (الصافي), **Employer cost** (كلفة صاحب العمل); the last row totals the four amounts.
- With nothing to show: "No approved or posted payroll in this month."
Needs: `view` on `hr_report` and `view` on `payroll_run`.

### Unsettled advances report: filters and columns — Reports
- Filter: **As of** (حتى تاريخ — today by default).
- Rows: advances and loans whose status is Paid out and that were paid out on or before that date. Columns: Reference (المرجع), **Kind** (النوع), **Employee**, **Paid on** (تاريخ الصرف), **Amount** (المبلغ), **Recovered** (المسترد), **Owed** (المتبقي), **Behind since** (متأخر منذ — the month of the oldest instalment not yet recovered; empty when the advance is on schedule; the month in progress never counts as late), **Days behind** (أيام التأخر — current, 1-30, 31-60, 61-90 or 90+). Recovered and Owed are today's figures. The last row totals Owed.
- With nothing to show: "No advance is still owing."
Needs: `view` on `hr_report` and `view` on `employee_advance`.

### Refusals — Reports
- **Not available to you** (غير متاح لك) — you lack the right to view HR reports (see Needs).
- The Payroll register or Unsettled advances is missing from the Report list — you do not hold the view permission of payroll runs or of employee advances.
- The **Print / Export** menu is missing or lacks a format — PDF needs the print right and Excel and Word the export right for that report (see Needs).
- "This export has <N> rows; a file may carry at most <cap>. Narrow the filters … and export again." — choose a shorter period.

## HR Settings (إعدادات الموارد البشرية)
Path: Settings → Administration → HR Settings   |   Arabic: الإعدادات ← الإدارة ← إعدادات الموارد البشرية
Address: /administration/hr-settings
Needs: `view` on `hr_setting` to open the screen; `configure` on `hr_setting` to add or change anything (as delivered: the HR Manager and the system administrator; the HR Officer and the CEO can only read).
What it is for: The master data the HR screens read, in five windows on one page: **Pay components** (مكوّنات الراتب), **Leave types** (أنواع الإجازات), **Working calendars** (تقاويم العمل) with their holidays, **Review cycles** (دورات التقييم) and **Limits for the morning sweep** (حدود المراجعة الصباحية). Nothing is deleted here; a row is deactivated. Positions are no longer on this screen — they are under HR → Human Resources → Positions.

### How to add or change a pay component — HR Settings
1. Open Settings → Administration → HR Settings, window **Pay components** (مكوّنات الراتب).
2. To add: under **New pay component** (مكوّن راتب جديد) type the **Code** (الرمز — letters, digits, hyphens or underscores; it cannot be changed later), **Name (English)** and optionally **Name (Arabic)**; choose the **Kind** (النوع) and the **Calculation** (طريقة الاحتساب); type the **Default (IQD or %)** (الافتراضي); optionally choose an **Expense account** (حساب المصروف) and/or a **Liability account** (حساب الالتزام); **Taxable** (خاضع للضريبة) is ticked by default — untick it if it is not. Press **Save** (حفظ).
3. To change one: press **Edit** (تعديل) in its row, change anything except the code, press **Save**.
4. To stop using one: type the **Reason** (السبب) in its row and press **Deactivate** (تعطيل). **Activate** (تفعيل) brings it back. A deactivated component is left out of new payroll computations; payslips already issued keep it.
5. The change is used the next time a draft payroll run is computed; posted runs do not change.
Needs: `configure` on `hr_setting`.

### How to add a leave type, or deactivate one — HR Settings
1. Open Settings → Administration → HR Settings, window **Leave types** (أنواع الإجازات).
2. Under **New leave type** (نوع إجازة جديد) type the **Code**, **Name (English)** and optionally **Name (Arabic)**; **Days / year** (أيام / سنة); **Carry-over** (الترحيل); **May go below zero by** (يُسمح بالسالب حتى); tick **Paid** (مدفوعة), **Needs attachment** (تحتاج مرفقاً) and **Warn before it lapses** (تنبيه قبل السقوط) as needed. Press **Save** (حفظ).
3. To stop using a type: type the **Reason** in its row and press **Deactivate** (تعطيل); **Activate** (تفعيل) brings it back. A deactivated type is not offered on new leave requests.
There is no Edit for an existing leave type on this screen: its days, carry-over and ticks cannot be changed here after it is created.
Needs: `configure` on `hr_setting`.

### How to add a working calendar and its holidays — HR Settings
1. Open Settings → Administration → HR Settings, window **Working calendars** (تقاويم العمل).
2. Under **New calendar** (تقويم جديد) type the **Code**, **Name (English)**, optionally **Name (Arabic)**, the **Year** (السنة) and the **Working days** (أيام العمل) as three-letter day names separated by commas — sun, mon, tue, wed, thu, fri, sat (the box starts with sun,mon,tue,wed,thu). Press **Save** (حفظ).
3. To add a public holiday: under **Add holiday** (إضافة عطلة) choose the calendar, the **Date** (التاريخ — it must fall in the calendar's year), type the **Name (English)** and optionally the **Name (Arabic)**, press **Add holiday**.
4. To remove a holiday press **Remove** (إزالة) beside it in the calendar's row.
5. One calendar is used per year: the year's calendar (if there are several for a year, the first by code). A year with no calendar uses Sunday to Thursday with no holidays. Create next year's calendar before leave is requested into it.
What reads it: leave days are counted on it, Attendance reads rest days and holidays from it, and Payroll takes the month's working days from it. A calendar cannot be edited after it is created; only its holidays change.
Needs: `configure` on `hr_setting`.

### How to create, open and close a review cycle — HR Settings
1. Open Settings → Administration → HR Settings, window **Review cycles** (دورات التقييم). Columns: Code, Name, **Period** (الفترة), **Signed off / reviews** (المعتمد / التقييمات), Status.
2. Under **New review cycle** (دورة تقييم جديدة) type the **Code**, **Name (English)**, optionally **Name (Arabic)**, and the period **From** (من) and **To** (إلى). Press **Save** (حفظ). The cycle is a **Draft** (مسودة).
3. Press **Open** (فتح) in its row. Status becomes **Open** (مفتوحة); reviews can now be started on HR → Performance.
4. When every review of the cycle is signed off or cancelled, press **Close** (إغلاق). Status becomes **Closed** (مغلقة); a closed cycle cannot be reopened.
Needs: `configure` on `hr_setting`.

### How to change the reminder limits — HR Settings
1. Open Settings → Administration → HR Settings, window **Limits for the morning sweep** (حدود المراجعة الصباحية).
2. Under **Change the limits** (تغيير الحدود) type whole numbers of days (0 to 366):
   - **Warn this many days before a contract ends** (30 as delivered);
   - **Remind the decider after a request waits this many days** (3) — leave requests waiting for a decision;
   - **Warn this many days before the year ends about leave that will not carry** (45);
   - **Warn of a document's expiry (days before)** (30) — also what makes a document read "Expiring" on HR → Documents.
3. Press **Save** (حفظ). A box left empty keeps its value.
Needs: `configure` on `hr_setting`.

### Fields — HR Settings
Pay component:
- **Code** (الرمز) — required, unique, fixed once saved.
- **Name (English)** (الاسم (إنجليزي)) — required; **Name (Arabic)** (الاسم (عربي)) — optional; these are what payslips print.
- **Kind** (النوع) — **Earning** (استحقاق: adds to gross pay), **Deduction** (استقطاع: taken from pay), **Employer cost** (كلفة على الشركة: paid by the company on top, not part of net pay).
- **Calculation** (طريقة الاحتساب) — **The salary in force** (الراتب النافذ: the employee's base salary; one active component only, an Earning), **Fixed amount** (مبلغ ثابت), **% of base** (% من الأساسي), **Typed on the run** (يُكتب في التشغيل: typed each month on the payroll run with a note), **Absences from the day sheet** (الغياب من كشف الحضور: one active component only, a Deduction), **Advances and loans due** (المستحق من السلف والقروض: one active component only, a Deduction).
- **Default (IQD or %)** (الافتراضي (دينار أو %)) — the monthly amount of a fixed component or the percentage of a % component, used for everybody who has no figure of their own on their employee record; 0 by default; a percentage cannot exceed 100.
- **Taxable** (خاضع للضريبة) — a mark kept on the component; the payroll computation does not use it.
- **Expense account** (حساب المصروف) — optional; where an earning or employer cost is charged. Left at "By the posting mapping" (حسب ربط الترحيل), Accounting's mapping decides. Not allowed on a Deduction.
- **Liability account** (حساب الالتزام) — optional; where a deduction or employer cost is owed (for example social security, tax). Not allowed on an Earning. The table's column **Posts to** (يُرحَّل إلى) shows both.
Leave type:
- **Code**, **Name (English)**, **Name (Arabic)** — as above.
- **Days / year** (أيام / سنة) — required; the yearly entitlement. 0 means the type is not held to a balance.
- **Carry-over** (الترحيل) — the most unused days that pass into the next year; 0 = nothing carries.
- **May go below zero by** (يُسمح بالسالب حتى) — how many days a request may overdraw the balance.
- **Paid** (مدفوعة) — ticked by default; unticked, payroll deducts the days as unpaid leave.
- **Needs attachment** (تحتاج مرفقاً) — a request of this type cannot be sent without a file (a sick note).
- **Warn before it lapses** (تنبيه قبل السقوط) — near the year end, notify about unused days above the carry-over.
Working calendar: **Code**, **Name (English)**, **Name (Arabic)**, **Year** (2000–2100), **Working days** — required. Holiday: **Date**, **Name (English)** — required; **Name (Arabic)** — optional.
Review cycle: **Code**, **Name (English)**, **From**, **To** — required; To not before From.
Limits: whole days, 0 to 366.

### After you save — HR Settings
- A pay component, leave type or review cycle is saved at once; there is no approval. Components and leave types are **Active** (فعّال) or deactivated; review cycles go **Draft** (مسودة) → **Open** (مفتوحة) → **Closed** (مغلقة).
- Changes act on what is computed afterwards: draft payroll runs when they are computed again, leave requests when they are counted, the next morning's reminders. Posted payroll runs and issued payslips never change.
- Nothing on this screen posts to the ledger.

### Refusals — HR Settings
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit".
- "code: '<code>' is already a pay component" / "…a leave type" / "…a calendar"; "code: <code> is already a review cycle" — choose another code.
- "name_en: is required".
- "calculation: the base salary is an earning"; "calculation: an absence deduction is a deduction"; "calculation: an advance recovered is a deduction" — set the Kind to match.
- "calculation: <code> is already the base salary; deactivate it first" (also "…the absence deduction…", "…the advance recovery…") — only one active component of that calculation may exist.
- "default_value: cannot be negative"; "default_value: a percentage of the base cannot exceed 100".
- "expense_account: a deduction costs the company nothing; it is owed to somebody — choose its liability account".
- "liability_account: an earning is owed to the person as net pay; it has no account of its own to be owed on".
- "reason: say why it is deactivated".
- "days_per_year: must be a number of days, up to two decimals" (the same for carry_over_days and allowed_negative_days).
- "year: must be a year between 2000 and 2100"; "working_days: name at least one day (mon,tue,wed,thu,sat)".
- "holiday_date: must fall in <year>"; "holiday_date: is already a holiday on this calendar".
- "period_to: cannot be before <date>".
- "<cycle> has <N> review(s) not yet signed off or cancelled; a cycle closes when every review is done." — sign off or cancel the remaining reviews on HR → Performance, then close.
- "<cycle> is <status>; it cannot become <status>."
- "<limit>: must be a whole number of days, 0 to 366".
- "Permission denied: 'configure' on 'hr_setting' is not granted to this user."
