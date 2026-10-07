# Chat, tasks and documents — user guide

This guide covers the screens people use to work together rather than to post documents: Chat (المحادثات), the AI dock — Noah (نوح — الذكاء الاصطناعي) in the corner of every screen, the Task Center — My Tasks (مهامي), the Document Centre (مركز المستندات) with QS Cloud Files, and the Cloud Files Settings (إعدادات Cloud Files) an administrator uses to switch the cloud files on.
**Chat** is for talking to colleagues inside the system, one to one or in a group. A message is never edited or deleted, only withdrawn with a reason. The **Messages** (الرسائل) button in the top bar shows how many messages are unread.
A **task** is a piece of work one person asks another to do, in a section, with a priority and a deadline. It moves by buttons from Draft to Assigned, Accepted, In progress, Handed in and Completed, and **Reply in Chat** opens a conversation about it.
The **Document Centre** is a window onto the company's cloud file store, QS Cloud Files. Each person links their own cloud account once, then browses, uploads and links files to the records they belong to. The files stay in the cloud; the system keeps only the links. The same files show on a record under its paperclip, in the **QS Cloud Files** panel.
None of these screens posts anything to the books. After an action the page answers as everywhere else: "Saved." or "That could not be saved." followed by the reason, which is always in English.

## Chat (المحادثات)
Path: Dashboard → Home → Chat   |   Arabic: الرئيسية ← الرئيسية ← المحادثات
Address: /chat   (one conversation: /chat?c=<conversation id>)
Needs: `view` on `chat` to open the screen and read; `create` on `chat` to write, start a conversation, react and withdraw. Both were given to every role that existed when chat was installed; a role created since needs them granted by an administrator, and a person with no role has no chat. Reading is by membership: only the people in a conversation see it — a Super User who is not in it sees nothing of it.
What it is for: Talking to colleagues inside the system — one to one, in a group, or about a record — with replies, reactions, @mentions and files. The page says "Talk to colleagues inside the ERP: one to one or in groups, about the work and about records." The list of conversations is on one side and the open conversation beside it.

### How to open Chat and read what is waiting — Chat
1. Open Dashboard → Home → Chat, or press the **Messages** (الرسائل) button in the top bar and then **Open Chat** (فتح المحادثات).
2. The **Conversations** (المحادثات) list shows every conversation you are in, the one with the latest message first: the other person's name or the group's name, the start of the last message and its time.
3. The **Unread** (غير مقروءة) column is how many messages you have not read there. An "@" before the number means somebody mentioned you.
4. Press a conversation. It opens beside the list. On a phone or a narrow window it takes the list's place; the arrow **Back to conversations** (العودة إلى المحادثات) returns to the list.
5. The conversation opens at the line "Unread messages" (رسائل غير مقروءة) — the first message you have not read — or at its end when everything is read.
6. A message counts as read when the conversation is open in the tab in front of you and you are at its end. The sender then sees **Seen** (تمت المشاهدة).
7. **Load earlier messages** (تحميل رسائل أقدم) at the top brings the older ones, fifty at a time.
New messages arrive by themselves within about two seconds while the conversation is open; there is nothing to refresh. With no conversation yet the list says "No conversations yet. Start one with New chat." (لا توجد محادثات بعد. ابدأ واحدة من «محادثة جديدة».); an empty conversation says "No messages yet. Say hello." (لا توجد رسائل بعد. ابدأ بالتحية.).

### How to use the Messages button in the top bar — Chat
1. The **Messages** (الرسائل) button is the envelope in the top bar, beside the bell. When you have unread messages the envelope is replaced by their number ("99+" above ninety-nine).
2. Press it. A panel lists up to seven of your conversations, those with unread messages first: each with the person's round picture (their initials) and the coloured dot of their status, the time of the last message, its start, and the number unread.
3. Press a conversation to open it as a **chat window** at the foot of the screen, without leaving the page you are on (see "How to chat in a window at the foot of the screen — Chat"). The small square at the end of the row, **Open in Chat** (فتح في صفحة المحادثات), opens it on the Chat screen instead. **Open Chat** (فتح المحادثات) at the bottom opens the screen.
4. On a phone the button is the **Messages** row at the bottom of the menu drawer, with the number beside it; it opens the same panel, and a conversation opens full screen.
- The number is checked about every fifteen seconds on any page, so a new message shows without reloading.
- A conversation you muted is not counted in the number.
- A person who has no chat permission still sees the button, with the old empty panel: "No new messages." (لا توجد رسائل جديدة.).

### How to chat in a window at the foot of the screen — Chat
1. Open a conversation from the Messages panel in the top bar. It opens as a small window at the bottom end of the screen, over whatever page you are on, and the box to write in has the cursor.
2. The window's top line shows the person's picture with their status dot, their name, and under it their status — or "… is typing..." (… يكتب...) while they write. Its buttons: **Minimise** (تصغير), **Open in Chat** (فتح في صفحة المحادثات) and **Close** (إغلاق).
3. Write and press **Enter** to send (**Shift+Enter** adds a line). The paperclip **Attach files** (إرفاق ملفات) adds up to five files; the smiling face **Emoji** (رموز تعبيرية) adds an emoji where the cursor is.
4. Each of your messages shows its time and a tick: a clock while it is being sent, one tick **Sent** (أُرسلت), two ticks **Delivered** (وصلت), two coloured ticks **Seen** (تمت المشاهدة). A message counts as seen when the other person has its window (or the Chat screen) in front and is at its end — exactly as on the Chat screen.
5. Up to three windows stand open side by side. Opening a fourth folds the oldest into a round **chat head** at the end of the screen: the person's picture with the number unread. Press a head to open its window again; point at it and press the small × to close it.
6. The windows stay open as you move from screen to screen, and after a reload in the same browser tab. They do not appear on the Chat screen itself, which is the full chat.
7. On a phone a window takes the whole screen; Close or Open in Chat leaves it.

### How to choose your status — Chat
1. Press your picture (or your initials) at the end of the top bar. Under **Status** (الحالة) press one of four:
   - **Available** (متاح) — green while you have the system open and use it; it turns to Away by itself after five idle minutes.
   - **Busy** (مشغول) — red. Messages and notifications make no sound while you are Busy.
   - **Away** (بعيد) — amber, however active you are.
   - **Appear offline** (الظهور كغير متصل) — colleagues see you as Offline, with no "last seen". You still receive every message and notification.
2. The choice is saved at once and kept until you change it, on every device. It is the small dot at the bottom corner of your picture — bottom right, bottom left in Arabic: green Available, red Busy, amber Away, grey Offline or Appear offline. You see your own on your picture in the top bar and on My profile; colleagues see it, within a few seconds, wherever your picture is shown to them — the Messages panel, the chat windows, the Chat screen, the people search, the Users list and a user's page, and the task lists. A dot is shown only to the people you share a conversation with; to anybody else your picture has none.
3. The **Busy** button at the top of the Conversations list is the same choice: it sets Busy, and **Clear busy** sets Available.

### How to start a conversation — Chat
Needs: `create` on `chat`.
1. Press **New chat** (محادثة جديدة) at the top of the screen. The window **Start a conversation** (بدء محادثة) opens.
2. In **Find a colleague** (ابحث عن زميل) type part of a name or an e-mail address ("Name or email" — الاسم أو البريد الإلكتروني). Up to twenty colleagues are listed, each with name and e-mail. Only active users who have chat are offered.
3. Press **Chat** (محادثة) beside the person. The window closes and the conversation opens beside the list.
4. Type your message and press **Send** (إرسال).
- If you already have a conversation with that person, that one opens; a second one is never made.
- "No colleague matches." (لا يوجد زميل مطابق.) — nobody active with chat has that name; try fewer letters.
- A conversation between two people has no name of its own and no members to change. To add a third person, create a group.

### How to create a group and manage its members — Chat
Needs: `create` on `chat`. Adding, removing and renaming are for the group's owner.
1. Press **New group** (مجموعة جديدة). The window **Create a group** (إنشاء مجموعة) opens.
2. Type the **Group name** (اسم المجموعة) — required, up to 80 characters.
3. In **Find a colleague** (ابحث عن زميل) look people up and press **Add** (إضافة) beside each; the button turns to **Added** (تمت الإضافة) and the line "N people chosen" (تم اختيار N) lists them. A person added by mistake cannot be un-picked in this window: create the group and remove them afterwards, or reload the page and start again.
4. Press **Create group** (إنشاء المجموعة). The group opens; you are its **Owner** (المالك). A group holds at most 50 people.
5. To see or change the members, press the people icon **Members** (الأعضاء) at the top of the open group. Each person is listed with their status (Online, Away, Busy, Offline).
6. The owner sees, in the same window: the icon **Remove from group** (إزالة من المجموعة) beside each member; the **Group name** box with **Rename** (إعادة التسمية); and a second **Find a colleague** box: press **Add** (إضافة) beside each new person, then **Add people** (إضافة أشخاص).
7. Anyone in a group may press **Leave group** (مغادرة المجموعة) and confirm with **Leave the group** (غادر المجموعة). "Leave this group? Its messages stop reaching you, and what is said after you leave stays unread unless you are added again."
- A person added later reads only what is written after they were added.
- When the owner leaves, the longest-standing member becomes the owner.
- Every change writes a line in the conversation, for example "Ali added Sara" or "Sara left the group".

### How to send a message, reply, mention and react — Chat
Needs: `create` on `chat`.
1. Open the conversation and type in the box "Write a message. Use @Name to mention someone." (اكتب رسالة. استخدم @الاسم للإشارة إلى شخص.).
2. Press Enter or **Send** (إرسال). Shift+Enter starts a new line ("Enter sends, Shift+Enter adds a line."). A message holds at most 4,000 characters.
3. **To mention somebody**, type @ and their whole name as it is shown in the conversation (for example @Ali Hassan; capitals do not matter). No list of names is offered: type it yourself. Only members of the conversation can be mentioned. The name shows in bold in the message, the person gets their own notification even if they muted the conversation, and the message is marked "@" for them.
4. **To reply to one message**, press the arrow **Reply** (رد) on it. "Replying to …" (رد على) appears above the box; type and send. The reply carries a line quoting the original; press that line to jump to it. The ✕ beside "Replying to" cancels the reply.
5. **To react**, press the face icon **React** (تفاعل) on a message and choose one of six: Like (إعجاب), Love (حب), Laugh (ضحك), Thanks (شكرًا), Done (تم), Looking into it (قيد النظر). The reaction shows under the message with a count; hover to see who. Press your own reaction again to take it back.
6. While somebody is writing you see "Ali is typing..." (… يكتب...) under the conversation.
A message cannot be changed after it is sent. If it is wrong, withdraw it and write it again.

### How to send a file — Chat
Needs: `create` on `chat`. The attachments permission is not needed.
1. In the open conversation press **Attach files** (إرفاق ملفات) under the message box and choose up to five files. Each is listed above the buttons; the ✕ **Remove file** (إزالة الملف) takes one out.
2. Add words if you wish — a message may be files only — and press **Send** (إرسال).
3. The files show under the message with their size and type. A picture (PNG, JPEG, GIF, WebP) is drawn in the conversation and opens full size in a new tab; a PDF opens in a new tab; both also have a **Download** (تنزيل) arrow. Any other file downloads when its name is pressed.
- The rules are the paperclip's: up to 25 MB a file; programs and archives (.exe, .bat, .zip, .rar, .7z …) are refused; so are an empty file and a file whose name does not match its content. Every file is scanned for viruses.
- The files of one message travel together, so keep their total under about 25 MB; send big files in separate messages.
- If one file is refused the whole message is not sent. It stays at the end of the conversation marked **Not sent** (لم تُرسل) with the reason and two buttons: **Try again** (إعادة المحاولة) and **Discard** (تجاهل).
- Only members of the conversation can open a file. When a message is withdrawn its files can no longer be opened.

### How to withdraw a message — Chat
Needs: `create` on `chat`; only the person who wrote the message.
1. On your own message press the bin icon **Withdraw** (سحب). The window **Withdraw message** (سحب الرسالة) opens: "The text stops being shown to everyone, and the withdrawal is recorded with your reason. It cannot be undone."
2. Type the **Reason** (السبب) — required, at least 3 characters, up to 200.
3. Press **Withdraw** (سحب).
- In place of the text everybody now reads "Withdrawn by <your name>" (سحبها …) and your reason. Its files and reactions are gone from the screen, and a reply that quoted it shows "Message withdrawn" (رسالة مسحوبة).
- The message is not deleted: the withdrawal and its reason are kept in the audit trail. Nothing in Chat can be deleted or edited.
- Lines the system wrote ("Ali added Sara") cannot be withdrawn.

### How to search conversations and messages — Chat
1. Type in the box **Search conversations and messages** (ابحث في المحادثات والرسائل) above the list.
2. The list narrows at once to the conversations whose name or last message contains what you typed.
3. From two characters on, a second table **Messages found** (الرسائل المطابقة) lists up to thirty messages that contain the words, newest first, from every conversation you are in: the conversation, who wrote it, a piece of the text, and **When** (الوقت).
4. Press a result. The conversation opens at that message.
- The search matches the letters as typed, anywhere in a message, upper or lower case alike. It does not look inside attached files, and withdrawn messages are not found.
- "Nothing matches." (لا شيء مطابق.) — neither a conversation nor a message has those letters.
- "The search could not be completed." (تعذّر إتمام البحث.) — try again in a moment.

### How to mute a conversation or show yourself as Busy — Chat
1. **Mute**: in the open conversation press the bell **Mute notifications** (كتم الإشعارات). The conversation no longer raises a notification and is not counted in the Messages button; its own Unread number still counts. A mention still reaches you. Press the crossed bell **Turn notifications back on** (إعادة تشغيل الإشعارات) to undo. Muting is yours alone; nobody else sees it.
2. **Busy**: at the top of the Conversations list press **Busy** (مشغول) — "Show me as Busy to colleagues". Colleagues you talk to see you as Busy while you have the system open. Press **Clear busy** (إلغاء حالة مشغول) — "Show my usual status again" — to return to normal.
3. With **Available** chosen (see "How to choose your status — Chat") your status is worked out by itself: Online (متصل) while the system is open and you used the page in the last five minutes; Away (بعيد) while it is open but untouched for five minutes; Offline (غير متصل) about a minute after you close it, with "last seen …" (آخر ظهور …). Busy and Away chosen in your own menu hold while the system is open; Appear offline always shows Offline, without "last seen".
Messages can be sent to a person in any status; they read them when they return.

### How to talk about a record — Chat
A conversation can be attached to one record. Under its name it shows "About record: <number>" (حول السجل), a link that opens the record, and in the list it carries a small link mark.
1. From a task: open the task and press **Reply in Chat** (الرد في المحادثة). The conversation about that task with the other person on it opens, with the message box already filled with "About TASK-001 — <title>: ". Nothing is sent until you press **Send** (إرسال).
2. At present that is the only button that starts a conversation about a record; other record pages have no chat button.
3. If you arrive in Chat through a link that asks to discuss a record, a panel **Discuss: <record>** (مناقشة: …) appears above the list. It lists any "Existing conversation about this record" (محادثة قائمة حول هذا السجل) you are in — press one to open it. To start a new one, look colleagues up in **Find a colleague**, press **Add** (إضافة) for each, give a **Group name** (اسم المجموعة) if you chose more than one, and press **Start conversation** (بدء المحادثة).
- Everybody in such a conversation must be able to open the record themselves; a person who cannot is refused by name.
- A member who later loses access to the record still reads the conversation but sees "This conversation is about a record you do not have access to." (هذه المحادثة عن سجلّ لا تملك صلاحية الوصول إليه.) instead of its number and link.

### Fields — Chat
- **Conversation** (المحادثة) — list column: the person or group, a status pill for a person who is not offline, a crossed bell if muted, a link mark if it is about a record, the start of the last message and its time.
- **Unread** (غير مقروءة) — list column: messages you have not read; "@" in front when you were mentioned.
- Search box **Search conversations and messages** (ابحث في المحادثات والرسائل) — optional; see "How to search conversations and messages".
- Message box — "Write a message. Use @Name to mention someone."; up to 4,000 characters; required unless a file is attached.
- **Attach files** (إرفاق ملفات) — optional; up to five files a message, 25 MB each.
- **Find a colleague** (ابحث عن زميل) — in New chat, New group and Members: part of a name or e-mail; offers active users who have chat, never yourself.
- **Group name** (اسم المجموعة) — required for a group; up to 80 characters.
- **Reason** (السبب) — in Withdraw message: required, 3 to 200 characters.
- On each message: the writer ("You" — أنت — for your own), the time, **React** (تفاعل), **Reply** (رد), and on your own **Withdraw** (سحب) and the delivery status.
- At the top of an open conversation: its name; for a person their status, for a group "N members" (N أعضاء); the bell (mute); the people icon — **Members** (الأعضاء) for a group, **Details** (التفاصيل) for two people.

### Statuses — Chat
Under each message you sent, the system shows how far it has got. It only moves forward, and nobody can set it by hand.
- **Sending** (جارٍ الإرسال) — on its way from your browser to the server.
- **Sent** (أُرسلت) — the server has it. Nobody's browser has received it yet.
- **Delivered** (وصلت) — the other person's browser has received it: they have the system open on some page.
- **Seen** (تمت المشاهدة) — the other person had the conversation open in front of them, at its end.
- **Not sent** (لم تُرسل) — the send failed; the reason is under it. Press **Try again** (إعادة المحاولة) or **Discard** (تجاهل). Trying again never sends the message twice.
In a group the status is the one every other member has reached: it stays Sent until everybody's browser has the message and becomes Seen only when everybody has read it, followed by a count such as "Seen 4/4". To see how far each person is, hover over the status: it lists them one by one.
A person's own status: **Online** (متصل), **Away** (بعيد), **Busy** (مشغول), **Offline** (غير متصل) — see "How to mute a conversation or show yourself as Busy".

### What happens next — Chat
- The people in the conversation see your message within about two seconds if they have it open, within about six seconds on the Chat list, and within about fifteen seconds on any other page, where the Messages button's number goes up.
- Each of them also gets a notification in the bell under Chat: one for a run of unread messages in a conversation (ten messages while they are away make one notification, not ten), and one for every message that mentions them. A muted conversation raises none, except for a mention. Opening the conversation marks them read.
- Chat sends no e-mail, no phone notification and nothing to WhatsApp. A person who has the system closed finds the messages when they sign in.
- If the connection drops the screen says "Reconnecting. Messages will appear again when the connection returns." (جارٍ إعادة الاتصال…) and tries again by itself. "You have been signed out. Sign in again to continue." means the session ended.
- Starting a conversation, adding or removing a member, leaving, renaming and withdrawing are written to the audit trail. The text of messages is not copied there.

### What Chat does not do — Chat
- A message cannot be edited or deleted — only withdrawn, with a reason, by the person who wrote it.
- No channels, no threads under a message, no voice or video calls.
- No e-mail or phone alert for a new message; the notification is inside the system only.
- No list of "read by" beyond the status under your own message.
- The search finds letters inside messages; it does not rank results and does not read attached files.
- Earlier messages of a group are not shown to a person added later.
- Apart from **Reply in Chat** on a task, record pages have no button to start a conversation about the record.
- A group cannot be deleted. People leave it; its messages stay for those who remain.

### Refusals when sending a message or a file — Chat
A message that was not sent stays at the end of the conversation marked **Not sent** (لم تُرسل), with the reason under it and the buttons **Try again** (إعادة المحاولة) and **Discard** (تجاهل).
- "Write something or attach a file before sending."
- "A message is at most 4000 characters; this one has N." — shorten it, or attach the text as a file.
- "At most 5 files go in one message." — send the rest in a second message.
- "<file> was not accepted: it is 30MB; the limit is 25MB." — send a smaller file.
- "<file> was not accepted: files ending .zip are not accepted (§21)." — send the documents themselves, not an archive.
- "<file> was not accepted: its content is a Windows executable. Executable files are not accepted (§21) — renaming one does not change what it is."
- "<file> was not accepted: it is named .pdf but its content is image/png. The name and the file disagree." — save the file under its true type.
- "<file> was not accepted: it is empty."
- "<file> did not pass the malware scan, so the message was not sent."
- "The message you are replying to is not in this conversation."
- **Not sent** with no reason under it — the connection failed, or the files together were too large for one message (about 25 MB). Press **Try again**, or discard it and send the files one by one.
- "You can read this conversation but not write in it." (يمكنك قراءة هذه المحادثة لكن لا يمكنك الكتابة فيها.) — you hold `view` but not `create` on chat; there is no message box.

### Refusals — Chat
A refusal shows in a red band titled "That did not go through." (لم تتم العملية.) or inside the window you were using.
- "Not available to you" — you hold no chat permission; ask an administrator.
- "This conversation does not exist or you are not in it." / "That conversation is no longer available to you." (لم تعد هذه المحادثة متاحة لك.) — you left it or were removed.
- "That person cannot be reached in chat: they are not an active user with chat access." / "Some of the people picked cannot be reached in chat: they are not active users with chat access."
- "Pick a colleague: a conversation needs somebody else in it." / "Pick at least one colleague for the group." / "Pick at least one colleague to add." / "Everyone picked is already in the group."
- "A group needs a name." / "A group holds at most 50 people."
- "Only an owner of the group does that." — adding, removing and renaming are the owner's.
- "A conversation between two people has no members to change." / "That person is not in the group."
- "Say why the message is withdrawn (at least 3 characters)." / "Only the person who wrote a message can withdraw it." / "That message is already withdrawn." / "Only a message somebody wrote can be withdrawn."
- "That message cannot be reacted to." — it was withdrawn, or it is a line the system wrote.
- "You cannot open that record, so you cannot start a conversation about it." (لا يمكنك فتح هذا السجل، لذلك لا يمكنك بدء محادثة عنه.)
- "<name> cannot open this record, so they cannot be added to a conversation about it." / "<name> cannot open the record this conversation is about, so they cannot be added." / "Pick at least one colleague to talk to about the record."
- "The list of colleagues could not be loaded." (تعذّر تحميل قائمة الزملاء.) / "That did not work. Try again." (لم تنجح العملية. حاول مرة أخرى.) — try again in a moment.
- "Permission denied: 'create' on 'chat' is not granted to this user."

## The AI dock — Noah (نوح — الذكاء الاصطناعي)
Path: every screen — the round button with the sparkle in the bottom end corner   |   Arabic: كل شاشة — الزر الدائري ذو النجمة في الزاوية السفلية
Address: no address of its own; the panel opens over the page you are on (its route is /assistant/api)
Needs: being signed in. Every active user may ask; what Noah reads is read as you, with your own permissions, so a storekeeper is told what a storekeeper's screens show. A proposal runs only after you press **Yes, do it** (نعم، نفّذ), as you, through the system's own rules — the same refusals you would meet on the screen.
What it is for: asking the system's assistant — the same Noah the WhatsApp group talks to — about a document, a figure, a screen or what to do next, without leaving the page. Since 2026-10-07.

### How to ask Noah — The AI dock
1. Press the round **AI — ask Noah** (الذكاء الاصطناعي — اسأل نوح) button in the bottom end corner of any screen. A panel titled **Noah — AI** (نوح — الذكاء الاصطناعي) opens above it, with the line "Reads as you; acts only after your Yes" (يقرأ باسمك؛ ولا ينفّذ إلا بعد موافقتك).
2. Write your question in **Ask Noah…** (اسأل نوح…) and press **Enter** (**Shift+Enter** adds a line), or press the arrow **Send** (إرسال). While he reads, the top line says **Reading…** (يقرأ…) and three dots pulse in the conversation.
3. His answer appears as a bubble, in the language you wrote in. A document number or a figure in it is something he read in the system as you. A picture he took of a screen shows inline under his words — press it to open it full size. A report he made (PDF or Excel) is a line with a download arrow under the answer.
4. Ask the next question in the same panel: the last twelve turns go with it, so "and Erbil?" or "show me the first one" means something. The conversation stays with this browser tab as you move from screen to screen; **Clear the conversation** (مسح المحادثة) — the bin in the panel's top line — starts afresh.
5. Paste a picture (a screenshot, a photo of a paper) into the box with Ctrl+V: it is listed as a chip above the box and goes with your question for him to read; at most two, up to 4 MB each.
6. **Close** (إغلاق) — the × or the Escape key — closes the panel; the button stays in the corner. On a phone the panel takes the whole screen.

### How a proposal is run — The AI dock
1. When you ask him to do something — approve a document, post an invoice, create a supplier, save a draft, run a few steps — he does not do it. A card **Noah proposes** (يقترح نوح) appears under his answer with the facts: the document, the figures, what cannot be undone.
2. Press **Yes, do it** (نعم، نفّذ) to run it as you, now, through the document's own service: your permissions, the maker-checker rule, the branch scope and the open period decide, exactly as on the screen. He tells you what happened — or the system's refusal, in its own words.
3. Press **No** (لا) and nothing is done ("Nothing was done." — لم يُنفَّذ شيء.).
4. A proposal stands for ten minutes and for one question: asking something else drops it, and he proposes afresh if you ask again.

### Fields — The AI dock
- **Ask Noah…** (اسأل نوح…) — the question, up to 4,000 characters.
- Pasted pictures — up to two, JPEG, PNG, GIF or WebP, each up to 4 MB; **Remove picture** (إزالة الصورة) on the chip takes one off.
- **Yes, do it** / **No** on a proposal card.

### After you save — The AI dock
- Nothing is saved by asking. Each answer is one line in the audit trail ("assistant.answered": your question's first words, the tools he used, whether a file or pictures went back). Each **Yes** writes the same audit rows a WhatsApp yes writes, with `web` as where it came from.
- The conversation is kept in this browser tab only (pictures and files are not kept across a reload); the server keeps nothing between questions.

### Refusals — The AI dock
- "The assistant is not set up on this server: …" (المساعد غير مهيّأ على هذا الخادم) — the host has no brain: neither the CLI signed in nor a key. An administrator sets it up as for the WhatsApp bridge (docs/RUNBOOK-whatsapp.md).
- "You are signed out. Sign in again and ask once more." — the session ended while the panel was open.
- "Something went wrong while answering. Try again." — the brain or the database failed; the error is in the server's log with its digest.
- A refusal from a proposal is the system's own sentence — the same one the screen would show — and nothing was changed.

## My Tasks (مهامي)
Path: Dashboard → Home → My Tasks   |   Arabic: الرئيسية ← الرئيسية ← مهامي
Address: /tasks   (one task: /tasks/<task number>, for example /tasks/TASK-001)
Needs: `view` on `task` to open the list and a task. **New task** needs `create` and `submit` on `task` and membership of at least one section. Assigning, reassigning, reviewing (Complete, Return for rework) and cancelling need `submit`; working a task given to you (Accept, Decline, Start, Block, Resume, Hand in) needs `execute`; editing a draft needs `edit_draft`; `administer` lets a person assign to anybody in a branch and stand in for the person who assigned. Printing needs `print` (PDF) or `export` (Excel, Word) on `task`; attaching a file needs `create` on `attachment`. As delivered, every role holds view, execute, print and export; the CEO, accounting manager, HR manager and project manager roles can also raise and assign; only the CEO role administers. A role created later has none of these until an administrator grants them.
What it is for: The Task Center. The screen is titled **Tasks** (المهام): "Work one person asks another to do, with a deadline, a section and the record it is about." The list shows the tasks given to you, the tasks you gave to others and — if you lead people — your team's. One task opens on its own page with its progress, the buttons for the next step, **Reply in Chat**, its watchers and its files.

### How to read the list — My Tasks
1. Open Dashboard → Home → My Tasks. The list opens on **My tasks** (مهامي): the work assigned to you.
2. Choose another list in **View** (العرض) and press **Show** (عرض): **Assigned by me** (ما كلّفتُ به) — tasks you raised or assigned to other people, your drafts included; **Team** (الفريق) — tasks of the people you lead (offered only if you manage a section, have people reporting to you, or administer tasks).
3. Narrow it with the second filter, also called **Show** (عرض); each choice carries its count in brackets: **All** (الكل); **Open** (المفتوحة) — Assigned, Accepted, In progress or Blocked; **Due today** (تستحق اليوم); **Due soon** (تستحق قريباً) — within the next three days; **Overdue** (متأخرة); **Blocked** (معطّلة); **Waiting for review** (بانتظار المراجعة) — handed in; **Completed** (المكتملة).
4. The box **Search this list** (ابحث في هذه القائمة) finds by task number, title, the name of the person assigned or assigning, the number of the record the task is about, or the section.
5. Columns: **Reference** (المرجع) — the task number, press it to open the task; **Title** (العنوان); **Assigned by** (كلّف بها) in My tasks, **Assigned to** (المكلَّف) in the other two — a draft shows "Not assigned" (غير مكلَّفة); **Section** (القسم) — not in Assigned by me; **Priority** (الأولوية); **Deadline** (الموعد النهائي), followed by "overdue" (متأخرة), "today" (اليوم) or "soon" (قريباً); **Status** (الحالة); and in Assigned by me **Progress** (التقدّم) as a percentage.
6. Work still owed comes first, then tasks handed in, then drafts, then finished ones; within each, the nearest deadline first, then the highest priority. Fifty rows a page.
7. In the Team view a second table, **Team workload** (حمل عمل الفريق), counts per person: **Open** (مفتوحة), **Overdue** (متأخرة), **Blocked** (معطّلة), **For review** (للمراجعة), **Completed** (مكتملة).
A task assigned to yourself is under My tasks, not under Assigned by me. Empty lists say, for example, "No tasks here. Work given to you appears in this list."

### How to raise and assign a task — My Tasks
Needs: `create` and `submit` on `task`, and membership of at least one section. Without them the **New task** button is not shown.
1. On the list press **New task** (مهمة جديدة).
2. Type the **Title** (العنوان) — required, 3 to 200 characters.
3. Choose the **Section** (القسم) — one of the sections you belong to.
4. Choose **Assigned to** (المكلَّف). Only the people you may give work to in that section are listed, each followed by why: "yourself" (أنت), "reports to you" (يتبعك), "your section" (قسمك) or "organisation" (المؤسسة). Leave it on **Not assigned yet (keep as a draft)** (غير مكلَّفة بعد (إبقاؤها مسودة)) to save a draft.
5. Set the **Priority** (الأولوية) — Low (منخفضة), Normal (عادية), High (عالية) or Urgent (عاجلة) — and, if there is one, the **Deadline** (الموعد النهائي), today or later.
6. Optionally fill **Description** (الوصف), the record the task is about — **Kind of record** (نوع السجل) and **Record number** (رقم السجل), both or neither — **Tags** (الوسوم) and up to five **Files** (الملفات).
7. Press **Create** (إنشاء). The task gets its number (TASK-001, TASK-002 …) and opens on its own page with "Saved.".
8. With a person chosen, the task is **Assigned** (مُسندة) at once and that person is notified. Without one it is a **Draft** (مسودة): "This task is a draft: only you can see it until you assign it."
9. To assign a draft later, open it and press **Assign** (إسناد): choose **Section** and **Assigned to** in the window "Assign TASK-001" and press **Assign**.

### Who you may assign a task to — My Tasks
The list under **Assigned to** (المكلَّف) is worked out by the system; a name that is not in it cannot be assigned, whatever is typed.
You must hold `submit` on `task`, work in the task's branch and belong to the section. The other person must be an active user who can view and work tasks and who works in the same branch. Then one of these must be true:
- **yourself** (أنت) — you may always give yourself a task.
- **reports to you** (يتبعك) — the person reports to you on their employee record, directly or through other managers.
- **your section** (قسمك) — you are the manager of the section and the person is a member of it.
- **organisation** (المؤسسة) — you hold `administer` on tasks: anybody in the branch, in any section.
Nothing else: a manager does not reach the whole company, a colleague in the same section cannot assign sideways, and nobody assigns upward to their own manager.
- "Nobody in this section is yours to assign" (لا أحد في هذا القسم يحق لك الإسناد إليه) — in that section you can only keep a draft.
- Managing a section is set by an administrator on Settings → Administration → **Department Managers** (مديرو الأقسام); who reports to whom is the manager named on each employee's record in HR. Sub-sections are not followed: managing a section does not cover the sections under it.

### How to open a task and what it shows — My Tasks
1. Press the number in **Reference** (المرجع), or follow a notification. The page is titled with the number and the title, for example "TASK-001 · Count the Erbil warehouse".
2. Header: **Reference** (المرجع); **Status** (الحالة); **Title** (العنوان); **Priority** (الأولوية); **Section** (القسم); **Assigned to** (المكلَّف); **Assigned by** (كلّف بها); **Raised by** (أنشأها); **Deadline** (الموعد النهائي); **Progress** (التقدّم); **About record** (بخصوص السجل) — a link when you may open that record; **Tags** (الوسوم); **Latest note** (آخر ملاحظة) — the reason typed with the last step; **Description** (الوصف).
3. The lines are the **Progress** (التقدّم) table — **Step** (الخطوة), **By** (بواسطة), **When** (الوقت) — one line for each step taken: Raised (أُنشئت), Assigned (أُسندت), Accepted (قُبلت), Started (بدأت), Blocked (عُطّلت), Handed in (سُلّمت), Completed (اكتملت), Cancelled (أُلغيت). Blocked is listed only while the task is blocked, and after a reassignment the lines start again from Assigned.
4. At the foot are the buttons you may press now. They depend on the status and on your part in the task; a missing button is not a fault.
5. The four icons in the title bar: printer (**Print / Export** — طباعة / تصدير), paperclip (**Attachments** — المرفقات), speech bubble (**Notes** — الملاحظات), clock (**Audit log** — سجل التدقيق).
6. Under the task is the **Watchers** (المتابعون) table.
A task past its deadline carries the line "This task is N days past its deadline."

### How to work on a task given to you and report progress — My Tasks
Needs: `execute` on `task`; only the person the task is assigned to.
1. Open the task from **My tasks**. A new task is **Assigned** (مُسندة).
2. Press **Accept** (قبول) to take it. To refuse it, type the reason in **Why you decline** (سبب الاعتذار) and press **Decline** (اعتذار); it goes back to the person who assigned it.
3. When you begin, press **Start** (بدء). The task is **In progress** (قيد التنفيذ).
4. If something stops you, type it in **What is in the way** (ما الذي يعيق العمل) and press **Block** (تعطيل). When you can go on, press **Resume** (استئناف).
5. When the work is done press **Hand in** (تسليم). The task waits for the person who assigned it, who completes it or returns it to you with a reason.
6. To say more along the way, open the speech bubble and press **Add note** (إضافة ملاحظة), attach a file with the paperclip, or press **Reply in Chat** (الرد في المحادثة).
Progress is reported by these buttons, not typed. The **Progress** (التقدّم) percentage is the stage the task has reached: 0% Draft, 10% Assigned or Declined, 25% Accepted, 50% In progress or Blocked, 90% Handed in, 100% Completed. Each step is told to the person who assigned the task, the person who raised it and the watchers, and the reason you typed shows on the task as **Latest note** (آخر ملاحظة).

### How to review, return, reassign or cancel a task — My Tasks
Needs: `submit` on `task`, as the person who assigned the task; or `administer` on `task`.
1. A task handed in shows under **Assigned by me** with the filter **Waiting for review** (بانتظار المراجعة). Open it.
2. If the work is good press **Complete** (إكمال). The task is **Completed** (مكتملة) and final.
3. If it needs more, type what in **What needs more work** (ما الذي يحتاج مزيداً من العمل) and press **Return for rework** (إعادة للتعديل). It goes back to **In progress** (قيد التنفيذ) with the same person.
4. To give it to somebody else press **Reassign** (إعادة إسناد): in the window "Reassign TASK-001" choose **Section** (القسم) and **Assigned to** (المكلَّف), type **Why it moves** (سبب النقل) — required; "The new person and the people who watch it are told." — and press **Reassign**. This is possible while the task is Assigned, Accepted, In progress, Blocked or Declined; the new person starts from Assigned.
5. To stop a task type the reason in **Why it is cancelled** (سبب الإلغاء) and press **Cancel task** (إلغاء المهمة). The person who raised it or assigned it can cancel it at any time before it is completed. Cancelled is final.
6. To change what a task says press **Edit** (تعديل): Title, Priority, Deadline, Description, the record it is about and Tags, then **Save** (حفظ). A draft is edited by the person who raised it; later by the person who raised or assigned it, or an administrator. The section and the person are changed with Reassign, not here.
A task is never deleted. A completed or cancelled task cannot be changed or reopened; raise a new one.

### How to discuss a task, add watchers, notes and files — My Tasks
1. **Reply in Chat** (الرد في المحادثة) opens Chat on the conversation about this task with the other person on it — the person it is assigned to, or the one who assigned or raised it — and fills the message box with "About TASK-001 — <title>: ". Nothing is sent until you press Send. The button shows when you may write in Chat and somebody other than you is on the task.
2. **Watchers** (المتابعون): people who follow the task without working on it. They can open it and are notified of its steps; they get no buttons. While the task is not finished, the person who raised it, assigned it or is working on it (or an administrator) chooses a name in **Add a watcher** (إضافة متابع) and presses **Add** (إضافة), or presses **Remove** (إزالة) on a row. Offered are active people who can view tasks in the task's branch. At most ten.
3. **Notes** (speech bubble): anybody who can open the task may add a note; notes are dated, signed and never edited.
4. **Files** (paperclip): while the task is not completed or cancelled, press **Choose a file** (اختر ملفاً) then **Attach** (إرفاق) — up to 25 MB, the usual rules. If QS Cloud Files is switched on, the same window has the **QS Cloud Files** panel to link cloud files to the task.
5. **Printer**: a copy of the task in English or Arabic, as PDF, Excel or Word.
6. **Clock**: every step, who took it, when and with what reason.

### Fields — My Tasks
- **Title** (العنوان) — required; 3 to 200 characters.
- **Section** (القسم) — required; the sections you belong to (all active sections if you administer tasks).
- **Assigned to** (المكلَّف) — optional on a new task (empty keeps a draft), required when assigning or reassigning; only people you may assign to in that section.
- **Priority** (الأولوية) — Low (منخفضة), Normal (عادية), High (عالية), Urgent (عاجلة); opens on Normal.
- **Deadline** (الموعد النهائي) — optional date; today or later when it is set or changed.
- **Description** (الوصف) — optional; up to 4,000 characters.
- **Kind of record** (نوع السجل) — optional; first choice **Not about a record** (لا تخص سجلاً). The kinds you may view are listed by their English names in both languages (Purchase Invoices, Sales Invoices, Journal Entries, Projects …); customers and suppliers are not offered.
- **Record number** (رقم السجل) — "The number you know the record by; you must be able to open it yourself." Typed exactly as printed on the record. Kind and number go together.
- **Tags** (الوسوم) — optional; "Up to eight, separated by commas."; each up to 30 characters.
- **Files** (الملفات) — optional; "Up to five files; more can be added on the task."
- Reason boxes — **Why you decline** (سبب الاعتذار), **What is in the way** (ما الذي يعيق العمل), **What needs more work** (ما الذي يحتاج مزيداً من العمل), **Why it is cancelled** (سبب الإلغاء), **Why it moves** (سبب النقل): each required for its step, up to 1,000 characters.
- Filters on the list: **View** (العرض) and **Show** (عرض) — see "How to read the list".

### Statuses — My Tasks
A status changes only by a button on the task's page.
- **Draft** (مسودة) — raised, not given to anybody. Only the person who raised it sees it. Next: **Assign** (إسناد) by that person → Assigned; or Cancel task.
- **Assigned** (مُسندة) — waiting for the person it was given to: **Accept** (قبول) → Accepted, or **Decline** (اعتذار) with a reason → Declined.
- **Accepted** (مقبولة) — taken, not begun. The same person: **Start** (بدء) → In progress.
- **In progress** (قيد التنفيذ) — being worked on. The same person: **Block** (تعطيل) with a reason → Blocked, or **Hand in** (تسليم) → Handed in.
- **Blocked** (معطّلة) — stopped by something. The same person: **Resume** (استئناف) → In progress.
- **Handed in** (مُسلَّمة للمراجعة) — waiting for review by the person who assigned it (or an administrator): **Complete** (إكمال) → Completed, or **Return for rework** (إعادة للتعديل) with a reason → In progress.
- **Declined** (معتذَر عنها) — refused by the person it was given to. The person who assigned it: **Reassign** (إعادة إسناد) → Assigned, or Cancel task.
- **Completed** (مكتملة) — accepted as done. Final.
- **Cancelled** (ملغاة) — stopped with a reason by the person who raised or assigned it. Final.
**Reassign** is open to the person who assigned the task (or an administrator) from Assigned, Accepted, In progress, Blocked and Declined. An administrator stands in for the person who assigned, never for the person doing the work.
A deadline counts only while work is owed (Assigned, Accepted, In progress, Blocked): a task handed in, completed, cancelled, declined or still a draft is never "overdue".

### Who sees a task — My Tasks
- A **Draft** is seen by the person who raised it and by nobody else — not a manager, not an administrator.
- Any other task is seen by the person who raised it, the person who assigned it, the person it is assigned to and its watchers, wherever they work.
- It is also seen, by people who can view tasks and work in the task's branch: the manager of the task's section, anybody the assigned person reports to, and a holder of `administer` on tasks.
- Nobody else. A task you may not see is simply not there: the list does not show it, search does not find it, and its address answers "That page does not exist".
- When a task is reassigned, the person it was taken from no longer sees it (unless they also raised it, assigned it or watch it) and is not notified.
- The record a task is about is linked only for a reader who may open that record; others see its number as plain text.

### What happens next — My Tasks
Each step raises a notification in the bell, under Tasks, to the people it concerns — never to the person who took the step, and only to people who can open the task.
- Assigned: the person it is given to and the watchers.
- Accepted, Declined, Started, Blocked, Resumed, Handed in: the person who assigned it, the person who raised it and the watchers.
- Returned for rework: the person working on it.
- Completed, Cancelled: the person it was assigned to and the watchers.
- Reassigned: the new person and the watchers.
- Edited — the title, description, priority or deadline of a task that is no longer a draft: the person it is assigned to and the watchers.
- Every morning the system checks deadlines. The person assigned is reminded when the deadline comes within three days and again on the day; once it has passed, that person and the person who assigned it are told the first morning and then once a week while it stays late. Moving the deadline starts the reminders again.
- Every step, with its reason, is in the task's audit log (the clock) and on its **Progress** table.
- Open, overdue and blocked tasks also feed the Dashboard and the Exceptions screen.

### What the Task Center does not do — My Tasks
- No sub-tasks, no repeating tasks, no time tracking, and no percentage to type: progress is the stage of the task.
- A task has one person assigned at a time, not a group.
- A task cannot be deleted or reopened. Cancel it with a reason, or raise a new one.
- A draft cannot be handed to somebody else to assign: only the person who raised it assigns or cancels it.
- Customers and suppliers cannot be chosen as the record a task is about.
- The kinds of record in **Kind of record** are named in English on the Arabic screen too.
- Managing a section does not extend to its sub-sections.
- The person a task was taken from on reassignment is not told.
- There is no e-mail for a task; the notifications are inside the system.

### Refusals when raising, editing or assigning a task — My Tasks
The reason follows "That could not be saved." on the list or on the task; after a refused New task the window opens again.
- "Give the task a title of at least 3 characters." / "A title is at most 200 characters." / "A description is at most 4000 characters."
- "The deadline 2026-10-01 has already passed; choose today or a later day."
- "A task carries at most 8 tags." / "A tag is at most 30 characters."
- "Choose one of your own sections for the task." — you do not belong to that section.
- "Choose who TASK-001 is for." — Assign and Reassign need a person.
- "<name> is outside the people you may assign to in this section. Choose someone from the list." — see "Who you may assign a task to".
- "TASK-001 is already with that person; choose somebody else."
- "Name the kind of record and its number, or neither."
- "There is no purchase order 'PO-HQ-2026-000009' that you may open." — the number is not typed as printed, or the record is not yours to open.
- "A task cannot be related to itself."
- "At most 5 files go with a new task; add the rest on its page."
- "<file> was not accepted: …" — a file broke the paperclip's rules (over 25 MB, a program or an archive, name and content disagree, empty); the task is not created.
- "Only the person who raised a draft changes it." / "Only the person who raised or assigned TASK-001 (or an administrator) changes what it says."
- "TASK-001 is completed and is final." / "TASK-001 is cancelled and is final." — a finished task is not edited.
- "Permission denied: 'submit' on 'task' is not granted to this user." — you may not assign; ask an administrator or a manager. The same sentence with 'create', 'edit_draft' or 'execute' names the permission you lack.

### Refusals — My Tasks
The reason follows "That could not be saved." on the task's page.
- "Say why before the task is rejected." (Decline) / "Say why before the task is blocked." / "…returned." / "…reassigned." / "…cancelled." — type the reason first.
- "Keep the reason to 1000 characters."
- "TASK-001 is completed; it cannot be started." — the step does not fit the status, usually because somebody moved the task while your page was open. Refresh the page. The status is named by its code (in_progress, submitted, rejected …).
- "Only the person it is assigned to can accept TASK-001." — the same for reject, start, block, resume and submit.
- "Only the person who assigned it (or an administrator) can complete TASK-001." — the same for return and reassign.
- "Only the person who raised the draft can assign TASK-001."
- "Only the person who raised or assigned it (or an administrator) can cancel TASK-001."
- "Only the people on TASK-001 choose who watches it." / "A task has at most 10 watchers." / "Choose the person who should watch it." / "TASK-001: a watcher must be somebody who can open the task."
- "TASK-001 has nobody else on it to talk to yet." — Reply in Chat on a task with nobody else on it.
- "A note says something. Write what is happening with this record." / "A note is at most 2,000 characters. Attach a longer text as a file." — from the Notes icon.
- "Not available to you" — you hold no `view` on tasks; ask an administrator.
- "That page does not exist" — the task number is wrong, or the task is not one you may see (a colleague's draft, a task you are not part of).

## Document Centre (مركز المستندات)
Path: Documents → Documents & Tasks → Document Centre   |   Arabic: المستندات ← المستندات والمهام ← مركز المستندات
Address: /documents
Needs: `view` on `cloud_files` to open the screen and to see the QS Cloud Files panel on a record; `create` on `cloud_files` to upload, make folders, link and unlink. Three more things must be true: an administrator has switched QS Cloud Files on (Cloud Files Settings); you have linked your own Cloud Files account; and, for anything about a record, you may open that record. As delivered, the roles that may use the paperclip have the Document Centre; a role without the attachments permission (the project manager, as delivered) has none until an administrator grants it.
What it is for: The Document Center — the system's window onto QS Cloud Files, the company's cloud file store: "Your files in QS Cloud Files, linked to the records they belong to." You browse, search, download, preview, upload, make folders, and link a cloud file to the record it belongs to. Nothing is copied into the system: the files stay in the cloud, and what you see there is exactly what the cloud lets your own account see.

### How to link your Cloud Files account — Document Centre
Needs: `view` on `cloud_files`, and a user name and password of your own in QS Cloud Files.
1. Open Documents → Documents & Tasks → Document Centre. The first time it says **Link your Cloud Files account** (اربط حسابك في Cloud Files): "Qimah opens your files as you, with an app password that you approve in Cloud Files. It is stored encrypted, is never shown again, and you can revoke it whenever you wish."
2. Press **Link my account** (ربط حسابي). The page now says "Waiting for your approval in Cloud Files" (بانتظار موافقتك في Cloud Files) and when the request expires — twenty minutes from now.
3. Press **Open Cloud Files** (فتح Cloud Files). The cloud's own page opens in a new tab. Sign in there if asked and press Grant access.
4. Come back to the system's tab. It continues by itself within a few seconds; or press **Check now** (تحقق الآن).
5. The folder list appears, and the toolbar says "Connected as <your name>" (متصل باسم …).
- "Cloud Files has not received your approval yet." (لم يستلم Cloud Files موافقتك بعد.) — finish step 3, then **Check now** again.
- "That sign-in request expired. Start again." (انتهت صلاحية طلب تسجيل الدخول. ابدأ من جديد.) — press **Link my account** again.
- **Cancel** (إلغاء) drops the request.
You link once; the link stays until you unlink, your account is deactivated, or the cloud stops accepting it. The system never asks for your cloud password itself.

### How to unlink or link again — Document Centre
1. **Unlink**: press **Unlink** (إلغاء الربط) in the toolbar, beside "Connected as …". It acts at once, without asking. The stored app password is deleted here and cancelled in the cloud; your files and the links on records stay as they are.
2. If the cloud could not be told, the page says **Account unlinked** (أُلغي ربط الحساب): "Your account was unlinked here, but Cloud Files could not be told to delete the app password. Remove it in Cloud Files under Settings, Security."
3. **Link again**: when the page says "Your Cloud Files link is no longer valid" (ربطك بـ Cloud Files لم يعد صالحًا) — "Cloud Files no longer accepts the app password Qimah holds for you (it was revoked there, or the server's key changed). Link your account again to continue." — press **Link my account again** (ربط حسابي من جديد) and follow the linking steps. **Unlink** on the same page removes the stale link instead.
- Everybody must link again after an administrator changes the address of Cloud Files.
- When an administrator deactivates a user, that user's link is removed and cancelled in the cloud automatically.
- There is no panel for this on My profile: linking and unlinking are done here.

### How to browse, search and filter — Document Centre
1. The list opens in the folder the administrator set as the start. The title is the open folder's name (**Document Centre** at the start) and the trail above it leads back up.
2. Press a folder's name to enter it. Folders are always listed before files.
3. Type in **Search this folder** (ابحث في هذا المجلد) and press Enter to keep the rows whose name contains the words. It searches the open folder only — not the folders inside it and not what is written in the files.
4. Filters, then **Apply** (تطبيق): **Show** (عرض) — Everything (الكل), Folders (المجلدات), PDF files (ملفات PDF), Images (الصور), Spreadsheets (جداول البيانات), Documents (المستندات — Word files, presentations and text), Linked to a record (مرتبط بسجل); **Sort by** (ترتيب حسب) — Name (الاسم), Modified (آخر تعديل), Size (الحجم); **Order** (الاتجاه) — Ascending (تصاعدي), Descending (تنازلي).
5. Fifty rows a page.
- You see only what the cloud shows your account: your own files and the folders shared with you. A colleague can see a different list in the same place.
- "Nothing is in your Cloud Files here yet. Upload a file or make a folder to begin." / "This folder is empty." (هذا المجلد فارغ.) / "No file in this folder matches." (لا يوجد ملف في هذا المجلد يطابق البحث.)
- The page shows no storage space used or left; look in Cloud Files itself for that.

### How to download, preview or open a file — Document Centre
1. **Download** (تنزيل) on a file's row — or pressing the file's name — saves the file to your computer.
2. **Preview** (معاينة) opens a picture of the file in a new tab. It is offered only where the cloud has a preview — normally images and PDFs. Word, Excel and PowerPoint files have none: download them or open them in Cloud Files.
3. **Open in Cloud Files** (فتح في Cloud Files) opens the file or folder in the cloud's own site in a new tab, where you can edit, rename, move, share or delete it with the rights you have there.
- Every download and preview is fetched by the system as you, so a file the cloud does not show you cannot be reached by guessing its address: the answer is "not found".
- Downloads and previews are written to the audit trail.

### How to upload files — Document Centre
Needs: `create` on `cloud_files`, and the right in the cloud to add to that folder.
1. Open the folder the files belong in.
2. Press **Upload files** (رفع ملفات). The window "Upload to <folder>" opens. The button is missing in a folder shared with you read-only.
3. Press **Choose files** (اختر ملفات) and pick one or several. Each is listed "Ready to upload" (جاهز للرفع).
4. Press **Upload** (رفع). Each file shows "Uploading, N%" and then "Uploaded to Cloud Files" (تم الرفع إلى Cloud Files), or "Not uploaded: <reason>" (لم يُرفع: …) with **Try again** (حاول مرة أخرى).
5. When all are through it says "Done. The list shows what Cloud Files now holds." Close the window; the files are in the list.
- "A file is shown as uploaded only after Cloud Files has confirmed it. Nothing is replaced; programs are refused."
- Up to 200 MB a file. A file with a name already in the folder is refused, never overwritten — rename it first. Programs, scripts and archives (.exe, .bat, .zip, .rar, .7z …) and empty files are refused.
- A file uploaded here is linked to no record. To file it against a record, link it afterwards, or upload it from the record's paperclip instead.

### How to make a new folder — Document Centre
Needs: `create` on `cloud_files`, and the right in the cloud to make folders there.
1. Open the folder the new one goes in and press **New folder** (مجلد جديد). The window "New folder in <folder>" opens.
2. Type the **Folder name** (اسم المجلد) — required, up to 255 characters. It cannot contain \ / < > : " | ? * , begin or end with a space, or end with a dot.
3. Leave **Share with the groups mapped to ERP roles** (مشاركة مع المجموعات المرتبطة بأدوار النظام) ticked if the colleagues whose roles the administrator mapped should see the folder; untick it to make the folder without sharing it. The box is shown only when roles have been mapped (it reads "group" when there is one).
4. Press **Create folder** (إنشاء المجلد). "Saved." and the folder is in the list.
A folder cannot be renamed, moved or deleted from the system; press **Open in Cloud Files** and do it there.

### How to link a file to a record — Document Centre
Needs: `create` on `cloud_files`; you must be able to open the record.
From the Document Centre:
1. On the file's (or folder's) row press **Link to record** (ربط بسجل). A form "Link <name> to a record" opens above the list.
2. Choose the **Kind of record** (نوع السجل) — see "Fields — Document Centre" for the kinds.
3. Type the **Record number** (رقم السجل) exactly as printed: "The number shown on the record, for example the invoice number."
4. Press **Link** (ربط). "Saved."; the record's number now shows in the file's **Linked to** (مرتبط بـ) column and is a link to the record.
From the record:
1. Open the record, press the paperclip, and in the **QS Cloud Files** panel press **Link a file from Cloud Files** (ربط ملف من Cloud Files).
2. The Document Centre opens with the note "Choose a file to link to <kind> <number>." Browse to the file.
3. Press **Link to this record** (ربط بهذا السجل). You are back on the record with the file listed. **Back to the record** (العودة إلى السجل) returns without linking.
- A file can be linked to several records, and a record can have many files.
- A link copies nothing: it points at the cloud's file. If the file is renamed or moved in the cloud the link follows it.
- People who have acted on the record and can open it are told "A file was linked to <number>".

### How to use the QS Cloud Files panel under a record's paperclip — Document Centre
Needs: `view` on `cloud_files` to see the panel, `create` to change it; Cloud Files switched on; and the right to open the record.
1. Open a record and press the paperclip. Under the system's own attachments is the panel **QS Cloud Files**. The number on the paperclip counts both.
2. Each linked file shows its name, size, "linked by <name>" (ربطه …), when, and **Open in Cloud Files** (فتح في Cloud Files). Press the name to download it; a linked folder opens in the Document Centre.
3. To add a file from your computer: **Choose files** (اختر ملفات), then **Upload** (رفع). "The file goes into this record's folder in Cloud Files and is linked to the record." The folder is made if it is not there.
4. **Link a file from Cloud Files** (ربط ملف من Cloud Files) picks a file that is already in the cloud.
5. **Create the record's folder** (إنشاء مجلد السجل) makes the record's own folder — record folder / kind / number, for example /Qimah/Purchase Invoices/PUR-HQ-2026-000004 — shares it with the cloud groups of the roles that may open that kind of record, and links it. The button is offered until the record has a folder linked.
6. To end a link type the reason in **Reason for unlinking <name>** (سبب إلغاء ربط <name>) and press **Unlink** (إلغاء الربط). The file stays in the cloud; only the link ends, and the reason is kept in the record's history.
- "Not available to you in Cloud Files" (غير متاح لك في Cloud Files) — a file is linked, but the cloud does not show it to your account (not shared with you, or deleted there). Its name is not given.
- "Link your account to see this file" (اربط حسابك لترى هذا الملف) — you have not linked your Cloud Files account.
- "No Cloud Files are linked to this record yet." (لا توجد ملفات من Cloud Files مرتبطة بهذا السجل بعد.)
The panel is absent when Cloud Files is switched off, when you hold no `view` on `cloud_files`, or on a kind of record that does not take cloud files.

### Fields — Document Centre
Columns of the list:
- **Name** (الاسم) — the file or folder; press a folder to enter it, a file to download it.
- **Type** (النوع) — Folder (مجلد), PDF, Image (صورة), Spreadsheet (جدول بيانات), Document (مستند), Presentation (عرض تقديمي), Text (نص) or File (ملف).
- **Size** (الحجم) and **Modified** (آخر تعديل) — as the cloud reports them.
- **Linked to** (مرتبط بـ) — the numbers of the records the file is linked to, each a link; only records you may open are shown.
- **Actions** (الإجراءات) — **Download** (تنزيل), **Preview** (معاينة), **Open in Cloud Files** (فتح في Cloud Files), **Link to record** (ربط بسجل).
The link form:
- **Kind of record** (نوع السجل) — required. The kinds you may view, among: Purchase invoice (فاتورة شراء), Purchase order (أمر شراء), Goods receipt (استلام بضاعة), Goods return (مرتجع بضاعة), Supplier payment (دفعة مورد), Supplier advance (دفعة مقدمة لمورد), Payment application (طلب سداد), Import application (طلب استيراد), Bill of lading (بوليصة شحن), Container (حاوية), Customs PD (بيان جمركي), Customs declaration (تصريح جمركي), Sales invoice (فاتورة مبيعات), Customer receipt (سند قبض من عميل), Sales return (مرتجع مبيعات), Bank loan (قرض مصرفي), Journal entry (قيد يومية), Employee (موظف), Project (مشروع), Customer (عميل), Supplier (مورد). Tasks and exceptions can be linked too, but at present they appear in this list as a code (cloudFiles.record_task, cloudFiles.record_exception) instead of a name.
- **Record number** (رقم السجل) — required; the number printed on the record (for a customer, supplier or project, its code), typed exactly.
Other fields:
- **Folder name** (اسم المجلد) — required for a new folder.
- **Reason for unlinking <name>** (سبب إلغاء ربط <name>) — required to end a link.
- Filters **Show** (عرض), **Sort by** (ترتيب حسب), **Order** (الاتجاه) — see "How to browse, search and filter".

### Statuses — Document Centre
The screen is always in one of these states, and says which:
- **This integration is not configured** (هذا التكامل غير مُهيأ) — "QS Cloud Files has not been switched on for this company. Ask an administrator to connect it." Nothing works until an administrator switches it on in Cloud Files Settings; a person who may open those settings sees the button **Open Cloud Files settings** (فتح إعدادات Cloud Files).
- **Link your Cloud Files account** (اربط حسابك في Cloud Files) — it is on, but you have not linked. Press **Link my account** (ربط حسابي).
- **Waiting for your approval in Cloud Files** (بانتظار موافقتك في Cloud Files) — you started linking and have not yet pressed Grant access in the cloud. The request lasts twenty minutes.
- **Your Cloud Files link is no longer valid** (ربطك بـ Cloud Files لم يعد صالحًا) — the cloud refuses the stored app password, or the address changed. Press **Link my account again** (ربط حسابي من جديد).
- Connected — the folder list, with "Connected as <name>" in the toolbar.
- **Cloud Files cannot be reached** (تعذّر الوصول إلى Cloud Files) — "The server did not answer. Nothing shown here is out of date; try again in a moment." The system never shows an old copy of the list.
- **Folder not available** (المجلد غير متاح) — "That folder does not exist, or Cloud Files does not show it to you." Press **Back to the start** (العودة إلى البداية).
A link between a file and a record is either live or ended. An ended link (unlinked with a reason) is kept in the record's history and never deleted.

### What happens next — Document Centre
- An upload or a new folder is reported only after the cloud has confirmed it; the list is then read again from the cloud.
- A linked file shows on the record under the paperclip, in the **QS Cloud Files** panel, and the record's number shows beside the file here.
- Whether a colleague can open a linked file is decided by the cloud, not by the link: the file must be theirs or shared with them. To share a record's files with the people who work on that kind of record, use **Create the record's folder** and keep the files in it.
- A folder made from the system is shared with the cloud groups the administrator mapped to roles, with the rights set in Cloud Files Settings at that moment. A later change of the mapping does not re-share folders already made.
- Uploads, new folders, links, unlinks, downloads and previews are written to the audit trail; linking and unlinking also show in the record's own history.
- Removing a file in the cloud does not remove its link: the record then shows "Not available to you in Cloud Files".

### What the Document Centre does not do — Document Centre
- It does not store files. The system's own attachments (the upper part of the paperclip window) remain a separate place; a file attached there is not in the cloud, and a cloud file is not an attachment.
- No renaming, moving, deleting or sharing of a file from the system — do that in Cloud Files.
- No search across folders and none inside files; the search box looks at names in the open folder.
- No preview of Office files.
- No storage figures, recent activity or version history.
- A cloud folder is not divided by branch: who sees which files is decided by sharing and groups in the cloud.
- A file over 200 MB cannot be uploaded from the system, and an upload that breaks off starts again from the beginning.
- It works only after an administrator has switched it on and you have linked your own account. Nobody can browse on your behalf, and you cannot use a colleague's link.

### Refusals when uploading — Document Centre
The reason shows beside the file as "Not uploaded: <reason>" (لم يُرفع: …), with **Try again** (حاول مرة أخرى). Nothing is ever half-uploaded: a file is either confirmed by the cloud or not there.
- "<file> was not accepted: it is empty."
- "<file> was not accepted: it is 250 MB; the limit is 200 MB." / "<file> was not accepted: it is larger than 200 MB."
- "<file> was not accepted: files ending .zip are not accepted." — the same for .exe, .dll, .bat, .cmd, .com, .scr, .ps1, .sh, .jar, .msi, .7z and .rar.
- "<file> was not accepted: its content is a Windows executable. Renaming it does not change what it is."
- "<file> was not uploaded: a file with that name is already there, or the folder is not." — rename the file and upload again; nothing is overwritten.
- "Cloud Files did not confirm the upload, so it is not counted as uploaded. Try again."
- "Cloud Files refused the file because it is too large." / "Cloud Files has no room left for that file." — the cloud's own limits; ask whoever runs Cloud Files.
- "Cloud Files does not allow that for this account." — your cloud account may not add files to that folder.
- "Link your Cloud Files account first." / "Cloud Files no longer accepts your account. Link it again." / "QS Cloud Files is not configured."
- "You cannot add files to that record." — from a record's paperclip: the record is not yours to open.
- "You do not have permission to add files." — you hold no `create` on `cloud_files`.
- "Your session has ended. Sign in again."
- "The connection failed before Cloud Files confirmed the file." (انقطع الاتصال قبل أن يؤكد Cloud Files استلام الملف.) — the connection dropped; press **Try again**. If files larger than about 25 MB always end this way, the server in front of the system is still limiting uploads: tell your administrator.

### Refusals — Document Centre
- "Not available to you" — you hold no `view` on `cloud_files`; ask an administrator.
- "This integration is not configured." — QS Cloud Files is not switched on; ask an administrator.
- "Link your Cloud Files account to continue." — link your account, then repeat what you were doing.
- "Your Cloud Files link is no longer valid. Link your account again."
- "server key: ERP_SECRET_KEY is not set on this server. Ask your administrator." — nobody can link until the server is set up; pass the sentence on.
- "Cloud Files did not open your folder with the new app password." — the linking was undone; start it again, and tell an administrator if it repeats.
- "You cannot link files to that record." — no record has that number as typed, or it is not yours to open (the answer is the same for both). Check the kind and the number.
- "That file is not available to you in Cloud Files." / "That file has no identifier in Cloud Files, so it cannot be linked."
- "That link no longer exists." / "You cannot change the files linked to that record." / "reason: is required to unlink a file"
- "name: is already taken in this folder, or the folder is not there any more" — choose another folder name.
- "name: A name cannot contain any of \ / < > : " | ? *" / "name: A name cannot begin or end with a space." / "name: A name cannot end with a dot." / "name: A name is at most 255 characters."
- "Cloud Files does not allow that for this account." — your cloud account has no right to do that in that folder.
- "Cloud Files cannot be reached." / "Cloud Files did not answer in time." / "Cloud Files answered with an error. Try again shortly." — try again in a moment; nothing was changed.
- "The folder the Document Center starts in does not exist for you in Cloud Files. Ask an administrator to check the settings."
- "Permission denied: 'create' on 'cloud_files' is not granted to this user." — you may look but not upload, make folders or link.

## Cloud Files Settings (إعدادات Cloud Files)
Path: Settings → Administration → Cloud Files Settings   |   Arabic: الإعدادات ← الإدارة ← إعدادات Cloud Files
Address: /administration/cloud-files
Needs: `view` on `cloud_setting` to open the screen; `configure` on `cloud_setting` to change anything on it (Save, Test the address, Map a role, Deactivate, Switch back on). As delivered: the roles that could configure attachments, the CEO and the system administrator.
What it is for: Switching QS Cloud Files on or off for the whole company, saying where the cloud server is, where the Document Centre starts and where record folders are made, and mapping the system's roles to the cloud's groups: "Switch QS Cloud Files on, say where it is, and map ERP roles to its groups." No password is typed here; each person links their own cloud account in the Document Centre.

### How to switch QS Cloud Files on — Cloud Files Settings
Needs: `configure` on `cloud_setting`.
1. Open Settings → Administration → Cloud Files Settings. The panel **Connection** (الاتصال) holds the settings.
2. Type the **Address of Cloud Files** (عنوان Cloud Files) — "Where Nextcloud is, for example https://files.qs-groups.com. Must be https."
3. Press **Test the address** (اختبار العنوان). A green band answers "Cloud Files answered (version …)." The test saves nothing.
4. Set **Document Center starts in** (يبدأ مركز المستندات من) — "A folder of each person's own Cloud Files. / is the whole of it."
5. Set **Record folders are made in** (تُنشأ مجلدات السجلات في) — "Inside the folder above. A record's folder is this folder / kind / number." It opens on /Qimah.
6. Tick **Cloud Files is switched on** (Cloud Files مُفعّل).
7. Press **Save** (حفظ). "Saved.", and the line "Settings last changed <time>." is updated.
8. Map the roles to cloud groups (next task), then tell people to open the Document Centre and press **Link my account**.
If a red band **Server key missing** (مفتاح الخادم غير مضبوط) is shown, Cloud Files cannot be switched on and nobody can link until whoever looks after the server sets the key it names; that is done on the server, not on this screen.

### How to switch it off or change the address — Cloud Files Settings
Needs: `configure` on `cloud_setting`.
1. To switch off, untick **Cloud Files is switched on** (Cloud Files مُفعّل) and press **Save** (حفظ).
2. Within about ten seconds the Document Centre says "This integration is not configured" for everybody and the QS Cloud Files panel disappears from every paperclip. Nothing is deleted: the files are in the cloud, and the links and people's linked accounts are kept for when it is switched on again.
3. To change the address, type the new one, press **Test the address** (اختبار العنوان), then **Save** (حفظ). Every person's link was made with the old address, so each of them is asked to link again.
4. Changing **Document Center starts in** moves where everybody's list begins; a person who has no such folder in their own cloud files is told the start folder does not exist for them.
A person who may open the screen but not change it sees the same values as plain text, without the buttons.

### How to map a role to a Cloud Files group — Cloud Files Settings
Needs: `configure` on `cloud_setting`. The group must already exist in Cloud Files.
1. Press **Map a role** (ربط دور) at the top of the screen.
2. Choose the **ERP role** (دور النظام).
3. Type the **Cloud Files group** (مجموعة Cloud Files) — "The group's name exactly as it is in Cloud Files."
4. Tick **Members may add and change files** (يحق للأعضاء إضافة الملفات وتعديلها) and **Members may share further** (يحق للأعضاء المشاركة مع آخرين) as needed; with neither, the group only reads.
5. Press **Save** (حفظ). The role appears in the table **ERP roles and Cloud Files groups** (أدوار النظام ومجموعات Cloud Files).
6. To change a mapping, map the same role again; the new values take the old ones' place. A role has one mapping.
7. To stop one, type the **Reason** (السبب) on its row and press **Deactivate** (إلغاء التفعيل). It stays in the table as Inactive (غير نشط) with the reason; **Switch back on** (إعادة التفعيل) restores it. A mapping is never deleted.
What a mapping does: "A folder made from the ERP is shared with the group of each role that may open the record, at the rights shown here." A record's folder is shared with the groups of the roles that may view that kind of record; a folder made in the Document Centre with the share box ticked is shared with every active mapped group. Putting people into the groups is done in Cloud Files itself.

### Fields — Cloud Files Settings
Panel **Connection** (الاتصال):
- **Address of Cloud Files** (عنوان Cloud Files) — required to switch on; a web address starting https://, with no user name, password or question mark in it.
- **Document Center starts in** (يبدأ مركز المستندات من) — required; a folder path with / between folders; / means the whole of each person's cloud files. People cannot browse above it.
- **Record folders are made in** (تُنشأ مجلدات السجلات في) — required; a folder inside the start folder, never / itself. Opens on /Qimah.
- **Cloud Files is switched on** (Cloud Files مُفعّل) — the on/off switch for the whole company.
Window **Map a role** (ربط دور):
- **ERP role** (دور النظام) — required; every role of the system is offered.
- **Cloud Files group** (مجموعة Cloud Files) — required; up to 64 characters.
- **Members may add and change files** (يحق للأعضاء إضافة الملفات وتعديلها) — optional tick; without it the group only reads, with it the group may add, change and delete files in the folder.
- **Members may share further** (يحق للأعضاء المشاركة مع آخرين) — optional tick; lets the group pass the folder on to others.
Table **ERP roles and Cloud Files groups** (أدوار النظام ومجموعات Cloud Files):
- **Role** (الدور), **Group** (المجموعة), **Write** (الكتابة) and **Share** (المشاركة) — Yes (نعم) or No (لا), **Active** (نشط) — Active (نشط) or Inactive (غير نشط) with the reason, **Actions** (الإجراءات) — **Deactivate** (إلغاء التفعيل) with its **Reason** (السبب), or **Switch back on** (إعادة التفعيل).
At the bottom of the page is the audit log of the settings: who changed what, and when.

### After you save — Cloud Files Settings
- Saving the connection applies to everybody within about ten seconds. No file is touched.
- Switching on does not connect anybody: each person must still press **Link my account** in the Document Centre once.
- A mapping is used from the next folder made from the system. Folders made earlier keep the sharing they were given; change those in Cloud Files.
- "No role is mapped to a group yet. Folders made from the ERP are then not shared with anyone." — until a role is mapped, a record's folder is shared with nobody by the system, and colleagues who cannot see it in the cloud read "Not available to you in Cloud Files" on its files.
- A mapping to a group that does not exist in Cloud Files shares nothing; the folder is still made. Check the group's spelling.
- Every change here is written to the audit log shown at the bottom of the page.

### Refusals — Cloud Files Settings
- "Not available to you" — you hold no `view` on `cloud_setting`.
- "Permission denied: 'configure' on 'cloud_setting' is not granted to this user." — you may look but not change.
- "address: is required to switch Cloud Files on"
- "address: The address is not a web address (for example https://files.example.com)."
- "address: The address must start with https:// (plain http is only accepted for this machine)." / "address: must start with https:// on a live server"
- "address: The address cannot carry a user name or password." / "address: The address cannot carry a query or a fragment."
- "server key: ERP_SECRET_KEY is not set on this server. Cloud Files cannot keep anyone's app password until it is set." (or "ERP_SECRET_KEY must be at least 32 characters. …") — the server is missing its key; pass the sentence to whoever looks after the server.
- "record folders: must be a folder inside the Document Center folder"
- "folder: A path uses / between folders." / "folder: A path cannot contain . or .. segments." / "folder: A folder name cannot begin or end with a space."
- "group: A Cloud Files group is required." / "group: A group name is at most 64 characters."
- "role: is not a role of this system" / "role: has no mapping"
- "reason: is required to switch a mapping off"
- After **Test the address**, under "Cloud Files did not answer as expected" (لم يستجب Cloud Files كما هو متوقع): "That address did not answer like Cloud Files." / "Cloud Files is in maintenance mode." / "That address is not an installed Cloud Files." / "Cloud Files cannot be reached." / "Cloud Files did not answer in time." — check the address; ask whoever runs the cloud server whether it is up.
