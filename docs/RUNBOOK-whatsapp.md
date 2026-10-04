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

## The pictures Noah sends

Noah explains a task as steps with pictures — up to six in one answer, each
sent with its own step as the caption — in the language of the person who
asked. Every picture carries red numbers on the things that matter (each field
of a form, the buttons, the tabs, the search and filters, the table, a record's
status and its printer / paperclip / notes / history icons), and he explains
each number: what it is for, why it is needed, what to enter, what it changes.

There are four pictures of a screen — `menu` (where it is, the entry ringed),
`screen`, `form` (what its New button opens) and `record` (one saved document
opened) — for **every built screen of the menu**, plus *sign in*, *the top
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
