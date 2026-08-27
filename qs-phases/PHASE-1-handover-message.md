# Phase 1 — the message to send

Copy from the line below. Send it once Phase 1 is deployed.

---

Mr Issa,

Phase 1 is on **erp.qs-groups.com**, beside the Phase 0 foundation. It is the
accounting core: the Chart of Accounts, Journal Entries, their posting and
reversal, and the reports read from what they post. Nothing beyond that — no
payables, no receivables, no fixed assets, no inventory.

**What is new in the menu**

*Accounting → Master Data*
- **Chart of Accounts** — the five families (Assets, Liabilities, Equity,
  Revenue, Expenses). An account is created under one of them and is either a
  **header** that groups other accounts or a **posting** account that takes
  entries. It is raised by one person and approved by another, and when it is
  no longer used it is deactivated — never deleted, because old entries still
  cite it.
- **Accounting rates** — the rate every posting is measured at. Publish one and
  it applies from its date onwards; correcting it supersedes the old figure
  rather than editing it, so an entry keeps the rate it was posted at.

*Accounting → Finance*
- **Journal Entries** — the entry opens with its number already on it. Fill in
  the two dates and the description, add the debit and credit lines, and the
  running totals sit at the top: it cannot be posted until they agree. You can
  attach a supporting document.
- **Accounting periods** — the months the books are open for. Open a year and
  its twelve periods are created. A period is open, soft-closed (adjustments
  only, with a reason) or closed.
- **General Ledger** — one account, entry by entry, with a running balance.
- **Trial Balance** — every account with a movement, and the two totals that
  must agree.
- **Financial statements** — the Statement of Profit or Loss for a period and
  the Statement of Financial Position at the end of it.
- **Reversals** — every correction ever made to the books, and why.

**Before the first entry — five minutes of setup**

1. **Settings → Administration → Departments**: create a department called
   Finance and tick **Finance department**. Journal Entries belong to Finance,
   so only its members may raise one.
2. **Settings → Administration → Users**: add both accounts to that department,
   and give `admin@qs-groups.com` the **Accounting Manager** role — approving a
   journal comes from holding that role, not from being an administrator.
3. **Accounting → Finance → Accounting periods**: open the current year.
4. **Accounting → Master Data → Accounting rates**: publish a USD rate. Every
   entry is measured in dinars and in dollars, so nothing posts without one.
5. **Accounting → Master Data → Chart of Accounts**: create the accounts you
   need — a cash account, a sales account, and so on.

**To try it**

Sign in as `employee@qs-groups.com`, open **Journal Entries**, press **New
journal**, add a debit line and a credit line for the same amount, and submit.
Sign in as `admin@qs-groups.com` and approve it: approving *is* posting, and
the entry is in the books from that moment.

Then look at the **Trial Balance** — your entry is in it and the two totals
agree — and at the **Financial statements**, which are drawn from the same
postings and nothing else.

**Correcting a mistake**

A posted entry cannot be edited or deleted; the system refuses both. Open it
and press **Reverse** with a reason. That writes the opposite entry, posts it,
and links the two permanently — the original stays readable, marked as
reversed, and the Reversals screen lists every correction with its reason.

**One thing deliberately left loose**

Revenue and expense accounts are meant to carry a **Business Line**, so the
Profit or Loss can be cut by line of business. That master data belongs to a
later phase, so for now a journal may be entered without one — the entries are
simply unclassified, not wrong, and the requirement is turned back on when the
Business Line master arrives.

Phase 1 is the accounting foundation the remaining accounting functions will
build on. Tell me when you are ready with Phase 2.
