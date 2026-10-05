# Getting started — user guide

This guide covers what every user needs before any one module: getting in, finding your way, and the parts every screen shares.
You **sign in** with the account an administrator issued; the first time, with a **temporary password** that must be replaced before anything else opens.
The **top bar** then carries the module menu, the Active branch, search, notifications, the language button and your own menu (profile, language, appearance, sign out).
The **Dashboard** is the first screen and shows what is waiting for you; **My Approvals** is where requests sent to you are decided.
Every module is made of the same two things — a **list** with a search box and filters, and a **record** window with a status chip, action buttons and four icons (print, attachments, notes, history).
Every action is answered with the same messages: "Saved." or "That could not be saved." followed by the reason.

## Concepts — Getting started

### Permissions decide what you see — Getting started concepts
Every screen, button and copy is tied to a permission on a kind of record. The permissions are: View (عرض), Create (إنشاء), Edit draft (تعديل المسودة), Submit for approval (إرسال للموافقة), Approve (موافقة), Execute (تنفيذ), Post (ترحيل), Reverse / cancel (عكس / إلغاء), Print (طباعة), Export (تصدير), Import (استيراد), Configure (إعداد), Administer (إدارة). They are granted to roles by an administrator.
- A menu entry appears only if you may view that screen; a module appears in the top bar only if it has at least one built screen you may open.
- A button (New, Approve, Post, Reverse…) appears only if you hold that permission and the record is in the right status. A missing button is not a fault.
- Typing a screen's address does not get round this: the screen answers "Not available to you".
- A Super User (shown as **System Administrator** — مسؤول النظام — under the name) passes every permission check.
- If an administrator changes your permissions while you work, the menu redraws itself on your next click; you do not need to sign out.

### Approval and maker-checker — Getting started concepts
Approving is a permission of its own, separate from raising a document and from posting it. How strictly "the person who raised it may not approve it" is applied depends on the document:
- Many documents (for example sales invoices, customer receipts, customer credit and debit notes) go Draft → Approve → Post, and each step simply needs its permission. The Approve button shows to whoever holds the approval permission.
- Some documents are sent for approval and arrive in **My Approvals** of the people who can decide them: new accounts in the chart of accounts, journal entries sent for approval, and a supplier's bank account sent for verification. The step is decided by a named role (or by the manager of the document's department).
- Where a second person is required, the system refuses the maker with "You cannot approve a document you raised. This step requires a different approver (Appendix B)." A supplier's bank account, for example, must be verified by somebody other than the person who entered it (only a Super User may verify alone).
- "This step is approved by '<role>'. You do not hold that role." means the request is waiting for a different role.
- Rejecting always needs a reason: "A 'rejected' decision requires a reason, and the reason is kept with it (§5.4)."
The module guides say, screen by screen, who may approve what.

### Languages — Getting started concepts
The system works in English and Arabic. Arabic turns the whole screen right-to-left. The choice is kept on the device you are using (not on your account), so each computer or phone remembers its own. Printed and exported copies ask for their language separately, whatever language your screen is in. The reason shown after "That could not be saved." is always written in English.

### Addresses — Getting started concepts
Every screen has an address (for example /sales/ar-invoices) and every filter you set is written into it, so a list as you filtered it, a report as you ran it, or a record can be bookmarked or sent to a colleague — who will see it only if their own permissions allow.

## Sign in (تسجيل الدخول)
Path: not in the menu — it is the first screen when you are not signed in
Address: /sign-in
Needs: an account issued by an administrator. There is no self-registration and no "forgot password" link.
What it is for: Proving who you are. Until you sign in, every address leads here.

### How to sign in — Sign in
1. Open the system's address in the browser. The screen says "Sign in to continue" (سجّل الدخول للمتابعة).
2. Type your **Email** (البريد الإلكتروني) and your **Password** (كلمة المرور). The eye button shows or hides what you type; "Caps Lock is on" (مفتاح Caps Lock مفعّل) warns you when capitals are locked.
3. Leave **Remember me on this device** (تذكّرني على هذا الجهاز) ticked on your own computer; untick it on a shared one.
4. Press **Sign in** (تسجيل الدخول). The Dashboard opens.
5. If your password is a temporary one, the Change password screen opens instead — see "Change password".

### How to sign in with an authenticator code — Sign in
1. Some accounts (a Super User, and roles the administrator marked as privileged) sign in with a second step once they have enrolled an authenticator app.
2. Type your email and password and press **Sign in**. The form comes back with one more box, **Authenticator code** (رمز تطبيق المصادقة).
3. Type your email and password again, open the authenticator app on your phone, type the six-digit code it shows now and press **Sign in**.
4. Enrolling the app is described under "Security".

### How to sign out — Sign in
1. Press your picture or name at the end of the top bar. Your menu opens.
2. Press **Sign out** (تسجيل الخروج). You are signed out at once and the Sign in screen opens.
On the Change password screen there is also a **Sign out** button under the form.

### Fields — Sign in
- **Email** (البريد الإلكتروني) — required; the e-mail address of your account.
- **Password** (كلمة المرور) — required.
- **Authenticator code** (رمز تطبيق المصادقة) — shown only when your account needs it: the 6-digit code from your authenticator app.
- **Remember me on this device** (تذكّرني على هذا الجهاز) — ticked by default. Ticked: you stay signed in on this device until the session ends. Unticked: you are signed out when the browser is closed. Neither makes the session longer.

### After you sign in — Sign in
- A session lasts 8 hours from the moment you sign in. After that the next click sends you back to Sign in; sign in again and continue.
- If an administrator deactivates your account or resets your password, you are signed out at the next click.
- Changing your own password signs out your other sessions (other browsers or devices), not the one you are using.

### Refusals — Sign in
- "Those credentials were not accepted. Check the address and password, or ask an administrator to reset it." (لم يتم قبول بيانات الاعتماد هذه…) — the email or the password is wrong, or the account is deactivated; the message is deliberately the same for all three. Check Caps Lock and the keyboard language, try again, then ask an administrator for a reset.
- "Too many failed attempts. Wait fifteen minutes and try again." (محاولات فاشلة كثيرة…) — five wrong tries within fifteen minutes lock sign-in for that account from your location. Wait fifteen minutes; a correct password will then work.
- "The temporary password has expired. Ask an administrator for a new one." (انتهت صلاحية كلمة المرور المؤقتة…) — a temporary password works for 72 hours after it was issued. Ask an administrator to issue a new one.
- "This account signs in with a second factor. Enter the code your authenticator app shows now." — the code was wrong or too old. Type email, password and the code the app shows at this moment. If you lost the phone, ask an administrator.

## Change password (تغيير كلمة المرور)
Path: not in the menu — opens by itself after signing in with a temporary password
Address: /password
Needs: to be signed in. While your password is temporary this is the only screen you can reach, besides signing out.
What it is for: Replacing the temporary password an administrator gave you with one only you know. Until you do, every other address brings you back here.

### How to replace a temporary password — Change password
1. Sign in with your email and the temporary password. The screen titled **Temporary password** (كلمة المرور المؤقتة) opens and says: "You signed in with a temporary password. Choose your own before continuing; nothing else is available until you do."
2. In **Temporary password** type the temporary password once more.
3. In **New password** (كلمة المرور الجديدة) type the password you want — at least 12 characters; a few words together are easiest.
4. Type it again in **Confirm new password** (تأكيد كلمة المرور الجديدة).
5. Press **Update password** (تحديث كلمة المرور). The Dashboard opens and the whole menu is now available.
To change your password later, use My profile → Change password.

### Fields — Change password
- **Temporary password** (كلمة المرور المؤقتة) — required; the password you just signed in with. (On an account whose password is not temporary the box is called **Current password** — كلمة المرور الحالية.)
- **New password** (كلمة المرور الجديدة) — required. "At least 12 characters. A few words are easier to remember and harder to guess." There is no rule about capitals, digits or symbols.
- **Confirm new password** (تأكيد كلمة المرور الجديدة) — required; the same password again.

### After you save — Change password
The temporary restriction is lifted immediately, the menu appears, and your other sessions (if any) are signed out. The change is written to your account's audit log.

### Refusals — Change password
The reason is shown in a red line above the button.
- "confirm: the two new passwords do not match" — retype both.
- "currentPassword: the current password is not correct" — the first box must hold the temporary (or current) password.
- "That password cannot be used: it is 8 characters; 12 is the minimum. A passphrase of a few words is easier to remember and harder to guess."
- "That password cannot be used: it contains "password", which is among the first passwords anyone tries." — the same for welcome, qwerty, letmein, admin, iloveyou, monkey, dragon, changeme, temporary, passw0rd.
- "That password cannot be used: it is the same character repeated." / "…it is a straight run of characters from the keyboard." / "…it contains the account name." / "…it contains the account holder’s name." / "…it is longer than 256 characters."
- If the temporary password has passed its 72 hours you cannot sign in at all: ask an administrator for a new one.

## Top bar and module menu (التنقل الرئيسي)
Path: at the top of every screen once you are signed in
Address: —
Needs: to be signed in. What it lists depends on your permissions.
What it is for: Getting to any screen. From left to right (right to left in Arabic): the company's mark and name (press it to go to the Dashboard), the module names, the Active branch, Search, Notifications, Messages, the language button, and your own menu.

### How to open a screen from the menu — Top bar and module menu
1. Press a module name in the bar. A panel drops down with the module's headings and, under each, its screens.
2. Press a screen name. The panel closes and the screen opens. The module you are in is highlighted in the bar and the open screen is marked in the panel.
3. Press the module name again, press anywhere outside, or press Esc to close the panel without going anywhere.
The modules, in order, are: Dashboard (الرئيسية), Accounting (المحاسبة), Receivables (الذمم المدينة), Payables (الذمم الدائنة), Logistics (اللوجستيات), Money Transfer (التحويلات), CRM, Projects (المشاريع), Inventory (المخزون), HR, Documents (المستندات), Monitoring (المتابعة), Reports (التقارير), Settings (الإعدادات). You see only those that hold a built screen you may open.
A few screen names in the panels are drawn in a lighter grey and show "Not yet built" (لم تُنشأ بعد) when you hover over them. Some of these work normally all the same (for example Sales Invoices, Customer Receipts and Sales Returns); the Monitoring screens really are empty.

### How to move between the screens of one heading — Top bar and module menu
Most screens show a row of tabs under the bar: the other screens of the same menu heading that you may open. Press a tab to switch; the open one is marked. It is the same list as the heading in the dropdown.

### How the bar behaves on a narrow window — Top bar and module menu
1. When the window gets narrower the module names are never shrunk. The bar first gives up, in this order: your name beside your picture, the words "Active branch", the small arrows beside the module names, and the company's name.
2. If that is still not enough, the module names become **icons**. Hover over an icon to read the module's name; press it to open the same dropdown.
3. On a tablet-width window (about 1,200 pixels or less) the modules leave the bar altogether and a **menu button** (☰, "Open navigation menu" — فتح قائمة التنقل) appears. As the window gets narrower still, the bell, the envelope and the language button — and on a phone (about 560 pixels or less) the branch picker and your picture — leave the bar as well. All of those except your own menu are then inside the menu button — see the next task.

### How to use the menu on a phone (the drawer) — Top bar and module menu
1. Press the menu button (☰). A drawer slides in.
2. At the top: the **Active branch** picker, the first characters of your user id and your role.
3. Below: every module as a row. Press a row to unfold its headings and screens (the module you are in is already unfolded), then press a screen.
4. At the bottom: **Notifications** (الإشعارات), **Messages** (الرسائل), the other language's name (**Arabic** — العربية — or **English** — الإنجليزية) to switch language, and **Appearance** (المظهر).
5. Close the drawer with ✕, by pressing outside it, or with Esc.
The drawer has no Sign out and no Profile settings entry. On a phone held upright, where your picture is not in the bar, turn the phone sideways (or use a wider window) to get your own menu back; the profile can also be opened by its address, /profile.

### How to open your own menu — Top bar and module menu
1. Press your picture (or your initials) at the end of the bar. The panel shows your name, e-mail and role.
2. **Profile settings** (إعدادات الملف الشخصي) opens My profile.
3. **Language** (اللغة) shows the language you would switch to and switches at once.
4. **Appearance** (المظهر) opens the appearance drawer.
5. **Sign out** (تسجيل الخروج) ends your session.
Under your name the bar shows your role: **System Administrator** (مسؤول النظام) for a Super User, otherwise your role codes, or **ERP user** (مستخدم النظام) when you have no role.

### What the footer says — Top bar and module menu
Every screen ends with a thin footer: the copyright line, the running version (for example v1.2.3) and a health light — **System is healthy** (النظام يعمل بشكل سليم) in green, or **System is degraded** (النظام متعثّر) in red when the database behind the screens is not answering properly. Quote the version when you report a problem.

## Active branch (الفرع النشط)
Path: in the top bar, beside the search icon (on a phone: at the top of the drawer)
Address: —
Needs: to be assigned to at least one branch by an administrator; the picker appears only when you are assigned to more than one.
What it is for: Saying which branch you are working in right now.

### How to change the Active branch — Active branch
1. Press the branch code under the words "Active branch" (الفرع النشط) and choose another of your branches.
2. The screen reloads by itself under the new branch. There is no Save button.
3. If you are assigned to a single branch, its code is shown as plain text and cannot be changed.

### What changing the branch does — Active branch
- New documents you raise are created in the Active branch, and the things offered on their forms follow it (for example, a new sales invoice offers only that branch's warehouses).
- Figures stated "as at" a date for a branch follow it: the Dashboard says "<branch> · as at <date>" at the top, and branch reports open on the Active branch.
- It is not a permission. Which records you are allowed to see is decided by the branches you are assigned to; a register may therefore still list documents of your other branches, and "Out of scope: this user has no access to branch 'X'." appears only when you touch a branch you are not assigned to.
- The choice is remembered on this device. If your access to that branch is later withdrawn, the system falls back to your default branch.

## Search (بحث)
Path: the magnifier in the top bar, or Ctrl K (⌘ K on a Mac) from any screen
Address: —
Needs: to be signed in.
What it is for: Jumping to a screen by name. It searches screens, not records.

### How to find a screen — Search
1. Press Ctrl K or the magnifier. A box opens: "Search screens… (type a page or module name)" (ابحث في الشاشات…).
2. Type part of a screen's name or of its menu heading — in the language your screen is in. Up to twelve matches are listed, each with its heading underneath.
3. Move with ↑ and ↓ and press Enter, or click a result. The screen opens.
4. Esc, the ✕ or a click outside closes the box. Ctrl K again also closes it.

### What Search finds and does not find — Search
- It finds only screens you are allowed to open — the same list as the menu.
- It does not find customers, invoices, items or any other record. To find a record, open its list and use that list's own search box.
- "No screen matches." (لا توجد شاشة مطابقة.) — nothing in your menu has that name; try a shorter word, or the screen may not be granted to you.

## Notifications (الإشعارات)
Path: the bell in the top bar (on a phone: Notifications at the bottom of the drawer)
Address: —
Needs: to be signed in.
What it is for: Reading what the system has told you — for example that money arrived, that an invoice was paid late, or that your account must enrol an authenticator.

### How to read your notifications — Notifications
1. Press the bell. A panel lists your ten latest notifications, newest first: a subject, a sentence and the date and time. Ones you have not read are highlighted.
2. Press the bell again, press outside, or press Esc to close the panel.
3. With nothing to show it says "You are all caught up. No new notifications." (لا توجد إشعارات جديدة.)
The panel only shows; it has no buttons. The Dashboard's "Waiting on me" band shows the number of unread notifications.

## Messages (الرسائل)
Path: the envelope in the top bar (on a phone: Messages at the bottom of the drawer)
Address: —
Needs: to be signed in.
What it is for: A place for messages. At present the panel always says "No new messages." (لا توجد رسائل جديدة.) — nothing can be written or read there.

### How to use it — Messages
Press the envelope to open the panel and again to close it. There is nothing to do in it yet; to leave word about a record, use the record's Notes icon instead.

## Language (اللغة)
Path: the button showing ع or EN in the top bar; also Language in your own menu and in the phone drawer
Address: —
Needs: to be signed in.
What it is for: Switching the whole interface between English and Arabic.

### How to switch language — Language
1. Press the button: it shows **ع** while the screen is in English and **EN** while it is in Arabic — the language you will get.
2. The page reloads in the other language. In Arabic everything is mirrored right-to-left; numbers, codes and document numbers stay left-to-right.
3. The same switch is in your own menu (**Language**, with the other language's name under it) and at the bottom of the phone drawer.

### What switching language changes — Language
- Menu names, screen titles, field labels, buttons, statuses and standard messages.
- It does not change the data (customer names, descriptions and notes stay as typed), the language of printed copies (chosen per copy), or the reason text after "That could not be saved.", which is English.
- The choice is stored on this device for a year; another device keeps its own. The Sign in screen follows the same choice.
- Unsaved typing on the screen is lost when the page reloads, so switch before filling a form.

## Appearance (المظهر)
Path: your own menu → Appearance (on a phone: Appearance at the bottom of the drawer)
Address: —
Needs: to be signed in.
What it is for: Changing how the screens look for you only — layout style, spacing and sizes. Colours are chosen on My profile.

### How to change the look — Appearance
1. Press your picture → **Appearance** (المظهر). A side panel opens, headed "Customize your workspace" (تخصيص مساحة العمل).
2. Under **Interface style** choose one of the cards: Current / Default (Existing ERP design), Standard (Balanced), Enterprise (Dense and efficient), Minimal (Clean and quiet), Modern (Contemporary), Command (Power user), Studio (Spacious and refined). Each card previews itself. A style sets all the settings below at once.
3. Or set them one by one under **Layout settings**: **Density** (كثافة العرض) — Comfortable (مريح), Compact (مضغوط), Spacious, Airy; **Corner style** (نمط الزوايا) — Soft (ناعمة), Rounded (مستديرة), Sharp, Subtle, Pill; **Content width** (عرض المحتوى) — Fluid (مرن), Contained (محدود), Wide, Full width.
4. Open **Advanced appearance** for **Border style** (None, Subtle, Standard, Strong), **Shadow** (None, Subtle, Soft, Elevated) and **Component size** (Small, Medium, Large).
5. Every choice applies immediately and saves itself: the line at the bottom says "Appearance saved to your account." Close the panel with ✕, a click outside, or Esc.
On the Arabic screen several of these labels (Interface style, the style names, Layout settings, Advanced appearance, Border style, Shadow, Component size and some option names) currently show question marks instead of Arabic words; the options still work in the same order as listed here.

### After you save — Appearance
The look is saved on your account and follows you to any device you sign in on. It changes nothing for other users and nothing in the data. "Could not save. Check your connection and try again." means the choice applied on screen but was not stored; pick it again when the connection is back.

## My Dashboard (لوحة معلوماتي)
Path: Dashboard → Home → My Dashboard   |   Arabic: الرئيسية ← الرئيسية ← لوحة معلوماتي
Address: /
Needs: to be signed in (the menu entry needs `view` on `dashboard`). Each part needs its own permission: `view` on `workflow_instance` for approvals waiting, `financial_statement` for the result and the monthly chart, `bank_account` for cash and bank, `ar_invoice` for Owed to us and Biggest customers, `ap_invoice` for Owed by us, `inventory_movement` for stock figures, `audit_event` for Recent activity.
What it is for: The first screen after signing in, titled **Dashboard** (لوحة المتابعة). It answers three questions in order — what is waiting for me, where does the money stand, what is wrong — and every figure links to the screen that proves it. It is read-only.

### How to read the Dashboard — My Dashboard
1. The line under the title says which branch and day the figures are for: "<branch> · as at <date>". Change the Active branch to see another branch.
2. **Waiting on me** (بانتظاري) — what needs your action, with a count and the link **All approvals** (كل الاعتمادات). Depending on your work it can list: approvals waiting for you (Document type, Raised by, **Waiting since** — بالانتظار منذ), stopped payables that need a reason or that you follow, **Service receipts awaiting confirmation** (استلامات خدمات بانتظار التأكيد), **Leave waiting for my decision** (إجازات بانتظار قراري), **Payroll waiting for me** (رواتب بانتظاري), **Advances and loans waiting for me** (سلف وقروض بانتظاري), **Reviews waiting for me** (تقييمات بانتظاري), **Offers waiting for a hire** (عروض بانتظار التعيين), **Employee requests waiting for me** (طلبات موظفين بانتظاري), **Payables due this week** (ذمم تستحق هذا الأسبوع) and the number of **Unread notifications** (إشعارات غير مقروءة). Press a number or an "Open …" link on a row to go to that document.
3. **Result · <from> to <to>** (النتيجة) — **Income** (الإيرادات), **Expenses** (المصروفات) and **Result** (النتيجة) for the year so far; link **Income Statement** (قائمة الدخل).
4. **Cash and bank** (النقد والبنوك) — the balance of each bank and cash account; press one to open the account; link **Accounts** (الحسابات).
5. **Owed to us** (مستحق لنا) and **Owed by us** (مستحق علينا) — **Total outstanding** (إجمالي المتبقي) and the amounts **Not yet due** (لم تستحق بعد), **1–30 days late**, **31–60 days late**, **61–90 days late**, **Over 90 days late**; link **Invoices** (الفواتير) to the sales or purchase invoices.
6. **Needs attention** (تحتاج إلى معالجة) — **What is wrong** (ما هو الخطأ) and **Where it is fixed** (أين يُعالَج): stock ledger problems (link Stock Ledger), receipts with no payer (link Receipts), a bank or cash account with no ledger account behind it (link Bank/Cash Accounts).
7. **How the business is doing** (كيف يسير العمل) — charts: **Income and expenses, month by month** (الإيرادات والمصروفات، شهراً بشهر), **Owed to us / Owed by us, by how late it is**, **Cash and bank balances** (أرصدة النقد والبنوك), **Biggest customers** (أكبر العملاء — year to date), **Stock held, by warehouse** (المخزون المحتفظ به، بحسب المستودع — at cost). Under each chart, open **Table** to read the same figures as numbers.
8. **Recent activity** (آخر النشاطات) — the latest events: Date, **Event** (الحدث), who, and the outcome Done (تم), Refused (مرفوض) or Failed (فشل); link **Audit log** (سجل التدقيق).

### Why your Dashboard differs from a colleague's — My Dashboard
A part is shown only when you hold the permission for the screen its figures come from, and only when it has something to show. A part you may not see is simply absent — the Dashboard never says "you cannot see this". An empty Dashboard therefore means nothing is waiting for you and you hold none of the money permissions.

### Refusals — My Dashboard
- "The Waiting on me section could not be read. Everything else on this page is unaffected." — that one part failed to load; refresh the page, and report it if it stays.
- A figure that looks wrong: press it (or the link in the band's title) and check it on the screen it comes from; the Dashboard only repeats that screen's figure.

## My Approvals (موافقاتي)
Path: Dashboard → Home → My Approvals   |   Arabic: الرئيسية ← الرئيسية ← موافقاتي
Address: /approvals
Needs: `view` on `workflow_instance` to open. To decide a request you must also hold the role the step asks for and the permission to approve that kind of record.
What it is for: Your approval inbox: the requests waiting for your decision, then what you sent for approval and what you decided. Subtitle: "Documents waiting for your decision, then what you submitted and what you decided."

### How to see what is waiting for you — My Approvals
1. Open Dashboard → Home → My Approvals (or press **All approvals** on the Dashboard).
2. Three counters at the top: **Waiting for you** (بانتظارك), **Pending** (معلّق — what you sent that is not decided yet) and **My decisions** (قراراتي).
3. The **Waiting for you** list shows one card per request: the kind of document, the document itself, the tag **Waiting on you** (بانتظارك), **Submitted by** (قدّمه), **Submitted** (تاريخ التقديم) and **Department** (القسم) with the role the step is waiting for. The oldest request is first.
4. With nothing waiting it says "Nothing is waiting for your approval." (لا شيء ينتظر موافقتك.)

### How to approve or reject a request — My Approvals
1. Read the document first: when its name is a link (a new account in the chart of accounts shows as "code — name"), press it to open the record.
2. To approve, press **Approve** (اعتماد) on the card.
3. To reject, type the **Reason for rejection** (سبب الرفض) and press **Reject** (رفض). The reason is required and is kept with the decision; the request goes back to the person who raised it for correction.
4. "Saved." confirms; the card leaves the list and the decision appears under **My decisions**.
For requests whose card shows only a long identifier with no link (journal entries, a supplier's bank account), open the document on its own screen — the journal entry itself, or the supplier's profile and its bank account — and use the Approve / Verify button there. From the inbox these are answered with "No record source is registered for '…'." and nothing is decided.

### How to follow what you sent for approval — My Approvals
1. **My submissions** (ما قدّمته) lists your last 20 requests: Document, Submitted, and Status — **Pending** (معلّق) until decided, then the decision (Approved — معتمد — or Rejected — مرفوض).
2. **My decisions** (قراراتي) lists your last 20 decisions: Document, **Decision** (القرار) with the reason you gave, and when (**Decided** — تم البت).

### Who can approve what — My Approvals
- A request appears in your inbox when its current step is assigned to you by name or to a role you hold.
- Which documents arrive here: requests for a new account in the chart of accounts, journal entries sent for approval, and suppliers' bank accounts sent for verification. Other documents (sales and purchase invoices, receipts, payments, notes, HR requests…) are approved on their own record with their own Approve button; what waits for you there is listed on the Dashboard.
- Maker-checker: whether the person who raised a request may also decide it is set per kind of request — see "Approval and maker-checker — Getting started concepts".

### Refusals — My Approvals
- "You cannot approve a document you raised. This step requires a different approver (Appendix B)." — somebody else must decide it.
- "This step is approved by '<role>'. You do not hold that role." — it is waiting for another role.
- "A 'rejected' decision requires a reason, and the reason is kept with it (§5.4)." — type the reason for rejection.
- "This <document> has already completed its approval route." / "This <document> is not awaiting approval. It may have been rejected or recalled." — it was decided or withdrawn while your page was open; refresh.
- "'approve' is not available while this document is '<status>'. …" — the document is no longer in a status that can be approved.
- "No record source is registered for 'journal_entry'." (or another kind) — this kind cannot be decided from the inbox; open the document and decide there.
- "Not available to you" — you do not hold the permission to open My Approvals.

## My profile (ملفي الشخصي)
Path: your own menu (your picture in the top bar) → Profile settings (إعدادات الملف الشخصي)
Address: /profile
Needs: to be signed in. No other permission: the page only ever shows and changes your own account.
What it is for: Your own account: your picture, display name, colours, password, and the facts of the account (roles, branches, departments).

### How to change your display name — My profile
1. Open your menu → **Profile settings**.
2. In **Edit profile** (تعديل الملف الشخصي) change **Display name** (الاسم المعروض) and press **Save** (حفظ). The e-mail is shown but cannot be changed here.
3. "Saved." confirms; the new name appears in the top bar and on everything you do from now on.

### How to change your password — My profile
1. In **Change password** (تغيير كلمة المرور) type your **Current password** (كلمة المرور الحالية), the **New password** (كلمة المرور الجديدة) and the same again in **Confirm new password** (تأكيد كلمة المرور الجديدة).
2. Press **Update password** (تحديث كلمة المرور).
3. "Your password has been changed." (تم تغيير كلمة المرور.) confirms it. Every other session of yours (other browsers, other devices) is signed out; the one you are using stays.

### How to set or remove your picture — My profile
1. Under your name press **Choose an image** (اختر صورة) and pick a PNG, JPEG or WebP file of at most 400 KB; a square picture looks best.
2. Press **Upload picture** (رفع الصورة). It appears in the top bar.
3. To go back to your initials press **Remove picture** (إزالة الصورة).

### How to choose your colours — My profile
1. In the **Appearance** (المظهر) panel pick a colour scheme: Sand (رملي), Classic blue (أزرق كلاسيكي), Slate (رمادي أردوازي), Graphite (جرافيت), Pearl (لؤلؤي), Ivory Linen (الكتان العاجي), Glacier (النهر الجليدي), Sage White (أبيض المريمية), Porcelain Rose (الخزف الوردي), Dune Bronze (برونز الكثبان) or Harbor Mist (ضباب الميناء).
2. Pick the highlight colour — "the buttons, the selected row, the mark under a title": Gold (ذهبي), Red (أحمر), Blue (أزرق), Green (أخضر) or Purple (بنفسجي).
3. Press **Update** (تحديث). The colours are saved to your account and follow you across devices; each user chooses independently.
Layout style, spacing and sizes are set in the Appearance panel of your own menu instead.

### Fields — My profile
- **Display name** (الاسم المعروض) — required, at most 120 characters. The name shown in the top bar, on documents you raise or approve, and in audit logs.
- **Email** (البريد الإلكتروني) — read-only; it is your sign-in name. Only an administrator can change it.
- **Current password** / **New password** / **Confirm new password** — all required; the new one at least 12 characters.
- **Choose an image** (اختر صورة) — optional; PNG, JPEG or WebP, up to 400 KB.
- **Account** (الحساب) panel, read-only: **Roles** (الأدوار), **Branches** (الفروع — a ★ marks your default branch), **Departments** (الأقسام — "Manager" (مدير) marks a department you manage), **Live sessions** (الجلسات النشطة — how many places you are signed in right now), **Password last changed** (آخر تغيير لكلمة المرور) and **Created** (تاريخ الإنشاء).
- **Audit log** (سجل التدقيق) at the bottom — what has happened to your account.

### After you save — My profile
Each form saves on its own button and answers "Saved." (or "Your password has been changed."). Changes to roles, branches or departments are not made here: ask an administrator.

### Refusals — My profile
- "displayName: is required" / "displayName: is longer than 120 characters".
- "confirm: the two new passwords do not match" / "currentPassword: the current password is not correct".
- "That password cannot be used: it is 9 characters; 12 is the minimum. …" and the other password reasons listed under "Refusals — Change password".
- "avatar: use a PNG, JPEG or WebP image" / "avatar: is larger than 400 KB".

## Security (الأمان)
Path: not in the menu and not linked from My profile — type the address; it also opens by itself when your account must enrol an authenticator and the time allowed has passed
Address: /profile/security
Needs: to be signed in.
What it is for: Setting up the second step of signing in — an authenticator app on your phone that shows a six-digit code. Required for a Super User and for roles an administrator marked as privileged; optional for everybody else.

### How to enrol an authenticator — Security
1. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Aegis…).
2. Open /profile/security. The **Second factor** (العامل الثاني) panel shows whether it is **Required for this account** (مطلوب لهذا الحساب) and whether you are **Enrolled** (مسجَّل) or **Not enrolled** (غير مسجَّل).
3. Press **Begin enrolment** (بدء التسجيل). The page shows a **Setup key** (مفتاح الإعداد) and an **otpauth address** (عنوان otpauth).
4. In the app choose "enter a setup key" and type the key (or paste the otpauth address).
5. Type the six-digit **Code from the app** (الرمز من التطبيق) and press **Confirm enrolment** (تأكيد التسجيل).
6. "The authenticator is enrolled. Sign-in will ask for its code." From now on signing in asks for the code.

### How to replace the authenticator (new phone) — Security
1. While you still have the old app, open /profile/security and press **Issue a new key** (إصدار مفتاح جديد).
2. Add the new key to the new app and confirm with its code. Until the new app is confirmed, sign-in still needs the code from the old one.
3. If the old phone is lost, ask an administrator.

### What happens if you do not enrol — Security
- An account that needs a second factor gets a reminder in the bell once a day: "Enrol your authenticator — This account must sign in with an authenticator code from <date>. Enrol it under My profile → Security."
- The page shows "This account must enrol an authenticator by <date>. After that date it can do nothing else until it has." You have 7 days from the first sign-in after it became required.
- After that date every screen brings you to this page: "The enrolment period has passed. Enrol an authenticator now; nothing else is available until you do." Enrol and the system opens again.

### Refusals — Security
- "Those credentials are not valid." — the code typed was wrong or expired; type the code the app shows right now.

## Concepts — Lists

### What every list looks like — Lists concepts
A list screen has, from top to bottom: a back button to the Dashboard, the tabs of its menu heading, the title with a short description, the **New …** button (only if you may create), the outcome message of your last action, a title bar with the number of rows, the toolbar (search and filters), and the table. The first column is usually the record's number or code and is the link that opens the record. Statuses are shown as coloured chips.

### How to search a list — Lists concepts
1. Type in the box **Search this list** (ابحث في هذه القائمة) and press Enter or the magnifier.
2. The list keeps the rows in which any value contains what you typed, upper or lower case alike: numbers and codes, names, a date typed the way it is stored (2026-10-04), an amount, a status word in English (draft, posted…).
3. The count beside the box ("12 records"; with nothing found "No records" — لا توجد سجلات) is the number of rows shown.
4. **Clear** (مسح) appears while a search is active and removes it.
The search word is put in the page's address, so a searched list can be bookmarked.

### How to filter a list — Lists concepts
1. Many lists carry a row of filters under the search box: drop-downs or boxes such as Kind, Customer, Show, a date, a branch.
2. Set them and press the button at the end of the row — **Filter** (تصفية) or **Show** (عرض) or, on reports, **Run** (عرض). Nothing changes until you press it.
3. To remove a filter choose its first option (All…) and press the button again.
Filters, too, go into the address.

### Saved views — Lists concepts
Some lists have a **Views** (العروض) drop-down among the filters — the Payables workbench, for example, offers All open, Stopped — reason required, Stopped, Imports, Rent & contracts. A view is a ready-made set of filters: choose it and press **Filter**. Views are provided with the system; the list screens have no button to save a view of your own. To keep your own combination of filters, bookmark the page after filtering.

### Paging — Lists concepts
Long lists are shown a page at a time with a row of page numbers at the bottom: the arrows are **Previous page** (الصفحة السابقة) and **Next page** (الصفحة التالية), the current page is highlighted, and "…" stands for skipped pages. Search and filters apply to the whole list, not only the page on screen. Shorter registers show every row on one page and have no page numbers.

### Printing or exporting a list or report — Lists concepts
Reports and some lists carry a **Print / Export** (طباعة / تصدير) menu at the top. Open it, choose the language row (English or العربية) and the format: PDF, Excel (.xlsx) or Word (.docx). The copy contains exactly what the screen shows under the same filters. PDF needs the Print permission on that screen's records, Excel and Word need Export; formats you may not have are not offered, and with none the menu is absent. "This export has N rows; a file may carry at most M. Narrow the filters (a shorter period, one item or one warehouse) and export again." means the result is too large for one file.

## Concepts — The New … dialog

### How a New … button works — New dialog concepts
1. The button at the top of a list (**New customer**, **New invoice**…, with a + sign) appears only if you may create that kind of record.
2. For simple records it opens a dialog over the list; for documents with lines (invoices, receipts, notes, returns) it opens a page of its own.
3. Fields marked with a red * are required (hover: "Required" — مطلوب). The browser will not send the form while one is empty.
4. Press the button at the bottom — **Create** (إنشاء) or **Save** (حفظ). It greys out while the form is being sent, so it cannot be pressed twice.
5. On success the dialog closes and the new record opens (or the list returns) with "Saved.". If the save is refused, the dialog opens again by itself with "That could not be saved." and the reason above it; correct and press again.
6. Close a dialog without saving with ✕, Esc, or a click outside it. What you typed is discarded.

### Codes and numbers are given by the system — New dialog concepts
You do not type a record's code or a document's number: "The system gives it its code when you save. The code cannot be typed or changed." A number is taken when the record is created and is never reused.

### Pickers that take a code or a name — New dialog concepts
Where a form asks for a customer, a supplier, a bank or cash account or an item, there are usually two boxes — the code and the name. Type in either one and choose from the suggestions; the other fills itself. What is typed must match an entry exactly, otherwise the form is not accepted. Only active (and, for customers and suppliers, approved) entries are offered.

## Concepts — The record window

### What every record looks like — Record window concepts
A record opens as a "window": a title bar with the kind of document and its number, then the four icons at its end; the header fields in labelled boxes, the first of them the number and the **Status** (الحالة) chip; a **Lines** (البنود) table with a count; and a foot with the action buttons on one side and the totals on the other. Above the window: a back button **Back to list** (العودة إلى القائمة), the trail back to the Dashboard, and the message of your last action. Related registers (payments received, what a credit was applied to…) are stacked underneath.

### The status chip — Record window concepts
The chip tells where the record is in its life. The common statuses are Draft (مسودة), Pending approval (بانتظار الموافقة), Approved (معتمد), Posted (مرحّل), Posted — partly paid (مُرحَّلة — مدفوعة جزئيًا), Posted — paid (مُرحَّلة — مدفوعة), Settled (مسوّى), Rejected (مرفوض), Cancelled (ملغى), Reversed (معكوس) and Closed (مغلق). A status changes only through an action button or by the system itself (for example an invoice becomes Settled when it is fully paid); nobody types a status.

### The actions row — Record window concepts
- The buttons at the foot are what may be done to the record now, by you: they depend on the status and on your permissions. Typical ones are Approve (اعتماد), Post (ترحيل), Return to draft, Cancel, Reverse.
- A button with a box beside it (a reason) needs the box filled first; the reason is stored in the audit log.
- Each press is one action: the page reloads and shows "Saved." or "That could not be saved." with the reason. Buttons grey out while working, so an action cannot be sent twice.
- A draft can be changed; an approved record is locked and must go back to draft to be changed; a posted record is never edited — it is reversed or corrected by another document.
- If the button you expect is missing: check the status chip (the step before may not be done), then your permissions.

### Typing lines into a document — Record window concepts
On invoices the lines are typed straight into the grid. There is no "add line" button: filling the last row opens a new empty one. The ✕ at the end of a row removes it. On a new document all lines are saved together when you press Create; on a saved draft each line saves itself when you leave the row ("saving…" — جارٍ الحفظ…), and an error is shown in red on the row it concerns. Column edges can be dragged to resize a column; double-click resets it.

### Links inside a record — Record window concepts
A customer, supplier, bank or cash account, item, warehouse, journal or related document shown on a record is usually a link: press it to open that party's profile or that document. Use the browser's Back button, or Back to list, to return.

## Concepts — The four icons at the top of a record

### The four icons in short — Four icons concepts
At the end of a record's title bar there are four small icons, always in this order: **printer** (print or export), **paperclip** (attachments), **speech bubble** (notes) and **clock** (history). Each opens a small window over the record and closes back onto it with ✕, Esc or a click outside. They are there from the moment the record is a draft. A number on the paperclip or the speech bubble is how many files or notes the record has. A few screens (a customer's or supplier's profile, your own profile) show an **Audit log** panel at the bottom of the page instead.

### Printer — how to print or export a record — Four icons concepts
1. Press the printer icon (hover: **Print / Export** — طباعة / تصدير). A window opens titled with the document and its number.
2. It has two rows, **English** and **العربية**, each with the formats you may have: **PDF**, **Excel (.xlsx)**, **Word (.docx)**.
3. Press one. The file downloads; open or print it from your downloads.
4. The copy carries the company's letterhead, the branch, who printed it and when, the record's fields, lines and totals, and signature boxes — Prepared by (أعدّه), Approved by (CEO) (اعتمده (المدير التنفيذي)), Received by (استلمه). A record that is not posted yet is stamped **DRAFT / NOT POSTED** (مسودة / غير مرحّل) on every page.
5. PDF needs the Print permission on that kind of record; Excel and Word need the Export permission. If you hold neither, the printer icon is not shown.
On many records the browser's own Print command (Ctrl+P) prints the same sheet directly.

### Paperclip — how to attach a file — Four icons concepts
1. Press the paperclip (hover: **Attachments** — المرفقات). The window lists the files already attached — name, size, who attached it and when. Press a file name to open or download it. With none it says "No documents are attached yet." (لا توجد مستندات مرفقة بعد.)
2. To add one press **Choose a file** (اختر ملفاً), pick the file, then press **Attach** (إرفاق). One file at a time.
3. "Saved." confirms and the count on the paperclip goes up.
Limits: "Up to 25MB. Programs and archives are refused on their content, not their name." Ordinary paperwork is accepted — for example PDF, pictures (JPG, PNG, GIF), Office files (Word, Excel, PowerPoint) and plain text. Refused: programs and scripts (.exe, .dll, .bat, .cmd, .com, .scr, .ps1, .sh, .jar, .msi…), archives (.zip, .7z, .rar), empty files, and a file whose name does not match its content (a picture renamed .pdf).
Who may attach: you need the Create permission on attachments and must be able to see the record. The upload box is simply not shown otherwise. Attached files cannot be deleted from this window.
Every file is checked for viruses when uploaded. A file that fails the check is kept aside and does not appear in the list — the screen still answers "Saved.", so if the count did not go up and your file is not listed, it did not pass the check; tell your administrator.

### Speech bubble — how to add a note — Four icons concepts
1. Press the speech bubble (hover: **Notes** — الملاحظات). A table lists the notes, newest first: **When** (متى), **Who** (من), **Note** (ملاحظة). With none: "No notes yet." (لا توجد ملاحظات بعد.)
2. Type in **Add note** (إضافة ملاحظة) — "What is happening with this record — dated and signed, never edited." — and press **Add note**.
3. "Saved." confirms; your note is at the top with your name and the time.
A note can be up to 2,000 characters; for anything longer attach a file. Notes cannot be changed or removed afterwards. The box to add a note shows only to people who may work on that kind of record (normally the Edit draft permission on it); everybody who can open the record can read the notes.

### Clock — how to read a record's history — Four icons concepts
1. Press the clock (hover: **Audit log** — سجل التدقيق). A timeline opens, newest first.
2. Each entry gives the date and time to the second, what happened (created, a line changed, approved, posted, a file attached, a note added, reversed…), who did it, the reason when one was required, and what changed field by field — for example "due date: 1 Oct 2026 → 15 Oct 2026".
3. Refused attempts are recorded too.
The history cannot be edited by anyone. "Nothing has been recorded for this record yet." (لم يُسجَّل شيء لهذا السجل بعد.) means the record is untouched since it was loaded.

### Refusals — Four icons concepts
- "<file> was not accepted: it is 30MB; the limit is 25MB." — attach a smaller file or split it.
- "<file> was not accepted: files ending .zip are not accepted (§21)." — attach the documents themselves, not an archive.
- "<file> was not accepted: its content is a Windows executable. Executable files are not accepted (§21) — renaming one does not change what it is."
- "<file> was not accepted: it is named .pdf but its content is image/png. The name and the file disagree." — save the file under its true type and attach again.
- "<file> was not accepted: it is empty."
- "You cannot access this attachment because you cannot access the record it belongs to (§21)."
- "This file did not pass its malware scan and cannot be downloaded (§21)."
- "A note says something. Write what is happening with this record." — the note was empty.
- "A note is at most 2,000 characters. Attach a longer text as a file."
- "No such record — it may be outside your branches."
- "Permission denied: 'create' on 'attachment' is not granted to this user." — you may not attach files; ask an administrator.

## Concepts — Messages

### "Saved." — Messages concepts
**Saved.** (تم الحفظ.) appears in a green band at the top of the screen after an action that worked — creating, saving, approving, posting, attaching a file, adding a note. It means the action is complete and stored; there is nothing more to press. It disappears when you move on. Some actions have their own sentence instead, for example "Your password has been changed."

### "That could not be saved." — Messages concepts
**That could not be saved.** (تعذّر الحفظ.) appears in a red band, followed by the reason. Nothing was changed — the action was refused as a whole, so there is never a half-saved record. Read the reason: it names the field or the rule and usually says what to do. Then correct and press the button again. The reason is in English on both the English and the Arabic screen. The most common reasons on any screen:
- "Permission denied: 'approve' on 'ar_invoice' is not granted to this user." — you lack that permission; the first word in quotes is the action, the second the kind of record. Ask an administrator or a colleague who holds it.
- "Out of scope: this user has no access to branch 'X'." — the record belongs to a branch you are not assigned to.
- "<field>: is required" / "<field>: is longer than N characters" — fill or shorten that field.
- "A <document> cannot move from 'draft' to 'posted'. From 'draft' it may move to: approved, cancelled." — a step was skipped; do the earlier step first.
- "'<action>' is not available while this document is '<status>'."
- "Moving a document to '<status>' requires a reason, and the reason is stored (§5.4)." — type the reason.
- "Cannot post into <period>: the period is closed. A closed period is final — the correction belongs in an open period (§3.2)." — use a date in an open accounting period.
- "No accounting mapping is configured for the '<line>' line of '<event>'. Configure the mapping in Accounting Mapping — the posting cannot choose an account on its own (§3.3)." — Finance must complete the accounting mapping; then try again.
- "You cannot approve a document you raised. This step requires a different approver (Appendix B)." — somebody else must approve.
When you ask for help, quote the reason exactly as shown.

### The "Coming soon" screen — Messages concepts
**Coming soon** (قريباً) on an otherwise empty screen means the screen is in the menu but has not been built yet: there is no data in it and nothing can be entered. The three Monitoring screens (List of customers, History, Reports) are like this. It is not an error and not a permission problem; use the working screen that covers the same need (for customers: Receivables → Sales & Receivables → Customers).

### The access-denied screen — Messages concepts
**Not available to you** (غير متاح لك) — "You do not have permission to open this screen." (لا تملك صلاحية فتح هذه الشاشة.) followed by "Ask an administrator to grant you access to <screen name>, quoting this page." The screen exists but your roles do not include viewing it. Nothing is wrong with the system; ask an administrator for access and name the screen shown in the message. The screen deliberately does not say what the page contains.

### "That page does not exist" — Messages concepts
**That page does not exist** (هذه الصفحة غير موجودة) — "The address you followed is not part of the approved menu tree." You typed or followed an address that is not a screen: a mistyped address, an old bookmark, a screen that is not built, or a record number that does not exist or belongs to data you may not see. Press **Go to the dashboard** (الذهاب إلى اللوحة الرئيسية) and open the screen from the menu.

### "This screen could not be shown" — Messages concepts
**This screen could not be shown** (تعذّر عرض هذه الشاشة) — "Something failed while rendering. Nothing was saved or changed." An unexpected fault while drawing the page. Press **Try again** (إعادة المحاولة). If it repeats, report it and quote the line "Reference <code> — quote it when you report this." together with the version in the footer.

### Empty lists and "Loading" — Messages concepts
- A sentence such as "No sales invoices yet." or "No records match these filters." (لا توجد سجلات تطابق عوامل التصفية هذه.) inside a table means there is simply nothing to list — clear a filter or widen the dates.
- A sentence instead of a form (for example "Add a customer first." or "Set up a warehouse first.") means the master data the form needs does not exist yet; create it, then come back.
- A grey skeleton with a thin moving bar at the top means the screen is loading; wait a moment.
