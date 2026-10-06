import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Field, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { addLandedCharge, lockLandedCost, withdrawLandedCharge } from './actions';
import type { LandedBlock } from './[payableNo]/load';

/**
 * The import's landed cost — the charges, what a lock would do, the locks,
 * the final cost — drawn in one place for two pages (2026-10-06, by direction:
 * "Landed cost … their own sheet … print, attachment, notes, audit").
 *
 * The import application's page shows it as one of its four sections, as it
 * always has; the landed-cost sheet (`/logistics/landed-costs/<import>`) shows
 * the same thing under a document header with the four doors. The windows
 * that add a charge, lock the cost or withdraw a charge say where to come back
 * to (`return_to`), so the sheet stays the sheet and the import stays the
 * import — nobody is sent to the other page.
 */

export interface LandedRow {
  readonly id: string;
  readonly payableNo: string;
}

export interface LandedMay {
  readonly addCharge: boolean;
  readonly lock: boolean;
  readonly withdraw: boolean;
}

export function landedChargesTotal(landed: NonNullable<LandedBlock>): string {
  return toDecimalString(
    landed.charges
      .filter((row) => !row.cancelledAt && row.chargeTypeCode !== 'purchase')
      .reduce((sum, row) => sum + parseDecimal(row.amountIqd, MONEY_SCALE), 0n),
    MONEY_SCALE,
  );
}

/** The charges, one row each: type, source, amount, state, note. */
export async function LandedChargesTable({
  landed,
  locale,
  labelledBy,
}: {
  readonly landed: NonNullable<LandedBlock>;
  readonly locale: string;
  readonly labelledBy: string;
}) {
  const lc = await getTranslations('admin.landed_cost');
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  return (
    <table aria-labelledby={labelledBy} className={s.sapTable}>
      <thead>
        <tr>
          <th scope="col">{lc('col_type')}</th>
          <th scope="col">{lc('col_source')}</th>
          <th className={s.sapNum} scope="col">
            {lc('col_amount')}
          </th>
          <th scope="col">{lc('col_state')}</th>
          <th scope="col">{lc('col_note')}</th>
        </tr>
      </thead>
      <tbody>
        {landed.charges.length === 0 ? (
          <tr>
            <td className={s.sapEmptyRow} colSpan={5}>
              {lc('none')}
            </td>
          </tr>
        ) : null}
        {landed.charges.map((row) => (
          <tr key={row.id}>
            <td>{locale !== 'en' && lc.has(`type_name.${row.chargeTypeCode}`) ? lc(`type_name.${row.chargeTypeCode}`) : row.chargeTypeName}</td>
            <td>
              <bdi dir="ltr">{row.sourceNo ?? '—'}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(row.amountIqd, 'IQD')}</bdi>
              {row.currency !== 'IQD' ? (
                <div className="muted">
                  <bdi dir="ltr">{money(row.amountTxn, row.currency)}</bdi>
                </div>
              ) : null}
            </td>
            <td>
              {row.cancelledAt ? (
                <span className="status status--cancelled" data-status="cancelled">
                  {lc('withdrawn')}
                </span>
              ) : row.lockId ? (
                <span className="status status--posted" data-status="posted">
                  {lc('locked_n', { sequence: row.lockSequence ?? 1 })}
                </span>
              ) : (
                <span className="status status--draft" data-status="draft">
                  {lc('unlocked')}
                </span>
              )}
            </td>
            <td>
              <bdi dir="auto">{row.reason ?? row.note ?? row.cancelReason ?? '—'}</bdi>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What a lock would do, what the models finally cost, the locks — and the
 * windows that add a charge, lock, or withdraw. No wrapper: the caller puts it
 * in its window.
 */
export async function LandedCostDetails({
  row,
  landed,
  locale,
  may,
  returnTo,
}: {
  readonly row: LandedRow;
  readonly landed: NonNullable<LandedBlock>;
  readonly locale: string;
  readonly may: LandedMay;
  readonly returnTo: string;
}) {
  const [lc, admin] = await Promise.all([getTranslations('admin.landed_cost'), getTranslations('admin')]);
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  const day = (value: string | Date | null) => (value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—');
  const withdrawable = landed.charges.filter((charge) => !charge.lockId && !charge.cancelledAt && charge.sourceType === 'journal_entry');
  const lockForm = may.lock && landed.state.ready && landed.state.unlocked > 0;

  return (
    <>
      {landed.state.unlocked > 0 && landed.preview.models.length > 0 ? (
        <div className={s.sapTableWrap}>
          <table aria-label={lc('preview_title')} className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{lc('col_model')}</th>
                <th className={s.sapNum} scope="col">
                  {lc('col_received')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_on_hand')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_value')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_allocated')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_unit_now')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_unit_after')}
                </th>
              </tr>
            </thead>
            <tbody>
              {landed.preview.models.map((model) => (
                <tr key={model.itemCode}>
                  <td>
                    <bdi dir="ltr">{model.itemCode}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{formatQuantity(model.receivedQty, locale as Locale)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{formatQuantity(model.onHandQty, locale as Locale)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(model.valueIqd, 'IQD')}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{model.allocatedIqd ? money(model.allocatedIqd, 'IQD') : '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(model.unitCostIqd, 'IQD')}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{model.unitCostAfterIqd ? money(model.unitCostAfterIqd, 'IQD') : '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* What each model finally cost, once the cost is locked — the figure the warehouse holds. */}
      {landed.finalCost.length > 0 ? (
        <div className={s.sapTableWrap}>
          <table aria-label={lc('final_title')} className={s.sapTable}>
            <caption className={s.sapTitleMeta}>{lc('final_title')}</caption>
            <thead>
              <tr>
                <th scope="col">{lc('col_model')}</th>
                <th className={s.sapNum} scope="col">
                  {lc('col_received')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_on_hand')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_invoiced_unit')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_charges_unit')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_final_unit')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_final_value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {landed.finalCost.map((model) => (
                <tr key={model.itemCode}>
                  <td>
                    <bdi dir="ltr">{model.itemCode}</bdi>
                  </td>
                  <td className={s.sapNum}>{model.receivedQty}</td>
                  <td className={s.sapNum}>{model.onHandQty}</td>
                  <td className={s.sapNum}>{money(model.invoicedUnitIqd, 'IQD')}</td>
                  <td className={s.sapNum}>{money(model.chargesUnitIqd, 'IQD')}</td>
                  <td className={s.sapNum}>
                    <strong>{money(model.finalUnitIqd, 'IQD')}</strong>
                  </td>
                  <td className={s.sapNum}>{money(model.finalValueIqd, 'IQD')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The Final Cost prints: the chain per layer, the locks' charges and where the departed part went. */}
          <div className={s.sapFootActions}>
            <ExportMenu exportKey="landed_cost_final" id={row.payableNo} label={lc('final_print')} />
          </div>
        </div>
      ) : null}

      {landed.locks.length > 0 ? (
        <div className={s.sapTableWrap}>
          <table aria-label={lc('locks_title')} className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{lc('col_lock')}</th>
                <th scope="col">{lc('col_date')}</th>
                <th scope="col">{lc('col_basis')}</th>
                <th className={s.sapNum} scope="col">
                  {lc('col_total')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_stock')}
                </th>
                <th className={s.sapNum} scope="col">
                  {lc('col_cogs')}
                </th>
                <th scope="col">{lc('col_journal')}</th>
                <th scope="col">{lc('col_by')}</th>
              </tr>
            </thead>
            <tbody>
              {landed.locks.map((lock) => (
                <tr key={lock.id}>
                  <td>{lock.sequence === 1 ? lc('lock_first') : `${lc('lock_adjustment')} ${lock.sequence}`}</td>
                  <td>
                    <bdi dir="ltr">{day(lock.lockDate)}</bdi>
                  </td>
                  <td>{locale !== 'en' && lc.has(`basis_name.${lock.basisCode}`) ? lc(`basis_name.${lock.basisCode}`) : lock.basisName}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(lock.totalIqd, 'IQD')}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(lock.inventoryIqd, 'IQD')}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(lock.cogsIqd, 'IQD')}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{lock.entryNo}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{lock.lockedBy ?? '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!landed.state.ready && landed.state.unlocked > 0 ? <p className={s.sapNote}>{lc('not_lockable')}</p> : null}

      {may.addCharge || lockForm || (may.withdraw && withdrawable.length > 0) ? (
        <div className={s.sapBody}>
          <SubmitRow>
            {may.addCharge ? (
              <NewRecordDialog buttonLabel={lc('add')} closeLabel={admin('close')} title={lc('add_title', { payableNo: row.payableNo })}>
                <p className="muted">{lc('add_note')}</p>
                <Form action={addLandedCharge}>
                  <Hidden name="payable_no" value={row.payableNo} />
                  <Hidden name="return_to" value={returnTo} />
                  <Grid>
                    <Select
                      label={lc('charge_type')}
                      name="charge_type"
                      options={landed.types.map((type) => ({
                        value: type.code,
                        label: locale !== 'en' && lc.has(`type_name.${type.code}`) ? lc(`type_name.${type.code}`) : type.name,
                      }))}
                      required
                    />
                    <Field id="landed-journal" label={lc('journal_entry_no')} name="journal_entry_no" required />
                    <Field id="landed-amount" label={lc('amount')} name="amount" required />
                    <Field hint={lc('reason_hint')} id="landed-reason" label={lc('reason')} name="reason" />
                  </Grid>
                  <Field id="landed-note" label={lc('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={lc('add')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {lockForm ? (
              <NewRecordDialog
                buttonLabel={landed.state.locked ? lc('lock_again') : lc('lock')}
                closeLabel={admin('close')}
                title={lc('lock_title', { payableNo: row.payableNo })}
              >
                <p className="muted">{lc('lock_note', { total: money(landed.preview.total, 'IQD') })}</p>
                <Form action={lockLandedCost}>
                  <Hidden name="payable_no" value={row.payableNo} />
                  <Hidden name="return_to" value={returnTo} />
                  <Hidden name="line_count" value={String(landed.preview.models.length)} />
                  <Grid>
                    <Select
                      defaultValue={landed.bases.find((basis) => basis.isDefault)?.code}
                      label={lc('basis')}
                      name="basis"
                      options={landed.bases.map((basis) => ({
                        value: basis.code,
                        label: locale !== 'en' && lc.has(`basis_name.${basis.code}`) ? lc(`basis_name.${basis.code}`) : basis.name,
                      }))}
                    />
                    <Field defaultValue={businessToday()} id="landed-lock-date" label={lc('lock_date')} name="lock_date" type="date" />
                  </Grid>
                  {landed.preview.models.length > 0 ? (
                    <div className={s.sapTableWrap}>
                      <table className={s.sapTable}>
                        <thead>
                          <tr>
                            <th scope="col">{lc('col_model')}</th>
                            <th scope="col">{lc('col_allocated')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {landed.preview.models.map((model, index) => (
                            <tr key={model.itemCode}>
                              <td>
                                <Hidden name={`model_${index}`} value={model.itemCode} />
                                <bdi dir="ltr">{model.itemCode}</bdi>
                              </td>
                              <td>
                                <input aria-label={`${lc('col_allocated')} ${model.itemCode}`} className={s.input} inputMode="decimal" name={`amount_${index}`} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  <p className="muted">{lc('manual_hint')}</p>
                  <Field id="landed-lock-note" label={lc('note')} name="note" wide />
                  <SubmitRow>
                    <Submit label={landed.state.locked ? lc('lock_again') : lc('lock')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {may.withdraw && withdrawable.length > 0 ? (
              <NewRecordDialog buttonLabel={lc('withdraw')} closeLabel={admin('close')} title={lc('withdraw')}>
                <p className="muted">{lc('withdraw_note')}</p>
                <Form action={withdrawLandedCharge}>
                  <Hidden name="payable_no" value={row.payableNo} />
                  <Hidden name="return_to" value={returnTo} />
                  <Select
                    label={lc('withdraw_charge')}
                    name="charge_id"
                    options={withdrawable.map((charge) => ({
                      value: charge.id,
                      label: `${charge.sourceNo ?? ''} · ${charge.chargeTypeName} · ${money(charge.amountIqd, 'IQD')}`,
                    }))}
                    required
                  />
                  <Field id="landed-withdraw-reason" label={lc('withdraw_reason')} name="reason" required wide />
                  <SubmitRow>
                    <Submit label={lc('withdraw')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </SubmitRow>
        </div>
      ) : null}
    </>
  );
}

/**
 * The whole section as the import application's page shows it: the window,
 * its title with the total and the state, the charges, then the details.
 * `titleActions` is the slot for the doors in the title (the paperclip on the
 * import's page); `showCharges` is off on the sheet, whose document window
 * already lists them.
 */
export async function LandedCostSection({
  row,
  landed,
  locale,
  may,
  returnTo,
  titleActions,
  showCharges = true,
}: {
  readonly row: LandedRow;
  readonly landed: NonNullable<LandedBlock>;
  readonly locale: string;
  readonly may: LandedMay;
  readonly returnTo: string;
  readonly titleActions?: ReactNode;
  readonly showCharges?: boolean;
}) {
  const lc = await getTranslations('admin.landed_cost');
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  return (
    <section aria-labelledby="payable-landed-title" className={s.sapDoc} id="landed-cost">
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="payable-landed-title">
          <span>{lc('section_title')}</span>
          <span className={s.sapTitleMeta}>
            {lc('meta', {
              total: money(landedChargesTotal(landed), 'IQD'),
              state:
                landed.state.unlocked > 0
                  ? lc('state_pending', { count: landed.state.unlocked })
                  : landed.state.locked
                    ? lc('state_locked')
                    : lc('state_open'),
            })}
          </span>
          {titleActions ? <span className={s.sapTitleActions}>{titleActions}</span> : null}
        </h2>
        {showCharges ? (
          <div className={s.sapTableWrap}>
            <LandedChargesTable labelledBy="payable-landed-title" landed={landed} locale={locale} />
          </div>
        ) : null}
        <LandedCostDetails landed={landed} locale={locale} may={may} returnTo={returnTo} row={row} />
      </div>
    </section>
  );
}
