# ERP Navigation Structure & Dropdown Menus

This document outlines the complete navigation bar hierarchy, dropdown categories, and route destinations for the ERP system.

---

## 🧭 Navigation Bar Overview

```text
[ Logo ]  Dashboard  |  Accounting ▾  |  Sales ▾  |  Purchasing ▾  |  Inventory ▾  |  Settings ▾
```

| # | Main Nav Item | Dropdown Subsections | Total Links | Direct Route |
|---|---------------|----------------------|:-----------:|--------------|
| 1 | **Dashboard** | *None (Direct)* | 1 | `/` |
| 2 | **Accounting** | Finance — General Ledger, Treasury & Banking, Master Data | 22 | `/finance` |
| 3 | **Sales** | Sales Operations & Receivables | 6 | `/sales` |
| 4 | **Purchasing** | Purchasing Operations & Payables | 6 | `/purchasing` |
| 5 | **Inventory** | Inventory & Warehouses | 9 | `/inventory` |
| 6 | **Settings** | Administration & Configuration | 8 | `/administration` |

---

## 📂 Detailed Navigation & Dropdown Hierarchy

### 1. Dashboard
Direct root destination.
* 🏠 **[Dashboard](https://erp.qs-groups.com/)** (`/`)

---

### 2. Accounting ▾

#### 🔹 Group A: Finance — General Ledger
* 📖 **[Journal Entry](https://erp.qs-groups.com/finance/journals)** — `/finance/journals`
* 🔄 **[Reversals](https://erp.qs-groups.com/finance/reversals)** — `/finance/reversals`
* 🔍 **[G/L Inquiry](https://erp.qs-groups.com/finance/gl-inquiry)** — `/finance/gl-inquiry`
* ⚖️ **[Trial Balance](https://erp.qs-groups.com/finance/trial-balance)** — `/finance/trial-balance`
* 📅 **[Accounting Periods](https://erp.qs-groups.com/finance/periods)** — `/finance/periods`
* ⚙️ **[Posting Mappings](https://erp.qs-groups.com/finance/posting-mappings)** — `/finance/posting-mappings`
* 📈 **[Income Statement](https://erp.qs-groups.com/finance/income-statement)** — `/finance/income-statement`
* 🏛️ **[Balance Sheet](https://erp.qs-groups.com/finance/balance-sheet)** — `/finance/balance-sheet`
* 📊 **[Changes in Equity](https://erp.qs-groups.com/finance/changes-in-equity)** — `/finance/changes-in-equity`
* 💵 **[Cash Flow Statement](https://erp.qs-groups.com/finance/cash-flow)** — `/finance/cash-flow`

#### 🔹 Group B: Treasury & Banking
* 🏦 **[Bank Accounts](https://erp.qs-groups.com/master-data/bank-accounts)** — `/master-data/bank-accounts`
* 🪙 **[Cash Accounts](https://erp.qs-groups.com/master-data/cash-accounts)** — `/master-data/cash-accounts`
* 📑 **[Bank and Cash Reporting](https://erp.qs-groups.com/treasury/reporting)** — `/treasury/reporting`

#### 🔹 Group C: Master Data
* 🗂️ **[Chart of Accounts](https://erp.qs-groups.com/master-data/chart-of-accounts)** — `/master-data/chart-of-accounts`
* 🗺️ **[Statement Mapping](https://erp.qs-groups.com/master-data/statement-mapping)** — `/master-data/statement-mapping`
* 💱 **[Currencies and Rates](https://erp.qs-groups.com/master-data/exchange-rates)** — `/master-data/exchange-rates`
* 🏢 **[Branches](https://erp.qs-groups.com/master-data/branches)** — `/master-data/branches`
* 🏬 **[Departments](https://erp.qs-groups.com/master-data/departments)** — `/master-data/departments`
* 🎯 **[Cost Centres](https://erp.qs-groups.com/master-data/cost-centres)** — `/master-data/cost-centres`
* 🏭 **[Warehouses](https://erp.qs-groups.com/master-data/warehouses)** — `/master-data/warehouses`
* 📜 **[Payment Terms](https://erp.qs-groups.com/master-data/payment-terms)** — `/master-data/payment-terms`
* 💳 **[Payment Methods](https://erp.qs-groups.com/master-data/payment-methods)** — `/master-data/payment-methods`

---

### 3. Sales ▾

#### 🔹 Sales & Accounts Receivable
* 👥 **[Customers](https://erp.qs-groups.com/sales/customers)** — `/sales/customers`
* 📄 **[Customer Statements](https://erp.qs-groups.com/sales/customer-statements)** — `/sales/customer-statements`
* 🧾 **[Sales Invoices](https://erp.qs-groups.com/sales/ar-invoices)** — `/sales/ar-invoices`
* ⏳ **[Receivables Ageing](https://erp.qs-groups.com/sales/receivables)** — `/sales/receivables`
* 💰 **[Customer Receipts](https://erp.qs-groups.com/sales/customer-receipts)** — `/sales/customer-receipts`
* ↩️ **[Sales Returns](https://erp.qs-groups.com/sales/sales-returns)** — `/sales/sales-returns`

---

### 4. Purchasing ▾

#### 🔹 Procurement & Accounts Payable
* 🚚 **[Suppliers](https://erp.qs-groups.com/purchasing/suppliers)** — `/purchasing/suppliers`
* 📄 **[Supplier Statements](https://erp.qs-groups.com/purchasing/supplier-statements)** — `/purchasing/supplier-statements`
* 🧾 **[Purchase Invoices](https://erp.qs-groups.com/purchasing/ap-invoices)** — `/purchasing/ap-invoices`
* ⏳ **[Payables Ageing](https://erp.qs-groups.com/purchasing/payables)** — `/purchasing/payables`
* 💸 **[Supplier Payments](https://erp.qs-groups.com/purchasing/supplier-payments)** — `/purchasing/supplier-payments`
* 📦 **[Purchase Returns](https://erp.qs-groups.com/purchasing/goods-returns)** — `/purchasing/goods-returns`

---

### 5. Inventory ▾

#### 🔹 Inventory & Warehouses
* 📥 **[Opening Stock](https://erp.qs-groups.com/inventory/opening-stock)** — `/inventory/opening-stock`
* 🔁 **[Stock Movement](https://erp.qs-groups.com/inventory/stock-movements)** — `/inventory/stock-movements`
* 📒 **[Stock Ledger](https://erp.qs-groups.com/inventory/stock-ledger)** — `/inventory/stock-ledger`
* 🔀 **[Transfer](https://erp.qs-groups.com/inventory/transfers)** — `/inventory/transfers`
* 🚚 **[Invoice Status Tracking](https://erp.qs-groups.com/inventory/in-transit)** — `/inventory/in-transit`
* 📦 **[Items](https://erp.qs-groups.com/inventory/items)** — `/inventory/items`
* 📏 **[Units of Measure](https://erp.qs-groups.com/inventory/uom)** — `/inventory/uom`
* 📑 **[Item Reconciliation](https://erp.qs-groups.com/inventory/stock-reconciliation)** — `/inventory/stock-reconciliation`
* 📊 **[Warehouses Report](https://erp.qs-groups.com/inventory/fifo-valuation)** — `/inventory/fifo-valuation`

---

### 6. Settings ▾

#### 🔹 Administration & System Setup
* 🏢 **[Company Profile](https://erp.qs-groups.com/administration/company)** — `/administration/company`
* 👤 **[Users](https://erp.qs-groups.com/administration/users)** — `/administration/users`
* 🛡️ **[Roles](https://erp.qs-groups.com/administration/roles)** — `/administration/roles`
* 🔑 **[Permissions](https://erp.qs-groups.com/administration/permissions)** — `/administration/permissions`
* 🔢 **[Numbering Series](https://erp.qs-groups.com/administration/numbering)** — `/administration/numbering`
* 📜 **[Audit Trail](https://erp.qs-groups.com/administration/audit)** — `/administration/audit`
* ⚙️ **[System Parameters](https://erp.qs-groups.com/administration/parameters)** — `/administration/parameters`
* ⏳ **[Background Jobs](https://erp.qs-groups.com/administration/jobs)** — `/administration/jobs`

---

## 📊 Comprehensive Route Reference Matrix

| Main Menu | Section / Category | Menu Item Name | Relative Route | Full URL |
| :--- | :--- | :--- | :--- | :--- |
| **Dashboard** | Overview | Dashboard | `/` | `https://erp.qs-groups.com/` |
| **Accounting** | Finance — General Ledger | Journal Entry | `/finance/journals` | `https://erp.qs-groups.com/finance/journals` |
| **Accounting** | Finance — General Ledger | Reversals | `/finance/reversals` | `https://erp.qs-groups.com/finance/reversals` |
| **Accounting** | Finance — General Ledger | G/L Inquiry | `/finance/gl-inquiry` | `https://erp.qs-groups.com/finance/gl-inquiry` |
| **Accounting** | Finance — General Ledger | Trial Balance | `/finance/trial-balance` | `https://erp.qs-groups.com/finance/trial-balance` |
| **Accounting** | Finance — General Ledger | Accounting Periods | `/finance/periods` | `https://erp.qs-groups.com/finance/periods` |
| **Accounting** | Finance — General Ledger | Posting Mappings | `/finance/posting-mappings` | `https://erp.qs-groups.com/finance/posting-mappings` |
| **Accounting** | Finance — General Ledger | Income Statement | `/finance/income-statement` | `https://erp.qs-groups.com/finance/income-statement` |
| **Accounting** | Finance — General Ledger | Balance Sheet | `/finance/balance-sheet` | `https://erp.qs-groups.com/finance/balance-sheet` |
| **Accounting** | Finance — General Ledger | Changes in Equity | `/finance/changes-in-equity` | `https://erp.qs-groups.com/finance/changes-in-equity` |
| **Accounting** | Finance — General Ledger | Cash Flow Statement | `/finance/cash-flow` | `https://erp.qs-groups.com/finance/cash-flow` |
| **Accounting** | Treasury & Banking | Bank Accounts | `/master-data/bank-accounts` | `https://erp.qs-groups.com/master-data/bank-accounts` |
| **Accounting** | Treasury & Banking | Cash Accounts | `/master-data/cash-accounts` | `https://erp.qs-groups.com/master-data/cash-accounts` |
| **Accounting** | Treasury & Banking | Bank and Cash Reporting | `/treasury/reporting` | `https://erp.qs-groups.com/treasury/reporting` |
| **Accounting** | Master Data | Chart of Accounts | `/master-data/chart-of-accounts` | `https://erp.qs-groups.com/master-data/chart-of-accounts` |
| **Accounting** | Master Data | Statement Mapping | `/master-data/statement-mapping` | `https://erp.qs-groups.com/master-data/statement-mapping` |
| **Accounting** | Master Data | Currencies and Rates | `/master-data/exchange-rates` | `https://erp.qs-groups.com/master-data/exchange-rates` |
| **Accounting** | Master Data | Branches | `/master-data/branches` | `https://erp.qs-groups.com/master-data/branches` |
| **Accounting** | Master Data | Departments | `/master-data/departments` | `https://erp.qs-groups.com/master-data/departments` |
| **Accounting** | Master Data | Cost Centres | `/master-data/cost-centres` | `https://erp.qs-groups.com/master-data/cost-centres` |
| **Accounting** | Master Data | Warehouses | `/master-data/warehouses` | `https://erp.qs-groups.com/master-data/warehouses` |
| **Accounting** | Master Data | Payment Terms | `/master-data/payment-terms` | `https://erp.qs-groups.com/master-data/payment-terms` |
| **Accounting** | Master Data | Payment Methods | `/master-data/payment-methods` | `https://erp.qs-groups.com/master-data/payment-methods` |
| **Sales** | Sales | Customers | `/sales/customers` | `https://erp.qs-groups.com/sales/customers` |
| **Sales** | Sales | Customer Statements | `/sales/customer-statements` | `https://erp.qs-groups.com/sales/customer-statements` |
| **Sales** | Sales | Sales Invoices | `/sales/ar-invoices` | `https://erp.qs-groups.com/sales/ar-invoices` |
| **Sales** | Sales | Receivables Ageing | `/sales/receivables` | `https://erp.qs-groups.com/sales/receivables` |
| **Sales** | Sales | Customer Receipts | `/sales/customer-receipts` | `https://erp.qs-groups.com/sales/customer-receipts` |
| **Sales** | Sales | Sales Returns | `/sales/sales-returns` | `https://erp.qs-groups.com/sales/sales-returns` |
| **Purchasing** | Purchasing | Suppliers | `/purchasing/suppliers` | `https://erp.qs-groups.com/purchasing/suppliers` |
| **Purchasing** | Purchasing | Supplier Statements | `/purchasing/supplier-statements` | `https://erp.qs-groups.com/purchasing/supplier-statements` |
| **Purchasing** | Purchasing | Purchase Invoices | `/purchasing/ap-invoices` | `https://erp.qs-groups.com/purchasing/ap-invoices` |
| **Purchasing** | Purchasing | Payables Ageing | `/purchasing/payables` | `https://erp.qs-groups.com/purchasing/payables` |
| **Purchasing** | Purchasing | Supplier Payments | `/purchasing/supplier-payments` | `https://erp.qs-groups.com/purchasing/supplier-payments` |
| **Purchasing** | Purchasing | Purchase Returns | `/purchasing/goods-returns` | `https://erp.qs-groups.com/purchasing/goods-returns` |
| **Inventory** | Inventory & Warehouses | Opening Stock | `/inventory/opening-stock` | `https://erp.qs-groups.com/inventory/opening-stock` |
| **Inventory** | Inventory & Warehouses | Stock Movement | `/inventory/stock-movements` | `https://erp.qs-groups.com/inventory/stock-movements` |
| **Inventory** | Inventory & Warehouses | Stock Ledger | `/inventory/stock-ledger` | `https://erp.qs-groups.com/inventory/stock-ledger` |
| **Inventory** | Inventory & Warehouses | Transfer | `/inventory/transfers` | `https://erp.qs-groups.com/inventory/transfers` |
| **Inventory** | Inventory & Warehouses | Invoice Status Tracking | `/inventory/in-transit` | `https://erp.qs-groups.com/inventory/in-transit` |
| **Inventory** | Inventory & Warehouses | Items | `/inventory/items` | `https://erp.qs-groups.com/inventory/items` |
| **Inventory** | Inventory & Warehouses | Units of Measure | `/inventory/uom` | `https://erp.qs-groups.com/inventory/uom` |
| **Inventory** | Inventory & Warehouses | Item Reconciliation | `/inventory/stock-reconciliation` | `https://erp.qs-groups.com/inventory/stock-reconciliation` |
| **Inventory** | Inventory & Warehouses | Warehouses Report | `/inventory/fifo-valuation` | `https://erp.qs-groups.com/inventory/fifo-valuation` |
| **Settings** | Administration | Company Profile | `/administration/company` | `https://erp.qs-groups.com/administration/company` |
| **Settings** | Administration | Users | `/administration/users` | `https://erp.qs-groups.com/administration/users` |
| **Settings** | Administration | Roles | `/administration/roles` | `https://erp.qs-groups.com/administration/roles` |
| **Settings** | Administration | Permissions | `/administration/permissions` | `https://erp.qs-groups.com/administration/permissions` |
| **Settings** | Administration | Numbering Series | `/administration/numbering` | `https://erp.qs-groups.com/administration/numbering` |
| **Settings** | Administration | Audit Trail | `/administration/audit` | `https://erp.qs-groups.com/administration/audit` |
| **Settings** | Administration | System Parameters | `/administration/parameters` | `https://erp.qs-groups.com/administration/parameters` |
| **Settings** | Administration | Background Jobs | `/administration/jobs` | `https://erp.qs-groups.com/administration/jobs` |
