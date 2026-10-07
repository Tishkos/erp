# What is left

Work that was asked for and is not finished, written down when the owner decided
to deploy on 2026-10-07 ("tell them document it … push and deploy … later once
we do everything … put in folder What is left"). One file per piece of work; read
the file before picking it up, and delete it (or move its line here to Done) when
it is finished.

| File | What | State at the deploy |
|---|---|---|
| [date-filters-and-sorting.md](date-filters-and-sorting.md) | A *Filter* button (Date from / Date to, Newest / Oldest first, newest first by default) on every register | Done on the busiest registers; the rest listed in the file |
| [due-date-after-swift.md](due-date-after-swift.md) | No due date shown, aged or reminded until it is set; the *Set the due date for the balance* dialog on the import application once a payment application is paid | See the file |
| [toasts.md](toasts.md) | Pop-up notifications (success, error, new notification, new chat message) and the On / Off switch | See the file |

## Smaller items noticed along the way

* **Empty states.** `src/components/admin/empty-state.tsx` exists (and the error and not-found pages use it); the ten most visible whole-page empties still draw the old row — `/notifications`, `/tasks`, `/approvals`, `/exceptions`, `/search`, `/documents`, `/chat`, `/profile/views`, `/finance/periods`, `/master-data/exchange-rates`, and the Monitoring "soon" screens.
* **Noah's account-menu picture.** `src/server/guide/markers.ts` numbers only `.erp-user-panel__item` entries, so the Active branch, Language, status and Sounds parts of the account menu are not numbered in his live picture of it.
* **Noah reads the section tabs' text** for a picture; since the tabs overflow behind *More*, that text includes "More" and a count.
* **The bank/cash account page** formats its `*Iqd` figures with the account's own currency code (harmless for an IQD account; a USD account would show dinar figures labelled USD).
* **Supplier ageing totals** (`open-items.ageing()`) are summed with `Number()`; the donut above them adds the same rows exactly.
* **Customer edit form** still shows Payment terms (only the New customer form dropped it); the Customers list still has its Payment terms column.
* **The development database** (`erp_ui`) is to be rebuilt from nothing (owner's choice): `C:\Users\tiish\.claude\jobs\619567b7\tmp\ops\rebuild-erp-ui.sh`, then the owner's appearance set as everyone's default again (`scripts/ops/set-company-appearance.ts --from-json …`). The e2e suite expects the built-in look, so run it before setting the default, or clear it for the run.
* **Live: everyone's default appearance.** After the deploy, set the owner's setup as the company default on live (`scripts/ops/set-company-appearance.ts --as <owner's live account> --from-json <file> --apply`, on the server).
