# Getting started — user guide

This guide covers what every user needs before any one module: getting in, finding your way, and the parts every screen shares.
You **sign in** with the account an administrator issued; the first time, with a **temporary password** that must be replaced before anything else opens.
The **top bar** then carries the module menu, search, notifications, messages and your own menu (the Active branch, the language, profile, appearance, sign out).
The **Dashboard** (Home) is the first screen and shows what is waiting for you; **My Approvals** lists the documents that wait for your decision. Both — with Notifications, Global Search and Saved views — are described in full in the Workspace guide; this guide keeps a short block for each.
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
- Some documents are sent along an approval route and are decided from their row in **My Approvals** by the people who can decide them: new accounts in the chart of accounts, journal entries sent for approval, and a supplier's bank account sent for verification. The step is decided by a named role (or by the manager of the document's department). My Approvals also lists the other documents that wait for you (purchase orders, payment applications, purchase invoices, HR requests…) and opens each on its own page, where its own button decides it.
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
4. Tick **I'm not a robot** (أنا لست روبوتًا) — the box under the form; sometimes it asks you to pick pictures first.
5. Press **Sign in** (تسجيل الدخول). The Dashboard opens.
6. If your password is a temporary one, the Change password screen opens instead — see "Change password".

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
- **I'm not a robot** (أنا لست روبوتًا) — Google's reCAPTCHA box, required; it must be ticked every time the form is sent (also after a wrong password, and when the form comes back asking for the authenticator code). The sign-in screen's highlight colour is blue whatever colours you chose inside the system.

### After you sign in — Sign in
- A session lasts 8 hours from the moment you sign in. After that the next click sends you back to Sign in; sign in again and continue.
- If an administrator deactivates your account or resets your password, you are signed out at the next click.
- Changing your own password signs out your other sessions (other browsers or devices), not the one you are using.

### Refusals — Sign in
- "Those credentials were not accepted. Check the address and password, or ask an administrator to reset it." (لم يتم قبول بيانات الاعتماد هذه…) — the email or the password is wrong, or the account is deactivated; the message is deliberately the same for all three. Check Caps Lock and the keyboard language, try again, then ask an administrator for a reset.
- "Too many failed attempts. Wait fifteen minutes and try again." (محاولات فاشلة كثيرة…) — five wrong tries within fifteen minutes lock sign-in for that account from your location. Wait fifteen minutes; a correct password will then work.
- "The temporary password has expired. Ask an administrator for a new one." (انتهت صلاحية كلمة المرور المؤقتة…) — a temporary password works for 72 hours after it was issued. Ask an administrator to issue a new one.
- "Tick “I’m not a robot” and sign in again." (ضع علامة على «أنا لست روبوتًا» ثم سجّل الدخول مرة أخرى.) — the box was not ticked, or its answer had expired (it lasts two minutes); tick it and press Sign in again.
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
What it is for: Getting to any screen. From left to right (right to left in Arabic): the company's mark and name (press it to go to the Dashboard), the module names, Search, Notifications, Messages, and your own menu — which holds the **Active branch** and the **Language** too. A person who chose the side panel or the bottom bar in Appearance has the module names there instead, and the open module's headings in the bar after the company's name (see "How to use the side panel instead of the top bar — Top bar and module menu").

### How to open a screen from the menu — Top bar and module menu
1. Press a module name in the bar. A panel drops down with the module's headings and, under each, its screens.
2. Press a screen name. The panel closes and the screen opens. The module you are in is highlighted in the bar and the open screen is marked in the panel.
3. Press the module name again, press anywhere outside, or press Esc to close the panel without going anywhere.
The modules, in order, are: Dashboard (الرئيسية), Accounting (المحاسبة), Receivables (الذمم المدينة), Payables (الذمم الدائنة), Transfers & Applications (التحويلات والطلبات) — the import applications and the payment applications, Logistics (اللوجستيات), Money Transfer (التحويلات), CRM, Projects (المشاريع), Inventory (المخزون), HR, Documents (المستندات), Monitoring (المتابعة), Reports (التقارير), Settings (الإعدادات). You see only those that hold a built screen you may open.
A few screen names in the panels are drawn in a lighter grey and show "Not yet built" (لم تُنشأ بعد) when you hover over them. Some of these work normally all the same (for example Sales Invoices, Customer Receipts and Sales Returns); the Monitoring screens really are empty.

### How to move between the screens of one heading — Top bar and module menu
Most screens show a row of tabs under the bar: the other screens of the same menu heading that you may open. Press a tab to switch; the open one is marked. It is the same list as the heading in the dropdown. With the side panel the tabs are not drawn: the bar's heading menus carry the same screens.

### How the bar behaves on a narrow window — Top bar and module menu
1. When the window gets narrower the module names are never shrunk. The bar first gives up, in this order: your name beside your picture, the company's name, and the small arrows beside the module names.
2. If that is still not enough, the module names become **icons**. Hover over an icon to read the module's name; press it to open the same dropdown.
3. On a tablet-width window (about 1,200 pixels or less) the modules leave the bar altogether and a **menu button** (☰, "Open navigation menu" — فتح قائمة التنقل) appears. As the window gets narrower still, the bell and the envelope — and on a phone (about 560 pixels or less) your picture — leave the bar as well. All of those except your own menu are then inside the menu button — see the next task.

### How to use the menu on a phone (the drawer) — Top bar and module menu
1. Press the menu button (☰). A drawer slides in.
2. At the top: the **Active branch** picker, the first characters of your user id and your role.
3. Below: every module as a row. Press a row to unfold its headings and screens (the module you are in is already unfolded), then press a screen.
4. At the bottom: **Notifications** (الإشعارات), **Messages** (الرسائل), the other language's name (**Arabic** — العربية — or **English** — الإنجليزية) to switch language, and **Appearance** (المظهر).
5. Close the drawer with ✕, by pressing outside it, or with Esc.
The drawer has no Sign out and no Profile settings entry. On a phone held upright, where your picture is not in the bar, turn the phone sideways (or use a wider window) to get your own menu back; the profile can also be opened by its address, /profile.

### How to use the side panel instead of the top bar — Top bar and module menu
Each person chooses where the modules are: your own menu → **Appearance** (المظهر) → **Navigation** (التنقل) → **Menu position** (موضع القائمة): **Top bar** (الشريط العلوي, as described above), **Side panel** (اللوحة الجانبية) or **Bottom bar** (الشريط السفلي). The choice is yours alone and follows you to every device.
1. With **Side panel** the modules leave the top bar and stand in a panel down the left of the screen (the right in Arabic), each with its icon — the list of the system's parts, as in Odoo. The module you are in is highlighted. The Dashboard stands first, under no heading; the other modules stand under a small heading with the ones related to them: **Finance** (المالية) — Accounting; **Invoicing** (الفوترة) — Receivables, Payables, Transfers & Applications; **Operations** (العمليات) — Logistics, Money Transfer, CRM, Projects, Inventory; **People** (الأفراد) — HR; **Workspace** (مساحة العمل) — Documents, Monitoring, Reports; **System** (النظام) — Settings. A heading appears only over modules you may open. To have one plain list instead, choose **Plain list** (قائمة بسيطة) under **Group modules in the side panel** (تجميع الوحدات في اللوحة الجانبية) in Appearance. On the narrow rail the headings become thin lines, and the first icon of each group names the group when you hover over it.
2. Press a module in the panel: its first screen opens (Accounting opens Journal Entries, Payables opens Purchase Invoices).
3. The top bar then shows, after the company's mark and name and a thin line, **that module's menu** — "Accounting menu" (قائمة المحاسبة) for Accounting: each of its headings with a small arrow — for Accounting **General Ledger ▾**, **Treasury & Banking ▾**, **Master Data — Financial ▾** and so on. Press a heading: its screens drop down; press one to open it. The heading of the screen you are on is highlighted, and the open screen is marked in its list. A module with a single heading (Receivables, Inventory, HR, Projects…) shows its screens themselves in the bar instead, as the page's tabs did. When the headings do not all fit, the last ones go behind **More ▾** (المزيد) at the end of the bar, with their count; nothing is shrunk. Esc, or a press outside, closes a heading's list.
4. To give the screen more height, the page's own row of tabs is not shown in this mode (the bar's menus carry the same screens), and the page's title stands in one row with the back button beside it, its description small under it, its buttons at the end.
5. Press **Collapse** (طيّ, at the foot of the panel) to make it a narrow rail of icons — or choose **Icons only** (الأيقونات فقط) under **Side panel and bottom bar** (اللوحة الجانبية والشريط السفلي) in Appearance. On the rail, hover over an icon (or reach it with Tab) to read the module's name, and press it to open the module. The button at the foot then reads "Expand side panel" (توسيع اللوحة الجانبية) and brings the names back.
6. The page takes the rest of the width, and **Content width** still applies to it.
On a phone (about 560 pixels or less) the side panel, the bar's headings and the compact title are not used: the menu button (☰) and its drawer are the navigation there and the tabs are shown, as with the top bar.

### How to use the bottom bar — Top bar and module menu
1. With **Bottom bar** (الشريط السفلي) the modules sit in a floating bar at the foot of the window: each module's icon with its name under it. When the names do not fit (or you chose **Icons only**) only the icons are shown; hover over one to read its name.
2. Press a module: its menu opens upwards, with the same headings and screens as its dropdown. Press a screen, press outside, or press Esc to close it. The module you are in is marked.
3. The top bar keeps the company's mark and name and shows the open module's headings after them, as with the side panel; the page keeps its own tabs and title. The page leaves room at its foot so nothing stays hidden behind the bar.
4. On a phone the bar holds the four modules you open most on that device (the module of the open screen always among them) and **More** (المزيد), which opens the menu drawer with every module.

### How to open your own menu — Top bar and module menu
1. Press your picture (or your initials) at the end of the bar. The panel shows your name, e-mail and role.
2. **Active branch** (الفرع النشط) with the branch you work in; with several branches, each of them as a button — press another to work in it (see "Active branch").
3. **Language** (اللغة) with **English** and **العربية** side by side, the one in use marked; press the other to switch at once.
4. **Status** (الحالة) — for a person who uses Chat: **Available** (متاح), **Busy** (مشغول), **Away** (بعيد) or **Appear offline** (الظهور كغير متصل), each with the coloured dot colleagues will see, the one in use ticked; a line under them says what it means. Press another to change it at once (see "How to choose your status — Chat").
5. **Sounds** (الأصوات) — the switch for the system's sounds on this browser (see "How to turn sounds on or off — Top bar and module menu"); under it **Pop-up notifications** (الإشعارات المنبثقة) — the switch for the small cards in the corner (see "How pop-up notifications work — Top bar and module menu").
6. **Profile settings** (إعدادات الملف الشخصي) opens My profile.
7. **Appearance** (المظهر) opens the appearance drawer.
8. **Sign out** (تسجيل الخروج) ends your session.
Under your name the bar shows your role: **System Administrator** (مسؤول النظام) for a Super User, otherwise your role codes, or **ERP user** (مستخدم النظام) when you have no role.

### How to turn sounds on or off — Top bar and module menu
1. Press your picture (or your initials) at the end of the bar. Near the bottom of the menu, **Sounds** (الأصوات) — "Messages, notifications and the results of forms" — has a switch; it is on unless you turned it off. Press it to change it; turning it on plays a short sound.
2. The sounds are short and soft: a two-note ding for a message from a colleague, a soft lift when your own message goes, a light chime when the bell gets a new notification, a bright rising sound when a form you sent is saved, submitted, approved or posted, two low notes when it is refused or fails, and a double tap when a required field is still empty.
3. Nothing sounds before you have pressed or typed something on the page, a message in a conversation you are reading makes no sound, and while your status is **Busy** messages and notifications make no sound. Muted conversations never sound.
4. The switch is kept in this browser only: another computer or browser keeps its own.

### How pop-up notifications work — Top bar and module menu
1. A small card pops up in the corner of the screen — at the bottom on the end side (bottom right in English, bottom left in Arabic), above the chat windows and the bottom bar; at the top, under the header, on a phone. At most three show at once; the next waits until one goes.
2. **After you send a form**: a green tick and the banner's own words ("Saved." or the screen's message) when it is saved, submitted, approved or posted; a red mark with the refusal in its words ("That could not be saved." and the reason) when it is refused. The banner on the screen stays exactly where it always is — the card is only a second place to see it. Opening a page, reloading it, or going back or forward never pops one up again.
3. **A new notification**: the bell's icon in the accent colour, its title and **Open** (فتح), which opens the record as the bell does. Not for what was already waiting when you opened the page, and not while the bell's list is open.
4. **A new message**: your colleague's face, the line they wrote and **Reply** (رد), which opens the conversation as a chat window at the foot of the screen. Not on the Chat screen, not for a muted conversation or the one you are reading; a newer message replaces the card, and reading the conversation takes it away.
5. A card goes by itself after five seconds (a refusal after eight); a thin line along its foot shows the time left. Resting the pointer on it, or moving to it with the keyboard (F6), holds it; **×** (**Dismiss**, إغلاق) closes it at once.
6. To turn them off: press your picture at the end of the bar; under **Sounds**, **Pop-up notifications** (الإشعارات المنبثقة) — "Saves, notifications and messages — errors always show" — has a switch, on unless you turned it off. Off, nothing pops up for saves, notifications or messages; a refusal still does. While your status is **Busy**, notifications and messages do not pop up. The switch is kept in this browser only.

### What the footer says — Top bar and module menu
Every screen ends with a thin footer: the copyright line, the running version (for example v1.2.3) and a health light — **System is healthy** (النظام يعمل بشكل سليم) in green, or **System is degraded** (النظام متعثّر) in red when the database behind the screens is not answering properly. Quote the version when you report a problem.

## Active branch (الفرع النشط)
Path: your own menu (your picture at the end of the top bar) → Active branch (on a phone: at the top of the drawer)
Address: —
Needs: to be assigned to at least one branch by an administrator; the choices appear only when you are assigned to more than one.
What it is for: Saying which branch you are working in right now.

### How to change the Active branch — Active branch
1. Press your picture (or your initials) at the end of the top bar. Under your name the menu shows **Active branch** (الفرع النشط) and the code of the branch you work in.
2. Under it, each of your branches is a button, the one in use ticked. Press another.
3. The screen reloads by itself under the new branch. There is no Save button.
4. If you are assigned to a single branch, only its code is shown and it cannot be changed. On a phone the same choice is at the top of the menu drawer (☰), as a list.

### What changing the branch does — Active branch
- New documents you raise are created in the Active branch, and the things offered on their forms follow it (for example, a new sales invoice offers only that branch's warehouses).
- Figures stated "as at" a date for a branch follow it: the Dashboard says "<branch> · as at <date>" at the top, and branch reports open on the Active branch.
- It is not a permission. Which records you are allowed to see is decided by the branches you are assigned to; a register may therefore still list documents of your other branches, and "Out of scope: this user has no access to branch 'X'." appears only when you touch a branch you are not assigned to.
- The choice is remembered on this device. If your access to that branch is later withdrawn, the system falls back to your default branch.

## Search (بحث)
Path: the magnifier in the top bar, or Ctrl K (⌘ K on a Mac) from any screen
Address: /search
Needs: to be signed in.
What it is for: Finding a record, a document number, an attached file or a screen from anywhere. It searches records as well as screens, and shows only what you are allowed to open. The full description — how to search with Ctrl K, what to type, the results page, and what Search does not find — is in the Workspace guide under "Global Search" (البحث الشامل).

## Notifications (الإشعارات)
Path: the bell in the top bar (on a phone: Notifications at the bottom of the drawer)
Address: /notifications
Needs: to be signed in; `view` on `notification`, which every role has.
What it is for: Reading what the system has told you and opening the record each notification is about. The bell shows the number of unread notifications; its panel lists the latest ones, marks them read or unread, and leads to the full Notifications page. The full description is in the Workspace guide under "Notifications" — for example "How to read notifications from the bell — Notifications" and "How to open what a notification is about — Notifications".

## Messages (الرسائل)
Path: the envelope in the top bar (on a phone: Messages at the bottom of the drawer)
Address: —
Needs: to be signed in.
What it is for: The way into the internal chat. While chat messages are unread the envelope carries their number; its panel lists your conversations, opens one as a chat window at the foot of the screen, and leads to the chat screen. Chat itself is described under "Chat".

### How to use it — Messages
1. Press the envelope. The panel lists up to seven of your conversations, those with unread messages first, each with the colleague's status dot.
2. Press a conversation to open it as a chat window at the foot of the screen (on a phone, full screen); the small square at the end of its row opens it on the Chat screen instead. **Open Chat** (فتح المحادثات) opens the chat screen.
3. Press the envelope again, press outside, or press Esc to close the panel.
For an account without access to Chat the panel only says "No new messages." (لا توجد رسائل جديدة.)

## Language (اللغة)
Path: your own menu (your picture at the end of the top bar) → Language; also on My profile, and at the bottom of the phone drawer
Address: —
Needs: to be signed in.
What it is for: Switching the whole interface between English and Arabic.

### How to switch language — Language
1. Press your picture (or your initials) at the end of the top bar. The menu shows **Language** (اللغة) with **English** and **العربية** side by side; the one in use is ticked.
2. Press the other one. The page reloads in that language. In Arabic everything is mirrored right-to-left; numbers, codes and document numbers stay left-to-right.
3. The same choice is on My profile (**Language**), and at the bottom of the phone drawer (the other language's name). The Sign in screen keeps its own language button.

### What switching language changes — Language
- Menu names, screen titles, field labels, buttons, statuses and standard messages.
- It does not change the data (customer names, descriptions and notes stay as typed), the language of printed copies (chosen per copy), or the reason text after "That could not be saved.", which is English.
- The choice is stored on this device for a year; another device keeps its own. The Sign in screen follows the same choice.
- Unsaved typing on the screen is lost when the page reloads, so switch before filling a form.

## Appearance (المظهر)
Path: your own menu → Appearance (on a phone: Appearance at the bottom of the drawer)
Address: —
Needs: to be signed in.
What it is for: Changing how the screens look and read for you only — where the menu is (top bar, side panel or bottom bar), layout style, spacing, text size, motion and table rows. Colours are chosen on My profile.

### How to change the look — Appearance
1. Press your picture → **Appearance** (المظهر). A side panel opens, headed "Customize your workspace" (تخصيص مساحة العمل).
2. Under **Navigation** (التنقل) choose where the modules are — **Menu position** (موضع القائمة): Top bar (الشريط العلوي), Side panel (اللوحة الجانبية) or Bottom bar (الشريط السفلي); whether the side panel and the bottom bar show **Icons and names** (الأيقونات والأسماء) or **Icons only** (الأيقونات فقط); whether the side panel lists the modules **Grouped** (مجمّعة) under headings such as Invoicing or as a **Plain list** (قائمة بسيطة); the **Side panel colour** (لون اللوحة الجانبية); and whether the **Top bar when scrolling** (الشريط العلوي عند التمرير) **Stays in view** (يبقى ظاهراً) or **Scrolls away** (يختفي مع التمرير). See "How to use the side panel instead of the top bar — Top bar and module menu".
3. Under **Interface style** (نمط الواجهة) choose one of the cards: Current / Default (الحالي / الافتراضي — Existing ERP design), Standard (قياسي — Balanced), Enterprise (مؤسسي — Dense and efficient), Minimal (بسيط — Clean and quiet), Modern (عصري — Contemporary), Command (قيادة — Power user), Studio (استوديو — Spacious and refined). Each card previews itself. A style sets Density, Corner style, Content width, Border style, Shadow and Component size at once; it never changes Navigation, Text size, Animations or Table rows.
4. Or set them one by one: under **Layout settings** (إعدادات التخطيط) **Corner style** and **Content width**; under **Text and density** (النص والكثافة) **Text size**, **Density** and **Animations**; under **Tables** (الجداول) **Table rows**.
5. Open **Advanced appearance** (مظهر متقدم) for **Border style**, **Shadow** and **Component size**.
6. Every choice applies immediately and saves itself: the line at the bottom says "Saving appearance…" (جارٍ حفظ المظهر…) and then "Appearance saved to your account." (تم حفظ المظهر في حسابك.). Close the panel with ✕, a click outside, or Esc.
7. Until you change something, you see **everyone's default**: the appearance the company chose for people who have not chosen their own (or the built-in one, when it chose none). Once you change a setting, the whole appearance is yours and stays yours.
8. Whoever may configure the company (the Company Setup permission) sees **Everyone's default** (الافتراضي للجميع) at the bottom of the panel: **Make my appearance everyone's default** (اجعل مظهري الافتراضي للجميع) makes your palette, accent colour, layout and navigation what everyone without their own sees; **Reset everyone's default to the built-in** (أعد الافتراضي للجميع إلى المظهر الأصلي) puts the built-in one back. Each asks you to confirm first, and is kept in the audit trail. People who chose their own appearance keep it either way.

### Fields — Appearance
- **Menu position** (موضع القائمة) — Top bar (the default), Side panel, Bottom bar.
- **Side panel and bottom bar** (اللوحة الجانبية والشريط السفلي) — Icons and names (the default), Icons only. The side panel's Collapse button changes the same setting.
- **Group modules in the side panel** (تجميع الوحدات في اللوحة الجانبية) — Grouped (مجمّعة, the default: related modules under headings such as **Invoicing** — الفوترة — over Receivables and Payables), Plain list (قائمة بسيطة). The top bar and the bottom bar are not grouped.
- **Side panel colour** (لون اللوحة الجانبية) — Default (افتراضي, the page's own surface), Highlight (مظلَّلة باللون المميز: a soft wash of your accent colour — a light wash on a light palette, a deep tint on a dark one — with the module you are in a stronger step of the same colour), Accent (اللون المميز: the panel is a deeper step of your accent colour — for blue, the royal blue of the logo — with white names and icons, black on gold). It colours the whole panel and the narrow rail, headings and the Collapse row included; the top bar keeps its colour. It follows your palette and accent colour as you change them.
Every chosen option in the panel, and the chosen style card, is highlighted exactly as the side panel highlights the module you are in.
- **Top bar when scrolling** (الشريط العلوي عند التمرير) — Stays in view (the default), Scrolls away (more room on a short screen).
- **Corner style** (نمط الزوايا) — Soft (ناعمة), Rounded (مستديرة), Sharp (حادّ), Subtle (خفيف), Pill (دائري).
- **Content width** (عرض المحتوى) — Fluid (مرن), Contained (محدود), Wide (عريض), Full width (عرض كامل).
- **Text size** (حجم النص) — Smaller (أصغر), Default (افتراضي), Larger (أكبر). Everything on the screen grows or shrinks with the text, as with the browser's zoom.
- **Density** (كثافة العرض) — Comfortable (مريح), Compact (مضغوط), Spacious (واسع), Airy (رحب).
- **Animations** (الحركة) — On (مفعّلة), Reduced (مخفّفة): menus, panels and highlights appear at once instead of sliding or fading.
- **Table rows** (صفوف الجداول) — Striped (مخطّطة, every other row lightly tinted — the default), Plain (عادية). It applies to every list and to the styles that tint rows.
- **Border style** (نمط الحدود) — None (بلا), Subtle, Standard (قياسي), Strong (قوي). **Shadow** (الظل) — None, Subtle, Soft, Elevated (مرتفع). **Component size** (حجم العناصر) — Small (صغير), Medium (متوسط), Large (كبير).

### After you save — Appearance
The look is saved on your account and follows you to any device you sign in on. It changes nothing for other users and nothing in the data. "Could not save. Check your connection and try again." (تعذّر الحفظ. تحقّق من الاتصال وحاول مرة أخرى.) means the choice applied on screen but was not stored; pick it again when the connection is back. When Noah shows you a live picture of a screen, the picture is drawn with the top bar whichever Menu position you chose — the module, heading and screen names are the same in the side panel and the bottom bar.

## My Dashboard (لوحة معلوماتي)
Path: Dashboard → Home → My Dashboard   |   Arabic: الرئيسية ← الرئيسية ← لوحة معلوماتي
Address: /
Needs: to be signed in (the menu entry needs `view` on `dashboard`). Each part needs the permission of the screen its figures come from.
What it is for: Home — the first screen after signing in, titled **Dashboard** (لوحة المتابعة). It shows the shortcut buttons, figure tiles, charts and lists that your permissions earn, each linking to the screen that proves it; it is read-only. The full description — every tile, chart and list, the import journey, and why your Home differs from a colleague's — is in the Workspace guide under "My Dashboard", for example "How to read Home — My Dashboard".

## My Approvals (موافقاتي)
Path: Dashboard → Home → My Approvals   |   Arabic: الرئيسية ← الرئيسية ← موافقاتي
Address: /approvals
Needs: `view` on `workflow_instance` to open. Deciding a document also needs the permission to approve that kind of record and, where the step names one, its role.
What it is for: One list of the documents waiting for your decision, then what you sent for approval and what you decided. Chart accounts, journal entries and bank details (and a purchase invoice held for review) are approved or rejected on their row; every other document opens on its own page to be decided there. The full description is in the Workspace guide under "My Approvals" — for example "How to approve or reject from the list — My Approvals" and "Refusals — My Approvals". For who may approve what, see "Approval and maker-checker — Getting started concepts".

## My profile (ملفي الشخصي)
Path: your own menu (your picture in the top bar) → Profile settings (إعدادات الملف الشخصي)
Address: /profile
Needs: to be signed in. No other permission: the page only ever shows and changes your own account.
What it is for: Your own account: your picture, display name, language, colours, password, the authenticator (second step of signing in), and the facts of the account (roles, branches, departments).

### How to change your display name — My profile
1. Open your menu → **Profile settings**.
2. In **Edit profile** (تعديل الملف الشخصي) change **Display name** (الاسم المعروض) and press **Save** (حفظ). The e-mail is shown but cannot be changed here.
3. "Saved." confirms; the new name appears in the top bar and on everything you do from now on.

### How to change your password — My profile
1. In **Change password** (تغيير كلمة المرور) type your **Current password** (كلمة المرور الحالية), the **New password** (كلمة المرور الجديدة) and the same again in **Confirm new password** (تأكيد كلمة المرور الجديدة).
2. Press **Update password** (تحديث كلمة المرور).
3. "Your password has been changed." (تم تغيير كلمة المرور.) confirms it. Every other session of yours (other browsers, other devices) is signed out; the one you are using stays.

### How to reach the authenticator (Security) — My profile
1. Open your menu → **Profile settings**.
2. The **Security** (الأمان) panel, under **Account**, shows whether the **Authenticator** (تطبيق المصادقة) is **Enrolled** (مسجَّل) or **Not enrolled** (غير مسجَّل), whether it is **Required for this account** (مطلوب لهذا الحساب) and when it was **Last used** (آخر استخدام).
3. Press the button at the top of the panel — **Set up authenticator** (إعداد تطبيق المصادقة) when none is enrolled, **Manage** (إدارة) when one is. It opens the Security screen, /profile/security, where the QR code is shown.

### How to set or remove your picture — My profile
1. Under your name press **Choose an image** (اختر صورة) and pick a PNG, JPEG or WebP file of at most 400 KB; a square picture looks best.
2. Press **Upload picture** (رفع الصورة). It appears in the top bar.
3. To go back to your initials press **Remove picture** (إزالة الصورة).

### How to choose your colours — My profile
1. In the **Appearance** (المظهر) panel pick a colour scheme: Sand (رملي), Classic blue (أزرق كلاسيكي), Slate (رمادي أردوازي), Graphite (جرافيت), Pearl (لؤلؤي), Ivory Linen (الكتان العاجي), Glacier (النهر الجليدي), Sage White (أبيض المريمية), Porcelain Rose (الخزف الوردي), Dune Bronze (برونز الكثبان) or Harbor Mist (ضباب الميناء).
2. Pick the highlight colour — "the buttons, the selected row, the mark under a title": Gold (ذهبي), Red (أحمر), Blue (أزرق), Green (أخضر) or Purple (بنفسجي).
3. Press **Update** (تحديث). The colours are saved to your account and follow you across devices; each user chooses independently.
Layout style, spacing and sizes are set in the Appearance panel of your own menu instead.

### How to choose your language — My profile
1. In the **Language** (اللغة) panel press **English** or **العربية**; the one in use is ticked.
2. The page reloads in that language at once — there is no Save button. The choice is kept on this device, as with the Language choice in your own menu.

### Fields — My profile
- **Display name** (الاسم المعروض) — required, at most 120 characters. The name shown in the top bar, on documents you raise or approve, and in audit logs.
- **Email** (البريد الإلكتروني) — read-only; it is your sign-in name. Only an administrator can change it.
- **Current password** / **New password** / **Confirm new password** — all required; the new one at least 12 characters.
- **Choose an image** (اختر صورة) — optional; PNG, JPEG or WebP, up to 400 KB.
- **Account** (الحساب) panel, read-only: **Roles** (الأدوار), **Branches** (الفروع — a ★ marks your default branch), **Departments** (الأقسام — "Manager" (مدير) marks a department you manage), **Live sessions** (الجلسات النشطة — how many places you are signed in right now), **Password last changed** (آخر تغيير لكلمة المرور) and **Created** (تاريخ الإنشاء).
- **Security** (الأمان) panel, read-only: **Authenticator** (تطبيق المصادقة — Enrolled or Not enrolled), **Required for this account** (مطلوب لهذا الحساب), **Last used** (آخر استخدام), and the button **Set up authenticator** (إعداد تطبيق المصادقة) or **Manage** (إدارة) that opens the Security screen.
- **Audit log** (سجل التدقيق) at the bottom — what has happened to your account.

### After you save — My profile
Each form saves on its own button and answers "Saved." (or "Your password has been changed."). Changes to roles, branches or departments are not made here: ask an administrator.

### Refusals — My profile
- "displayName: is required" / "displayName: is longer than 120 characters".
- "confirm: the two new passwords do not match" / "currentPassword: the current password is not correct".
- "That password cannot be used: it is 9 characters; 12 is the minimum. …" and the other password reasons listed under "Refusals — Change password".
- "avatar: use a PNG, JPEG or WebP image" / "avatar: is larger than 400 KB".

## Security (الأمان)
Path: your own menu (your picture in the top bar) → Profile settings (إعدادات الملف الشخصي) → the **Security** (الأمان) panel → **Set up authenticator** (إعداد تطبيق المصادقة) or **Manage** (إدارة); it also opens by itself when your account must enrol an authenticator and the time allowed has passed
Address: /profile/security
Needs: to be signed in.
What it is for: Setting up the second step of signing in — an authenticator app on your phone that shows a six-digit code. Required for a Super User and for roles an administrator marked as privileged; optional for everybody else.

### How to enrol an authenticator — Security
1. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Aegis…).
2. Open Profile settings and press **Set up authenticator** (إعداد تطبيق المصادقة) in the **Security** panel (address /profile/security). The **Second factor** (العامل الثاني) panel shows whether it is **Required for this account** (مطلوب لهذا الحساب) and whether you are **Enrolled** (مسجَّل) or **Not enrolled** (غير مسجَّل).
3. Press **Begin enrolment** (بدء التسجيل). The page shows a QR code, with the **Setup key** (مفتاح الإعداد) under it.
4. In the app choose to add an account and scan the QR code with the phone's camera. If it cannot be scanned, choose "enter a setup key" in the app and type the key. If you are reading the page on the same phone the app is on, press **Open in the authenticator app** (افتح في تطبيق المصادقة) beside **On this phone** (على هذا الهاتف) instead.
5. Type the six-digit **Code from the app** (الرمز من التطبيق) and press **Confirm enrolment** (تأكيد التسجيل).
6. "The authenticator is enrolled. Sign-in will ask for its code." From now on signing in asks for the code.

### How to replace the authenticator (new phone) — Security
1. While you still have the old app, open Profile settings → **Security** → **Manage** (إدارة) and press **Issue a new key** (إصدار مفتاح جديد).
2. Scan the new QR code with the new app (or type the new key) and confirm with its code. Until the new app is confirmed, sign-in still needs the code from the old one.
3. If the old phone is lost, ask an administrator.

### Fields — Security
- **Second factor** (العامل الثاني) panel, read-only: **Required for this account** (مطلوب لهذا الحساب), **Authenticator** (تطبيق المصادقة — Enrolled or Not enrolled), **Enrolled on** (تاريخ التسجيل), **Last used** (آخر استخدام).
- The QR code — shown only between **Begin enrolment** and **Confirm enrolment**. It holds the setup key, the company's name and your e-mail; the app shows the company's name beside the code it produces. It is drawn by the system itself and is black on white in every colour scheme.
- **Setup key** (مفتاح الإعداد) — the same key as the QR code, in groups of four letters, for typing into the app.
- **On this phone** (على هذا الهاتف) → **Open in the authenticator app** (افتح في تطبيق المصادقة) — opens the app with the key filled in, on a phone or tablet that has an authenticator app installed. On a computer without one it does nothing.
- **Code from the app** (الرمز من التطبيق) — required; the six digits the app shows now.

### What happens if you do not enrol — Security
- An account that needs a second factor gets a reminder in the bell once a day: "Enrol your authenticator — This account must sign in with an authenticator code from <date>. Enrol it under My profile → Security."
- The page shows "This account must enrol an authenticator by <date>. After that date it can do nothing else until it has." You have 7 days from the first sign-in after it became required.
- After that date every screen brings you to this page: "The enrolment period has passed. Enrol an authenticator now; nothing else is available until you do." Enrol and the system opens again.

### Refusals — Security
- "Those credentials are not valid." — the code typed was wrong or expired; type the code the app shows right now.

## Concepts — Lists

### What every list looks like — Lists concepts
A list screen has, from top to bottom: a back button to the Dashboard, the tabs of its menu heading, the title with a short description, the **New …** button (only if you may create), the outcome message of your last action, a title bar with the number of rows, the toolbar (search, filters and, on some lists, the Views button), and the table. The first column is usually the record's number or code and is the link that opens the record. Statuses are shown as coloured chips.

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
A number of lists and reports have a **Views** (العروض) button with a bookmark icon, beside the search box or at the top of the page. It keeps the search and filters now on screen under a name of your own, opens them again with one press, and can make one view the default of its screen or pin it to Home. A view holds filters, never records, and only you see it. The full description — including which screens have the button — is in the Workspace guide under "Saved views" (العروض المحفوظة).
A few lists also carry an older **Views** (العروض) drop-down among their filters — Import Applications, for example, offers All open, Stopped — reason required, Stopped, Imports, Rent & contracts. Those are ready-made filters supplied with the system: choose one and press **Filter**. On a list with neither, bookmark the page after filtering to keep your own combination.

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
**Coming soon** (قريباً) on an otherwise empty screen means the screen is in the menu but has not been built yet: there is no data in it and nothing can be entered. The three Monitoring screens (List of customers, History, Reports) are like this. It is not an error and not a permission problem; use the working screen that covers the same need (for customers: Accounting → Master Data — Financial → Customers).

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
