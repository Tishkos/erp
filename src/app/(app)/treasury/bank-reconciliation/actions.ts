'use server';

import { redirect } from 'next/navigation';
import { list, runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { parseDecimal } from '@/server/domain/money';
import * as attachments from '@/server/services/attachments';
import * as statements from '@/server/services/bank-statement';
import * as rec from '@/server/services/bank-reconciliation';

/**
 * Bank Reconciliation — REQ-ACC-001 Part D-3. Every verb is the existing
 * engines' (`bank-statement.ts`, `bank-reconciliation.ts`); these read the
 * form and say where to come back to. A record is addressed by its
 * statement's number.
 */
const LIST = '/treasury/bank-reconciliation';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;

function amountOf(value: string, signed = false): bigint {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!(signed ? /^-?\d+(\.\d{1,4})?$/ : /^\d+(\.\d{1,4})?$/).test(cleaned)) throw new Error(`"${value}" is not an amount.`);
  return parseDecimal(cleaned, 4n);
}

/** The statement header: whose account, which period, and the bank's own two balances. */
export async function openStatementAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      statements.openStatement(tx, ctx, {
        bankCashAccountId: text(formData, 'bank_cash_account_id'),
        branchCode: ctx.branchCode,
        periodFrom: text(formData, 'period_from'),
        periodTo: text(formData, 'period_to'),
        openingBalanceIqd: amountOf(text(formData, 'opening'), true),
        closingBalanceIqd: amountOf(text(formData, 'closing'), true),
        bankReference: text(formData, 'bank_reference').trim() || null,
      }),
    (value) => {
      const made = value as { statementNo?: string } | null | undefined;
      return made?.statementNo ? record(made.statementNo) : `${LIST}?statement=new`;
    },
  );
}

/** One line typed on the screen. Money in is positive, money out negative. */
export async function addLineAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const { id } = await rec.statementIdByNo(tx, no);
    const bookingDate = text(formData, 'booking_date');
    const direction = text(formData, 'direction') === 'out' ? -1n : 1n;
    return statements.addLines(tx, ctx, id, {
      source: 'typed',
      lines: [
        {
          bookingDate,
          valueDate: text(formData, 'value_date') || bookingDate,
          amountIqd: direction * amountOf(text(formData, 'amount')),
          reference: text(formData, 'reference').trim() || null,
          counterparty: text(formData, 'counterparty').trim() || null,
          description: text(formData, 'description').trim() || null,
        },
      ],
    });
  }, record(no));
}

/** The bank's file, pasted — a header row, then a line per row. */
export async function pasteLinesAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const { id } = await rec.statementIdByNo(tx, no);
    const read = statements.readPastedLines(text(formData, 'content'));
    return statements.addLines(tx, ctx, id, { source: 'pasted', ...read });
  }, record(no));
}

/** Closed only if opening plus the lines is the bank's closing balance. */
export async function closeStatementAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const { id } = await rec.statementIdByNo(tx, no);
    return statements.closeStatement(tx, ctx, id);
  }, record(no));
}

export async function openReconciliationAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const { id } = await rec.statementIdByNo(tx, no);
    return rec.open(tx, ctx, id);
  }, record(no));
}

async function reconciliationOf(tx: Parameters<typeof rec.statementIdByNo>[0], no: string): Promise<string> {
  const { reconciliationId } = await rec.statementIdByNo(tx, no);
  if (!reconciliationId) throw new Error(`Statement ${no} has no reconciliation open yet.`);
  return reconciliationId;
}

/** Proposes matches; agrees none of them. */
export async function suggestAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => rec.suggestMatches(tx, ctx, await reconciliationOf(tx, no)), record(no));
}

/** A person agrees a suggested match, and their name goes on it. */
export async function confirmMatchAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn((tx, ctx) => rec.confirmMatch(tx, ctx, text(formData, 'match_id')), record(no));
}

/** A match built by hand: the statement lines and the ledger items ticked. */
export async function matchManuallyAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      rec.matchManually(tx, ctx, await reconciliationOf(tx, no), {
        statementLineIds: list(formData, 'statement_line_id'),
        journalLineIds: list(formData, 'journal_line_id'),
      }),
    record(no),
  );
}

/** A line the books never saw — a fee, interest, a returned payment — recorded and matched. */
export async function adjustmentAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      rec.postAdjustment(tx, ctx, await reconciliationOf(tx, no), {
        statementLineId: text(formData, 'adjust_line_id'),
        accountId: text(formData, 'account_id'),
        description: text(formData, 'adjust_description'),
        departmentCode: text(formData, 'department_code') || null,
      }),
    record(no),
  );
}

/** Agreed only when it balances, every line is matched and no suggestion waits. */
export async function finaliseAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(async (tx, ctx) => rec.finalise(tx, ctx, await reconciliationOf(tx, no)), record(no));
}

/** A finalised reconciliation reopened — counted, audited, with its reason. */
export async function reopenAction(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  await runAdminAndReturn(
    async (tx, ctx) => rec.reopen(tx, ctx, await reconciliationOf(tx, no), text(formData, 'reason')),
    record(no),
  );
}

/** The bank's own statement file, kept on the statement (object `bank_statement`). */
export async function attachToStatement(formData: FormData): Promise<void> {
  const no = text(formData, 'statement_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(no)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const { id } = await rec.statementIdByNo(tx, no);
    return attachments.upload(tx, ctx, { objectType: statements.DOCUMENT_TYPE, objectId: id, fileName: upload.name, content });
  }, record(no));
}
