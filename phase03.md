# ERP Operations Build

## 1. Items Master Data

### Fields

* **Item Code**
* **Item Full Name**
* **Related Supplier(s)**
* **Inventory Account**
* **Sales Account**
* **COGS Account**

### Supplier Link

The same item can be linked to more than one supplier.

When the item is used in a Sales Invoice, the supplier(s) linked to that item must be available for selection.

---

## 2. Customers

### Fields

* **Customer Name**
* **Customer Code**
* **Payment Terms**
* **Contact Information**

### Payment Terms

A new payment term can be defined whenever required.

### Account Statement

* **Sales** are shown as **Debit**.
* **Payments or discounts** are shown as **Credit**.

---

## 3. Suppliers

### Fields

* **Supplier Name**
* **Supplier Code**
* **Payment Terms**
* **Contact Information**

### Payment Terms

A new payment term can be defined whenever required.

### Account Statement

* **Purchases** are shown as **Credit**.
* **Payments or discounts** are shown as **Debit**.

---

## 4. Purchase Invoice

### Header

* **Invoice Number** — automatically generated
* **Posting Date**
* **Due Date**
* **Supplier Code**
* **Supplier Name** — searchable

### Invoice Lines

* **Item Code**
* **Item Name** — automatically displayed when the Item Code is selected
* **Quantity**
* **Unit Price**
* **Discount**
* **Total Price**
* **Warehouse**

### Inventory Effect

A Purchase Invoice increases stock in the selected warehouse.

### Journal Entry

**Inventory Dr. / Accounts Payable Cr.**

### Posting

The Purchase Invoice is not posted until it receives **CEO approval**.

---

## 5. Sales Invoice

### Header

* **Invoice Number** — automatically generated
* **Posting Date**
* **Due Date**
* **Customer Code** — searchable
* **Customer Name** — searchable

### Invoice Lines

* **Item Code** — searchable
* **Item Name** — searchable
* **Quantity**
* **Unit Price**
* **Discount**
* **Total Price**
* **Supplier**
* **Warehouse**

Selecting the **Item Code** automatically brings the corresponding **Item Name**.

Selecting the **Item Name** brings the corresponding **Item Code**.

### Supplier

When an item is selected, the Supplier field must display the supplier(s) linked to that item.

The same item can be entered on separate invoice lines under different suppliers when required.

### Inventory Effect

A Sales Invoice decreases stock from the selected warehouse.

### Journal Entry

**Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.**

### COGS

COGS is calculated using **FIFO (First In, First Out)**.

The item cost follows the selected **item, supplier, and warehouse stock**.

### Posting

The Sales Invoice is not posted until it receives **CEO approval**.

---

## 6. Banks and Cash

### Master Data

* **Bank/Cash Name**
* **Bank Number** — automatically generated
* **Type** — Cash or Bank
* **Related Account**

### Statement

* **Incoming amounts** are shown as **Debit**.
* **Outgoing amounts** are shown as **Credit**.

### Payments

Payments must contain:

* **Supplier Name**
* **Supplier Code**
* **Date**
* **Bank/Cash Name**
* **Bank/Cash Code**
* **Amount**
* **Reference**
* **Supplier Invoice**

Payments can be allocated to the related supplier invoice, including **partial payments**.

### Payment Journal

**Accounts Payable Dr. / Bank or Cash Cr.**

### Receipts

Receipts must contain:

* **Customer Name**
* **Customer Code**
* **Date**
* **Bank/Cash Name**
* **Bank/Cash Code**
* **Amount**
* **Reference**
* **Customer Invoice**

Receipts can be allocated to the related customer invoice, including **partial receipts**.

### Receipt Journal

**Bank or Cash Dr. / Accounts Receivable Cr.**

---

## 7. Warehouses

### Warehouse Setup

* **Warehouse Name**
* **Warehouse Code**

### Warehouses Report

The warehouse report must display:

* **Item Name**
* **Item Code**
* **Warehouse Name**
* **Warehouse Code**
* **Quantity**
* **Total Price**

### Transfer

Items can be transferred between warehouses.

### Opening Stock

Opening Stock must contain:

* **Item Name**
* **Item Code**
* **Quantity**
* **Total Price**
* **Average Unit Price**
* **Warehouse Name**
* **Warehouse Code**

### Item Reconciliation

Item Reconciliation must contain:

* **Item Name**
* **Warehouse**
* **In/Out**
* **Adjustment Quantity**

The adjustment is entered as **In** or **Out** to match the actual inventory quantity.

### Stock Movement

* Purchases are recorded as **stock In**.
* Sales are recorded as **stock Out**.
* Warehouse transfers move stock **Out** from one warehouse and **In** to another.
* Reconciliation adjusts stock as **In** or **Out**.

---

## 8. Invoice Status Tracking (QS Suppliers)

### Source

A Purchase Invoice is automatically copied to this section with **all invoice details**.

### In Process

When the invoice is in **In Process**, its items are automatically booked to the **In Process warehouse**.

### On Board

When the status changes to **On Board**, the invoice items are automatically moved to the **On Board warehouse**.

### On Port

When the status changes to **On Port**, the invoice items are automatically moved to the **On Port warehouse**.

### In Bounded

When the status changes to **In Bounded**, a warehouse must be selected and the invoice items are automatically moved to that warehouse.

### Notification

Every status change sends a notification to the **selected system users**.

---

## 9. Sales Returns

### Header

* **Customer Name**
* **Customer Code**
* **Date**
* **Offset Account** — Accounts Receivable or Bank; one must be selected
* **Original Sales Invoice Number**

### Return Lines

* **Item Name**
* **Item Code**
* **Return Quantity**
* **Item Price** — taken from the original invoice
* **Warehouse** — where the returned stock will be allocated

### Quantity Control

The return quantity cannot exceed the **remaining returnable quantity** from the original Sales Invoice after considering previous returns.

### Journal Entry

**Sales Return Dr. / Accounts Receivable or Bank Cr. / Inventory Dr. / COGS Cr.**

### Cost

The Inventory and COGS amounts for each returned item are taken from the **original Sales Invoice item cost**.

---

## 10. Purchase Return

### Header

* **Supplier Name**
* **Supplier Code**
* **Date**
* **Offset Account** — Accounts Payable or Bank; one must be selected
* **Original Purchase Invoice Number**

### Return Lines

* **Item Name**
* **Item Code**
* **Return Quantity**
* **Item Price** — taken from the original invoice
* **Warehouse** — from which the item will be returned

### Quantity Control

The return quantity cannot exceed the **remaining returnable quantity** from the original Purchase Invoice after considering previous returns.

### Journal Entry

**Accounts Payable or Bank Dr. / Inventory Cr.**

---

## 11. System Inventory Control

### Negative Stock

**Negative stock is not allowed.**

The system must prevent inventory quantities from becoming negative.



 req: I need you to perform a **complete final audit of the entire ERP system** before we start operating it.

This is not a partial review. I need you to audit **everything, from the first screen to the last workflow**, and compare the actual implementation against my **ERP Operations Build** line by line.

The build is the **single source of truth**. Do not assume that something is correct because it already exists in the system.

### CRITICAL RULE 1 — ALL SYSTEM SEQUENCES MUST BE AUTOMATIC

Any code, number, ID, invoice number, bank/cash number, sequence, or other identifier that is supposed to be generated by the system must be **automatically generated by the system**.

Users must NOT manually enter these values.

This includes, at minimum:

* Item Code
* Purchase Invoice Number
* Sales Invoice Number
* Bank Number
* Cash Number
* Supplier/Customer codes if the implementation defines them as system-generated
* Any other sequence or identifier used by the system

For Item Code specifically:

**Item Code must be completely automatic.**

There must be:

* No manual Item Code input
* No editable Item Code field during creation
* No possibility for users to create duplicate or invalid Item Codes
* Automatic generation every time a new item is created
* Correct persistence of the generated code across the entire system

Please check **Phase 03** especially carefully for this issue and verify every sequence in that phase.

---

# FULL ERP AUDIT

## 1. ITEMS MASTER DATA

Verify that the Item master contains exactly the required functionality:

* Item Code
* Item Full Name
* Related Supplier(s)
* Inventory Account
* Sales Account
* COGS Account

Verify that:

* Item Code is system-generated automatically.
* The user cannot manually type or overwrite the Item Code.
* One item can be linked to multiple suppliers.
* Linked suppliers are available when the item is used in a Sales Invoice.
* Item Code and Item Name selection work correctly wherever required.
* No unnecessary item fields or features have been added.

---

## 2. CUSTOMERS

Verify:

* Customer Name
* Customer Code
* Payment Terms
* Contact Information

Check that:

* Customer Code follows the correct system-generation rule.
* Payment Terms can be created when required.
* Customer Account Statements work correctly.
* Sales appear as **Debit**.
* Payments and discounts appear as **Credit**.

Test the complete customer flow and verify that the accounting data is reflected correctly.

---

## 3. SUPPLIERS

Verify:

* Supplier Name
* Supplier Code
* Payment Terms
* Contact Information

Check that:

* Supplier Code follows the correct system-generation rule.
* New payment terms can be created when required.
* Supplier Account Statements work correctly.
* Purchases appear as **Credit**.
* Payments and discounts appear as **Debit**.

Test the complete supplier flow.

---

# 4. PURCHASE INVOICE

Audit every part of the Purchase Invoice.

### Header

* Invoice Number — automatically generated
* Posting Date
* Due Date
* Supplier Code
* Supplier Name — searchable

### Lines

* Item Code
* Item Name
* Quantity
* Unit Price
* Discount
* Total Price
* Warehouse

Verify that:

* Invoice Number is automatically generated.
* Item Name is automatically shown when Item Code is selected.
* Purchase Invoice correctly increases stock in the selected warehouse.
* Correct warehouse receives the stock.
* Correct accounting entry is generated:

**Inventory Dr. / Accounts Payable Cr.**

Most importantly:

**Purchase Invoice must NOT be posted before CEO approval.**

Test the approval restriction in practice.

---

# 5. SALES INVOICE

Audit the entire Sales Invoice workflow.

### Header

* Invoice Number — automatically generated
* Posting Date
* Due Date
* Customer Code — searchable
* Customer Name — searchable

### Lines

* Item Code — searchable
* Item Name — searchable
* Quantity
* Unit Price
* Discount
* Total Price
* Supplier
* Warehouse

Verify both-direction selection:

* Selecting Item Code must bring Item Name.
* Selecting Item Name must bring Item Code.

### Supplier Logic

When an item is selected:

* The linked supplier(s) must be displayed.
* The user must be able to select the appropriate supplier.
* The same item must be allowed on separate invoice lines under different suppliers when required.

### Inventory

Verify that:

* Sales decrease stock.
* Stock is deducted from the selected warehouse.
* The system cannot deduct stock from the wrong warehouse.

### COGS

Verify that COGS uses:

**FIFO — First In, First Out**

The cost must correctly follow:

**Item + Supplier + Warehouse Stock**

Do not just check the calculation visually. Test actual inventory scenarios with multiple purchases and different costs to confirm FIFO behavior.

### Journal Entry

Verify:

**Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.**

### Approval

A Sales Invoice must **NOT be posted until CEO approval**.

Test this restriction.

---

# 6. BANKS AND CASH

Audit:

### Master Data

* Bank/Cash Name
* Bank Number — automatically generated
* Type — Cash or Bank
* Related Account

Verify all numbers/sequences are automatically generated where required.

### Statement

Verify:

* Incoming = Debit
* Outgoing = Credit

### Supplier Payments

Verify:

* Supplier Name
* Supplier Code
* Date
* Bank/Cash Name
* Bank/Cash Code
* Amount
* Reference
* Supplier Invoice

Test:

* Full payment allocation
* Partial payment allocation
* Correct outstanding balance after payment
* Correct supplier statement
* Correct journal entry:

**Accounts Payable Dr. / Bank or Cash Cr.**

### Customer Receipts

Verify:

* Customer Name
* Customer Code
* Date
* Bank/Cash Name
* Bank/Cash Code
* Amount
* Reference
* Customer Invoice

Test:

* Full receipt allocation
* Partial receipt allocation
* Correct outstanding balance
* Correct customer statement
* Correct journal entry:

**Bank or Cash Dr. / Accounts Receivable Cr.**

---

# 7. WAREHOUSES

Audit the entire inventory warehouse system.

### Warehouse Setup

* Warehouse Name
* Warehouse Code

### Warehouse Report

Must correctly show:

* Item Name
* Item Code
* Warehouse Name
* Warehouse Code
* Quantity
* Total Price

### Transfer

Test warehouse transfers.

Verify that transferring stock:

* Decreases stock from the source warehouse.
* Increases stock in the destination warehouse.
* Does not create or destroy inventory.
* Correctly records the movement.

### Opening Stock

Verify:

* Item Name
* Item Code
* Quantity
* Total Price
* Average Unit Price
* Warehouse Name
* Warehouse Code

### Item Reconciliation

Verify:

* Item Name
* Warehouse
* In/Out
* Adjustment Quantity

Test both:

* Stock In adjustment
* Stock Out adjustment

### Stock Movement

Verify the complete logic:

* Purchase = Stock In
* Sale = Stock Out
* Transfer = Stock Out from source + Stock In to destination
* Reconciliation = Stock In or Stock Out

Check that all inventory movements remain consistent throughout the ERP.

---

# 8. INVOICE STATUS TRACKING — QS SUPPLIERS

Audit this workflow very carefully because it contains automatic warehouse movement.

### Source

A Purchase Invoice must automatically be copied into this section with **all invoice details**.

### In Process

When status is **In Process**:

* Invoice items automatically move/book into the **In Process warehouse**.

### On Board

When status changes to **On Board**:

* Items automatically move to the **On Board warehouse**.

### On Port

When status changes to **On Port**:

* Items automatically move to the **On Port warehouse**.

### In Bounded

When status changes to **In Bounded**:

* The system must require a warehouse selection.
* Items must automatically move to the selected warehouse.

### Notifications

Every status change must send a notification to the selected system users.

Test every status transition individually.

Also test that the inventory is not duplicated when the status changes multiple times.

---

# 9. SALES RETURNS

Audit:

### Header

* Customer Name
* Customer Code
* Date
* Offset Account
* Original Sales Invoice Number

Offset Account must allow:

* Accounts Receivable
* Bank

One must be selected.

### Lines

* Item Name
* Item Code
* Return Quantity
* Item Price from Original Invoice
* Warehouse

### Critical Quantity Rule

The return quantity must **never exceed the remaining returnable quantity** from the original Sales Invoice after previous returns.

Test:

* Full return
* Partial return
* Multiple partial returns
* Attempted return exceeding remaining quantity

The system must block invalid returns.

### Journal

Verify:

**Sales Return Dr. / Accounts Receivable or Bank Cr. / Inventory Dr. / COGS Cr.**

### Cost

Inventory and COGS amounts for returned items must come from the **original Sales Invoice item cost**.

Test this with different FIFO costs.

---

# 10. PURCHASE RETURNS

Audit:

### Header

* Supplier Name
* Supplier Code
* Date
* Offset Account
* Original Purchase Invoice Number

Offset Account must allow:

* Accounts Payable
* Bank

One must be selected.

### Lines

* Item Name
* Item Code
* Return Quantity
* Item Price from Original Invoice
* Warehouse

### Quantity Rule

The return quantity must never exceed the **remaining returnable quantity** from the original Purchase Invoice after previous returns.

Test:

* Full return
* Partial return
* Multiple partial returns
* Attempted return above the remaining quantity

### Journal

Verify:

**Accounts Payable or Bank Dr. / Inventory Cr.**

Also verify the correct warehouse stock reduction.

---

# 11. NEGATIVE STOCK CONTROL

This is mandatory.

**Negative stock is NOT allowed.**

Test situations where:

* A Sales Invoice attempts to sell more than available stock.
* A warehouse transfer attempts to transfer more than available stock.
* A return or adjustment could create an invalid quantity.

The system must prevent negative inventory.

Do not only hide the error visually. The backend/database/business logic must also prevent invalid stock.

---

# 12. CROSS-SYSTEM CONSISTENCY AUDIT

This is extremely important.

Do not test each module in isolation.

Run complete end-to-end scenarios such as:

**Supplier → Purchase Invoice → CEO Approval → Warehouse Stock → Sales Invoice → FIFO COGS → Customer Receivable → Customer Receipt → Sales Return / Purchase Return**

Verify that every transaction correctly updates:

* Inventory
* Warehouse balances
* Customer balances
* Supplier balances
* Accounts
* Journal Entries
* Invoice status
* Payment/receipt allocations
* Returnable quantities
* COGS
* Stock valuation

The same transaction must never produce conflicting data between modules.

---

# 13. AUTOMATIC NUMBER / SEQUENCE AUDIT

Search the entire ERP codebase and UI for every manually entered sequence or identifier.

For every system-generated value, verify:

1. It is generated automatically.
2. It is unique.
3. It cannot be accidentally duplicated.
4. It cannot be incorrectly manually edited.
5. It remains consistent after saving.
6. It remains consistent after reopening the record.
7. It remains consistent across related modules.
8. Concurrent creation cannot create duplicate numbers.
9. Deleted/failed transactions cannot corrupt the sequence.
10. The UI does not expose unnecessary manual-entry fields.

Pay special attention to **Phase 03**.

---

# 14. REMOVE EVERYTHING NOT REQUESTED

Compare the current ERP against my build.

Anything that is:

* Not requested
* Not necessary for the requested workflows
* An unnecessary field
* An unnecessary button
* An unnecessary workflow
* An unnecessary status
* An unnecessary report
* An unnecessary option
* An unnecessary configuration
* Extra functionality that was never requested

should be removed unless it is technically required for the requested functionality.

Do NOT add new functionality during this audit just because it might be useful.

The goal is to implement **my build accurately**, not to expand the scope.

---

# 15. FINAL CODE + DATABASE AUDIT

Do not only test the frontend.

Audit:

* Frontend validation
* Backend validation
* API logic
* Database constraints
* Transaction handling
* Accounting logic
* Inventory calculations
* Sequence generation
* Permissions
* Approval logic
* Data relationships
* Error handling
* Duplicate prevention
* Race conditions where relevant

A rule must not exist only in the UI.

For example, if Item Code must be automatic, the backend/database must also prevent a user or API request from manually creating an invalid Item Code.

---

# 16. TEST EVERY REQUIREMENT

For every requirement in my build, mark it internally as:

**PASS** — implemented and tested correctly

**FAIL** — incorrect or missing

**FIXED** — issue found and corrected

**NOT APPLICABLE** — only when genuinely not applicable

Do not mark something as correct simply because the screen exists.

A feature is only considered complete when the actual behavior has been tested.

---

# 17. FINAL RESULT I EXPECT

Before the 7 PM Iraq-time call, I need the system to be in a **final operational state**.

Please:

1. Audit the complete ERP.
2. Compare everything against the ERP Operations Build.
3. Find missing requirements.
4. Find incorrect implementations.
5. Find calculation/accounting errors.
6. Find inventory errors.
7. Find workflow errors.
8. Find validation problems.
9. Find manually generated sequences.
10. Find unnecessary extras.
11. Fix all issues found.
12. Test the fixes again.
13. Perform a final end-to-end test.

At **7:00 PM Iraq time today**, we will test the entire ERP together.

The objective is that after this final audit, we can operate the system tomorrow without discovering basic implementation problems.

Please treat this as a **production-readiness audit**, not a normal development review.

**Do not tell me that something is correct without actually checking it.**

**Do not assume existing functionality is correct.**

**Do not add features that are not in the build.**

**Do not leave manual sequence generation anywhere it should be automatic.**

The **ERP Operations Build is the final authority for what the system must do.**
