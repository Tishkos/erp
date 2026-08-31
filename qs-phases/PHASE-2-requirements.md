# ERP Implementation — Phase 2

> **Source:** the sponsor's Phase 2 definition, received 2026-08-31. Recorded
> here verbatim; the acceptance record for this phase will sit beside it as
> `PHASE-2-master-data.md` when the phase closes.

## Purpose

Phase 2 prepares the main accounting master data that will be used by the next
accounting and operational phases. The objective is to create the core records
once and use the same records throughout the ERP.

## Phase 2 Requirements

| No. | Requirement | Expected Result |
|---|---|---|
| 1 | Cost Centres | Cost centres can be created, edited and deactivated so they can be selected later in accounting and operational transactions and used in reporting. |
| 2 | Customers | Customer records can be created and maintained with the basic information required for future Accounts Receivable, sales and collection transactions. |
| 3 | Suppliers | Supplier records can be created and maintained with the basic information required for future Accounts Payable, purchasing and payment transactions. |
| 4 | Item Master Data | Items can be created and maintained with an internal item code, item name, category and unit of measure. Each item can be linked to one or more suppliers, with one supplier identified as the default supplier. The same item record will be used later in Purchasing, Inventory and Sales. |
| 5 | Bank Accounts | Company bank accounts can be created and maintained and linked to the correct branch and G/L account for use in later treasury and payment processes. |
| 6 | Cash Accounts | Company cash accounts can be created and maintained and linked to the correct branch and G/L account for use in later cash and payment processes. |
| 7 | Payment Terms | Standard payment terms can be created and maintained so they can be assigned later to customers, suppliers and related transactions. |
| 8 | Payment Methods | Standard payment methods can be created and maintained for future receipts and payments, such as cash, bank transfer and cheque. |

## Expected Result of Phase 2

At the end of Phase 2, the ERP contains the main accounting master records
required for the next phases. Cost centres, customers, suppliers, items, bank
accounts, cash accounts, payment terms and payment methods are ready for use.
Items can also be linked to their suppliers, including a default supplier.

---

## How the requirements were read

Three points in the definition admit more than one reading. What was built, and
why, so the sponsor can disagree with a decision rather than with an outcome.

### Customers and suppliers are two screens over one record

Requirements 2 and 3 name them separately, and the menu offers them separately:
**Customers** and **Suppliers**, each asking only what its role needs.

Underneath, a company is **one record**. The approved blueprint is explicit —
§6: *"one record serves CRM, Sales, Finance, Projects, Logistics and Money
Transfer"*, and §3.1 requires one authoritative record per party. A company
that both buys from us and sells to us is one legal person. Two records for it
would make netting their balances impossible and would let the two halves
disagree about their own address.

So adding a company on the Customers screen that already exists as a supplier
**gives that partner the customer role**. It does not create a second record.
The record page shows both roles as two switches, so anyone arriving from
Customers can see the company is also a supplier.

### Cash accounts got a screen of their own

Requirements 5 and 6 are two requirements, and the questions differ. A bank
account has a bank, an account number, an IBAN, a SWIFT code and a statement
format. A cash account has a custodian and a float ceiling. One form asking all
of it would ask most people, most of the time, for fields that do not apply.

They remain one table, because every later payment and receipt must resolve
"which account?" against a single list.

### A cheque is a payment method, not a settlement rail

Requirement 8 gives three examples — cash, bank transfer, cheque. Those are
*methods*, which is what a person picks. Beneath each sits a **kind** — bank,
cash or transfer — which is the rail the money moves on and what later phases
branch on.

A cheque is therefore a method of kind `bank`: it clears through a bank account
and reconciles against a bank statement, which is everything the system needs
to know about it. Naming a fourth kind would add a branch to every payment path
that behaved identically to `bank`.

## What the screens refuse, and why

Master data is only worth having if it cannot quietly become wrong. Each refusal
below is enforced by the database, not only by the screen.

| Refusal | Why |
|---|---|
| Two suppliers marked default for one item | A purchase order would have to pick one arbitrarily. Enforced by a unique index. |
| Linking an item to a partner who is not a supplier | And the supplier role cannot be removed while item links depend on it. |
| Retiring a unit of measure that items are measured in | Those items would name a unit no picker offers. |
| Retiring a payment term a partner still uses | Their next invoice would have no answer to "when is this due?" |
| Two accounts carrying one G/L account | A statement only reconciles against a balance belonging to one account. |
| A stock item with no tracking | §9.3 — serial, batch or both. There is no fourth option. |
| A fee with no account to post to | A cost nobody accounts for. |
| A bank account with no number | It could never be reconciled to a statement. |
| A cash account with no custodian | §17 — a float that is nobody's responsibility cannot be counted. |
| A partner who is neither customer nor supplier | §6 — either role, or both, never neither. |
| Deleting any of these records | §1.1 — deactivation says the same thing and keeps the history readable. |

## Not included in Phase 2

Transactions of any kind. Phase 2 creates the records that later phases
*select* from: no purchase order, sales order, invoice, receipt or payment is
part of it. Price lists, tax codes, warehouses, barcodes and item unit
conversions are also outside this phase — they belong to the operational phases
that use them.
