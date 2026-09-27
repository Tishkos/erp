# Setup checklist — what the system needs before it works

Some parts of the system only work when certain things are set up in the
database first. Most have a screen; a few do not. When one is missing, the
screen usually still opens, but a document refuses to post, or something
simply never appears (for example, invoices never reach Invoice Status
Tracking).

On a development database, `npm run db:seed` sets all of this up. On a real
company database, check each item below.

The quickest way: run `docs/setup-check.sql` against your database. Each
section prints what it found; the table below says what a healthy result looks
like.

```
psql "$DATABASE_URL_OWNER" -f docs/setup-check.sql
```

## The checklist

| # | What | Why it matters | Where to set it | Healthy result |
|---|---|---|---|---|
| 1 | **The three shipment-stage warehouses**: In Process, On Board, On Port | Invoice Status Tracking. A Purchase Invoice enters tracking only when its lines go to the In Process warehouse, and the "Move to" buttons move the goods into the On Board and On Port warehouses. | **No screen.** Only the seed or SQL (see below). | 3 rows: `in_process`, `on_board`, `on_port` |
| 2 | **A user with the CEO role** | Purchase and Sales Invoices are approved by the CEO. Without one, invoices wait for approval forever. | Administration → Users (give a user the `ceo` role) | At least 1 row |
| 3 | **An open accounting period for today** | Nothing posts into a closed period, or a date with no period. | Finance → Periods | 1 row with status `open` |
| 4 | **A USD exchange rate** | Any document in USD needs a rate to convert to IQD. | Master Data → Exchange Rates | 1 row |
| 5 | **Posting mappings** | Tells each document which accounts to post to (payable, receivable, revenue, returns, opening stock…). A missing one makes that document refuse to post. | Finance → Posting Mappings | **0 rows** (the query lists the missing ones) |
| 6 | **Every stock item has an Inventory account and a COGS account** | Purchase, sale, return, opening stock and reconciliation of that item refuse to post without them. (The Sales account is optional; the mapping is used when it is empty.) | Master Data → Items → the item | **0 rows** (the query lists the items missing one) |
| 7 | **Every Bank / Cash account is linked to a ledger account** | Payments and receipts post to that ledger account. | Master Data → Bank Accounts / Cash Accounts | **0 rows** |
| 8 | **Every user has a branch** | A user sees and creates documents only in their branch(es). A user without one sees nothing. | Administration → Users | **0 rows** |
| 9 | **Who is notified on a status change** (optional) | Invoice Status Tracking notifies these users on every status change. | Inventory → Invoice Status Tracking, bottom of the page | At least 1 row per branch that tracks shipments |
| 10 | **All migrations applied** | New features (for example print permissions, migration `0213`) need their migration. | `npm run db:migrate` | The latest is `1795900000017` or later |

## Fixing item 1 — the shipment-stage warehouses (no screen)

This is the one thing with no screen. Run once, as the database owner, and
replace `HQ` with the branch code that receives imported goods:

```sql
INSERT INTO warehouse (code, name, branch_code, warehouse_type, shipment_stage) VALUES
  ('WH-INPROC', 'In Process', 'HQ', 'main', 'in_process'),
  ('WH-BOARD',  'On Board',   'HQ', 'main', 'on_board'),
  ('WH-PORT',   'On Port',    'HQ', 'main', 'on_port')
ON CONFLICT DO NOTHING;
```

If you already have warehouses you want to use for these stages, mark them
instead of creating new ones:

```sql
UPDATE warehouse SET shipment_stage = 'in_process' WHERE code = 'YOUR-IN-PROCESS-CODE';
UPDATE warehouse SET shipment_stage = 'on_board'   WHERE code = 'YOUR-ON-BOARD-CODE';
UPDATE warehouse SET shipment_stage = 'on_port'    WHERE code = 'YOUR-ON-PORT-CODE';
```

Only one warehouse may hold each stage. The fourth stage, In Bounded, has no
warehouse of its own: the person moving the invoice chooses one.

## Permissions worth knowing

A button that is missing is usually a permission, not a bug:

| Button or section | Needs |
|---|---|
| Invoice Status Tracking → "Move to …" | `execute` on shipments |
| Invoice Status Tracking → notification list | `configure` on shipments |
| Print / Export → PDF | `print` on that document or report |
| Print / Export → Excel and Word | `export` on that document or report |
| Invoice "Approve and post" | the CEO role |
