import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { LoanBankField } from '@/components/admin/loan-terms-fields';
import { LoanProceeds } from '@/components/admin/loan-proceeds';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as loans from '@/server/services/loans';
import * as rates from '@/server/services/exchange-rates';
import {
  buildSchedule,
  commissionOf,
  COMMISSION_BASES,
  FREQUENCIES,
  GRACE_KINDS,
  INTEREST_BASES,
  INTEREST_TYPES,
  LOAN_PURPOSES,
  netProceeds,
  percentOf,
  PRINCIPAL_METHODS,
  type Frequency,
  type ScheduleRow,
} from '@domain/loans';
import { MONEY_SCALE, parseDecimal, toDecimalString, toIqd } from '@domain/money';
import { formatMoney, type Locale } from '@/i18n/config';
import { businessToday } from '@/server/domain/business-date';
import { NEW_BANK } from '../form';
import { createLoan } from '../actions';

/**
 * A bank's offer, entered as its letter states it — by direction, 2026-10-03.
 *
 * It was a dialog, and a dialog is the wrong shape for this: a facility has a
 * currency, a reference, a commission the bank may state either way, a rate
 * that may follow a published one, a grace period, and a schedule of several
 * rows that the accountant has to be able to read and correct. So it is a
 * document, drawn as the Purchase Invoice's own new page is — the window, the
 * header fields, the lines, the figure at the foot — with the instalments as
 * its lines.
 *
 * ── Why the terms live in the address ───────────────────────────────────
 * The schedule is worked out by `buildSchedule`, which is in the domain, and
 * `domain-purity.test.ts` will not let the domain be imported into a browser
 * bundle. So the schedule is laid out **here**, on the server, from the terms
 * in the query string: *Update schedule* submits the form to this same page by
 * GET, which re-renders every field from what was typed and the instalments
 * from the terms they describe. No arithmetic is duplicated into the browser,
 * and no round trip happens that the accountant did not ask for.
 *
 * The rows are inputs. Retyping one and pressing *Create loan* keeps what was
 * typed — `assertScheduleRepays` holds any typed schedule to repaying the
 * principal exactly, so a row that does not add up is refused rather than
 * stored.
 */
export default async function NewLoanPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const [locale, t, admin, column, page, context, outcome] = await Promise.all([
    getLocale(),
    getTranslations('admin.loans'),
    getTranslations('admin'),
    getTranslations('admin.columns'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'create', loans.PERMISSION_OBJECT)) return <Denied object={page('loans')} />;

  const params = await searchParams;
  const said = (name: string, fallback = '') => {
    const value = params[name];
    return (typeof value === 'string' ? value : '') || fallback;
  };

  const pickers = await withCurrentUser((tx) => loans.pickers(tx));
  const today = businessToday();

  // ── The offer, as the address carries it ─────────────────────────────────
  const principalText = said('principal');
  const commissionBasis = said('commission_basis', 'percentage');
  const commissionPct = said('commission_pct', '0');
  const commissionFixed = said('commission_fixed');
  const treatmentCode = said('commission_treatment', pickers.treatments[0]?.code ?? '');
  const interestPct = said('interest_pct');
  const interestBasis = said('interest_basis', 'reducing');
  const interestType = said('interest_type', 'fixed');
  const count = Math.max(1, Math.min(240, Number(said('instalment_count', '4')) || 4));
  const frequency = said('frequency', 'quarterly') as Frequency;
  const firstDue = said('first_due_date');
  const principalMethod = said('principal_method', 'equal_principal');
  const graceKind = said('grace_kind', 'none');
  const graceUntil = said('grace_until');
  const disbursementDate = said('expected_disbursement_date', today);

  /*
   * The instalments, from the terms above — or nothing to show yet, when the
   * principal and the first due date have not been given. Every refusal
   * `buildSchedule` makes is a sentence worth reading, so it is shown rather
   * than swallowed: a grace that swallows the loan, a first instalment before
   * the money arrives, a custom schedule missing a date.
   */
  const amount = principalText.trim() ? parseDecimal(principalText.trim(), MONEY_SCALE) : 0n;
  const treatment = pickers.treatments.find((row) => row.code === treatmentCode) ?? null;
  const commission =
    commissionBasis === 'none'
      ? 0n
      : commissionBasis === 'fixed'
        ? commissionFixed.trim()
          ? parseDecimal(commissionFixed.trim(), MONEY_SCALE)
          : 0n
        : amount > 0n && commissionPct.trim()
          ? commissionOf(amount, percentOf(commissionPct, 'A commission'))
          : 0n;

  let schedule: ScheduleRow[] = [];
  let refusal: string | null = null;
  if (amount > 0n && firstDue) {
    try {
      schedule = buildSchedule({
        principal: amount,
        commission,
        spreadCommission: Boolean(treatment?.spread),
        interestPctPa: interestPct.trim() ? percentOf(interestPct, 'An interest rate') : null,
        count,
        frequency,
        firstDueDate: firstDue,
        startDate: disbursementDate,
        principalMethod: principalMethod as (typeof PRINCIPAL_METHODS)[number],
        interestBasis: interestBasis as (typeof INTEREST_BASES)[number],
        grace: graceKind as (typeof GRACE_KINDS)[number],
        graceUntil: graceUntil || null,
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
  }

  const account = pickers.accounts.find((row) => row.id === said('bank_cash_account_id')) ?? pickers.accounts[0];
  /*
   * What the money comes to in the account's own currency (0276). A dollar
   * facility paid into a dinar account arrives as dinars, and the person
   * entering the offer should see how many before they commit to it. The rate
   * is read from Currencies & Rates on the day the bank says it will send —
   * never typed here, and never stored.
   */
  const loanCurrency = said('currency', account?.currency ?? 'IQD');
  const applied =
    loanCurrency === (account?.currency ?? 'IQD')
      ? null
      : await withCurrentUser((tx) => rates.rateOn(tx, loanCurrency, disbursementDate)).catch(() => null);
  // The figures on this page are the loan's own money, not the account's.
  const currency = said('currency', account?.currency ?? 'IQD');
  const money = (value: bigint) => formatMoney(toDecimalString(value, MONEY_SCALE), currency, locale as Locale);
  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ value, label: t(`${prefix}${value}`) }));

  const select = (name: string, chosen: string, list: readonly { value: string; label: string }[], label: string) => (
    <select aria-label={label} defaultValue={chosen} name={name}>
      {list.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  const fields: DocumentField[] = [
    // ── 1 · the facility ────────────────────────────────────────────────
    {
      // `bare`: the field draws its own label, and a second one above it read
      // as two questions (2026-10-03).
      label: t('bank'),
      bare: true,
      value: (
        <LoanBankField
          banks={pickers.banks.map((bank) => ({
            value: bank.code,
            label: bank.swift ? `${bank.name} · ${bank.swift}` : bank.name,
          }))}
          labels={{
            bank: t('bank'),
            another: t('another_bank'),
            name: t('bank_name'),
            nameHint: t('bank_name_hint'),
            swift: t('bank_swift'),
          }}
          newBankValue={NEW_BANK}
        />
      ),
    },
    {
      label: t('facility_reference'),
      control: true,
      value: (
        <input
          aria-label={t('facility_reference')}
          defaultValue={said('facility_reference')}
          name="facility_reference"
          type="text"
        />
      ),
    },
    {
      label: t('account'),
      control: true,
      value: select(
        'bank_cash_account_id',
        account?.id ?? '',
        pickers.accounts.map((row) => ({ value: row.id, label: `${row.code} · ${row.name} · ${row.currency}` })),
        t('account'),
      ),
    },
    {
      /*
       * What the loan is owed in — the bank's currency, not the receiving
       * account's (0276). The list is Finance's own, from Currencies & Rates.
       */
      label: t('loan_currency'),
      control: true,
      value: select(
        'currency',
        said('currency', account?.currency ?? 'IQD'),
        pickers.currencies.map((row) => ({ value: row.code, label: `${row.code} · ${row.name}` })),
        t('loan_currency'),
      ),
    },
    {
      label: t('principal'),
      control: true,
      value: (
        <input
          aria-label={t('principal')}
          defaultValue={principalText}
          inputMode="decimal"
          name="principal"
          required
          type="text"
        />
      ),
    },
    {
      // What the bank sends and what is owed, as the letter is typed.
      label: t('proceeds'),
      control: true,
      wide: true,
      value: (
        <LoanProceeds
          deductedCodes={pickers.treatments.filter((row) => row.deducted).map((row) => row.code)}
          labels={{
            lands: t('proceeds_lands'),
            owed: t('proceeds_owed'),
            commission: t('proceeds_commission'),
          }}
          locale={locale}
          percentField="commission_pct"
          principalField="principal"
          treatmentField="commission_treatment"
        />
      ),
    },
    ...(applied
      ? [
          {
            label: t('expected_proceeds'),
            wide: true,
            value: (
              <bdi dir="ltr">
                {/* The rate as published, without the zeroes nobody reads. */}
                {`1 ${loanCurrency} = ${toDecimalString(applied.iqdPerUnit, 8n).replace(/\.?0+$/, '')} ${
                  account?.currency ?? 'IQD'
                }`}
                {' · '}
                {formatMoney(
                  toDecimalString(
                    toIqd(
                      amount > 0n ? netProceeds(amount, commission, Boolean(treatment?.deducted)) : 0n,
                      applied.iqdPerUnit,
                    ),
                    MONEY_SCALE,
                  ),
                  account?.currency ?? 'IQD',
                  locale as Locale,
                )}
              </bdi>
            ),
          },
        ]
      : []),
    {
      label: t('expected_disbursement'),
      control: true,
      value: (
        <input
          aria-label={t('expected_disbursement')}
          defaultValue={disbursementDate}
          name="expected_disbursement_date"
          type="date"
        />
      ),
    },

    // ── 2 · the commission ──────────────────────────────────────────────
    {
      label: t('commission_basis'),
      control: true,
      value: select('commission_basis', commissionBasis, options(COMMISSION_BASES, 'cb_'), t('commission_basis')),
    },
    {
      label: t('commission_pct'),
      control: true,
      value: (
        <input
          aria-label={t('commission_pct')}
          defaultValue={commissionPct}
          inputMode="decimal"
          name="commission_pct"
          type="text"
        />
      ),
    },
    {
      label: t('commission_fixed'),
      control: true,
      value: (
        <input
          aria-label={t('commission_fixed')}
          defaultValue={commissionFixed}
          inputMode="decimal"
          name="commission_fixed"
          type="text"
        />
      ),
    },
    {
      label: t('treatment'),
      control: true,
      value: select(
        'commission_treatment',
        treatmentCode,
        pickers.treatments.map((row) => ({
          value: row.code,
          label: locale !== 'en' && t.has(`tr.${row.code}`) ? t(`tr.${row.code}`) : row.name,
        })),
        t('treatment'),
      ),
    },
    {
      label: t('other_fees'),
      control: true,
      value: (
        <input
          aria-label={t('other_fees')}
          defaultValue={said('other_fees')}
          inputMode="decimal"
          name="other_fees"
          type="text"
        />
      ),
    },

    // ── 3 · the interest ────────────────────────────────────────────────
    {
      label: t('interest'),
      control: true,
      value: (
        <input
          aria-label={t('interest')}
          defaultValue={interestPct}
          inputMode="decimal"
          name="interest_pct"
          type="text"
        />
      ),
    },
    {
      label: t('interest_type'),
      control: true,
      value: select('interest_type', interestType, options(INTEREST_TYPES, 'it_'), t('interest_type')),
    },
    {
      label: t('interest_reference'),
      control: true,
      value: (
        <input
          aria-label={t('interest_reference')}
          defaultValue={said('interest_reference')}
          name="interest_reference"
          placeholder={t('interest_reference_hint')}
          type="text"
        />
      ),
    },
    {
      label: t('interest_spread'),
      control: true,
      value: (
        <input
          aria-label={t('interest_spread')}
          defaultValue={said('interest_spread')}
          inputMode="decimal"
          name="interest_spread"
          type="text"
        />
      ),
    },
    {
      label: t('interest_basis'),
      control: true,
      value: select('interest_basis', interestBasis, options(INTEREST_BASES, 'ib_'), t('interest_basis')),
    },

    // ── 4 · the repayment ───────────────────────────────────────────────
    {
      label: t('principal_method'),
      control: true,
      value: select('principal_method', principalMethod, options(PRINCIPAL_METHODS, 'pm_'), t('principal_method')),
    },
    {
      label: t('instalments'),
      control: true,
      value: (
        <input
          aria-label={t('instalments')}
          defaultValue={String(count)}
          inputMode="numeric"
          min={1}
          name="instalment_count"
          required
          type="number"
        />
      ),
    },
    {
      label: t('frequency'),
      control: true,
      value: select('frequency', frequency, options(FREQUENCIES, 'freq_'), t('frequency')),
    },
    {
      label: t('first_due'),
      control: true,
      value: (
        <input aria-label={t('first_due')} defaultValue={firstDue} name="first_due_date" required type="date" />
      ),
    },
    {
      label: t('grace_kind'),
      control: true,
      value: select('grace_kind', graceKind, options(GRACE_KINDS, 'gk_'), t('grace_kind')),
    },
    {
      label: t('grace_until'),
      control: true,
      value: (
        <input aria-label={t('grace_until')} defaultValue={graceUntil} name="grace_until" type="date" />
      ),
    },
  ];

  return (
    <AdminPage
      back={{ href: '/treasury/loans', label: admin('back') }}
      title={t('new')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error ?? refusal} errorTitle={admin('error_title')} saved={false} savedLabel="" />

      <form action={createLoan}>
        <DocumentWindow
          actions={
            <>
              {/*
                The same form, submitted to this page by GET: every field comes
                back as it was typed and the instalments are laid out from the
                terms they describe. The schedule is worked out on the server
                because the arithmetic belongs to the domain (2026-10-03).
              */}
              <Submit formAction="/treasury/loans/new" formMethod="get" label={t('update_schedule')} tone="secondary" variant="document" />
              <Submit label={t('create')} variant="document" />
            </>
          }
          documentType={page('loans')}
          fields={fields}
          fieldsAfterLines={[
            {
              label: t('purpose'),
              control: true,
              value: select(
                'purpose_code',
                said('purpose_code', 'import_finance'),
                LOAN_PURPOSES.map((code) => ({ value: code, label: t(`pu_${code}`) })),
                t('purpose'),
              ),
            },
            {
              label: t('capitalise'),
              control: true,
              wide: true,
              value: (
                <label className={s.sapCheck}>
                  <input defaultChecked name="commission_capitalised" type="checkbox" value="1" />
                  <span>{t('capitalise_note')}</span>
                </label>
              ),
            },
          ]}
          id="loan-new"
          linesCount={schedule.length}
          linesTitle={t('schedule')}
          number=""
          totals={
            amount > 0n
              ? [
                  { label: t('proceeds_owed'), value: money(amount) },
                  { label: t('proceeds_commission'), value: money(commission) },
                  {
                    label: t('proceeds_lands'),
                    value: money(netProceeds(amount, commission, Boolean(treatment?.deducted))),
                  },
                ]
              : []
          }
        >
          <table className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{t('due_date')}</th>
                <th className={s.sapNum} scope="col">
                  {t('col_principal')}
                </th>
                <th className={s.sapNum} scope="col">
                  {t('col_interest')}
                </th>
                <th className={s.sapNum} scope="col">
                  {t('col_total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {schedule.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={5}>
                    {t('schedule_empty')}
                  </td>
                </tr>
              ) : null}
              {schedule.map((row, index) => (
                <tr key={row.sequence}>
                  <td>{row.sequence}</td>
                  <td className={s.sapCellField}>
                    <input
                      aria-label={`${t('due_date')} ${row.sequence}`}
                      defaultValue={row.dueDate}
                      name={`due_date_${index}`}
                      type="date"
                    />
                  </td>
                  <td className={`${s.sapCellField} ${s.sapNum}`}>
                    <input
                      aria-label={`${t('col_principal')} ${row.sequence}`}
                      defaultValue={toDecimalString(row.principal, MONEY_SCALE)}
                      inputMode="decimal"
                      name={`principal_${index}`}
                      type="text"
                    />
                  </td>
                  <td className={`${s.sapCellField} ${s.sapNum}`}>
                    <input
                      aria-label={`${t('col_interest')} ${row.sequence}`}
                      defaultValue={toDecimalString(row.interest, MONEY_SCALE)}
                      inputMode="decimal"
                      name={`interest_${index}`}
                      type="text"
                    />
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(row.total)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
            {schedule.length > 0 ? (
              <tfoot>
                <tr className={s.sapTotalRow}>
                  <td colSpan={2}>{t('schedule_totals')}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(schedule.reduce((sum, row) => sum + row.principal, 0n))}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(schedule.reduce((sum, row) => sum + row.interest, 0n))}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(schedule.reduce((sum, row) => sum + row.total, 0n))}</bdi>
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
          <input name="row_count" type="hidden" value={schedule.length} />
          <input name="loan_date" type="hidden" value={today} />
        </DocumentWindow>
      </form>
    </AdminPage>
  );
}
