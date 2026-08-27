# Phase 0 — the message to send

Copy from the line below. It describes what is live at **erp.qs-groups.com**
today, in the order somebody should try it.

---

Mr Issa,

Phase 0 is on **erp.qs-groups.com**. Everything that is not Phase 0 has been
taken out — not just hidden from the menu, but refused on the address as well,
so what you see is the whole of what exists.

**The two accounts**

- `admin@qs-groups.com` — administrator; may do anything, and approves
- `employee@qs-groups.com` — an ordinary employee; raises documents

Password for both: `QS329cm!Safinah` — please change it from **Profile
settings** in the top-right menu.

**What is in the system**

*Settings → Administration*
- **Company** — the company's own record: name, currency, address, fiscal year
- **Users** — create a person, give them roles, branches and departments; each
  gets a one-time temporary password
- **Roles** and **Permissions** — create a role, then tick, for each section of
  the system, exactly what that role may do: view, create, edit, submit,
  approve, export, and the rest. Nothing is allowed unless it is ticked
- **Data scopes**, **Department managers**, **Numbering**, **Audit trail**

*Accounting → Master Data*
- **Branches** — a branch is created with its main warehouse and its cash
  account in one step; the code is generated from the name as you type it
- **Departments** — and this is where you say who manages each one, which is
  what decides who approves that department's documents

*Accounting → Sample documenting*
- **Invoicing** — one document, so the rules above can be seen working end to
  end. It is only a demonstration: it posts nothing to any ledger. That is the
  accounting phases' work, and we have not started them.

**To try the approval flow**

1. Sign in as `employee@qs-groups.com`, go to **Accounting → Invoicing** and
   press **New invoice**. The document opens with its number already on it —
   nobody types a document number in this system, and no number is ever reused.
2. Fill in the customer and the department, then add the items: description,
   quantity, unit price. The total is worked out from the lines; it cannot be
   typed, so it can never disagree with them. You can attach the signed order
   or any supporting file to the invoice.
3. Press **Submit for approval**. The status becomes *Pending approval* and it
   goes to whoever manages that invoice's department.
4. Sign out, sign in as `admin@qs-groups.com`, and open **My approvals**. The
   invoice is waiting there; open it and press **Approve**.
5. Look at the bottom of the invoice. It says who raised it and when, who
   approved it and when, and every step in between — in plain words, not codes.
   Nothing in this system is ever deleted; a mistake is cancelled before it is
   decided, or reversed after, and both stay on the record.

I have left one of each on the system for you: **INV-2026-00001** is waiting
for your approval, and **INV-2026-00002** has already been through the whole
flow so you can see what a finished record looks like. Cancel or reverse them
whenever you like.

**The five statuses, for every document from here on**

Draft → Pending approval → Approved. **Cancelled** before anybody has decided;
**Reversed** afterwards. If an approver sends something back, it returns to
Draft with their reason on it, for the person who raised it to correct and
send again.

Phase 0 is the foundation only: the company, its branches and departments, its
people, what each of them may do, how documents are numbered, how they are
approved, and what is remembered about them. Nothing accounting has been built
yet — that starts with Phase 1, whenever you are ready to share it.
