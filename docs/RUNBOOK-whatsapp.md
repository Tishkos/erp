# Runbook — the WhatsApp bridge (REQ-WA-001)

The bridge is a separate process beside the application. It holds one
WhatsApp session on the company's own number (never a person's — W-R6),
delivers the `whatsapp` notification channel, and answers the CEO's
questions read-only. Everything it is told, and everything it says, is on
the WhatsApp screen (`Administration → WhatsApp`) and in the audit trail.

## 1. Before the first start

1. **A dedicated SIM** in a phone the company controls (D-WA-1). WhatsApp
   must be installed and registered on it; the bridge pairs as a *linked
   device* of that phone.
2. On the host that will run the bridge (the owner's laptop for the pilot,
   the VPS for production — D-WA-6): the repository, `npm ci`, and a `.env`
   with `DATABASE_URL` (the application role, exactly as the app uses).
   Optional: `ANTHROPIC_API_KEY`, which lets the router model fill the gaps
   the phrase patterns leave (`.env.example`). Without it the bot still
   answers every catalogue phrase.
3. On the WhatsApp screen: add the CEO as a contact — the user, the number
   in international form (`+9647…`), *Notifications*, *Questions*. Questions
   can only be ticked for a user who holds the CEO role (D-WA-3). Add anyone
   else who should receive notifications (notifications only).
4. On the same screen, under *Notifications that reach a phone*: turn the
   WhatsApp channel on for the rules that should reach a phone. Two CEO
   rules ship with it on (an escalated stop, a supplier payment made).

## 2. Pairing (the QR code)

```
npm run whatsapp-bridge
```

The first start prints a QR code in the terminal. On the company phone:
WhatsApp → Linked devices → Link a device → scan. The log then says
`connected as <number>` and the screen's *Bridge* window shows *Paired: Yes*
with the bot number and a last-seen time that moves every minute.

The pairing is stored in the database (`whatsapp_session`), so restarts do
not ask again. To pair a different phone: *Forget pairing* on the screen
(with a reason), or `npm run whatsapp-bridge -- --reset-pairing`, then start
the bridge and scan again. If the phone *unlinks* the device, the log says
`logged out — run with --reset-pairing and scan again`.

## 3. Running it

* **Pilot (laptop):** keep the terminal open. When the laptop sleeps the bot
  is offline; deliveries wait as `pending` and are sent when it returns —
  nothing is lost.
* **Production (VPS):** `deploy/whatsapp-bridge.service` — copy to
  `/etc/systemd/system/qs-erp-whatsapp.service`, `systemctl daemon-reload`,
  `systemctl enable --now qs-erp-whatsapp`. The log is
  `/var/log/qs-erp/whatsapp-bridge.log`; the QR code prints there on the
  first start (`journalctl -u qs-erp-whatsapp -f` while pairing). On
  `deploy.sh` restart it with `systemctl restart qs-erp-whatsapp`.

Every 20 seconds (`WA_POLL_SECONDS`) the bridge delivers the `whatsapp`
channel: pending rows are sent, a transport failure is retried after 1, 10
and 60 minutes and then stays `failed` on the Background Jobs and WhatsApp
screens, a recipient with no number or notifications off is `suppressed`.
Once an hour it blanks message bodies older than the retention
(`retention_days`, 90) — the rows and their outcomes stay. Once a day, at
`digest_hour` (08, business time) or as soon after it as the bridge is up,
it sends *today's summary* in `digest_locale` to every contact with *Morning
digest* ticked who may ask — the same text as asking `summary`.

## 4. Asking

Send a message to the company number from the CEO's phone. The catalogue,
in either language (`help` / `مساعدة` lists it):

| Ask | Reply |
|---|---|
| `stock in warehouse Najaf`, `شنو موجود بمخزن النجف`, `stock in WH-0032` | items, quantities, FIFO value; XLSX when more than `inline_rows` |
| `status of IMP-HQ-2026-000004`, `PAYAPP-HQ-2026-000007?` | the document's status, stage, stop, owner |
| `swift pending more than 3 days`, `سويفت معلق اكثر من ٣ ايام` | the applications sent and unconfirmed |
| `payables due this week`, `المستحقات هذا الأسبوع` | the dashboard's list |
| `stopped payables`, `holds needing a reason`, `الموقوفة بدون سبب` | the workbench's stopped filters |
| `supplier balance Jinko`, `رصيد المورد SUP-00001` | the balance and the statement as PDF |
| `customer balance Al Noor`, `رصيد الزبون النور` | the same for a customer |
| `today's summary`, `ملخص اليوم` | the dashboard in ten lines |

A name that matches several warehouses or partners is answered with the
candidates; one that matches none, with the list. Every reply ends with
*as of … · branch … · read as …* (W-R7). Nothing can be changed from chat:
the read runs in a transaction PostgreSQL holds read-only, as the asking
user, with that user's own permissions.

Anyone not on the contact list — or listed without the CEO role, or with
Questions off — gets no reply at all; the attempt is in the message log
with its reason and in the audit trail as `whatsapp.refused`.

## 5. The e-mail channel (same release)

`scripts/ops/deliver-notifications.ts` runs every five minutes from
`crontab.erp` and owns the e-mail channel: it dispatches the outbox, runs
the `notification.deliver` jobs and sends through the host's SMTP settings
(`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). With mail unconfigured
the e-mail rows are marked `suppressed` and the log says so once per run.

## 6. When something is wrong

| Symptom | Where to look |
|---|---|
| *Paired: No* after scanning | the terminal: a `connection closed (401)` means the phone refused — reset the pairing and scan again within the QR's minute |
| Last seen stopped moving | the bridge process died or the laptop slept; start it again, nothing is lost |
| A delivery is `failed` | the WhatsApp screen's *Bridge* window counts them; the message log has the transport's words; after three attempts it rests until a new notification |
| The CEO asks and hears nothing | the message log: `no reply` with the reason (unlisted / deactivated / not CEO / questions off) |
| The CEO is answered "I can't answer that yet" | the phrase is outside the catalogue and no router model is configured; set `ANTHROPIC_API_KEY` on the bridge host, or ask with a catalogue phrase |
| The number is banned | D-WA-5: re-pair a replacement SIM; if it recurs, the official Cloud API replaces the bridge layer only |

## Noah for everybody (2026-10-04)

* **Who may ask:** any active user with a contact row whose *Questions* switch
  is on (Settings → Administration → WhatsApp). The CEO role is no longer
  required. Each person is answered as themselves: a tool refuses what their
  role cannot see and says which permission is missing.
* **Who may act:** a contact whose *Actions* switch is on. Noah proposes, the
  person answers with a plain yes, and the step runs through the document's own
  service as that person — approve or reject from the inbox, a document's next
  step by its number (submit, approve, post, reverse, cancel), a new customer
  or supplier, approving a prospect.
* **What he knows about the system:** the top bar as it is drawn (`screens`)
  and the written guide in `docs/guide/` (`guide`). A deploy replaces the
  guide; nothing needs restarting beyond the bridge itself.
* **Issues:** whatever people report to him is appended to
  `/opt/qs-erp-next/var/issues/reported-issues.md` — read it with
  `ssh root@31.97.123.206 cat /opt/qs-erp-next/var/issues/reported-issues.md`,
  or ask him "what issues were reported?". Change `Status: open` to
  `Status: fixed` when one is dealt with.
* **Without a phone:** `npx tsx scripts/ops/ask-noah.ts <email> "<question>"`
  on the server answers exactly as the group would be answered, as that user.
  Add `--propose` to try a preview or a plan: what he would ask a yes for is
  printed and never run, and a preview undoes itself.
* After a deploy: `systemctl restart whatsapp-bridge`, so the bridge runs the
  new instructions and tools.

## He speaks only when called (2026-10-04)

* **The trigger is `!ai` at the very start of the message.** Anything else said
  in the group is not read, not logged and not answered — a question he could
  answer, his name, `!ai` in the middle of a sentence. Nothing is inferred.
* `!ai <request>` — answered, for every group member whose number has a contact
  row with *Questions* on. The request is whatever follows the trigger: a
  question, a look-up, "digest this month's sales", a how-to, a draft.
* `!ai … !dontwrite` and `!ai … !ignore` — nothing happens: no answer, and
  nothing is run.
* A yes to something he proposed is `!ai yes` (`!ai no` to decline); the typed
  commands are `!ai approve <number>`, `!ai reject <number> <reason>`,
  `!ai confirm <code>`, `!ai pending`.
* `!ai` on its own gets one line saying how to use it. A group member whose
  number is not on the contact list is told so once (and not again for six
  hours); add them on Settings → Administration → WhatsApp.
* **He says nothing unasked — never.** With *group only* on (the default) the
  bridge cannot send a message that is not the answer to an `!ai` message: no
  greeting when it starts, no copy of a notification, no morning digest. The
  two switches *Post notifications to the group* and *Post the morning digest
  to the group* do nothing while *group only* is on. Notifications still reach
  people in the application and by e-mail. A restart of the bridge is silent.
* The model is the `agent_model` setting — `claude-opus-5-5`.

## What people can do in the group

Everything starts with `!ai` at the beginning of the message.

* **Ask anything** — `!ai why is the customer's account empty?`, `!ai what's stuck?`,
  `!ai how do I add a supplier?` (he answers in steps, a picture at each step).
* **Tag somebody** — `!ai explain this to @Ali in Arabic`: the answer is written
  to Ali and tags him. It is still read as the person who asked.
* **Reply to a message** with `!ai explain this` — he is shown that one message
  (and its picture or file), nothing else from the group.
* **Send a picture** — a screenshot of an error, a photo of a paper invoice —
  with `!ai what is this?` in its caption. He reads it.
* **Send a supplier's invoice** (PDF, Excel or photo) with `!ai enter this` — he
  keys a draft purchase invoice and reads it back; nothing posts.
* **Have him do a step** — `!ai post INV-…`: he shows what it will do and waits
  for `!ai yes`.

## Requests, feedback and what he remembers

Everything Noah writes down besides answers is a file on the server under
`/opt/qs-erp-next/var/noah/` (it outlives a deploy):

| Folder | What | Who reads it |
|---|---|---|
| `requests/REQ-YYYYMMDD-NNN.md` (+ `INDEX.md`) | One file per thing people want changed: a new field, a new screen or report, a workflow the company does differently. Each has what is wanted, why, how it works today, the real steps, an example, the questions still open, and his own reading. | Whoever builds the system. Set `- Status:` by hand as it moves: `in progress`, `done`, `declined`. |
| `feedback/FB-….md`, `feedback/eval-candidates.jsonl` | Each 👎 / 👍 with the exchange it was about. | Turn each candidate into a case in `tests/noah/questions.ts`. |
| `memory/company.md`, `memory/people/<user>.md` | What he was told to keep. | Edit or delete a line by hand to correct him. |
| `memory/walk/`, `memory/last/` | The walkthrough each person is in; their last exchange. | Nobody needs to. |

```
ssh root@31.97.123.206 'cat /opt/qs-erp-next/var/noah/requests/INDEX.md'
ssh root@31.97.123.206 'cat /opt/qs-erp-next/var/noah/requests/REQ-20261005-001.md'
```

What people say in the group:

* `!ai we need another field on bank loans: who guaranteed it` — he checks how it
  works today, asks a question or two, files it and gives its number.
* `!ai 👎` (or "that was wrong") after an answer — written down; he looks again.
* `!ai remember that I always want Arabic` / `!ai remember: our Najaf store is WH-NJF`
  (a company fact only from an administrator) / `!ai forget …`.
* `!ai walk me through posting INV-…` — one step at a time; `!ai done` after each,
  and he checks the system before giving the next.
* `!ai what will posting INV-… do?` — the exact journal and stock lines, nothing changed.
* `!ai approve the opening stock and then post the invoice` — one plan, one `!ai yes`.
* `!ai show me the suppliers screen live` / `… the sample one` — whose data the picture shows.

**Every picture is live** (since 2026-10-05): there are no training pictures
any more, and no switch for them. `NOAH_HOWTO_LIVE` is no longer read; the
folder `var/guide-shots` on the server is no longer used and may be deleted.

## Trying him without the group watching

The bridge is linked to one person's WhatsApp. With `WA_SELF_CHAT=on` in
`/opt/qs-erp-next/.env` (then `systemctl restart whatsapp-bridge`), that person
can open their own **Message yourself** chat and write `!ai …` there: he
answers in that chat, as them, with everything he can do in the group. Nobody
else's private chat is ever read, and a note to self that does not begin with
`!ai` is not read either. Remove the line (or set it to `off`) to switch it off.

## Live pictures

Every picture Noah sends is taken at that moment, of the running system, as
the person who asked, in the language they asked for: where a screen is in the
menu, the screen, the form that opens for a new record, one of their own
records, a window (attachments, notes, history, print, an action that asks for
a reason), the sign-in page, the top bar. A few seconds each.

* `!ai how do I add a supplier?` — the menu, the screen and the form, each at
  its step.
* `!ai show me INV-HQ-2026-000001 and where I press to post it` — that
  document's own page, with an arrow at the button.
* It is taken **as the person who asked**, through a session that lives three
  minutes and is revoked as soon as the picture is taken; it appears, revoked,
  on that user's sessions list, and every picture is in the audit trail
  (`whatsapp.screenshot`, with what was opened). The sign-in page is pictured
  signed out, as nobody.
* It **cannot change anything**: the browser it uses is refused every request
  that is not a plain page read. To show a form or a window it may open a menu
  of the top bar and press a button that only opens a window — never a button
  that acts, never a key, never a form.
* It shows **real figures in the group** — what that person's own screen
  shows. If that is ever not wanted, set `NOAH_LIVE_SHOTS=off` in
  `/opt/qs-erp-next/.env` and restart the bridge: he then explains in words
  only. There is no other set of pictures to fall back on.
* A list with nothing in it yet has no record to open, and a screen he may not
  open is not pictured: he says so, and explains in words.
* The server needs a browser: `npx playwright install chromium` and
  `npx playwright install-deps chromium`, once.
* Try one by hand: `npx tsx scripts/ops/live-shot.ts <email> <path> [--point "Label"]`,
  or the whole answer: `npx tsx scripts/ops/ask-noah.ts <email> "show me the form for a new supplier"`.

## Noah's test set

`tests/noah/questions.ts` holds some fifty real questions, each with what a
right answer cannot be without: the tools he must have used, facts that must be
in the words, things that must never be said, the language, the pictures, a
proposal made and not run. Run them against the real model after any change to
his instructions, his tools, the guide or the pictures:

```
NOAH_APP_URL=http://localhost:3000 npx tsx scripts/ops/noah-eval.ts   # all of them, about half an hour (the URL is for the live-picture cases)
npx tsx scripts/ops/noah-eval.ts --only howto --only action
npx tsx scripts/ops/noah-eval.ts --only doc-why-draft-en
npx tsx scripts/ops/noah-eval.ts --list
```

It answers each question exactly as the bridge would (the path `ask-noah.ts`
uses), as the seeded administrator unless the case names somebody else. It
never acts: a proposal is recorded for the judge and dropped, and an issue he
files goes to a scratch file. One line per case, a tally by area, and every
answer in full in `var/noah/eval-<date>.json`. It ends 1 if a case fails. The
facts are those of the seeded development database; when a fact moves, correct
the case, and when Noah answers badly, leave it failing and fix Noah.

## When Noah gets something wrong

Every answer keeps what he did to reach it. On the server:

```
grep 'inbound from' /var/log/qs-erp/whatsapp-bridge.log | tail -40
```

shows, per answer, the look-ups in order with their time and what a refused
one said (never the question or the answer). The same trace, with the
arguments, is on the message itself — Settings → Administration → WhatsApp →
the message log, or `whatsapp_message.detail -> 'trace'`.

To ask him the same thing yourself, as that person, and see the trace:

```
cd /opt/qs-erp-next && npx tsx scripts/ops/ask-noah.ts <email> "<the question>"
```

What he can read to explain a problem: `document_story` (one document whole —
lines, journal, stock, history, what it is waiting for), `activity_log` (who
did what, what was refused and why), `system_status` (health, migrations,
scheduled jobs, the application's error log). One failed look-up no longer
ends the question: each runs in its own savepoint.

## The pictures Noah sends

Noah explains a task as steps with pictures — up to eight in one answer, each
sent with its own step as the caption — in the language of the person who
asked. Every picture carries red numbers on the things that matter (each field
of a form, the buttons, the tabs, the search and filters, the table, a record's
status and its printer / paperclip / notes / history icons), and he explains
each number: what it is for, why it is needed, what to enter, what it changes.

There are four pictures of a screen — `menu` (where it is, the entry ringed),
`screen`, `form` (what its New button opens) and `record` (one saved document
opened) — and one of each window that opens from it (`dialog`: attachments,
notes, history, print, an action that asks for a reason), for **every built
screen of the menu**, plus *sign in*, *the top
bar*, *the account menu* and *change password*.

They are not taken when the question is asked: they are made ahead of time
from the **seeded local development server**, so they show sample data and
never the company's. The script walks the menu itself, so a new screen is
covered by running it again.

Make them (the development server running on port 3000, signed-in user from
`scripts/seed-dev.ts`):

```
npx tsx scripts/guide/make-screens.ts            # every built screen, English and Arabic
npx tsx scripts/guide/make-screens.ts --only payables/suppliers --force
npx tsx scripts/guide/make-screens.ts --only sign-in --force
```

They land in `var/guide-shots/` with an `index.json` (which also says what
each red number points at). Put them on the server, where `var/` outlives a
deploy:

```
scp -r var/guide-shots root@31.97.123.206:/opt/qs-erp-next/var/
```

Check from the server, without a phone:

```
cd /opt/qs-erp-next && npx tsx scripts/ops/ask-noah.ts <email> "how do I add a supplier? show me"
```

It prints the answer as the group would get it: each message, and under each
picture the caption it is sent with. No pictures on the server is not an
error: Noah says the path in words. Make them again when a screen's layout
changes.
