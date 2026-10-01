# QS — how the business works, and how its payables work

Read this before anything else in `docs/requirements/`. It is the plain-English
account of the company the system serves: what it buys, from whom, how it pays,
how the goods arrive, and what goes wrong. The requirements assume it.

## Who we are

QS is an Iraqi importer and distributor of solar equipment — panels, batteries,
inverters, mounting structures, cables, and occasionally other goods such as
electric scooters. We buy from manufacturers and trading companies in China,
Singapore and the UAE (Smartelectric, Eenovance, Flyfine, CNBM, Aiko, Longi,
Jinko and around twenty others) and sell from warehouses in Iraq. Over the
last twelve months we opened 58 import files worth about USD 35 million, and
at any time roughly a third of that money is somewhere between our bank and
the supplier, or between the factory and our warehouse.

## Everything we owe is a payable

The biggest payables are the imports, but every month we also owe the
landlord for the office, the electricity and internet companies, the freight
forwarders and customs brokers who move our containers, the consultants, and
the banks for their charges and loan instalments. In the system all of these
are one kind of record — a **payable** — with the same questions asked of
each: what do we owe, to whom, by when, has it been approved, has the money
gone, has it been confirmed, and if it is late, why?

## How an import works, from start to finish

It starts when a supplier sends a **proforma invoice (PI)**: the models, the
quantities, the price, and the payment terms. The terms are almost always in
two parts — a deposit of 10–50 % now, and the balance *against the bill of
lading*, which means when the goods are on the ship, or sometimes 60–90 days
later under Sinosure credit. The PI number becomes the reference everything
else follows.

Before we can pay a foreign supplier, our bank needs a **pre-declaration
(PD)** registered in ASYCUDA, the Iraqi customs system. The customs clerk
submits it, the bank is named on it, it goes through *Submitted → PreApproved
→ Validated*, and it stays valid for about six months. Only with a validated
PD will the bank accept our **payment application** — the file we send asking
them to transfer the money by SWIFT. We work with Mansour, Arab Bank, NBI and
Rafidain. The money for a payment is either our own, deposited into the
account, or a **bank loan**: Rafidain, for example, lends against a commission
deducted up front and repaid in instalments on fixed dates.

Then we wait for the bank. A SWIFT normally clears in about eleven days; some
take three weeks, and a few have taken three months. When it clears we record
the SWIFT date and reference; that is the moment the supplier is paid, the
money leaves our account, and our purchase invoice is settled.

Once the deposit is paid the factory produces and ships. One invoice may go on
several **bills of lading**, and one bill of lading may cover anything from
one to fifteen **containers**, arriving through Aqaba in Jordan or Umm Qasr in
southern Iraq. Containers from the same invoice arrive weeks apart. At the
port the broker clears each container, the "port file" goes back to the PD so
customs can write it off, and the container is trucked to one of our
warehouses — CNBM, Baghdad Al-Jurf and the others — where the warehouse team
counts what came in. Only when every container is received, every instalment
is paid, and the PD is *totally written off* is the import finished.

### A real example

Invoice CSA-AL0001-1 from Smartelectric, January 2026: USD 1.34 million of
panels, batteries and inverters, 5,807 units, 40 % deposit and the balance
before delivery. PD 9330 was registered on 18 January and validated. The
goods came on four bills of lading and ten containers, seven of them through
Umm Qasr and three through Aqaba, between February and May; the last were
received in late August. The PD expired on 10 September with part of it still
not written off — the port files were outstanding — so the file is not closed
even though the goods are sold and the supplier is paid.

## How a service payable works

The Erbil office lease is a contract, not an invoice: a fixed amount every
month, due on the first. Nobody has to confirm that the office was
"delivered" — the lease is the evidence — but the payment still goes through
the same approval and payment steps, and if October's rent is not paid by the
second of the month the system asks why, exactly as it asks why a SWIFT is
late.

A forwarder's bill is different again: the department that ordered the work
confirms it was done, the invoice is approved, and because the cost belongs to
a particular import, it is charged to that import's landed cost rather than
lost in general expenses. Utilities, brokers, consultants and bank charges
follow the same path: request → confirm (where there is something to confirm)
→ invoice → approve → pay → close.

## What goes wrong today

Until now the imports lived in a Google Sheet and the rest lived in e-mails.
The sheet records *that* something happened but never *why it hasn't*:

* Twenty-five payment applications are unpaid, some for a hundred days, and
  not one has a written reason.
* Containers are a list of numbers in one cell, so "seven of ten arrived"
  cannot be said.
* Received quantities were copied from the invoice onto every bill of lading,
  so one import appears to have been received four times over.
* Eleven "unpaid" files have PDs already written off — paid, but never
  recorded.
* The rent, the forwarders and the brokers are not in the sheet at all.

## What the Payables module changes

One record per payable, from the PI (or the lease) to closed. Every update
from every department — the clerk's PD status, the accountant's SWIFT date,
the logistics officer's container ETA, the warehouse count — lands in that
record's **status log**, dated and signed, never overwritten. When any step
passes its time limit the record is marked **stopped** and must carry a reason
code, an owner and a next action; the daily check does the marking, people
supply the why. The money side is one process for everything: funds checked
and reserved, application sent, confirmation recorded, statement matched.
Containers are tracked one by one. And at the end, the real **landed cost** of
each panel — purchase price plus freight, customs, port, bank commission and
loan cost — is known, not estimated.

## Words we use

| Word | Meaning |
|---|---|
| **PI** | Proforma invoice — the supplier's offer we accept; its number is our reference. |
| **PD** | Pre-declaration registered in ASYCUDA (Iraqi customs); the bank pays only against a validated PD. |
| **Payment application** | Our request to the bank (or cashier) to pay; SWIFT for foreign suppliers, local transfer, cash or cheque otherwise. |
| **SWIFT date** | The day the bank confirms the transfer went — the day the supplier is paid. |
| **B/L** | Bill of lading — the shipping document; one per vessel booking, listing its containers. |
| **Port file** | The customs papers for an arrived container, returned to the PD so it can be written off. |
| **Written off** | Customs has settled the PD for the goods that arrived — partially, then totally. |
| **Landed cost** | What a unit really cost us: purchase + freight + customs + port + bank commission + loan cost. |
| **Stopped** | A step is past its time limit or blocked; the record carries why, who owns it, and what happens next. |
| **Cleared** | An import is finished: fully paid, every container received, PD totally written off. |

*Written 2026-10-01 from `QS_DASHBOARD.xlsx` and the workflow page
`docs/requirements/REQ-AP-001-workflow.pdf`. Figures are as of that date.*
