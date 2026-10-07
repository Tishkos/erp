/**
 * The registers behind the screens a view can be saved on (platform phase, Agent 8).
 *
 * One function per screen whose rows are read and filtered in the page. The
 * page calls it to draw; `saved-view-counts.ts` calls the same function to
 * count what a pinned view would list — so the number on Home is, by
 * construction, the number of rows the screen shows under that view, for the
 * same person. They read through the caller's transaction, so row security and
 * branch scope are the caller's.
 */
import type { Tx } from '../db/client';
import {
  filterContainerRegister,
  filterInvoiceRegister,
  filterPartnerRegister,
  type ContainerRegisterFilter,
  type InvoiceRegisterFilter,
  type PartnerRegisterFilter,
} from '../domain/register-filters';
import { applyRegisterDates, NO_REGISTER_DATES, type RegisterDates } from '../domain/register-dates';
import * as ap from './ap-invoice';
import * as expenses from './expenses';
import * as partners from './partners';
import * as shipments from './shipments';

/**
 * Purchase Invoices: every invoice the reader may see with its payment state,
 * the rows the filters keep, inside the Filter's window of invoice dates,
 * newest first unless asked otherwise (the register is read whole, so the
 * order is the whole register's, not a page's).
 */
export async function invoiceRegister(
  tx: Tx,
  filter: InvoiceRegisterFilter & { readonly dates?: RegisterDates },
  today: string,
) {
  const rows = await ap.list(tx);
  const withState = rows.map((row) => ({
    ...row,
    state: expenses.paymentState(
      {
        status: row.status,
        // Never overdue on a date nobody set — an advance's balance waits for its SWIFT (2026-10-07).
        dueDate: row.dueDateSetAt ? row.dueDate : null,
        totalIqd: row.totalIqd,
        settledAmountIqd: row.settledAmountIqd,
      },
      today,
    ),
  }));
  return {
    shown: applyRegisterDates(
      filterInvoiceRegister(withState, filter),
      (row) => row.invoiceDate,
      filter.dates ?? NO_REGISTER_DATES,
      (row) => row.invoiceNo,
    ),
  };
}

/** Containers: the rows of the chosen view, then the search and the ETA window. */
export async function containerRegister(
  tx: Tx,
  filter: ContainerRegisterFilter & { readonly view?: shipments.ContainerFilter['view'] | undefined },
) {
  const rows = await shipments.listContainers(tx, { view: filter.view ?? null });
  return { shown: filterContainerRegister(rows, filter) };
}

/** Customers or Suppliers: the role's partners, then the search and the status. */
export async function partnerRegister(tx: Tx, role: partners.PartnerRole, filter: PartnerRegisterFilter) {
  const rows = await partners.listByRole(tx, role);
  return { shown: filterPartnerRegister(rows, filter) };
}
