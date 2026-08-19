Qimah al safinah qs stands for qimah al safinah is just a company selected company active company


For D7, record it as:

Expense normal balance — resolved: X000001 — Expense — QS showed Cr only as a placeholder/default display because the balance was zero. It does not represent the account’s accounting configuration. Expense accounts are debit-normal.


Qimah Al Safinah (QS) is the company the ERP is being built for.

So in D7, you do not need to keep asking whether QS is “one entity among several.” For the current scope, QS simply identifies Qimah Al Safinah.

You can replace that whole uncertainty with:

Company scope — resolved: The ERP is being developed for Qimah Al Safinah (QS). The Chart of Accounts belongs to Qimah Al Safinah. Any future multi-company structure would be treated as a separate future requirement and does not need to complicate the current Chart of Accounts design.

That leaves the more practical D7 questions: account currencies, required dimensions, control-account responsibility, and whether all branches share the same Chart of Accounts. 


For accounts in the Chart of Accounts, should each account have one fixed currency?

For example:

Cash IQD → IQD only
Cash USD → USD only
Bank USD → USD only

Or should a single account be able to accept multiple currencies? 
should have mutliple selectable currenices in the begining say its not decided please 
Account currency — 🟢 Decided

Each Chart of Accounts account is limited to one currency only.

When creating a new account, the ERP should ask for the Account Currency at the beginning of the setup. The currency should not be assumed automatically.

For example:

Cash IQD → IQD
Cash USD → USD
Bank EUR → EUR

If Accounting needs the same type of account in another currency, they should create a separate account for that currency.


