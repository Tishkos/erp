/**
 * Money Transfer reports — Phase 09.11, §12.7.
 *
 * The eleven reports §12.7 names. Two of them live beside the mechanism they
 * report on rather than here — Bank Execution Batch Reconciliation in
 * `bank-execution.ts` and Client Import Cross-Reference in `client-import.ts` —
 * because both are the natural read of a structure defined there, and splitting
 * them off would mean two places knowing the same joins.
 *
 * ── The acceptance criterion these exist for ────────────────────────────────
 * §12.7: *"Every transfer and refund reconciles to client subledger, bank ledger
 * and General Ledger."* `reconciliation` below is that statement as a query. It
 * does not compare a report to a report: it compares what the module says
 * happened against what the journal says, and against what the subledger says,
 * from the rows themselves. A reconciliation assembled from three cached
 * summaries agrees with itself and proves nothing.
 *
 * Every figure here is scoped by RLS exactly as the tables are, so a report shows
 * a user their own branch and nothing else (§22) without asking for a filter.
 */
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  bankExecutionBatch,
  bankExecutionBatchLine,
  businessPartner,
  journalEntry,
  journalLine,
  moneyTransfer,
  moneyTransferClientAccount,
  moneyTransferDeposit,
  moneyTransferExpense,
  subledgerEntry,
} from '../db/schema';
import { grossExchangeSpread, transferStageName } from '../domain/money-transfer';
import { parseDecimal, RATE_SCALE, toDecimalString } from '../domain/money';

export interface ReportOptions {
  readonly from?: string;
  readonly to?: string;
  readonly clientAccountId?: string;
}

/**
 * §12.7 — **Client Deposit Ledger.**
 *
 * Every deposit a client made, what has been used, and what is left. Ordered by
 * date because that is the order the client remembers paying in.
 */
export async function clientDepositLedger(tx: Tx, options: ReportOptions = {}) {
  const query = tx
    .select({
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      accountNo: moneyTransferClientAccount.accountNo,
      depositNo: moneyTransferDeposit.depositNo,
      depositDate: moneyTransferDeposit.depositDate,
      method: moneyTransferDeposit.method,
      bankReference: moneyTransferDeposit.bankReference,
      status: moneyTransferDeposit.status,
      amountIqd: moneyTransferDeposit.amountIqd,
      usedIqd: moneyTransferDeposit.usedAmountIqd,
      refundedIqd: moneyTransferDeposit.refundedAmountIqd,
      availableIqd: sql<string>`(${moneyTransferDeposit.amountIqd}
        - ${moneyTransferDeposit.usedAmountIqd}
        - ${moneyTransferDeposit.refundedAmountIqd})`,
      journalEntryId: moneyTransferDeposit.journalEntryId,
      // §12.7 — "distinguish posted from provisional data". A draft deposit is
      // an expectation; it is shown, and it is labelled.
      isPosted: sql<boolean>`${moneyTransferDeposit.status} <> 'draft'`,
    })
    .from(moneyTransferDeposit)
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransferDeposit.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .orderBy(asc(moneyTransferDeposit.depositDate), asc(moneyTransferDeposit.depositNo));

  return options.clientAccountId
    ? query.where(eq(moneyTransferDeposit.clientAccountId, options.clientAccountId))
    : query;
}

/**
 * §12.7 — **Open Client Balances.**
 *
 * Whose money the company is holding, and how much. The question Treasury asks
 * every morning, and the one Appendix E's guidance makes a compliance question
 * as well as a cash one.
 */
export async function openClientBalances(tx: Tx) {
  const result = await tx.execute(sql`
    select p.code                                        as "clientCode",
           p.legal_name                                  as "clientName",
           a.account_no                                  as "accountNo",
           a.status::text                                as "accountStatus",
           a.opened_on                                   as "openedOn",
           coalesce(sum(d.amount_iqd), 0)::text          as "depositedIqd",
           coalesce(sum(d.used_amount_iqd), 0)::text     as "usedIqd",
           coalesce(sum(d.refunded_amount_iqd), 0)::text as "refundedIqd",
           coalesce(sum(d.amount_iqd - d.used_amount_iqd - d.refunded_amount_iqd), 0)::text
                                                         as "balanceIqd"
      from money_transfer_client_account a
      join business_partner p on p.id = a.partner_id
      left join money_transfer_deposit d
             on d.client_account_id = a.id
            and d.status in ('posted', 'partially_executed', 'settled')
     group by p.code, p.legal_name, a.account_no, a.status, a.opened_on
    having coalesce(sum(d.amount_iqd - d.used_amount_iqd - d.refunded_amount_iqd), 0) <> 0
        or a.status <> 'closed'
     order by p.code, a.account_no
  `);

  return result.rows as unknown as Array<{
    clientCode: string;
    clientName: string;
    accountNo: string;
    accountStatus: string;
    openedOn: string;
    depositedIqd: string;
    usedIqd: string;
    refundedIqd: string;
    balanceIqd: string;
  }>;
}

/**
 * §12.7 — **Transfer Register**, and with it the Gross Spread, Direct Expenses
 * and Net Margin reports.
 *
 * One query rather than four: they are the same rows read for different columns,
 * and four queries would be four chances for the spread on one report to
 * disagree with the spread on another. `stage` carries Appendix B's own name for
 * the status, so the register reads in the blueprint's vocabulary rather than
 * the schema's.
 */
export async function transferRegister(tx: Tx, options: ReportOptions = {}) {
  const rows = await tx
    .select({
      transferNo: moneyTransfer.transferNo,
      status: moneyTransfer.status,
      transferDate: moneyTransfer.transferDate,
      branchCode: moneyTransfer.branchCode,
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      accountNo: moneyTransferClientAccount.accountNo,
      beneficiaryName: moneyTransfer.beneficiaryName,
      bankReference: moneyTransfer.bankReference,
      requestedUsd: moneyTransfer.requestedUsd,
      officialRate: moneyTransfer.officialRateIqdPerUsd,
      clientRate: moneyTransfer.clientRateIqdPerUsd,
      transferAmountIqd: moneyTransfer.transferAmountIqd,
      journalEntryId: moneyTransfer.journalEntryId,
      returnJournalEntryId: moneyTransfer.returnJournalEntryId,
      refundAmountIqd: moneyTransfer.refundAmountIqd,
      recognisedResultIqd: moneyTransfer.recognisedResultIqd,
      logisticsJobRef: moneyTransfer.logisticsJobRef,
      directExpensesIqd: sql<string>`(select coalesce(sum(e.amount_iqd), 0)
         from money_transfer_expense e
        where e.money_transfer_id = ${moneyTransfer.id} and e.status = 'posted')`,
      expensesChargedToClientIqd: sql<string>`(select coalesce(sum(e.amount_iqd), 0)
         from money_transfer_expense e
        where e.money_transfer_id = ${moneyTransfer.id} and e.status = 'posted'
          and e.charged_to_client)`,
    })
    .from(moneyTransfer)
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(dateRange(options))
    .orderBy(desc(moneyTransfer.transferDate), asc(moneyTransfer.transferNo));

  // The spread is computed by the domain function, not by SQL. A second
  // implementation in the database would be a second answer, and the one nobody
  // is testing is the one that drifts.
  return rows.map((row) => {
    const spread = grossExchangeSpread(parseDecimal(row.requestedUsd, 4n), {
      officialIqdPerUsd: parseDecimal(row.officialRate, RATE_SCALE),
      clientIqdPerUsd: parseDecimal(row.clientRate, RATE_SCALE),
    });
    const expenses = parseDecimal(row.directExpensesIqd, 4n);

    return {
      ...row,
      stage: transferStageName(row.status),
      grossExchangeSpreadIqd: toDecimalString(spread, 4n),
      netServiceMarginIqd: toDecimalString(spread - expenses, 4n),
      isPosted: row.status !== 'draft',
    };
  });
}

/** §12.7 — **Direct Expenses**, per fee, with the transfer each belongs to. */
export async function directExpenses(tx: Tx, options: ReportOptions = {}) {
  return tx
    .select({
      expenseNo: moneyTransferExpense.expenseNo,
      expenseDate: moneyTransferExpense.expenseDate,
      expenseType: moneyTransferExpense.expenseType,
      description: moneyTransferExpense.description,
      amountIqd: moneyTransferExpense.amountIqd,
      chargedToClient: moneyTransferExpense.chargedToClient,
      status: moneyTransferExpense.status,
      transferNo: moneyTransfer.transferNo,
      clientCode: businessPartner.code,
      journalEntryId: moneyTransferExpense.journalEntryId,
    })
    .from(moneyTransferExpense)
    .innerJoin(moneyTransfer, eq(moneyTransfer.id, moneyTransferExpense.moneyTransferId))
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .orderBy(asc(moneyTransferExpense.expenseDate), asc(moneyTransferExpense.expenseNo));
}

/** §12.7 — **Returned Transfers.** §12.6's lifecycle, as a list. */
export async function returnedTransfers(tx: Tx) {
  return tx
    .select({
      transferNo: moneyTransfer.transferNo,
      clientCode: businessPartner.code,
      transferDate: moneyTransfer.transferDate,
      transferAmountIqd: moneyTransfer.transferAmountIqd,
      returnedAt: moneyTransfer.returnedAt,
      returnReason: moneyTransfer.returnReason,
      returnJournalEntryId: moneyTransfer.returnJournalEntryId,
      originalJournalEntryId: moneyTransfer.journalEntryId,
      // §12.6 — the company absorbs all bank charges, so they are shown beside
      // the return rather than netted into it.
      bankChargesAbsorbedIqd: sql<string>`(select coalesce(sum(e.amount_iqd), 0)
         from money_transfer_expense e
        where e.money_transfer_id = ${moneyTransfer.id} and e.status = 'posted')`,
      refundAmountIqd: moneyTransfer.refundAmountIqd,
      status: moneyTransfer.status,
    })
    .from(moneyTransfer)
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(isNotNull(moneyTransfer.returnedAt))
    .orderBy(desc(moneyTransfer.returnedAt));
}

/** §12.7 — **Refunds.** */
export async function refunds(tx: Tx) {
  return tx
    .select({
      transferNo: moneyTransfer.transferNo,
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      refundedAt: moneyTransfer.refundedAt,
      refundAmountIqd: moneyTransfer.refundAmountIqd,
      refundJournalEntryId: moneyTransfer.refundJournalEntryId,
      transferAmountIqd: moneyTransfer.transferAmountIqd,
    })
    .from(moneyTransfer)
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(isNotNull(moneyTransfer.refundedAt))
    .orderBy(desc(moneyTransfer.refundedAt));
}

/**
 * §12.7 — **Transfer-to-Bank Statement Reconciliation.**
 *
 * Every transfer, with the bank execution batch that paid it and the statement
 * line that batch matched. A transfer with no batch, or a batch with no
 * statement line, is the finding — the report exists to show the gaps, so those
 * rows are kept rather than filtered out.
 *
 * The statement line is a reference until Phase 07.7 provides real statements;
 * the shape of this report does not change when it does.
 */
export async function transferToBankStatement(tx: Tx, options: ReportOptions = {}) {
  return tx
    .select({
      transferNo: moneyTransfer.transferNo,
      transferDate: moneyTransfer.transferDate,
      status: moneyTransfer.status,
      transferAmountIqd: moneyTransfer.transferAmountIqd,
      bankReference: moneyTransfer.bankReference,
      journalEntryId: moneyTransfer.journalEntryId,
      batchNo: bankExecutionBatch.batchNo,
      batchStatus: bankExecutionBatch.status,
      batchTotalIqd: bankExecutionBatch.totalIqd,
      statementLineRef: bankExecutionBatch.statementLineRef,
      reconciledAt: bankExecutionBatch.reconciledAt,
      lineReversedAt: bankExecutionBatchLine.reversedAt,
    })
    .from(moneyTransfer)
    .leftJoin(
      bankExecutionBatchLine,
      eq(bankExecutionBatchLine.moneyTransferId, moneyTransfer.id),
    )
    .leftJoin(bankExecutionBatch, eq(bankExecutionBatch.id, bankExecutionBatchLine.batchId))
    .where(dateRange(options))
    .orderBy(asc(moneyTransfer.transferDate), asc(moneyTransfer.transferNo));
}

/**
 * §12.7 acceptance 1 — *"Every transfer and refund reconciles to client
 * subledger, bank ledger and General Ledger."*
 *
 * For one transfer: what the module recorded, what the journal posted, and what
 * the client subledger moved — read from the rows in each, so agreement is a
 * finding rather than an assumption. `reconciles` is true only when all three
 * agree; anything else is a difference somebody has to explain.
 */
export interface TransferReconciliation {
  readonly transferNo: string;
  readonly clientCode: string;
  readonly moduleAmountIqd: string;
  readonly generalLedgerIqd: string;
  readonly clientSubledgerIqd: string;
  readonly reconciles: boolean;
}

export async function reconciliation(
  tx: Tx,
  moneyTransferId: string,
): Promise<TransferReconciliation> {
  const [transfer] = await tx
    .select({
      transferNo: moneyTransfer.transferNo,
      amountIqd: moneyTransfer.transferAmountIqd,
      journalEntryId: moneyTransfer.journalEntryId,
      clientCode: businessPartner.code,
    })
    .from(moneyTransfer)
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(eq(moneyTransfer.id, moneyTransferId))
    .limit(1);

  if (!transfer) throw new Error(`No money transfer '${moneyTransferId}'.`);

  // The G/L side: the debit the initiation posting put on the client clearing
  // account, read from the journal itself rather than from anything this module
  // stored about it.
  const [gl] = await tx
    .select({
      total: sql<string>`coalesce(sum(${journalLine.debitIqd}), 0)`,
    })
    .from(journalLine)
    .innerJoin(journalEntry, eq(journalEntry.id, journalLine.journalEntryId))
    .where(
      and(
        eq(journalEntry.sourceModule, 'money_transfer'),
        eq(journalEntry.sourceDocId, moneyTransferId),
        eq(journalEntry.sourceEvent, 'initiated'),
        eq(journalLine.lineRole, 'client_clearing'),
      ),
    );

  // The subledger side: the same movement as the client's own ledger recorded
  // it. Written from the journal line in the same transaction (§1.2), so a
  // difference here means the subledger framework itself is broken.
  const [sub] = await tx
    .select({
      total: sql<string>`coalesce(sum(${subledgerEntry.debitIqd}), 0)`,
    })
    .from(subledgerEntry)
    .innerJoin(journalEntry, eq(journalEntry.id, subledgerEntry.journalEntryId))
    .where(
      and(
        eq(journalEntry.sourceModule, 'money_transfer'),
        eq(journalEntry.sourceDocId, moneyTransferId),
        eq(journalEntry.sourceEvent, 'initiated'),
        eq(subledgerEntry.partyCode, transfer.clientCode),
      ),
    );

  const moduleAmount = parseDecimal(transfer.amountIqd, 4n);
  const glAmount = parseDecimal(gl?.total ?? '0', 4n);
  const subAmount = parseDecimal(sub?.total ?? '0', 4n);

  return {
    transferNo: transfer.transferNo,
    clientCode: transfer.clientCode,
    moduleAmountIqd: toDecimalString(moduleAmount, 4n),
    generalLedgerIqd: toDecimalString(glAmount, 4n),
    clientSubledgerIqd: toDecimalString(subAmount, 4n),
    reconciles: moduleAmount === glAmount && glAmount === subAmount,
  };
}

function dateRange(options: ReportOptions) {
  if (options.from && options.to) {
    return and(
      sql`${moneyTransfer.transferDate} >= ${options.from}`,
      sql`${moneyTransfer.transferDate} <= ${options.to}`,
    );
  }
  if (options.from) return sql`${moneyTransfer.transferDate} >= ${options.from}`;
  if (options.to) return sql`${moneyTransfer.transferDate} <= ${options.to}`;
  return undefined;
}
