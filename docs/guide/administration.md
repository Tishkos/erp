# Administration — user guide

Administration is the heading under the **Settings** (الإعدادات) module where the company, its people and their access are set up, and where the health of the system is watched.
Work flows in this order: set up the **Company** and its main branch; create **Users** and give each one branches, departments and roles; decide what each role may do (**Roles**, **Permissions**) and who finalises documents in each department (**Department Managers**); set how documents are numbered (**Numbering**).
After that the screens are for watching: **Audit Trail** (who did what), **Background Jobs** (what the server runs by itself) and **Backup and Health**.
Two one-time data loads (**Legacy Books Import**, **Payables Sheet Migration**), the **WhatsApp** bridge and **Payables Settings** complete the heading.
HR Settings and Project Settings sit under the same heading but are described in the HR and Projects guides.

## Concepts — Administration

The ideas below are shared by every Administration screen. Each one is explained once here and referred to by name in the screen blocks.

### The screens under Administration — Administration concept
The Settings (الإعدادات) module opens a menu whose first heading is Administration (الإدارة). Its screens, in menu order (a person sees only those their roles tick "View" on):
- Company (الشركة) — /administration/company
- Users (المستخدمون) — /administration/users
- Department Managers (مديرو الأقسام) — /administration/managers
- Roles (الأدوار) — /administration/roles
- Permissions (الصلاحيات) — /administration/permissions
- Numbering (الترقيم) — /administration/numbering
- Audit Trail (سجل التدقيق) — /administration/audit
- Background Jobs (المهام الخلفية) — /administration/jobs
- Backup and Health (النسخ الاحتياطي وحالة النظام) — /administration/backup-health
- Legacy Books Import (استيراد الدفاتر القديمة) — /administration/legacy-import
- Payables Sheet Migration (data import) (ترحيل جدول الذمم الدائنة (استيراد بيانات)) — /administration/payables-migration
- HR Settings (إعدادات الموارد البشرية) — /administration/hr-settings (see the HR guide)
- WhatsApp (واتساب) — /administration/whatsapp
- Project Settings (إعدادات المشاريع) — /administration/project-settings (see the Projects guide)
- Payables Settings (إعدادات الذمم الدائنة) — /administration/payables-settings

### Users, roles and permissions — Administration concept
- A **user** is one person's own sign-in account (e-mail and password). Each employee has an individual account; accounts are never shared.
- A **permission** is one action on one part of the system — for example "View" on customer invoices or "Post" on journals. There are thirteen actions: View, Create, Edit draft, Submit for approval, Approve, Execute, Post, Reverse / cancel, Print, Export, Import, Configure, Administer (see "Permissions" for what each allows).
- A **role** is a named set of permissions, for example Accounting Officer, Accounting Manager, CEO, System Administrator, HR Manager, HR Officer, Project Manager, Logistics Officer, Customs Officer.
- A person holds one or more roles and can do exactly what those roles tick — nothing else. What is not ticked is refused: the menu item is hidden and the address is refused too.
- A person without "View" on a screen who opens its address sees **Not available to you** (غير متاح لك): "You do not have permission to open this screen. Ask an administrator to grant you access to …".
- A change to a role, a branch or a department reaches the person straight away: their menu is redrawn on their next click. They do not need to sign out.
- Roles are given to people on the Users screen; what a role may do is ticked on the Permissions screen (or on the role's own page under Roles).

### Super User — Administration concept
- A **Super user** (مستخدم خارق) passes every permission check and sees every branch. It is the one blanket grant in the system.
- The Super user mark is shown on the Users list and on the user's record, but there is no button on any screen to switch it on or off.
- A Super user is still bound by maker-checker: they cannot approve a document they raised themselves, unless that document's own rules say a Super user may.
- A Super user is not automatically a Department Manager, and does not automatically hold the CEO role. Creating roles, changing permissions and giving roles to people need the CEO role even for a Super user (see "The CEO role").
- A Super user account must sign in with an authenticator code (see "Sign-in rules").
- A deactivated account is refused everything, Super user included.

### The CEO role and who may change access — Administration concept
- Creating a role, renaming a role, ticking or unticking a role's permissions, and giving or taking a role from a person are reserved to a user who holds the **CEO** role.
- The CEO role holder also needs the matching permission ("Administer" on Permissions, plus "Create"/"Configure" on Roles or "Configure" on Users).
- Anyone else sees these screens read-only: the tick boxes cannot be changed, and the role boxes and the **Add role** control do not appear.
- If someone without the CEO role tries anyway, the refusal is: "Permission denied: 'administer' on 'permission' is not granted to this user."

### Branch scope — Administration concept
- Every document belongs to a branch. A person sees and works on the records of the branches they have been given, and no others. Having no branch means seeing nothing, not everything.
- Branches are given on the user's record (Settings → Administration → Users → open the person → **Branches** card).
- The **Active branch** (الفرع النشط) in the person's own menu (their picture at the end of the top bar) shows the branch they are working in. With one branch it is plain text; with several it is a row of that person's branches to choose from. A new document starts in the active branch. The active branch is only a starting choice — it is not what gives access.
- One of the person's branches is marked **Default** (افتراضي): it is the branch a session starts in.
- Working on a branch you have not been given is refused with: "Out of scope: this user has no access to branch '…'."
- The Audit Trail follows the same rule: a person sees the events of their own branches; company-wide events (a permission change, a sign-in failure, a configuration change) are shown only to a Super user.

### Maker-checker and the approvals inbox — Administration concept
- **Maker-checker** means the person who raised a document cannot approve it. The refusal is: "You cannot approve a document you raised. This step requires a different approver (Appendix B)."
- Who approves: a document submitted for approval goes to the manager of the department it was raised in. A Department Manager who raises a document in their own department finalises it directly, with no second approval. Being manager of one department gives no authority over another department's documents.
- If the approver is the wrong person the refusal is: "This step is approved by '…'. You do not hold that role."
- If the department has no manager the refusal is: "No Department Manager is assigned to …, so this document has nobody to go to. Assign one before raising documents in that department (§5.2)." Fix it on the department's page (see "Department Managers").
- The inbox is **My Approvals** (موافقاتي): Dashboard → Home → My Approvals (الرئيسية ← الرئيسية ← موافقاتي), address /approvals. It shows **Waiting for you** (بانتظارك) — each document with who submitted it, when, and its department — with **Approve** (اعتماد) and **Reject** (رفض). A rejection needs a **Reason for rejection** (سبب الرفض). Below are **My submissions** (ما قدّمته) and **My decisions** (قراراتي). The screen also lists the other documents that wait for your decision and opens each on its own page; it is described in full under "My Approvals" in the Workspace guide.
- Open the document from the inbox and read it before deciding: its number in the inbox is a link.

### Nothing is deleted — Administration concept
- The system does not delete. A user, a branch, a department or a WhatsApp contact is **deactivated** with a written reason; a settings row (a payable type, a reason code, an expense category) is switched to inactive; a number series is **closed**; a document is **cancelled** or **reversed** with a reason. The record stays and keeps its history.
- A number that was issued is never reused, even if the document it was meant for failed. Gaps are kept, not filled.
- Every change is written to the audit trail at the moment it happens: who, when, which record, what changed (old value → new value), the reason, and whether it succeeded. A refused attempt is recorded too.
- The audit trail cannot be edited by anyone.

### The Audit log on a record — Administration concept
- The record pages of this area (a user, a role, a number series, the company) carry an **Audit log** (سجل التدقيق) button at the top. It jumps to the **Audit log** panel at the bottom of the same page.
- The panel lists what happened to that one record, newest first: the moment, the event in words, who did it, the outcome, the reason, and what changed field by field.
- If nothing happened yet it says "Nothing has been recorded for this record yet."
- The company-wide list of every event is the Audit Trail screen.

### Sign-in rules: temporary password, lockout, authenticator — Administration concept
- **Temporary password.** A new account, and an account whose password was reset, gets a temporary password. It is shown to the administrator once (or e-mailed to the person when e-mail is set up). The person signs in with it and is taken straight to the change-password screen; nothing else is available until they choose their own password. A temporary password that was never replaced stops working 72 hours after it was issued: "The temporary password has expired. Ask an administrator for a new one." The fix is **Reset password** on the user's record.
- **Password rules.** At least 12 characters. Refused: very common words (for example "password", "welcome", "qwerty", "admin", "changeme"), one character repeated, a straight keyboard run, and a password containing the account's e-mail name or the person's name. The message starts "That password cannot be used: …".
- **Lockout.** Five failed sign-ins for the same account from the same network address within fifteen minutes (a wrong password or a wrong authenticator code both count) lock it out: "Too many failed attempts. Wait fifteen minutes and try again." There is no unlock button; the person waits fifteen minutes.
- **Sessions.** A sign-in lasts eight hours. Deactivating an account or resetting its password ends all its sessions at once. Changing your own password ends your other sessions.
- **Authenticator (second step).** Super users and holders of sensitive roles (for example CEO, Accounting Manager, System Administrator, HR Manager) must sign in with a six-digit code from an authenticator app. The person enrols it themselves under My profile → **Security** (الأمان), address /profile/security: **Begin enrolment** (بدء التسجيل), scan the QR code with the app (or type the **Setup key** (مفتاح الإعداد) into it), type the **Code from the app** (الرمز من التطبيق), **Confirm enrolment** (تأكيد التسجيل). They have seven days from the first sign-in after it became required; a reminder appears in the bell each day. After seven days the Security screen is the only screen available until they enrol. The Users screen has no button to enrol, remove or reset another person's authenticator.

### Common messages on Administration screens — Administration concept
- After a successful save the page shows **Saved.** (تم الحفظ.). When a save is refused it shows **That could not be saved.** (تعذّر الحفظ.) followed by the reason. The reasons are written in English on both the English and the Arabic screens.
- A reason usually starts with the name of the field, then the problem — for example "email: already has an account" or "reason: is required to deactivate an account".
- "Permission denied: '<action>' on '<section>' is not granted to this user." — your roles do not tick that action. Ask the CEO role holder to tick it on the Permissions screen, or to give you a role that has it.
- "Out of scope: this user has no access to branch '…'." — the record's branch is not one of yours. Ask for the branch on your user record.
- "No <record> '<code>'." — the record named in the address does not exist.
- Lists on these screens have a search box ("Search this list"): type any part of a code, name or e-mail and press Enter; **Clear** (مسح) removes the search. The count of records shown is beside it.
- The row of tabs under the page title lists the other Administration screens you are allowed to open.

## Company (الشركة)
Path: Settings → Administration → Company   |   Arabic: الإعدادات ← الإدارة ← الشركة
Address: /administration/company
Needs: `view` on `company` to open. The first save needs `create` on `company`; later saves need `configure` on `company`. Changing the main branch needs `configure` on `branch`.
What it is for: The one legal entity every module works for — its code, legal name, the currency the books are kept in, and its address — and the head office (the first branch). The page title is **Company Setup** (إعداد الشركة). There is exactly one company; other branches are added under Accounting → Master Data — Organization → Branches (/master-data/branches).

### How to set up the company the first time — Company
1. Open Settings → Administration → Company (الإعدادات ← الإدارة ← الشركة), address /administration/company. While nothing is saved the page says "The company has not been set up yet. Fill in the details below to create the main company record."
2. In the **Details** (التفاصيل) panel type the **Company code** (رمز الشركة) and the **Legal name** (الاسم القانوني).
3. Choose the **Base currency** (العملة الأساسية). It starts on IQD.
4. Type the **Company location** (موقع الشركة) — the head office address as it should appear on documents.
5. Click **Create** (إنشاء). The page shows **Saved.** (تم الحفظ.).

### How to change the company details — Company
1. Open Settings → Administration → Company, address /administration/company.
2. In the **Details** (التفاصيل) panel change the **Legal name** (الاسم القانوني), the **Base currency** (العملة الأساسية) or the **Company location** (موقع الشركة). The **Company code** (رمز الشركة) is read-only and cannot be changed.
3. Click **Update** (تحديث).
4. To see who changed what, click **Audit log** (سجل التدقيق) at the top; see "The Audit log on a record".

### How to change the main branch name or address — Company
1. Open Settings → Administration → Company, address /administration/company.
2. Go to the **Main branch** (الفرع الرئيسي) panel. It shows the head office: the branch with code HQ, or the first active branch if there is no HQ.
3. Change **Branch name** (اسم الفرع) or **Branch location** (موقع الفرع). The **Code** (الرمز) is read-only.
4. Click **Save** (حفظ). The Save button appears only if you may configure branches; otherwise the fields are read-only.
5. To add or manage other branches click **Open Branches** (فتح الفروع), which goes to /master-data/branches.

### Fields — Company
Screen: Settings → Administration → Company, address /administration/company.
- **Company code** (رمز الشركة) — required. 1 to 32 letters, digits, hyphens or underscores, starting with a letter or digit; saved in capitals. It cannot be changed after the first save.
- **Legal name** (الاسم القانوني) — required, up to 200 characters. The company's registered name; it is, for example, the name on the e-mail that carries a new user's temporary password.
- **Base currency** (العملة الأساسية) — required. One of IQD (Iraqi dinar), USD (US dollar), EUR (Euro), CNY (Chinese yuan); the default is IQD. The ledger keeps its books in this currency; other currencies are priced through the exchange rates. The screen accepts a change later and only stores the new choice — it does not convert anything already recorded — so it is meant to be chosen once, at set-up.
- **Company location** (موقع الشركة) — optional, up to 500 characters. The head office address as it appears on documents.
- Main branch — **Code** (الرمز) — read-only.
- Main branch — **Branch name** (اسم الفرع) — required, up to 200 characters.
- Main branch — **Branch location** (موقع الفرع) — optional, up to 500 characters.

### After you save — Company
Screen: Settings → Administration → Company, address /administration/company.
The company has no statuses and no approval: a save takes effect at once and nothing is posted to the ledger. The first save is recorded as "Company created", later saves as "Company updated", each with the old and new values, in the **Audit log** at the bottom of the page. A change to the main branch is recorded on the branch.

### Refusals — Company
Screen: Settings → Administration → Company, address /administration/company.
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — the company code has a space or another character. Retype it with letters, digits, - or _ only.
- "legalName: is required" — the legal name is empty. Type it.
- "legalName: is longer than 200 characters" — shorten the name.
- "baseCurrency: is a three-letter ISO code, e.g. IQD or USD" — choose a currency from the list.
- "text: is longer than 500 characters" — the company location or the branch location is too long. Shorten it.
- "name: is required" — the main branch name is empty. Type it.
- "Permission denied: 'configure' on 'company' is not granted to this user." — you may open the screen but not change it. See "Common messages on Administration screens".

## Users (المستخدمون)
Path: Settings → Administration → Users   |   Arabic: الإعدادات ← الإدارة ← المستخدمون
Address: /administration/users (a person's record: /administration/users/<id>)
Needs: `view` on `app_user` to open the list and a record. **New user** needs `create` on `app_user`. Renaming a person and giving or taking branches and departments needs `configure` on `app_user`. Resetting a password, deactivating and reactivating need `administer` on `app_user`. Giving or taking a role needs the CEO role together with `administer` on `permission` and `configure` on `app_user`.
What it is for: Each employee's own sign-in account: creating it, handing over the temporary password, and deciding which branches, departments and roles the person has. Accounts are deactivated, never deleted.

### How to find a user and open the record — Users
1. Open Settings → Administration → Users (الإعدادات ← الإدارة ← المستخدمون), address /administration/users.
2. The list shows **Name** (الاسم), **Email** (البريد الإلكتروني), **Super user** (مستخدم خارق) Yes/No, and **Active** (نشط) — an **Active** (نشط) or **Inactive** (غير نشط) mark.
3. To search, type part of a name or e-mail in the search box and press Enter. **Clear** (مسح) removes the search.
4. Click the person's name to open their record.

### What the user record shows — Users
Screen: Settings → Administration → Users → click a name, address /administration/users/<id>.
- Top: the person's name, **Audit log** (سجل التدقيق) button, and **Back to list** (العودة إلى القائمة).
- Left, the card: picture or initials, name, e-mail, and marks — **Active** (نشط) or **Inactive** (غير نشط); **Super user** (مستخدم خارق) if they are one; **Must change password** (يجب تغيير كلمة المرور) while they still hold a temporary password. On your own record it adds "This is your own account."
- Left, **Details** (التفاصيل): **Sessions** (الجلسات) — how many sign-ins are live now; **Created** (تاريخ الإنشاء); **Last updated** (آخر تحديث); **Employee** (الموظف) — the employee number as a link to the HR record, or **Not an employee** (ليس موظفاً); **Key** (المفتاح) — a short technical identifier.
- Left, **Reset password** (إعادة تعيين كلمة المرور) panel and the **Deactivate this account** (إلغاء تفعيل هذا الحساب) or **Reactivate** (إعادة التفعيل) panel — shown only to those who may administer users. The deactivate panel is not shown on your own record.
- Right, three cards with a count in the title: **Roles** (الأدوار), **Branches** (الفروع), **Departments** (الأقسام). Each lists what the person has, with **Revoke** (سحب) beside each line and an add control below. In Branches the default one says **Default** (افتراضي) and the others offer **Set as default** (تعيين كافتراضي). In Departments a department the person manages says **Manager** (مدير).
- Right, **Update** (تحديث) panel: **Display name** (الاسم المعروض) and the read-only **Email** (البريد الإلكتروني).
- Right, **Sessions** (الجلسات): the last ten sign-ins, newest first, with **Started** (بدأت), **Expires** (تنتهي), **Outcome** (النتيجة) — **Live** (نشطة) or **Revoked** (أُلغيت) — and **Reason** (السبب), for example "Account deactivated: …" or "Password reset by administrator". A session that simply ran out of time still reads Live in this table; the count in Details counts only sessions that are really live.
- Bottom: the **Audit log** (سجل التدقيق) of this person — account changes, sign-in credential events and department memberships together.

### How to create a user — Users
1. Open Settings → Administration → Users (الإعدادات ← الإدارة ← المستخدمون), address /administration/users.
2. Click **New user** (مستخدم جديد). A dialog opens.
3. Type the **Email** (البريد الإلكتروني) and the **Display name** (الاسم المعروض).
4. Under **Roles** (الأدوار) tick the roles the person should hold. The role boxes appear only if you hold the CEO role; otherwise leave it and ask the CEO role holder to add roles afterwards. A person with no role can sign in but can do nothing.
5. Under **Branches** (الفروع) tick every branch the person works in.
6. Under **Departments** (الأقسام) tick the person's departments.
7. In **Default** (افتراضي) choose the branch their sessions start in. It must be one of the branches you ticked. If you leave it empty, the first ticked branch becomes the default.
8. **Also an employee** (موظف أيضاً) is ticked already: the person is added to the HR employee register together with the account. Untick it for a sign-in that is not a person on the staff (for example an auditor's account).
9. If it stays ticked, choose **Employee's department** (قسم الموظف) — or leave "The first department ticked above" (أول قسم محدد أعلاه) — and, if you wish, **Employee's position** (منصب الموظف).
10. Click **Create** (إنشاء). You land on the new person's record.
11. Hand over the temporary password — see "How to hand over the temporary password — Users".

### How to hand over the temporary password — Users
Screen: the user's record, address /administration/users/<id>, straight after creating the user or resetting the password.
1. If e-mail is set up and the message was accepted, the page says "The temporary password has been e-mailed to <address>." Nothing more to do.
2. Otherwise a box titled **Temporary password** (كلمة مرور مؤقتة) shows the password with the note "Shown once. Hand it to the person; they will be asked to replace it at first sign-in." Copy it now and give it to the person privately.
3. If the e-mail failed, the page says "The e-mail could not be sent; the temporary password is shown below instead." and shows the box.
4. The box can be seen only for about a minute and a half after the save, and it disappears as soon as you save anything else. After that the password cannot be shown again — use **Reset password** (إعادة تعيين كلمة المرور) to issue a new one.
5. The person signs in with it, is taken to the change-password screen, and must choose their own password (at least 12 characters) before anything else opens. Until then their record shows **Must change password** (يجب تغيير كلمة المرور).
6. A temporary password that is not replaced stops working after 72 hours. Reset the password again to issue a new one.

### How to give or take a role — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Roles** (الأدوار) card choose a role under **Add role** (إضافة دور) and click **Grant** (منح).
3. To take a role away click **Revoke** (سحب) beside it.
4. The change works at once; the person's menu changes on their next click.
5. The add control and the Revoke buttons appear only for a holder of the CEO role who may also configure users. See "The CEO role and who may change access".

### How to give or take a branch, and set the default branch — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Branches** (الفروع) card choose a branch under **Add branch scope** (إضافة نطاق فرع) and click **Grant** (منح). Only active branches the person does not yet have are offered.
3. To make a branch the one their sessions start in, click **Set as default** (تعيين كافتراضي) beside it. The default branch shows **Default** (افتراضي).
4. To take a branch away click **Revoke** (سحب) beside it. The person stops seeing that branch's records at once.
5. See "Branch scope" for what a branch gives.

### How to give or take a department — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Departments** (الأقسام) card choose a department under **Add department scope** (إضافة نطاق قسم) and click **Grant** (منح). The person joins as an ordinary member.
3. To take a department away click **Revoke** (سحب). If the person was that department's manager, the department is left without a manager.
4. Making someone a department's manager is not done here — it is done on the department's page (see "Department Managers").

### How to rename a user — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Update** (تحديث) panel change the **Display name** (الاسم المعروض) and click **Save** (حفظ).
3. The **Email** (البريد الإلكتروني) is read-only: an account's e-mail cannot be changed after it is created.

### How to reset a password — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Reset password** (إعادة تعيين كلمة المرور) panel click **Reset password** (إعادة تعيين كلمة المرور). The panel says: "Issues a new temporary password and signs the person out everywhere."
3. The person is signed out of every session immediately.
4. Hand over the new temporary password — see "How to hand over the temporary password — Users".

### How to deactivate or reactivate a user — Users
1. Open Settings → Administration → Users, click the person, address /administration/users/<id>.
2. In the **Deactivate this account** (إلغاء تفعيل هذا الحساب) panel type the **Reason** (السبب) — it is kept in the audit trail — and click **Deactivate** (إلغاء التفعيل).
3. Every live session of that person ends immediately and they can no longer sign in. The account stays in the list as **Inactive** (غير نشط) with all its history.
4. To bring the person back, open the record and click **Reactivate** (إعادة التفعيل). Their roles, branches and departments are as they were.
5. You cannot deactivate your own account; the panel is not shown on your own record.

### What to do when a user cannot sign in — Users
Screen for the fixes: Settings → Administration → Users → click the person, address /administration/users/<id>. The person sees one of these messages on the sign-in page:
- "Those credentials were not accepted. Check the address and password, or ask an administrator to reset it." — the e-mail or password is wrong, or the account is deactivated (the sign-in page gives the same message for both). Check the record: if it is **Inactive** (غير نشط), use **Reactivate** (إعادة التفعيل); otherwise use **Reset password** (إعادة تعيين كلمة المرور) and hand over the new temporary password.
- "The temporary password has expired. Ask an administrator for a new one." — the temporary password was not replaced within 72 hours. Use **Reset password**.
- "Too many failed attempts. Wait fifteen minutes and try again." — five failed tries in fifteen minutes. There is no unlock button, and resetting the password does not lift the wait; the person waits fifteen minutes. If they have forgotten the password, reset it so that it is ready when the wait is over.
- The sign-in page shows an extra field **Authenticator code** (رمز تطبيق المصادقة) — the account has an authenticator; the person types the six-digit code their app shows now. If the code is wrong the page says: "This account signs in with a second factor. Enter the code your authenticator app shows now."
- After signing in the person is held on the change-password screen — they are still on a temporary password and must choose their own first.
- After signing in the person is held on the Security screen — the seven days to enrol an authenticator have passed; they must enrol now (see "Authenticator (second sign-in step) for a user — Users").

### Authenticator (second sign-in step) for a user — Users
- Who needs it: Super users, and holders of sensitive roles (for example CEO, Accounting Manager, System Administrator, HR Manager). Whether a role requires it is fixed by the system; it is not a tick on the Roles screen.
- The administrator does nothing on the Users screen: the person enrols their own authenticator under My profile → **Security** (الأمان) → **Set up authenticator** (إعداد تطبيق المصادقة), address /profile/security.
- Steps for the person: install an authenticator app; click **Begin enrolment** (بدء التسجيل); scan the QR code with the app, or choose "enter a setup key" in it and type the **Setup key** (مفتاح الإعداد) shown; type the six-digit **Code from the app** (الرمز من التطبيق); click **Confirm enrolment** (تأكيد التسجيل). The page then says "The authenticator is enrolled. Sign-in will ask for its code."
- Time allowed: seven days from the first sign-in after it became required. During those days a reminder appears in the bell once a day. After them, the Security screen is the only screen the person can open until they enrol.
- The Users screen has no button to remove or reset a person's authenticator.

### Fields — Users
Screen: Settings → Administration → Users → **New user** (مستخدم جديد), address /administration/users.
- **Email** (البريد الإلكتروني) — required. A valid e-mail address, saved in lower case. It is what the person signs in with, must not already have an account, and cannot be changed later.
- **Display name** (الاسم المعروض) — required, up to 120 characters. The name shown everywhere the person acts. If "Also an employee" is ticked it also becomes the employee's name.
- **Roles** (الأدوار) — optional tick boxes, each shown as "Name (code)". Shown only to a holder of the CEO role. What the person may do.
- **Branches** (الفروع) — optional tick boxes of the active branches, "CODE · Name". The branches whose records the person may see. Required in practice when "Also an employee" is ticked.
- **Departments** (الأقسام) — optional tick boxes of the active departments. Used for approval routing and, when "Also an employee" is ticked, for the employee's department.
- **Default** (افتراضي) — optional list of active branches. The branch a session starts in. Must be one of the ticked branches; empty means the first ticked branch.
- **Also an employee** (موظف أيضاً) — ticked by default. Ticked: the person is put in the HR register with the account, linked to it, in the default branch, hired today. Unticked: the account is only a sign-in.
- **Employee's department** (قسم الموظف) — optional. The department of the employee record. Empty means "The first department ticked above" (أول قسم محدد أعلاه).
- **Employee's position** (منصب الموظف) — optional. The position on the employee record; empty (—) means none.
- On the record, **Reason** (السبب) in the deactivate panel — required to deactivate; kept in the audit trail and shown as the reason the sessions ended.

### After you save — Users
Screen: Settings → Administration → Users, address /administration/users.
- A new account is **Active** (نشط) at once, carries a temporary password and the mark **Must change password** (يجب تغيير كلمة المرور) until the person replaces it. There is no approval step.
- With "Also an employee" ticked, the account and the employee are created together or not at all; the employee number then appears on the record under **Details** → **Employee** (الموظف).
- Statuses: **Active** (نشط) → **Inactive** (غير نشط) by Deactivate (reason required) → **Active** again by Reactivate.
- Every step is in the person's **Audit log**: "User created", "User updated", "User deactivated", "User reactivated", "Password reset", "Default branch set", the granting and revoking of roles, branches and departments, and "All sessions ended".
- Nothing is posted to the ledger by this screen.

### Refusals — Users
Screen: Settings → Administration → Users, address /administration/users.
- "email: is not a valid address" — the e-mail is mistyped. Correct it.
- "email: already has an account" — an account with that e-mail exists (it may be inactive). Open that account and reactivate it instead of creating a second one.
- "displayName: is required" / "displayName: is longer than 120 characters" — type a name of up to 120 characters.
- "branchCode: the user is not scoped to that branch" — the **Default** branch you chose is not among the branches you ticked (or the person does not have that branch). Tick the branch too, or choose a default from the ticked ones.
- "alsoEmployee: an employee works at a branch — give the user a branch, or untick "Also an employee"" — no branch was ticked. Tick a branch, or untick Also an employee.
- "alsoEmployee: an employee belongs to a department — choose the employee's department, or untick "Also an employee"" — no department was ticked or chosen. Choose one, or untick Also an employee.
- "branch: the employee is kept in branch …, which you do not work in — untick "Also an employee" and HR will add the person" — you are creating a person for a branch that is not one of yours. Untick Also an employee; HR adds the employee later.
- "user: you cannot deactivate your own account" — ask another administrator.
- "reason: is required to deactivate an account" — type the reason first.
- "Permission denied: 'administer' on 'permission' is not granted to this user." — you tried to give or take a role without the CEO role. Ask the CEO role holder.
- "Permission denied: 'create' on 'app_user' is not granted to this user." (or 'configure', 'administer') — your roles do not allow that step on users.
- When a new user is refused, the dialog opens again with the message, but what you typed is not kept — fill it in again.

## Department Managers (مديرو الأقسام)
Path: Settings → Administration → Department Managers   |   Arabic: الإعدادات ← الإدارة ← مديرو الأقسام
Address: /administration/managers
Needs: `view` on `user_department_scope` to open. Changing a manager is done on the department's page and needs `configure` on `user_department_scope`, or being the manager of that department.
What it is for: A read-only list of every department with its manager — "who finalises what". A manager approves documents raised in their own department without a second approval; everyone else's documents in that department go to that manager.

### How to read the list — Department Managers
1. Open Settings → Administration → Department Managers (الإعدادات ← الإدارة ← مديرو الأقسام), address /administration/managers.
2. Each row is one department: **Department** (القسم) as "CODE · Name"; **Manager** (المدير) — the manager's name, or "No manager assigned" (لم يُعيَّن مدير); **Members** (الأعضاء) — how many people belong to it; **Active** (نشط) — Active or Inactive.
3. A department can show more than one name under Manager if several people carry the manager mark.
4. Click the department to open its page; click a manager's name to open that person's user record.
5. Search by department code, department name or manager name in the search box.
6. If no department has a manager the page says "No department has a manager yet. Assign one from the department's page."
7. The **Departments** (الأقسام) button at the top opens the departments list (/master-data/departments).
8. Nothing can be changed on this screen itself.

### How to make someone a department's manager — Department Managers
1. Open Settings → Administration → Department Managers, address /administration/managers, and click the department. Its page opens (/master-data/departments/<code>).
2. If the person is already in the **Members** (الأعضاء) table, click **Make manager** (تعيين مديراً) on their row.
3. If the person is not a member yet, go to **Add a member** (إضافة عضو), choose the person, tick **As department manager** (كمدير للقسم) and click **Add a member** (إضافة عضو).
4. The person becomes the department's manager at once and can finalise documents of that department.
5. To take the manager mark away click **Remove as manager** (إزالة كمدير) on their row; they stay a member. **Remove from department** (إزالة من القسم) takes them out of the department altogether.
6. These buttons appear only if you may configure department memberships or you are that department's manager.

### After you save — Department Managers
Screen: Settings → Administration → Department Managers, address /administration/managers.
The change is immediate and needs no approval. It is recorded as "Department manager assigned", "Department manager removed" or "Member removed from department" in the department's Audit log and in the person's Audit log. Documents already waiting for approval are not moved by this screen.

### Refusals — Department Managers
Screen: Settings → Administration → Department Managers, address /administration/managers (changes are made on the department's page).
- "No Department Manager is assigned to …, so this document has nobody to go to. Assign one before raising documents in that department (§5.2)." — seen when a document is submitted in a department with no manager. Make someone the manager as described above, then submit again.
- "userId: is not a known user" — the person chosen no longer exists. Choose again.
- "Permission denied: 'configure' on 'user_department_scope' is not granted to this user." — you are neither allowed to configure memberships nor the manager of that department.

## Roles (الأدوار)
Path: Settings → Administration → Roles   |   Arabic: الإعدادات ← الإدارة ← الأدوار
Address: /administration/roles (a role's page: /administration/roles/<code>)
Needs: `view` on `role` to open. A new role needs the CEO role, `administer` on `permission` and `create` on `role`. Renaming needs the CEO role, `administer` on `permission` and `configure` on `role`. Changing a role's permissions needs the CEO role and `administer` on `permission`.
What it is for: The list of roles. "A role is a named set of permissions. People hold roles; roles hold grants." Here a role is created, renamed, and its permissions are ticked section by section.

### How to read the list and open a role — Roles
1. Open Settings → Administration → Roles (الإعدادات ← الإدارة ← الأدوار), address /administration/roles.
2. Columns: **Code** (الرمز); **Name** (الاسم); **Description** (الوصف); **Grants** (المنح) — how many permissions the role has on screens that exist today; **Holders** (الحاملون) — how many people hold it; **System** (نظام) — Yes for a role that came with the system.
3. Search by code, name or description in the search box.
4. Click the code to open the role's page.
5. The role's page shows **Details** (التفاصيل) — **Code** (الرمز), **System role** (دور نظام) Yes/No, **Grants** (المنح) — then **Update** (تحديث) for a role that is not a system role, then **Permissions for this role** (صلاحيات هذا الدور), then the **Audit log** (سجل التدقيق).

### How to create a role — Roles
1. Open Settings → Administration → Roles, address /administration/roles.
2. Click **New role** (دور جديد). The button appears only for a holder of the CEO role who may create roles.
3. Type the **Name** (الاسم). The **Code** (الرمز) fills itself from the name as you type — "Accountant Branch" becomes accountant_branch. You may type your own code instead.
4. Optionally type a **Description** (الوصف).
5. Click **Create** (إنشاء). The new role's page opens.
6. The role has no permissions yet. Tick them now — see "How to choose a role's permissions — Roles".
7. Give the role to people on the Users screen (see "How to give or take a role — Users").

### How to choose a role's permissions — Roles
1. Open Settings → Administration → Roles, click the role's code, address /administration/roles/<code>.
2. Go to **Permissions for this role** (صلاحيات هذا الدور). The hint says: "Tick the actions this role may take on each system section. What is not ticked is refused."
3. The permissions are grouped by menu heading (for example General Ledger (الأستاذ العام), Administration (الإدارة)). Each heading is a closed bar with a counter such as "3 / 12" — how many of its sections the role has anything on. Click a bar to open it.
4. Inside, each row is one **System section** (قسم النظام): the screens it covers and, under them, the section's code name. The columns are the thirteen actions: View, Create, Edit draft, Submit for approval, Approve, Execute, Post, Reverse / cancel, Print, Export, Import, Configure, Administer.
5. Tick a box to allow that action on that section; untick it to refuse it. "View" is what puts the screen in the person's menu and lets its address open.
6. Click **Save permissions** (حفظ الصلاحيات) at the bottom. One save covers all headings.
7. Everyone holding the role gets the change at once.
8. If the boxes cannot be ticked and there is no Save button, you may look but not change: see "The CEO role and who may change access".
9. The same table is on the Permissions screen, where you can move from role to role.

### How to rename a role — Roles
1. Open Settings → Administration → Roles, click the role's code, address /administration/roles/<code>.
2. In the **Update** (تحديث) panel change the **Name** (الاسم) or the **Description** (الوصف) and click **Save** (حفظ).
3. A system role has no Update panel. Its page says: "A system role keeps its code and name; its permissions can still be changed."
4. A role's code never changes. There is no button to delete or deactivate a role; to retire one, revoke it from the people who hold it.

### Fields — Roles
Screen: Settings → Administration → Roles → **New role** (دور جديد), address /administration/roles.
- **Code** (الرمز) — optional. Left blank, it is made from the name: lower-case letters and digits with underscores; if that code is taken, _2, _3 … is added. If typed: 1 to 32 letters, digits, hyphens or underscores, saved in lower case. It cannot be changed later.
- **Name** (الاسم) — required, up to 120 characters. Shown wherever the role is offered.
- **Description** (الوصف) — optional, up to 500 characters. Shown in the list and under the role's title.

### After you save — Roles
Screen: Settings → Administration → Roles, address /administration/roles.
A role has no statuses and no approval. A new role exists at once, with no permissions and no holders. Saving permissions replaces the role's ticks for the sections shown on the screen with exactly what is ticked; a permission on a section that is not shown is left as it was. Changes are recorded in the role's Audit log as "Role created", "Role updated" and "Permissions set" (with the ticks before and after).

### Refusals — Roles
Screen: Settings → Administration → Roles, address /administration/roles.
- "name: is required" / "name: is longer than 120 characters" — type a name of up to 120 characters.
- "code: '…' is already a role" — the code you typed is in use. Type another, or leave the code blank.
- "code: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — the code has a space or another character.
- "code: could not be made from the name; type one" — the name has no English letters or digits (for example an Arabic-only name), so no code could be made. Type a code in English letters.
- "code: too many records share that name; type a code" — type your own code.
- "role: a system role keeps its name" — system roles cannot be renamed.
- "Permission denied: 'administer' on 'permission' is not granted to this user." — only a holder of the CEO role may create or change roles. See "The CEO role and who may change access".

## Permissions (الصلاحيات)
Path: Settings → Administration → Permissions   |   Arabic: الإعدادات ← الإدارة ← الصلاحيات
Address: /administration/permissions (one role: /administration/permissions?role=<code>)
Needs: `view` on `permission` to open. Changing ticks needs the CEO role and `administer` on `permission`.
What it is for: The editor of what each role may see and do. Choose a role on the left; on the right tick, section by section, the actions it may take. "What is ticked is what this role sees in the navigation and may open by URL; what is not ticked is refused on both."

### How to change what a role may do — Permissions
1. Open Settings → Administration → Permissions (الإعدادات ← الإدارة ← الصلاحيات), address /administration/permissions.
2. Under **Choose a role** (اختر دوراً) click the role. Each role shows how many grants it has and how many people hold it. The first role is selected when the page opens.
3. On the right, **Permissions for this role** (صلاحيات هذا الدور) shows the role's name; a system role carries the mark **System role** (دور نظام).
4. Click a menu heading to open it. Each row is a section (its screens and its code name); each column is an action.
5. Tick or untick the boxes, then click **Save permissions** (حفظ الصلاحيات).
6. The change reaches everyone holding the role at once; their menu is redrawn on their next click.
7. **Open role** (فتح الدور) goes to the role's own page under Roles.
8. For an explanation on the screen itself, open **How permissions work** (كيف تعمل الصلاحيات) on the left.
9. If the boxes cannot be ticked and there is no Save button, you do not hold the CEO role or the Administer permission on Permissions.

### The thirteen actions and what each allows — Permissions
Screen: Settings → Administration → Permissions, address /administration/permissions. The columns, in the order shown:
- **View** (عرض) — internal name view. Shows the section in the menu and lets its pages open, by menu or by address. Without it the section does not exist for the role.
- **Create** (إنشاء) — create. Lets the role add new records in the section.
- **Edit draft** (تعديل المسودة) — edit_draft. Lets the role change a record while it is still a draft. Approved records are not editable.
- **Submit for approval** (إرسال للموافقة) — submit. Lets the role send a draft for approval. The document goes to the manager of the department it was raised in.
- **Approve** (موافقة) — approve. Lets the role approve or reject what was submitted. A Department Manager finalises documents of their own department without a second approval. The person who raised a document still cannot approve it.
- **Execute** (تنفيذ) — execute. Lets the role carry out an approved document, for example issue stock or pay.
- **Post** (ترحيل) — post. Lets the role post to the ledger.
- **Reverse / cancel** (عكس / إلغاء) — reverse_cancel. Lets the role reverse or cancel a record, with a reason kept in the audit trail. Nothing is ever deleted.
- **Print** (طباعة) — print. Lets the role print the record.
- **Export** (تصدير) — export. Lets the role export the list as a file. Every export is recorded in the audit trail.
- **Import** (استيراد) — import. Lets the role bring records in from a file (for example, running the Legacy Books Import or the Payables Sheet Migration).
- **Configure** (إعداد) — configure. Lets the role edit the settings of the section: names, assignments, defaults (for example, changing a user's branches, a number series, the WhatsApp contacts).
- **Administer** (إدارة) — administer. The highest level for the section: deactivate, reset and administer (for example, resetting a user's password, deactivating a user, closing a number series).
There are no other actions and no "all" tick: each box is one action on one section. Only screens that exist today are listed.

### After you save — Permissions
Screen: Settings → Administration → Permissions, address /administration/permissions.
The role's ticks for the sections shown become exactly what is on the screen; nothing needs approval. The change is recorded as "Permissions set" in the role's Audit log with the ticks before and after. People holding the role see the result on their next click: a screen they lost disappears from the menu and its address is refused; a screen they gained appears.

### Refusals — Permissions
Screen: Settings → Administration → Permissions, address /administration/permissions.
- "Permission denied: 'administer' on 'permission' is not granted to this user." — you do not hold the CEO role, or the CEO role lacks the Administer tick on Permissions. A Super user without the CEO role is refused here too.
- An unknown role in the address is not an error: the screen simply shows the first role in the list. Choose the role you meant on the left.

## Numbering (الترقيم)
Path: Settings → Administration → Numbering   |   Arabic: الإعدادات ← الإدارة ← الترقيم
Address: /administration/numbering (one series: /administration/numbering/<key>)
Needs: `view` on `number_series` to open. **New series** needs `create`; editing a series needs `configure`; closing or reopening needs `administer` — all on `number_series`.
What it is for: Every document takes its number from a series. Here each series' prefix, pattern and counters are set. "Numbers are never reused; gaps are kept, not filled."

### How to read the list and open a series — Numbering
1. Open Settings → Administration → Numbering (الإعدادات ← الإدارة ← الترقيم), address /administration/numbering.
2. Columns: **Key** (المفتاح) — the series' name, one per kind of document; **Prefix** (البادئة); **Pattern** (النمط); **Padding** (الخانات); **Per branch** (لكل فرع) Yes/No; **Per year** (لكل سنة) Yes/No; **Issued** (الصادر) — how many numbers the series has handed out; **Last number** (آخر رقم) — the highest number issued; **Active** (نشط).
3. Search by key, prefix or pattern.
4. Click the key to open the series. Its page shows the pattern and status, **Details** (التفاصيل), the edit form under **Update** (تحديث), **Recently issued numbers** (الأرقام الصادرة مؤخراً) — the last eight numbers with the time each was issued, or "This series has not issued a number yet." — and the **Audit log** (سجل التدقيق).

### How a document number is built — Numbering
Screen: Settings → Administration → Numbering, address /administration/numbering.
The **Pattern** (النمط) is text with these pieces in curly brackets:
- {PREFIX} — the series' prefix.
- {BRANCH} — the code of the document's branch.
- {YY} — the last two digits of the year of the document's date; {YYYY} — the full year. The year comes from the document's date, not from today, so a back-dated document is numbered in its own year.
- {SERIAL} — the running number, filled with leading zeros up to the **Padding** (عدد الخانات). It must be in every pattern.
Example: prefix EMP, pattern {PREFIX}-{BRANCH}-{SERIAL}, padding 4, in branch HQ gives EMP-HQ-0001, EMP-HQ-0002 …
**Separate counter per branch** (عدّاد منفصل لكل فرع) starts a separate count for each branch; **Separate counter per year** (عدّاد منفصل لكل سنة) starts again from 1 each year.

### How to create a series — Numbering
1. Open Settings → Administration → Numbering, address /administration/numbering.
2. Click **New series** (سلسلة جديدة).
3. Type the **Series key** (مفتاح السلسلة) and the **Prefix** (البادئة).
4. Check the **Pattern** (النمط) — it starts as {PREFIX}-{SERIAL} — and the **Padding** (عدد الخانات), which starts at 6.
5. Tick **Separate counter per branch** (عدّاد منفصل لكل فرع) and/or **Separate counter per year** (عدّاد منفصل لكل سنة) if wanted. If you tick per branch, put {BRANCH} in the pattern; if you tick per year, put {YY} or {YYYY} in it.
6. Click **Create** (إنشاء). The series' page opens.
7. A series is used only by the kind of document that asks for that key; creating a series does not by itself change how any document is numbered.

### How to change a series — Numbering
1. Open Settings → Administration → Numbering, click the key, address /administration/numbering/<key>.
2. In the **Update** (تحديث) panel change **Prefix** (البادئة), **Pattern** (النمط), **Padding** (عدد الخانات) or the two counter ticks.
3. Click **Save** (حفظ).
4. The change applies to numbers issued from now on. Numbers already issued are never renumbered.
5. Two series should not share a prefix and a pattern: the same number would be written for two kinds of record. If it happens, a number another series already holds is stepped over (the gap stays). For example, on 2026-10-06 **AP_INVOICE** (purchase invoices) moved from API to **PUR** and **PAYABLE_LOCAL_GOODS** (local-goods payables), which had used PUR, moved to **LOC**; the numbers they had issued keep API- and PUR-.

### How to close or reopen a series — Numbering
1. Open Settings → Administration → Numbering, click the key, address /administration/numbering/<key>.
2. Click **Close series** (إغلاق السلسلة). The series becomes **Inactive** (غير نشط).
3. While it is closed, no document of that kind can get a number, so it cannot be saved.
4. To use it again click **Reopen series** (إعادة فتح السلسلة).

### Fields — Numbering
Screen: Settings → Administration → Numbering → **New series** (سلسلة جديدة), address /administration/numbering.
- **Series key** (مفتاح السلسلة) — required. 1 to 32 letters, digits, hyphens or underscores, saved in capitals. Cannot be changed later.
- **Prefix** (البادئة) — required, up to 10 characters, saved in capitals. What {PREFIX} becomes.
- **Pattern** (النمط) — required, up to 60 characters, saved in capitals. Default {PREFIX}-{SERIAL}. Allowed pieces: {PREFIX} {BRANCH} {YY} {YYYY} {SERIAL}; {SERIAL} is required.
- **Padding** (عدد الخانات) — required. A whole number from 1 to 18; default 6. The number of digits the running number is padded to.
- **Separate counter per branch** (عدّاد منفصل لكل فرع) — optional tick; unticked by default. Needs {BRANCH} in the pattern.
- **Separate counter per year** (عدّاد منفصل لكل سنة) — optional tick; unticked by default. Needs {YY} or {YYYY} in the pattern.

### After you save — Numbering
Screen: Settings → Administration → Numbering, address /administration/numbering.
Statuses: **Active** (نشط) → **Inactive** (غير نشط) by Close series → Active by Reopen series. No approval. Recorded in the series' Audit log as "Number series created", "Number series updated", "Number series closed" (with the reason "Series closed by administrator") and "Number series reopened". A number, once issued, is spent: if the document it was meant for fails to save, that number is not given to the next document and a gap stays in the sequence.

### Refusals — Numbering
Screen: Settings → Administration → Numbering, address /administration/numbering.
- "key: '…' is already a series" — that key exists. Open the existing series instead.
- "key: use 1–32 letters, digits, hyphens or underscores, starting with a letter or digit" — the key has a space or another character.
- "prefix: is required" / "prefix: is longer than 10 characters" — type a prefix of up to 10 characters.
- "pattern: is required" / "pattern: is longer than 60 characters" — type a pattern of up to 60 characters.
- "padding: is a whole number from 1 to 18" — type a whole number in that range.
- "pattern: Sequence '…' is not usable: the pattern must contain {SERIAL}" — add {SERIAL} to the pattern.
- "pattern: Sequence '…' is not usable: unknown token(s) …" — the pattern has a piece in curly brackets that is not one of the five allowed. Remove or correct it.
- "pattern: Sequence '…' is not usable: it resets per branch, so the pattern must contain {BRANCH} or two branches would share a number" — add {BRANCH}, or untick the per-branch counter.
- "pattern: Sequence '…' is not usable: it resets per year, so the pattern must contain {YY} or {YYYY} or two years would share a number" — add {YY} or {YYYY}, or untick the per-year counter.
- "No active document sequence is configured for '…'." — seen when saving a document whose series is closed or missing. Reopen the series here (**Reopen series**), then save the document again.

## Audit Trail (سجل التدقيق)
Path: Settings → Administration → Audit Trail   |   Arabic: الإعدادات ← الإدارة ← سجل التدقيق
Address: /administration/audit
Needs: `view` on `audit_event`.
What it is for: The company-wide record of "who did what, when, to which record, and whether it succeeded". It is read-only: events are only ever added, and nothing here can be edited or removed. For the history of one record, use the **Audit log** on that record instead.

### How to read the audit trail — Audit Trail
1. Open Settings → Administration → Audit Trail (الإعدادات ← الإدارة ← سجل التدقيق), address /administration/audit.
2. Events are listed newest first, fifty to a page. The total count is under the table; use the page numbers to go back in time.
3. Columns:
   - **When** (متى) — the date and time of the event.
   - **Action** (الإجراء) — what happened, in words (for example "User created", "Password reset", "Permissions set").
   - **Record type** (نوع السجل) — the kind of record (for example User, Role, Branch, Journal entry, Sign-in, Approval).
   - **Record** (السجل) — the record itself, shown by the number or name people know and linked to its page where one exists (journal entries, accounts, users, departments, branches, the company, roles, number series). A record that no longer exists reads "a record that no longer exists".
   - **Who** (من) — the person who did it.
   - **Branch** (الفرع) — the branch the event belongs to; a dash for company-wide events.
   - **Outcome** (النتيجة) — **Done** (تم), **Refused** (مرفوض) or **Failed** (فشل). A refused attempt (no permission, wrong branch) is recorded too.
   - **Reason** (السبب) — the reason typed with a deactivation, rejection, reversal or cancellation.
4. Which events you see follows your branches: you see the events of the branches you have been given. Company-wide events — permission and configuration changes, sign-in failures — are shown only to a Super user.

### How to search the audit trail — Audit Trail
1. Open Settings → Administration → Audit Trail, address /administration/audit.
2. Type in the search box ("Search by action, record or person" — ابحث بالإجراء أو السجل أو الشخص) and press Enter.
3. The search looks at the person's name, the reason, and the event's and record's internal English names — so type a person's name, or an English word such as created, posted, deactivated, denied, journal, role. It also finds a record by its code where the code is the record's identifier (a role code, a number series key, a branch or department code).
4. Words of the Arabic event names are not searched, and a document's printed number is not always searchable; when you want one document's history, open the document and use its Audit log (the clock icon on a document, the **Audit log** button on an administration record).
5. To see everything again, empty the search box and press Enter.
6. There are no other filters on this screen and no export button.

### Refusals — Audit Trail
Screen: Settings → Administration → Audit Trail, address /administration/audit.
- **Not available to you** (غير متاح لك) — you do not have View on the audit trail. Ask for it.
- "No records match these filters." — the search found nothing among the events you are allowed to see. Try a different word, or remember that company-wide events are visible only to a Super user.
Nothing can be saved on this screen, so there are no save refusals.

## Background Jobs (المهام الخلفية)
Path: Settings → Administration → Background Jobs   |   Arabic: الإعدادات ← الإدارة ← المهام الخلفية
Address: /administration/jobs
Needs: `view` on `job`.
What it is for: Shows the jobs the server runs by itself on a timetable, when each last ran and whether it succeeded, and how many hand-offs (notifications and other queued work) are still waiting. It is read-only: a job is run on the server, not from this screen.

### How to read the scheduled jobs — Background Jobs
1. Open Settings → Administration → Background Jobs (الإعدادات ← الإدارة ← المهام الخلفية), address /administration/jobs.
2. The first window, **Scheduled jobs** (المهام المجدولة), has one row per job:
   - **Name** (الاسم) — the job's name.
   - **Schedule (cron)** (الجدولة (cron)) — when it runs, as five timetable fields: minute, hour, day of month, month, day of week. "0 1 * * *" means 01:00 every day; "*/5 * * * *" means every five minutes; "0 3 * * 0" means 03:00 on Sundays.
   - **Timeout** (المهلة) — the longest it is allowed to run, in seconds.
   - **Last Run** (آخر تشغيل) — when it last ran.
   - **Exit code** (رمز الخروج) — 0 means it finished properly; any other number means it failed.
   - **Duration** (المدة) — how long the last run took, in seconds.
   - **Status** (الحالة) — **Succeeded** (نجح), **Failed** (فشل) or **Never run** (لم يُشغَّل بعد).
   - **Log file** (ملف السجل) — where on the server the job writes its log; give this path to whoever looks after the server when a job has failed.
3. The jobs on the timetable are:
   - backup — 01:00 every day: the nightly backup.
   - inventory-integrity — 02:15 every day: checks the stock ledger against the stock documents.
   - closing-checks — 02:30 every day: checks the month that is due to close and notifies what blocks it.
   - payables-sweep — 06:10 every day: checks payables against their time limits, stops and escalations.
   - due-notices — 06:20 every day: notices for customer invoices falling due.
   - hr-sweep — 06:30 every day: the HR morning reminders (contracts ending soon, leave requests waiting for a decision, annual leave that will not carry over).
   - health-check — 06:40 every day: the checks shown on Backup and Health; findings go to the bell.
   - deliver-notifications — every five minutes: sends waiting notifications (e-mail) and retries failed ones.
   - restore-drill — 03:00 every Sunday: restores the newest backup as a test and verifies it.
4. If the window says the timetable is not beside this build and nothing is scheduled, the server was installed without its timetable; tell whoever looks after the server.

### How to read the waiting hand-offs — Background Jobs
Screen: Settings → Administration → Background Jobs, address /administration/jobs.
1. **Transactional outbox** (صندوق الإرسال) — work written together with a document and handed on afterwards. One row per **Queue** (الطابور): **Pending** (منتظر) — still waiting; **Dispatched** (أُرسل) — handed on; **Abandoned** (مُهمَل) — given up; **Oldest pending** (أقدم منتظر) — since when the oldest waiting item has waited. A Pending number that keeps growing, or an old "Oldest pending", means the delivery job is not running.
2. **Notification deliveries** (تسليم الإشعارات) — a count of notification deliveries by **Channel** (القناة) — shown as in_app (the bell), email or whatsapp — and **Status** (الحالة):
   - **Pending** (قيد الانتظار) — waiting to be sent.
   - **Sent** (مُرسَل) — delivered.
   - **Failed** (فشل) — the send failed. A failed delivery is retried after 1, 10 and 60 minutes; after three attempts it stays Failed.
   - **Suppressed** (محجوب) — deliberately not sent: the person has no address or number, notifications are switched off for them, or e-mail is not set up. This is not an error.

### Refusals — Background Jobs
Screen: Settings → Administration → Background Jobs, address /administration/jobs.
- **Not available to you** (غير متاح لك) — you do not have View on background jobs.
- A job marked **Failed** (فشل) cannot be re-run from the screen. Note its name and its Log file and tell whoever looks after the server. The same failure also appears as a finding on Backup and Health for about a day and a half.
Nothing can be saved on this screen.

## Backup and Health (النسخ الاحتياطي وحالة النظام)
Path: Settings → Administration → Backup and Health   |   Arabic: الإعدادات ← الإدارة ← النسخ الاحتياطي وحالة النظام
Address: /administration/backup-health
Needs: `view` on `system_health`.
What it is for: Answers "is the system well, and is it backed up?" — read fresh every time the page opens. It shows the system's state, what the daily health check finds right now, and the backup sets on the server. It is read-only. (In Arabic the page title reads النسخ الاحتياطي والصحة.)

### How to read the System window — Backup and Health
1. Open Settings → Administration → Backup and Health (الإعدادات ← الإدارة ← النسخ الاحتياطي وحالة النظام), address /administration/backup-health.
2. The **System** (النظام) window lists **Name** (الاسم), **Value** (القيمة) and **Result** (النتيجة):
   - **Database** (قاعدة البيانات) — **Reachable** (متاحة) or **Not reachable** (غير متاحة); Result Yes/No.
   - **Migrations** (الترحيلات) — "N applied of M" and **at head** (محدّثة) or **behind** (متأخرة). "Behind" means the database has not received all the updates this version of the program expects; Result No.
   - **Version** (الإصدار), **Build** (البناء), **Revision** (المراجعة) — which release of the program is running. Quote these when reporting a problem.
   - **Business date** (تاريخ العمل) — today's date as the system counts it (Baghdad time).
   - **Checked** (وقت الفحص) — the moment these facts were read.
3. The small health light in the page footer ("System is healthy" / "System is degraded") reads the same two facts: database reachable and updates at head.

### How to read the Findings window — Backup and Health
Screen: Settings → Administration → Backup and Health, address /administration/backup-health.
1. **Findings** (النتائج) lists what the health check finds now: **Severity** (الخطورة) — **Serious** (خطير) or **Warning** (تحذير); **Code** (الرمز); **Finding** (النتيجة) — a sentence saying what is wrong and what to do. The sentences are in English.
2. With nothing wrong it says "Every check passed: backup, partitions, fiscal, jobs, disk, deliveries, bank_accounts."
3. The possible findings:
   - backup_missing (Serious) — no nightly backup has ever been written.
   - backup_stale (Serious) — the newest backup is more than 26 hours old; the nightly job has not run.
   - backup_incomplete (Serious) — the newest backup set did not finish.
   - backup_unencrypted (Warning) — the newest backup set is not encrypted.
   - partition_horizon (Serious or Warning) — the storage for payable history is not prepared for next year; payable changes would fail from 1 January. The payables sweep job prepares it — check that job is running.
   - period_missing (Serious) — no accounting period covers today, so nothing can post. Open the year on the accounting periods screen.
   - period_closed (Warning) — the period covering today is closed.
   - next_year_missing (Warning, from November) — next year's fiscal year is not open yet.
   - job_failed (Serious for the backup and the restore test, otherwise Warning) — a scheduled job failed within the last 36 hours. See Background Jobs.
   - disk_low (Serious under 10% free, Warning under 20%) — the server's disk is filling up.
   - deliveries_stuck (Warning) — notifications have waited more than a day; the delivery job is not running.
   - bank_account_unlinked (Serious) — an active bank or cash account points at a ledger account that is missing or inactive. Re-link it on the bank/cash accounts screen.
4. The same check runs every morning (06:40). When it finds anything, the accounting managers, the system administrators and the Super users get one notification in the bell with the findings.
5. Most findings are for whoever looks after the server; the period and bank-account findings are for the accountants.

### How to read the Backup sets window — Backup and Health
Screen: Settings → Administration → Backup and Health, address /administration/backup-health.
1. **Backup sets** (مجموعات النسخ الاحتياطي) lists the latest nightly backups on the server, newest first, up to fourteen.
2. Columns: **Set** (المجموعة) — the set's name, which is its date and time; **Written** (وقت الكتابة); **Size** (الحجم); **Complete** (مكتملة) — Yes when the backup finished; **Encrypted** (مشفّرة) — Yes when the set is encrypted; **Off-site copy** (نسخة خارجية) — Yes when a copy was sent away from the server.
3. A healthy picture is a new set every night with Complete = Yes, Encrypted = Yes and Off-site copy = Yes.
4. If the window says no backup set has been written, backups are not running at all — this is urgent; tell whoever looks after the server.
5. Backups cannot be started, downloaded or restored from this screen.

### Refusals — Backup and Health
Screen: Settings → Administration → Backup and Health, address /administration/backup-health.
- **Not available to you** (غير متاح لك) — you do not have View on system health.
Nothing can be saved on this screen.

## Legacy Books Import (استيراد الدفاتر القديمة)
Path: Settings → Administration → Legacy Books Import   |   Arabic: الإعدادات ← الإدارة ← استيراد الدفاتر القديمة
Address: /administration/legacy-import
Needs: `view` on `legacy_import` to open and read the reports. Running it (dry run or apply) needs `import` on `legacy_import`.
What it is for: Brings the old accounting system's exported workbooks into the ERP, once. Always in two steps: a dry run that only produces a report, then — after the report has been read — an apply. Applying creates the missing partners, items and warehouses, posts the partners' opening balances, raises the opening stock for costing and approval, and keeps every old document as read-only history.

### How to run a dry run — Legacy Books Import
1. Open Settings → Administration → Legacy Books Import (الإعدادات ← الإدارة ← استيراد الدفاتر القديمة), address /administration/legacy-import.
2. In **Run the import** (تشغيل الاستيراد) click **Choose the workbooks** (اختر الملفات) and select all the files the old system exported together: customers, suppliers, account balances, materials, warehouses, sales, purchases, receipt vouchers, payment vouchers, and the accounts (trial balance). Both .xlsx and .xls files are accepted.
3. Each file is recognised by its column headings, not by its name — except the suppliers' file, which must have "Supplier" or "مورد" in its file name.
4. Set the **Cut-over date** (تاريخ الانتقال): the day the old books close. It starts on today.
5. Leave **Run** (التشغيل) on **Dry run — report only** (تجريبي — تقرير فقط).
6. Click **Run** (تشغيل). Nothing is written except the report, which appears below.
7. Read the report — especially **What stops the apply** (ما يمنع التطبيق) — before going further. See "How to read the report — Legacy Books Import".

### How to apply the import — Legacy Books Import
1. First clear every line under **What stops the apply** (ما يمنع التطبيق) and run the dry run again until it says "Nothing — the set can be applied." (لا شيء — يمكن تطبيق المجموعة.).
2. Open Settings → Administration → Legacy Books Import, address /administration/legacy-import.
3. Choose exactly the same files again (the same file names and the same contents as the dry run) and set the **Cut-over date** (تاريخ الانتقال).
4. Set **Run** (التشغيل) to **Apply** (تطبيق) and click **Run** (تشغيل).
5. The report now shows what was done: the journal numbers of the opening balances and the document numbers of the opening stock replace the words "after apply" (بعد التطبيق).
6. Then finish by hand: (a) open the Opening Stock screen (/inventory/opening-stock), correct the unit costs and approve each document — the stock does not post until then; (b) enter the rest of the old trial balance (cash boxes, exchange centres, paid capital, the year's expenses and revenues) as an opening journal dated the cut-over date on the journals screen (/finance/journals).
7. Running the apply again with the same files adds only what is missing; nothing is deleted or doubled.

### How to read the report — Legacy Books Import
Screen: Settings → Administration → Legacy Books Import, address /administration/legacy-import. The report of the latest run is shown as these windows, top to bottom:
- **Workbooks recognised** (الملفات المتعرَّف عليها) — each file and sheet, what it was **Read as** (قُرئ على أنه) and how many **Rows** (الصفوف). The title line gives the kind of run, the number of files, the cut-over date, when and by whom. A file that was not recognised shows a dash where its kind would be. "Not uploaded: …" lists the kinds of workbook that were missing.
- **What stops the apply** (ما يمنع التطبيق) — every reason the set cannot be applied yet, each marked as a stop. Empty means "Nothing — the set can be applied."
- **Rows that could not be read** (صفوف تعذّرت قراءتها) — file, row number and why. Shown only when there are any.
- **Partners** (الشركاء) — how many will be created, how many are already there, and how many have a name that disagrees. Disagreeing names are listed first (old name against the **Name in the ERP** (الاسم في النظام)); then the partners to be created with **Account no.** (رقم الحساب), **Name** (الاسم), **Kind** (النوع) — Customer or Supplier — and **Phone** (الهاتف). A partner's code in the ERP is its old account number.
- **Opening balances** (الأرصدة الافتتاحية) — the totals of the old books' partner balances against the old trial balance for Customers IQD, Customers USD, Suppliers IQD, Suppliers USD, with the verdict "The partner balances agree with the old trial balance to the dinar." or "The partner balances do not agree with the old trial balance — check the files before applying."; the journals to be posted (one per currency, with the number of lines and the equity side); and every partner's balance. The note explains that dollar balances are posted in dinars at the rate the old books carried them at, and shows the ERP's own rate on the cut-over date beside it.
- **Warehouses** (المخازن) and **Items** (الأصناف) — to be created and already there. New items and warehouses get their codes when applied.
- **Opening stock** (المخزون الافتتاحي) — one Opening Stock document per warehouse with lines, units and value at the proposed cost. The note compares the old trial balance's stock value with the proposed costs.
- **Positions with no known cost (raised at zero)** (مواقع بلا تكلفة معروفة (رُفعت بصفر)) — items whose cost the old books did not carry. Shown only when there are any; give them a cost on the Opening Stock screen before approving.
- **Sold, still at sea — not stock** (مباع وما زال في الطريق — ليس مخزوناً) — negative quantities and the in-transit warehouse. These are not imported as stock.
- **History kept** (السجل المحفوظ) — counts of old sale lines, purchase lines, receipts and payments kept as read-only history on the partner, and **Rows written** (الصفوف المكتوبة). Names or account numbers that match no partner are listed; they are kept by name or number.
- **The old trial balance — for the opening journal you enter by hand** (ميزان المراجعة القديم — لقيد الافتتاح الذي تدخله يدوياً) — each line with IQD, USD and the final IQD figure.
- **Runs** (التشغيلات) — every run so far: **Run** (التشغيل) (Dry run or Apply), **Files** (الملفات), **Cut-over** (الانتقال), **When** (الوقت), **By** (بواسطة).

### Fields — Legacy Books Import
Screen: Settings → Administration → Legacy Books Import, address /administration/legacy-import.
- **Workbooks (.xlsx / .xls)** (الملفات (.xlsx / .xls)) — required; choose several files at once. The customers, account balances and warehouses workbooks are needed for the import to be applied.
- **Cut-over date** (تاريخ الانتقال) — required; default today. "The day the old books close: the opening journal and the opening stock carry this date. The period must be open."
- **Run** (التشغيل) — **Dry run — report only** (تجريبي — تقرير فقط), the default, or **Apply** (تطبيق).

### After you save — Legacy Books Import
Screen: Settings → Administration → Legacy Books Import, address /administration/legacy-import.
- A dry run writes only its report and a line in **Runs**; nothing else changes.
- An apply, in one go: creates the missing warehouses, items and partners under your own name and permissions (partners are created active, with the old account number as their code); posts the opening position as one journal per currency, in dinars, dated the cut-over date — each partner on its control account, debit when they owe the company and credit when the company owes them, with the equity side balancing; raises one Opening Stock document per warehouse, submitted and **not** approved, with the old books' quantities and the latest cost the old books carry; and stores the old sales, purchases, receipts and payments as read-only history.
- Who acts next: the accountant corrects the costs and approves each Opening Stock document (the stock and its value post only then), and enters the remaining opening journal by hand.
- The old documents are history only. They are never posted again, because the opening balances already carry the net position.

### Refusals — Legacy Books Import
Screen: Settings → Administration → Legacy Books Import, address /administration/legacy-import.
- "These files have not been dry-run. Run the dry run first and read its report." — you chose Apply for a set of files that was never dry-run, or a file's name or content changed since the dry run. Run the dry run with exactly these files, read it, then apply.
- "The import cannot be applied yet: … (and N more — see the dry run)" — the set still has stops. Run the dry run, fix every line under What stops the apply, and try again.
- "No files were uploaded. Choose the workbooks the old system exported." — choose the files first.
- "attachment_missing" — the same thing: no file was chosen.
- "The cut-over date must be a day, written YYYY-MM-DD." — pick a date.
- "<file name>: …" — that file could not be opened as a workbook. Export it again from the old system.
Stops shown in the report (each must be cleared before applying):
- "The customers workbook is missing; the import needs it." (also for balances and warehouses) — add that file to the selection.
- "Account … is "…" in the old books and "…" in the ERP; rename one before importing." — a partner with that code already exists under a different name. Rename the partner in the ERP (or correct the old file) so the names match.
- "Balance row … names account …, which is in no partner file." — a balance belongs to an account that is in neither the customers nor the suppliers file. Add the account to the right file.
- "No USD rate: the old trial balance does not imply one and none is in force on …" — enter a USD exchange rate for the cut-over date on the exchange rates screen.
- "Posting Mappings has no account for "…" on "Legacy books — opening balances"" — give that line an account on the Posting Mappings screen (/finance/posting-mappings).
- "The cut-over date … cannot be posted to: …" — the accounting period of that date does not accept postings; the exact reason follows the colon. Open the period, or choose a cut-over date in an open period.
- "The IQD opening journal would not post: …" (or USD) — the exact reason follows the colon. Fix what it names, then run the dry run again.

## Payables Sheet Migration (data import) (ترحيل جدول الذمم الدائنة (استيراد بيانات))
Path: Settings → Administration → Payables Sheet Migration (data import)   |   Arabic: الإعدادات ← الإدارة ← ترحيل جدول الذمم الدائنة (استيراد بيانات)
Address: /administration/payables-migration
Needs: `view` on `payables_migration` to open and read. Running it needs `import` on `payables_migration`. Signing off the comparison needs `approve` on `payables_migration` and must be done by someone other than the person who applied the import.
What it is for: Loads the company's payables tracking workbook (QS_DASHBOARD.xlsx) into the Payables module, once: dry run first, read the report, apply, and have the "cleared" comparison signed off by a second accountant.

### How to run a dry run — Payables Sheet Migration
1. Open Settings → Administration → Payables Sheet Migration (الإعدادات ← الإدارة ← ترحيل جدول الذمم الدائنة), address /administration/payables-migration.
2. In **Run the import** (تشغيل الترحيل) click **Choose the workbook** (اختر الملف) and select the .xlsx file.
3. Leave **Run** (التشغيل) on **Dry run — report only** (تجربة — تقرير فقط) and click **Run** (تشغيل).
4. Nothing is written except the report. Read it — see "How to read the report — Payables Sheet Migration".
5. Suppliers are matched by name and are never created by this import. For each supplier listed as not matched, correct the name on the supplier's record (or create the supplier), then run the dry run again.
6. Where the report says a bank has no USD account, open the account first, then run again.
7. What is brought in is tracking, not accounting: the imports, their payment applications (Paid where the sheet has a SWIFT date, Sent to the bank where it has only an application date, Draft where it has neither), the PDs with their status, bank and the invoice number written beside them, and the B/Ls and containers with where they are (Received, At port, On board). No purchase invoice, no journal and no stock is created.
8. A PD's note is what the sheet's Pending page says in words beside it. Dates and statuses written there are not notes.

### How to apply and sign off — Payables Sheet Migration
1. Open Settings → Administration → Payables Sheet Migration, address /administration/payables-migration.
2. Choose the very same file that was dry-run (unchanged), set **Run** (التشغيل) to **Apply** (تطبيق) and click **Run** (تشغيل).
3. The report now fills the **Created** (أُنشئ) column and the **ERP** (النظام) totals, so the sheet's totals can be compared with what is in the system.
4. Running the apply again adds only what is missing.
5. A second accountant — not the person who applied — opens the same screen, reads the **Cleared** (الإغلاق) window, optionally types a **Note** (ملاحظة) and clicks **Sign off the comparison** (اعتماد المقارنة). The form says "Signed off by an accountant who did not apply the import." and is shown only to that second person, only for an applied run that is not yet signed off.
6. After sign-off the window title shows "Signed off <date> — <note>" and the run's line in **Runs** shows the date under **Signed off** (الاعتماد).

### How to read the report — Payables Sheet Migration
Screen: Settings → Administration → Payables Sheet Migration, address /administration/payables-migration. The latest run's report, top to bottom:
- **Latest run** (آخر تشغيل) — the kind of run, the file, the date and who ran it. A table of **What** (البند), **Rows** (الصفوف) in the sheet, **Already there** (موجود مسبقًا) and **Created** (أُنشئ) for: Imports (dashboard), Payment applications (PMT), PDs (PD), B/Ls (BL), Containers, Product detail rows, Pending order lines, PD notes (Pending). Then **Totals — sheet against ERP** (الإجماليات — الجدول مقابل النظام): **Invoiced** (المفوتر), **Paid (SWIFT)** (المدفوع (سويفت)) and **Applied** (المطلوب من البنك) in USD, the sheet beside the ERP; before an apply the ERP column says "Shown after apply."
- **Suppliers not matched — never created** (موردون غير مطابقين — لا يُنشؤون أبدًا) — the supplier name in the sheet and the imports that use it; or "Every supplier is matched."
- **Banks and accounts** (البنوك والحسابات) — each bank named in the sheet, the bank it matched and its USD account; "None — open one, then run again" where there is no account.
- **Payment applications not imported** (طلبات دفع لم تُرحَّل) — row, PO / invoice, amount and why: "No dashboard row has this PO / invoice number.", "Supplier "…" is not matched.", "No bank is named.", "No active USD account at ….", "No SWIFT payment method is set up."
- **PDs with no import — the customs officer's holding list** (تصاريح بلا معاملة — قائمة انتظار موظف الجمارك) — customs pre-declarations in the sheet that belong to no import.
- **Verify the SWIFT date — not paid in the sheet, PD totally written off** (تحقق من تاريخ السويفت — غير مدفوع في الجدول والتصريح مشطوب كليًا) — applications whose payment date should be checked by hand.
- **Cleared — the sheet's "Clear?" against the rule** (الإغلاق — عمود «Clear?» مقابل القاعدة) — how many imports the system's rule clears against how many the sheet marked cleared, and each import where the two differ: **Sheet** (الجدول), **Rule** (القاعدة), **Fully paid** (مدفوع بالكامل), **All received** (مستلم بالكامل), **PDs written off** (التصاريح مشطوبة); or "The sheet and the rule agree on every import." This is the window that is signed off.
- **Containers** (الحاويات) — bills of lading whose container numbers could not be read ("Numbers that are not container numbers") or that list no container, and how many had their quantity spread over their containers as an estimate.
- **Warehouses named in the sheet** (المخازن المذكورة في الجدول) — each name in the sheet and the warehouse it matched in the ERP.
- **Values changed on the way in** (قيم عُدّلت عند الإدخال) — every value the import corrected: row, field, the original and what was used.
- **Runs** (مرات التشغيل) — every run: **Run** (التشغيل), **File** (الملف), **When** (التاريخ), **By** (بواسطة), **Signed off** (الاعتماد).

### Fields — Payables Sheet Migration
Screen: Settings → Administration → Payables Sheet Migration, address /administration/payables-migration.
- **Workbook (.xlsx)** (الملف (.xlsx)) — required; one .xlsx file.
- **Run** (التشغيل) — **Dry run — report only** (تجربة — تقرير فقط), the default, or **Apply** (تطبيق).
- **Note** (ملاحظة) — optional; the sign-off remark, kept with the run.

### After you save — Payables Sheet Migration
Screen: Settings → Administration → Payables Sheet Migration, address /administration/payables-migration.
- Dry run: only the report and a line in **Runs**.
- Apply: the imports, payment applications, customs pre-declarations, bills of lading, containers, order lines and notes of the sheet are created in the Payables module where they did not exist; every import touched takes the stage its facts give it, and those the rule clears are cleared. The run is listed in **Runs** as **Apply** (تطبيق).
- Then a second accountant signs off the cleared comparison. A run moves: dry run → applied → signed off. Each step is in the audit trail.

### Refusals — Payables Sheet Migration
Screen: Settings → Administration → Payables Sheet Migration, address /administration/payables-migration.
- "Run the dry run of this file first and read its report; only a file that has been dry-run is applied (§24.3)." — you chose Apply for a file that was not dry-run, or the file was changed (even re-saved) since its dry run. Run the dry run of this exact file first.
- "The person who applied the import does not sign off its comparison (§5.2)." — maker-checker: ask another accountant with the Approve permission to sign off.
- "This run is already signed off." — nothing more to do.
- "A dry run changes nothing; the applied run is the one signed off." — only an applied run can be signed off.
- "No such migration run." — reload the page and try again.
- "attachment_missing" — no file was chosen. Choose the workbook.
- "The import payable type is missing." — the payable type for imports is not set up; check Payables Settings → Payable types.

## WhatsApp (واتساب)
Path: Settings → Administration → WhatsApp   |   Arabic: الإعدادات ← الإدارة ← واتساب
Address: /administration/whatsapp
Needs: `view` on `whatsapp` to open. Every change (contacts, rules, settings, forgetting the pairing) needs `configure` on `whatsapp`.
What it is for: Controls the company's WhatsApp link ("the bridge"): whether it is connected, whose phone numbers it knows and what each may do, which notifications also go to a phone, the one group it works in, its limits, and a log of every message in and out. Nothing is deleted here; a contact is deactivated. The page is five windows, top to bottom: **Bridge** (الجسر), **Contacts** (جهات الاتصال), **Notifications that reach a phone** (الإشعارات التي تصل إلى الهاتف), **Settings** (الإعدادات), **Messages** (الرسائل).

### How to check the bridge status — WhatsApp
1. Open Settings → Administration → WhatsApp (الإعدادات ← الإدارة ← واتساب), address /administration/whatsapp.
2. The **Bridge** (الجسر) window shows one line:
   - **Paired** (مقترن) — Yes when the company phone has been linked.
   - **Bot number** (رقم البوت) — the company number the bridge speaks from.
   - **Status** (الحالة) — what the bridge last reported, in English: connecting, waiting for QR scan, connected, reconnecting, disconnected, logged out, stopped — or "never started" (لم يبدأ بعد).
   - **Last seen** (آخر ظهور) — when the bridge last reported. While it runs this moves every minute; a time that has stopped moving means the bridge is not running.
   - **Pending** (معلق) — WhatsApp notifications waiting to be sent.
   - **Failed** (فشل) — WhatsApp notifications that could not be sent.
3. Healthy is: Paired = Yes, Status = connected, Last seen within the last minute or two, Failed = 0.
4. While the bridge is off nothing is lost: notifications wait as Pending and are sent when it returns.

### How pairing works, and how to forget a pairing — WhatsApp
Screen: Settings → Administration → WhatsApp, address /administration/whatsapp.
1. The bridge is a separate program that runs on the server beside the ERP. It is not started or paired from this screen.
2. The first time it starts it shows a QR code where it runs. On the company phone open WhatsApp → Linked devices → Link a device and scan that code. The screen then shows **Paired** = Yes with the bot number.
3. The pairing is remembered, so restarting the bridge does not ask again.
4. To link a different phone, or after the phone unlinked the device (Status "logged out"): in the **Bridge** window, under **Forget pairing** (نسيان الاقتران), type the **Reason** (السبب) and click **Forget pairing** (نسيان الاقتران). "The next start of the bridge prints a new QR code. Say why." Then ask whoever looks after the server to restart the bridge and scan the new code.
5. The Forget pairing form appears only while Paired = Yes and only if you may configure WhatsApp.

### How to add a person's number, or change what they may do — WhatsApp
1. Open Settings → Administration → WhatsApp, address /administration/whatsapp, and go to **Contacts** (جهات الاتصال).
2. Under **Add or update a contact** (إضافة جهة اتصال أو تحديثها) choose the **User** (المستخدم) — active users are listed as "Name · e-mail".
3. Type the **Number** (الرقم) in international form with the plus sign, for example +9647xxxxxxxxx. A local 07… number is read as an Iraqi number.
4. Tick the switches the person should have (see "The four switches of a contact — WhatsApp"): **Notifications** (الإشعارات), **Questions** (الأسئلة), **Morning digest** (ملخص الصباح), **May decide documents** (يحق له اعتماد المستندات).
5. Click **Save** (حفظ). The person appears in the Contacts table.
6. To change a person who already has a contact, use the same form: choose the same user, type the number, tick everything they should have, and Save. The form replaces the number and all four switches with exactly what is on it — a switch you leave unticked is switched off, and the form always opens with only Notifications ticked. So re-tick every switch the person should keep.
7. Each user has one contact and one number; one number cannot belong to two users.

### The four switches of a contact — WhatsApp
Screen: Settings → Administration → WhatsApp → Contacts, address /administration/whatsapp.
- **Notifications** (الإشعارات) — the person receives on their phone the notifications of the rules that have WhatsApp turned on and that are addressed to a role they hold. Off: nothing is sent to their phone (the notification still appears in the bell inside the ERP).
- **Questions** (الأسئلة) — the person may ask the bot questions and be answered. It can be ticked only for a user who holds the CEO role. Each question is answered read-only, with that person's own permissions and branches, and is written to the audit trail. Anyone else who writes to the bot gets no reply at all.
- **Morning digest** (ملخص الصباح) — the person receives the daily summary once a day at the digest hour. It is sent only to contacts who are also allowed Questions (so, holders of the CEO role).
- **May decide documents** (يحق له اعتماد المستندات) — the person may approve or reject, from chat, a document that is already waiting for their approval. It works only together with Questions; ticked without Questions it is saved as No. From chat the person writes the command (approve / reject), receives a six-digit code, and sends the code back within ten minutes; the decision then runs under their own permissions, so maker-checker and a closed period refuse exactly as on the screen.
The table also shows **Holds CEO role** (يحمل دور المدير التنفيذي) Yes/No and **Active** (فعّال).

### How to deactivate or reactivate a contact — WhatsApp
1. Open Settings → Administration → WhatsApp, address /administration/whatsapp, and find the person in **Contacts** (جهات الاتصال).
2. In the last column type the **Reason** (السبب) in the small box and click **Deactivate** (تعطيل). The bot stops sending to that number and stops answering it.
3. To switch the contact back on click **Activate** (تفعيل).
4. A contact is never deleted; the messages already exchanged stay in the log.

### How to choose which notifications reach a phone — WhatsApp
1. Open Settings → Administration → WhatsApp, address /administration/whatsapp, and go to **Notifications that reach a phone** (الإشعارات التي تصل إلى الهاتف).
2. Each row is one notification rule: **Code** (الرمز), **Event** (الحدث) — what triggers it, **Recipient role** (دور المستلم) — the role whose holders receive it, **Channels** (القنوات) — where it is sent now (in_app is the bell, email, whatsapp), and **WhatsApp** (واتساب).
3. Click **Turn on** (تشغيل) to add WhatsApp to a rule, or **Turn off** (إيقاف) to remove it.
4. A rule with WhatsApp on sends to every person who holds the rule's role and has an active contact with Notifications ticked. The copy in the bell always exists. A person with no number, a deactivated contact or Notifications off is marked "suppressed" — that is not an error.
5. If a group is registered and group notifications are on, each such notification is also posted once to the group.

### How to set up the one group — WhatsApp
Screen: Settings → Administration → WhatsApp → Settings, address /administration/whatsapp.
1. The bot works in at most one WhatsApp group. Any other group it is added to is ignored completely.
2. Add the company number to the group on the phone. Ask whoever looks after the server for the group's id (the bridge can list the groups it is in); it ends in @g.us.
3. In **Settings** (الإعدادات) paste the id into **Group id** (معرّف المجموعة) and click **Save** (حفظ) on that row. Optionally type the **Group name** (اسم المجموعة) so the screen shows which group it is.
4. Set the three group rows by typing on or off and saving each: **Answer questions in the group (on / off)** (الإجابة على الأسئلة في المجموعة (on / off)), **Post notifications to the group (on / off)** (إرسال التنبيهات إلى المجموعة (on / off)), **Post the morning digest to the group (on / off)** (إرسال ملخّص الصباح إلى المجموعة (on / off)).
5. One more row has no translated name on the screen (it shows a raw name ending in setting_group_only). It is the "answer only in the group" switch and is on by default: while a group is registered, a question sent to the bot in a private chat is logged and left unanswered ("no reply") — questions are asked in the group. Type off and save to let the bot answer private chats too.
6. In the group the same rule decides who is answered: only a contact with Questions (a holder of the CEO role).
7. To go back to private messages only, clear **Group id** (leave it empty) and save.

### How to change a setting — WhatsApp
1. Open Settings → Administration → WhatsApp, address /administration/whatsapp, and go to **Settings** (الإعدادات).
2. Each row shows the **Setting** (الإعداد), its **Value** (القيمة) in a box, and when it was last **Updated** (آخر تحديث).
3. Type the new value in the row's box and click **Save** (حفظ) on that row. Each row is saved on its own.
4. The change takes effect the next time the bridge checks, within about twenty seconds.

### How to read the message log — WhatsApp
1. Open Settings → Administration → WhatsApp, address /administration/whatsapp, and go to **Messages** (الرسائل) at the bottom.
2. It lists the latest 100 messages, newest first:
   - **Date** (التاريخ) — when.
   - **Direction** (الاتجاه) — **In** (وارد) for a message received, **Out** (صادر) for one sent.
   - **Number** (الرقم) and **User** (المستخدم) — the phone and the person it belongs to; a dash for an unknown number.
   - **Intent** (القصد) — what the message was taken to be, as an internal English word (for example notification, digest, none).
   - **Status** (الحالة) — received (مستلمة), answered (مُجابة), no reply (بلا رد), failed (فشلت), sending (قيد الإرسال), sent (أُرسلت).
   - **Message** (الرسالة) — the first 160 characters; after a dash, the error if sending failed.
   - **Attachment** (المرفق) — the name of a file sent with it.
3. "no reply" means the bot deliberately did not answer: the number is not a contact, the contact or the user is deactivated, the user does not hold the CEO role, Questions is off, or the message was a private chat while questions belong in the group.
4. "(body removed after retention)" ((أُزيل النص بعد مدة الاحتفاظ)) means the text was blanked after the number of days in the settings; the line itself stays.

### Fields — WhatsApp
Screen: Settings → Administration → WhatsApp, address /administration/whatsapp.
Contact form (**Add or update a contact**):
- **User** (المستخدم) — required; an active user.
- **Number** (الرقم) — required. International format with the plus: +9647xxxxxxxxx. Spaces, dashes and brackets are ignored; a number starting 00 is accepted; a local 07xx number of 11 digits is read as Iraq (+964).
- **Notifications** (الإشعارات) — tick; ticked by default.
- **Questions** (الأسئلة) — tick; unticked by default; only for a holder of the CEO role.
- **Morning digest** (ملخص الصباح) — tick; unticked by default.
- **May decide documents** (يحق له اعتماد المستندات) — tick; unticked by default; needs Questions.
- **Reason** (السبب) — required to deactivate a contact, and to forget the pairing.
Settings rows:
- **Router model (free-form questions)** (نموذج التوجيه (الأسئلة الحرة)) and **Agent model (reserved for the WA-3 agent)** (نموذج الوكيل (محجوز للمرحلة WA-3)) — the names of the AI models the bridge uses to understand free-form questions. Technical; leave as set unless told otherwise.
- **Rows shown as text before a file is attached** (عدد السطور المعروضة نصاً قبل إرفاق ملف) — a whole number from 1 to 100. A longer answer is sent as a file instead of text.
- **Most rows in one attached file** (الحد الأقصى للسطور في ملف مرفق) — a whole number from 100 to 20,000.
- **Outbound messages per minute** (الرسائل الصادرة في الدقيقة) — a whole number from 1 to 600. The bot never sends faster than this.
- **Days message bodies are kept** (أيام الاحتفاظ بنص الرسائل) — a whole number from 7 to 3650. After that the text of a message is blanked in the log.
- **Hour of the morning digest (00–23)** (ساعة ملخص الصباح (00–23)) — a whole number from 0 to 23, in Baghdad time. The digest goes out at that hour, or as soon after it as the bridge is running, once a day.
- **Language of the morning digest (ar or en)** (لغة ملخص الصباح (ar أو en)) — ar or en.
- **Group id** (معرّف المجموعة) — empty, or one group id ending in @g.us.
- **Group name** (اسم المجموعة) — free text, up to 120 characters; may be empty.
- **Answer questions in the group (on / off)**, **Post notifications to the group (on / off)**, **Post the morning digest to the group (on / off)** and the unnamed "answer only in the group" row — type on or off. Anything other than on, true, 1 or yes is saved as off.

### After you save — WhatsApp
Screen: Settings → Administration → WhatsApp, address /administration/whatsapp.
Every change takes effect at once on the screen and on the bridge's next check (about twenty seconds). Contacts move between **Active** (فعّال) and deactivated; nothing is approved and nothing is posted to the ledger. Each change — a contact added, updated, deactivated or activated, a setting changed, a rule's channels changed, the pairing forgotten — is written to the audit trail with the old and new values and the reason where one was asked. Questions that were not answered are in the message log as "no reply"; an asker who was refused is also written to the audit trail as refused.

### Refusals — WhatsApp
Screen: Settings → Administration → WhatsApp, address /administration/whatsapp.
- "e164: is not a phone number (+9647xxxxxxxxx)" — the number is mistyped. Type it with the plus sign and the country code.
- "e164: is already another user's number" — that number is on another person's contact. Correct the number, or change the other contact first.
- "allow_queries: only a user holding the ceo role may ask questions (D-WA-3)" — you ticked Questions for someone who does not hold the CEO role. Untick Questions, or have the CEO role given to the person first.
- "reason: say why it is deactivated" — type the reason before clicking Deactivate.
- "channels: a rule keeps at least one channel" — WhatsApp is the rule's only channel, so it cannot be turned off.
- "<setting>: must be a whole number from … to …" — the value is outside the allowed range for that setting.
- "digest_locale: must be ar or en" — type ar or en.
- "group_jid: must be a group id ending in @g.us" — paste the id exactly as given, or leave it empty.
- "router_model: must be a model id such as claude-opus-5-5" (or agent_model) — the model name has a space or another character.
- "Permission denied: 'configure' on 'whatsapp' is not granted to this user." — you may look but not change.
- A person says "the bot does not answer me": look in **Messages** for their line. "no reply" with their name means one of the conditions under "How to read the message log" is not met; a line with no user name means their number is not a contact.

## Payables Settings (إعدادات الذمم الدائنة)
Path: Settings → Administration → Payables Settings   |   Arabic: الإعدادات ← الإدارة ← إعدادات الذمم الدائنة
Address: /administration/payables-settings
Needs: `view` on `payables_settings` to open. Every change needs `configure` on `payables_settings`.
What it is for: The Payables module's own configuration on one page — "Types, stages, time limits, reason codes — configuration, not code". Six windows, top to bottom: **Payable types** (أنواع الذمم), **Stages** (المراحل), **Time limits** (المهل الزمنية), **Reason codes** (رموز الأسباب), **Expense categories** (فئات المصاريف), **Event codes** (رموز الأحداث). Nothing is deleted; a row is deactivated, and a changed time limit is a new dated row.

### How to switch a payable type on or off — Payables Settings
1. Open Settings → Administration → Payables Settings (الإعدادات ← الإدارة ← إعدادات الذمم الدائنة), address /administration/payables-settings.
2. In **Payable types** (أنواع الذمم) each row shows **Code** (الرمز), **Name** (الاسم), **Needs an order** (يتطلب أمر شراء), **Needs a department** (يتطلب قسمًا), **Needs a receipt** (يتطلب استلامًا) — a tick or a dash — the **Number series** (سلسلة الترقيم) its documents are numbered from, and **Active** (فعّال).
3. Tick or untick **Active** (فعّال) on the row and click **Save** (حفظ) on that row.
4. A deactivated type cannot be used for a new payable; payables of that type that already exist carry on as before.
5. The other columns of a type (what it needs, its number series) cannot be changed on this screen.

### How to rename, reorder or deactivate a stage — Payables Settings
1. Open Settings → Administration → Payables Settings, address /administration/payables-settings, and go to **Stages** (المراحل).
2. Each row is one stage of one payable type: **Type** (النوع), **Order** (الترتيب), **Name** (الاسم), **Derivation rule (read-only)** (قاعدة الاشتقاق (للقراءة فقط)), **Active** (فعّال), and the **Edit** (تعديل) column.
3. In the Edit column change the **Name** (الاسم), the **Order** (الترتيب) number or the **Active** (فعّال) tick, and click **Save** (حفظ) on that row.
4. The derivation rule — what makes a payable reach that stage — is fixed by the system and can only be read here. You change what a stage is called and where it sits, not when it becomes true.

### How to set or change a time limit — Payables Settings
1. Open Settings → Administration → Payables Settings, address /administration/payables-settings, and go to **Time limits** (المهل الزمنية).
2. The table lists every limit: **Check** (الفحص), **Scope** (النطاق), **Limit (days)** (المهلة (أيام)), **Escalate after (days)** (التصعيد بعد (أيام)), **Escalate to role** (التصعيد إلى دور), **Valid from** (ساري من), **Active** (فعّال). Old limits stay in the table with a dash under Active.
3. Under **Set a limit (a change is a new dated row)** (تحديد مهلة (التغيير صف جديد مؤرخ)) type the **Check** (الفحص) — the code of the check, exactly as it appears in the table, for example swift_pending, recurring_overdue, service_unconfirmed.
4. Type the **Scope** (النطاق): all (the default), or a narrower one — type:import, bank:<bank code>, method:<payment method code>, port:<port code>, supplier:<supplier id>.
5. Type **Limit (days)** (المهلة (أيام)) and, if wanted, **Escalate after (days)** (التصعيد بعد (أيام)) and **Escalate to role** (التصعيد إلى دور).
6. Choose **Valid from** (ساري من) and click **Save** (حفظ).
7. The new row is added. The active row for the same check and the same scope is switched off at the same moment and stays in the table as history. Limits are never edited in place.
8. Caution: because the old row is switched off at once, give the new row a Valid from of today or earlier. If you date it in the future, no limit of that scope is in force until that date (a wider one, such as all, applies meanwhile if there is one).

### What a time limit does — Payables Settings
Screen: Settings → Administration → Payables Settings → Time limits, address /administration/payables-settings.
- Once a day (the payables sweep job, 06:10) the system looks at every active check. A payable that has been in the checked condition longer than the limit in force gets one automatic stop, waiting for someone to give its reason, owner and next action.
- When several limits fit the same payable, the most specific scope wins: supplier, then bank / method / port, then type, then all. Between two of the same kind, the one with the later Valid from wins.
- **Escalate after (days)** — a stop raised by this check that still has no owner after this many days since it was opened is escalated, once, to the **Escalate to role**. If the role is left empty it goes to the accounting manager role.

### How to add or change a reason code — Payables Settings
1. Open Settings → Administration → Payables Settings, address /administration/payables-settings, and go to **Reason codes** (رموز الأسباب). These are the reasons offered when a payable is stopped.
2. The table shows **Code** (الرمز), **Name** (الاسم), **Lane** (المسار), **Default owner role** (الدور المسؤول افتراضيًا), **Needs detail** (يتطلب تفاصيل) and **Active** (فعّال).
3. Under **New reason code** (رمز سبب جديد) type the **Code** (الرمز) and the **Name** (الاسم); optionally the **Lane** (المسار) and the **Default owner role** (الدور المسؤول افتراضيًا); tick **Needs detail** (يتطلب تفاصيل) if a stop with this reason must carry a written explanation.
4. Click **Save** (حفظ). A new code is always saved as active.
5. To change an existing code, use the same form with the same **Code**: type its name again and set the ticks as they should be, then Save. Lane and Default owner role left empty keep their present values. **Needs detail** and **Active** are saved exactly as ticked.
6. To deactivate a code, save it again through the form with **Active** (فعّال) unticked. It is no longer offered for new stops; stops that already use it keep it.

### How to add or change an expense category — Payables Settings
1. Open Settings → Administration → Payables Settings, address /administration/payables-settings, and go to **Expense categories** (فئات المصاريف).
2. The table shows **Code** (الرمز), **Name** (الاسم), **Needs an order** (يتطلب أمر شراء), **Needs a receipt** (يتطلب استلامًا) and **Active** (فعّال).
3. Under **New expense category** (فئة مصروف جديدة) type the **Code** (الرمز) and the **Name** (الاسم), tick **Needs an order** (يتطلب أمر شراء) and **Needs a receipt** (يتطلب استلامًا) as required, and click **Save** (حفظ). A new category is always saved as active.
4. To change or deactivate an existing category, use the same form with the same **Code**: type the name, set the three ticks as they should be (untick **Active** (فعّال) to deactivate), and Save. All three ticks are saved exactly as shown on the form.
5. A deactivated category is no longer offered when an expense is entered.

### How to rename or deactivate an event code — Payables Settings
1. Open Settings → Administration → Payables Settings, address /administration/payables-settings, and go to **Event codes** (رموز الأحداث). These are the kinds of entry written in a payable's history.
2. Each row shows the **Lane** (المسار) it belongs to (Payable, Order, Service, Contract, Bank, Payment, PD, Shipment, Warehouse, Cost, Stop), the **Code** (الرمز), the **Name** (الاسم) and **Active** (فعّال).
3. Change the **Name** (الاسم) or the **Active** (فعّال) tick on the row and click **Save** (حفظ) on that row.
4. New event codes cannot be added here; they arrive with the system.

### Fields — Payables Settings
Screen: Settings → Administration → Payables Settings, address /administration/payables-settings.
Time limit form:
- **Check** (الفحص) — required. The code of a check the system knows (hint: "swift_pending, recurring_overdue, service_unconfirmed…").
- **Scope** (النطاق) — optional; default all. Hint: "all · type:import · bank:ARAB · method:SWIFT · supplier:<id>".
- **Limit (days)** (المهلة (أيام)) — required. A whole number, zero or more.
- **Escalate after (days)** (التصعيد بعد (أيام)) — optional. A whole number, zero or more; empty means no escalation.
- **Escalate to role** (التصعيد إلى دور) — optional. The code of the role to tell; empty means the accounting manager role.
- **Valid from** (ساري من) — required date. The day the limit starts to count.
Reason code form:
- **Code** (الرمز) — required. 2 to 20 capital letters, digits or underscores, starting with a letter; saved in capitals. The code PENDING_REASON belongs to the system and cannot be edited.
- **Name** (الاسم) — required. What people see when they choose the reason.
- **Lane** (المسار) — optional. The part of the payable the reason usually concerns.
- **Default owner role** (الدور المسؤول افتراضيًا) — optional. The role that normally follows up a stop with this reason.
- **Needs detail** (يتطلب تفاصيل) — tick; unticked by default. A stop with this reason must carry a written detail.
- **Active** (فعّال) — tick; ticked by default.
Expense category form:
- **Code** (الرمز) — required. 2 to 40 lower-case letters, digits or underscores, starting with a letter; saved in lower case.
- **Name** (الاسم) — required.
- **Needs an order** (يتطلب أمر شراء) — tick; unticked by default.
- **Needs a receipt** (يتطلب استلامًا) — tick; ticked by default.
- **Active** (فعّال) — tick; ticked by default.
Stage row: **Name** (الاسم) — empty keeps the present name; **Order** (الترتيب) — a whole number from 1; **Active** (فعّال).
Event code row: **Name** (الاسم) — empty keeps the present name; **Active** (فعّال).
Payable type row: **Active** (فعّال).

### After you save — Payables Settings
Screen: Settings → Administration → Payables Settings, address /administration/payables-settings.
Every change takes effect immediately and needs no approval; the page shows **Saved** (تم الحفظ). Nothing is posted to the ledger. Each change is written to the audit trail with the old and new values. Rows are never removed: a type, stage, reason code, expense category or event code is deactivated; a replaced time limit stays in the table as an inactive dated row.

### Refusals — Payables Settings
Screen: Settings → Administration → Payables Settings, address /administration/payables-settings. On this screen a refusal is shown under **That did not save** (لم يتم الحفظ).
- "check: '…' is not a check." — the check code is not one the system knows. Copy the code exactly from the Check column of the table.
- "limit_days: a limit is a whole number of days, zero or more." — type a whole number, 0 or more.
- "code: a reason code is 2–20 capitals, digits or underscores." — retype the reason code using only letters, digits and underscores, starting with a letter.
- "code: PENDING_REASON belongs to the sweep and cannot be edited." — that reason is the system's own; choose another code.
- "code: a category code is 2–40 lower-case letters, digits or underscores." — retype the category code using only letters, digits and underscores, starting with a letter.
- "stage: no stage '…' on that rail." — the stage no longer exists for that type. Reload the page.
- "code: '…' is not in the catalogue — codes are added by the build that writes them." — event codes cannot be invented here.
- "type: '…' is not a payable type." — reload the page.
- "Permission denied: 'configure' on 'payables_settings' is not granted to this user." — you may look but not change.
- "type: … is deactivated." — seen when creating a payable of a type that was switched off here. Tick **Active** on that type again if it should be used.
