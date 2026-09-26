# Print and export — every Operations Build document and report

Every document and report of the Operations Build prints as **PDF** and exports
to **Excel (.xlsx)** and **Word (.docx)**, in **English and Arabic**, from one
**Print / Export** menu on its screen. A document's record page also prints
cleanly with the browser's own print (Ctrl+P).

## How it is built

```
screen ──► builder (src/server/print/documents.ts, reports.ts)
             reads the same services the screen reads, with the screen's filters
           ──► PrintModel (src/server/print/model.ts)   figures kept as decimal strings
             ├─► renderPdf   (pdf.ts)   A4, embedded Arabic font, bidi (bidi.ts)
             ├─► renderXlsx  (xlsx.ts)  numbers, frozen heading, SUM totals
             ├─► renderDocx  (docx.ts)  the PDF's layout as an editable document
             └─► PrintSheet  (src/components/print/print-sheet.tsx)  Ctrl+P
```

- **One route** serves every copy: `/export/<key>/<number>?format=pdf|xlsx|docx&lang=en|ar`
  plus, for a report, the screen's own query string. (Two dozen per-screen
  routes each compiled the whole service graph separately and ran the
  development server out of memory.)
- **Permission**: `view` on the screen's object, then `print` for the PDF and
  `export` for Excel and Word (`src/server/print/access.ts`). Without either
  verb the menu does not appear and the URL is refused (403, audited as denied).
  Migration `0212` grants `print` to the Accounting Manager and officer and
  `export` to the manager on the objects that had neither.
- **Branch scope**: documents are read through row-level security, so another
  branch's document is not found (404); the handler checks the branch again.
- **Audit**: every copy is recorded as `<object>.exported` — who, which document
  or report, format, language, filters, file name, and `exportedAt` as an ISO string.

## Libraries, and why

| Format | Library | Why this one |
|---|---|---|
| PDF | `pdfkit` 0.20 | Pure JavaScript, no browser binary on the server; embeds TrueType fonts and shapes Arabic through fontkit. Maintained (2026 release). |
| Excel | `write-excel-file` 4.1 | Small (one dependency), maintained (2026); writes real number, date and formula cells, frozen rows, column widths, sheet names and right-to-left sheets. |
| Word | `docx` 9.7 | The maintained standard for generating .docx; repeating header rows, rows that cannot split, page-number fields, right-to-left tables, embedded fonts, header images. |

The Arabic face is **IBM Plex Sans Arabic** (SIL Open Font License, licence
beside the files in `src/server/print/assets/`), embedded in every PDF and
Word file and loaded by the print sheet.

## Documents and reports

| Document / report | Screen | PDF | Excel | Word |
|---|---|---|---|---|
| Purchase Invoice | record | ✓ | ✓ | ✓ |
| Sales Invoice | record | ✓ | ✓ | ✓ |
| Supplier Payment (with its invoice allocations) | record | ✓ | ✓ | ✓ |
| Customer Receipt (with its invoice allocations) | record | ✓ | ✓ | ✓ |
| Sales Return | record | ✓ | ✓ | ✓ |
| Purchase Return | record | ✓ | ✓ | ✓ |
| Transfer | list row | ✓ | ✓ | ✓ |
| Opening Stock | record | ✓ | ✓ | ✓ |
| Item Reconciliation | list row | ✓ | ✓ | ✓ |
| Customer / Supplier Account Statement | report | ✓ | ✓ | ✓ |
| Bank / Cash Account Statement | account record | ✓ | ✓ | ✓ |
| Warehouses Report | report | ✓ | ✓ | ✓ |
| Stock Movement | report | ✓ | ✓ | ✓ |
| Invoice Status Tracking (stage, warehouse, history) | report | ✓ | ✓ | ✓ |
| Trial Balance | report | ✓ | ✓ | ✓ |
| Income Statement, Balance Sheet, Changes in Equity, Cash Flow | report | ✓ | ✓ | ✓ |
| General Ledger, and one account's ledger | report | ✓ | ✓ | ✓ |

## Limitations

- **Bank/Cash Account Statement** is read from the account's own ledger
  account, not the bank subledger: supplier payment and customer receipt
  postings do not name the bank account on their bank line, so the bank
  subledger stays empty (and marking the ledger account as the bank control
  account makes those postings refuse). Correcting the postings is a posting
  change and was out of scope.
- **Financial statements in Excel**: their subtotals (gross margin, result,
  a side's total) are the statement layout's own lines, written as numbers.
  Column totals elsewhere are `SUM` formulas.
- **Word** embeds the regular weight of the Arabic font; Word draws bold from it.
- **Excel** cannot embed fonts; sheets use Arial, which carries Arabic on
  Windows and macOS.
- The company's Arabic name is the one the application shell shows
  (`shell.company_name`); the company record has no Arabic name field.
