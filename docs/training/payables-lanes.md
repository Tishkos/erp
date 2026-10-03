# Payables — one page per lane

REQ-AP-001 Stage 8 training sheet. Each lane of the workflow diagram is one
person's job; this is what that person opens in the morning, what they press,
what stops them, and which column of `QS_DASHBOARD.xlsx` the screen replaces.
Everything is under **Payables** unless said otherwise. Arabic users see the
same screens right to left with the same buttons.

**Three rules for every lane**

1. Nothing is edited after the fact. A wrong record is cancelled with a reason,
   reversed, or re-registered; the history keeps both.
2. "Stopped? YES" always has a reason, an owner and a next action. When a time
   limit passes, the system stops the import itself and asks for the reason
   (*Stopped — reason required*); the lane's owner completes it with
   **Complete — reason, owner, next action**.
3. Every import has one page — *Import applications* → the import. Its status
   log is the sheet's row: every change, who, when.

---

## Lane 1 — Order & invoice ("What we buy") · accountant

| | |
|---|---|
| Opens | **Purchase Invoices**, **Import applications** |
| Replaces | `dashboard`: PO no./INV., INV. Date, Supplier, INV. Amount, INV. Qty, Pmt Terms, Products |

* **A new import:** Purchase Invoices → *New* → supplier, dates, lines (the
  warehouse on a line is where the goods will be received), tick **Import**,
  leave *Import application* at **New**, type the terms as the supplier wrote
  them → Create. The import application opens behind the invoice with its
  number (`IMP-…`) and its purchase order; nobody fills a second form.
* **An import migrated from the sheet:** tick **Import** and choose it under
  *Import application* — the invoice joins it.
* **Rent, a forwarder, a broker, a utility:** *Add expense* on Purchase
  Invoices (type of fee, supplier, amount, dates); **Mark paid** when paid. Unpaid / Overdue / Paid read themselves.
* **A cost of an import** (freight, clearance, port): *Add expense* with
  *Belongs to import* set — it becomes part of the import's landed cost, not
  an expense.
* **Stops you:** the same supplier invoice entered twice; a non-PO invoice
  without its type of fee.

## Lane 2 — Bank & finance ("Where the money comes from") · treasury / accounting manager

| | |
|---|---|
| Opens | **Bank Loans**, *Master Data → Bank Accounts*, the import page's *Funds* |
| Replaces | the bank boxes of the diagram — Mansour · Arab · NBI · Rafidain |

* **A loan:** Bank Loans → *New loan* → bank, the account the money lands in,
  principal, commission (%, or amount) and how it is taken, interest,
  instalments → *Create loan*. A second person approves it (the CEO above the
  account's limit). Record the disbursement when the bank credits it.
* **Repay:** the loan's schedule → the instalment due → repay. Instalments are
  paid whole and in order; the sweep marks *Due* a week ahead and *Overdue*
  after the date, and tells each import the loan funded.
* **Available balance** on a payment application = balance − reserved by
  approved applications. Approving reserves; rejecting or cancelling
  releases.
* **Stops you:** paying USD from an IQD account (D3); drawing more than the
  loan's room.

## Lane 3 — Payment ("Paying the supplier") · accounting officer → manager → treasury

| | |
|---|---|
| Opens | **Payment Applications**, the import page |
| Replaces | `PMT`: Bank, Application AMT., Application date, Swift date, Payment Status; the dashboard's Paid / Remaining / Applied |

1. **New payment application** (on the import page, or the register): amount,
   method (SWIFT, transfer, cash, cheque), the account, optionally the loan
   that funds it. *Plan instalments* first when the terms are 30 / 70.
2. **Approve — reserve funds** — a second person.
3. **Send to bank** — the date the file went; the checks run here: the
   supplier's bank account verified, funds available, the PD validated and
   registered with the same bank. A manager may override a failing check with
   a reason; the override is printed on the application.
4. **Confirm SWIFT** (or *transfer / cash paid / cheque paid*) with the date
   and the reference from the bank's copy; attach the copy. This posts the
   payment against the posted invoice (or a deposit before it).
5. **Record debit** when the statement shows it.

* A migrated row the sheet left *sent* although the money had gone: **Paid
  before the cut-over** — records the bank's date and reference, posts
  nothing (D37).
* **Applied / Paid / Remaining** on the import page are the sheet's columns,
  computed.
* **Stops you:** a stop in the payment lane blocks Create, Approve and Send
  (not Confirm — the bank's answer is always recorded).

## Lane 4 — PD / ASYCUDA ("Customs pre-declaration") · customs officer

| | |
|---|---|
| Opens | **Customs Pre-Declarations** |
| Replaces | `PD` and `Pending`: PD No., Registration / Expire Date, Status, Bank Code, Notes; "Check / MATCH / STATUS CHECK" |

* **Register PD** — the import, the number as ASYCUDA shows it, registration
  and expiry dates (typed from ASYCUDA, never calculated), the bank.
* **Change status** with the date and where you saw it (ASYCUDA screenshot or
  your own check). Attach the screenshot.
* **Update from ASYCUDA list** — paste the document list; the screen shows the
  difference (will change / already so / no such PD / final) and applies only
  when you press *Apply*.
* **Re-register** a rejected or expired PD: a new PD that names the old one;
  the old one stays as customs left it.
* **The holding list** (after the cut-over): view *Holding list — not linked
  to an import* → open each PD → **Link to an import**.
* The view *Expiring within 45 days* is the morning list. The day after expiry
  the PD moves to its expired status itself and the import stops until it is
  re-registered.

## Lane 5 — Shipment, per container ("Every container on its own") · logistics officer

| | |
|---|---|
| Opens | **Bills of Lading**, **Containers** |
| Replaces | `BL` and `CTN No.`: BL No., POD, ETA, Shipping Status, CTN No., PORT File Sent? |

* **New B/L** for the import: number, date, vessel, ports, ETA; paste the
  container numbers (one per line — numbers failing the ISO check digit are
  refused).
* Move the containers along — *Sailed*, *At port*, *Customs cleared*, *Port
  file sent* — one at a time or **Move all containers**. Change an ETA with
  its reason; the import's "X of Y received" counts itself.
* **Stops you:** a container past its ETA by the time limit stops the import
  (*Late* view) until you say why.
* Invoices that are **not** imports still use *Inventory → Invoice Status
  Tracking*; that page points here for imports.

## Lane 6 — Warehouse & stock ("What we have in stock") · storekeeper

| | |
|---|---|
| Opens | **Containers** (view *Not received yet*) |
| Replaces | `BL Product Detail`, Inbounded Qty, Outbound / Inventory Detail |

* **Receive container** → the warehouse of this branch → for each line the
  quantity received, damaged and short. Anything not received whole needs
  *What happened*; the import gets a claim stop in the warehouse lane.
* Until received, the goods are the company's but in transit: on the balance
  sheet, not available to sell.
* A container whose lines say *estimated* came from the sheet without a
  product detail: count what is there.

## Closing — Cleared and the landed cost · accounting manager

* An import is **cleared by nobody**: when it is fully paid, every container
  is received and every PD is totally written off, it moves to *Cleared* and
  becomes read-only; if one of the three stops holding it re-opens with the
  reason.
* **Landed cost:** on the import page, *Add charge* for a cost parked on the
  clearing account by a journal; when every PD is totally written off, **Lock
  landed cost** — the preview shows each model's unit cost now and after.
  Late charges are a dated adjustment (*Allocate late charges*), never an
  edit.

---

**Where to look when lost:** the import page's status log (what happened),
the *Stopped — reason required* view of Import applications (what needs you),
and the notification bell (what the sweep told you this morning).
