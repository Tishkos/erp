import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Undo2 } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  Timeline,
  admin as s,
  type TimelineEntry,
} from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { ConfirmButton } from '@/components/admin/confirm-button';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import {
  formatBusinessDate,
  formatMoney,
  formatQuantity,
  formatTimestamp,
  type Locale,
} from '@/i18n/config';
import { CURRENCIES } from '@domain/currencies';
import { can, isDepartmentManager } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as invoicing from '@/server/services/invoicing';
import {
  addInvoiceLine,
  approveInvoice,
  discardInvoice,
  attachToInvoice,
  cancelInvoice,
  rejectInvoice,
  removeInvoiceLine,
  reverseInvoice,
  submitInvoice,
  updateInvoice,
} from '../actions';

/**
 * One invoice — the document window.
 *
 * Its number is at the top because that is what the document *is*; the status
 * beside it says where it has got to. Below, in the order a person works: who
 * it is for, what is on it, and what can be done with it now.
 *
 * Requirement 10 sits underneath and is not decoration — who raised it, when,
 * its status, and its approval history, each read back from the trail that
 * recorded it rather than from a stored summary.
 *
 * Every action offered is one §7's status structure allows *and* this person
 * may take. The service refuses anything else, so this page can only ever
 * offer less than the truth, never more.
 */
export const dynamic = 'force-dynamic';

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, column, status, locale, context, outcome, { number: rawNumber }] =
    await Promise.all([
      getTranslations('admin'),
      getTranslations('page'),
      getTranslations('column'),
      getTranslations('status'),
      getLocale(),
      requireContext(),
      outcomeOf(searchParams),
      params,
    ]);
  const documentNo = decodeURIComponent(rawNumber);
  const { principal } = context;
  if (!can(principal, 'view', invoicing.PERMISSION_OBJECT)) {
    return <Denied object={page('invoicing')} />;
  }

  const data = await withCurrentUser(async (tx) => {
    try {
      const detail = await invoicing.detail(tx, documentNo);
      return { ...detail, depts: (await departments.listAll(tx)).filter((d) => d.active) };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, raiser, department, managerName, history, lines, depts } = data;
  const when = (d: Date) => formatTimestamp(d.toISOString(), locale as Locale);
  const money = (amount: string) => formatMoney(amount, row.currency, locale as Locale);

  const isManager = isDepartmentManager(principal, row.departmentCode) || principal.isSuperUser;
  const isDraft = row.status === 'draft';
  const mayEdit = isDraft && can(principal, 'edit_draft', invoicing.PERMISSION_OBJECT);
  const maySubmit = isDraft && can(principal, 'submit', invoicing.PERMISSION_OBJECT);
  const mayDecide =
    row.status === 'submitted' && isManager && can(principal, 'approve', invoicing.PERMISSION_OBJECT);
  const mayCancel =
    (isDraft || row.status === 'submitted') &&
    can(principal, 'reverse_cancel', invoicing.PERMISSION_OBJECT);
  const mayReverse =
    row.status === 'approved' && can(principal, 'reverse_cancel', invoicing.PERMISSION_OBJECT);
  const mayAttach = can(principal, 'create', 'attachment');
  const hidden = { id: row.id, documentNo: row.documentNo };

  /** Who raised it, and what each approver decided. */
  const trail: TimelineEntry[] = [
    {
      id: 'raised',
      when: when(row.createdAt),
      action: t('invoicing.trail_raised'),
      actor: raiser?.displayName ?? null,
      outcome: 'success',
      reason: null,
      detail: null,
    },
    ...history.map(
      (entry, index): TimelineEntry => ({
        id: `decision-${index}`,
        when: when(entry.decidedAt),
        action: t(`invoicing.trail_${entry.decision}`),
        actor: entry.actorName ?? null,
        outcome: entry.decision === 'rejected' ? 'denied' : 'success',
        reason: entry.reason,
        detail: null,
      }),
    ),
  ];

  return (
    <AdminPage
      back={{ href: '/accounting/invoicing', label: t('back') }}
      title={row.documentNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {/* The document band: what it is, where it stands, what happens next. */}
      <div className={s.docBand}>
        <div className={s.docIdentity}>
          <span className={s.docNumber}>{row.documentNo}</span>
          <span className={`status status--${row.status}`}>{status(row.status)}</span>
        </div>
        <div className={s.docTotal}>
          <span>{column('amount')}</span>
          <strong>{money(row.amount)}</strong>
        </div>
        <div className={s.docActions}>
          {maySubmit ? (
            <ActionButton
              action={submitInvoice}
              hidden={hidden}
              label={t('invoicing.submit')}
              small={false}
              tone="primary"
            />
          ) : null}
          {mayDecide ? (
            <ActionButton
              action={approveInvoice}
              hidden={hidden}
              label={t('invoicing.approve')}
              small={false}
              tone="primary"
            />
          ) : null}
          {/* Drafts only. Past that it is a document, and §7 cancels or
              reverses it rather than removing it. */}
          {mayEdit ? (
            <ConfirmButton
              action={discardInvoice}
              body={t('invoicing.discard_confirm', { documentNo: row.documentNo })}
              cancelLabel={t('cancel')}
              confirmLabel={t('invoicing.discard_yes')}
              hidden={hidden}
              label={t('invoicing.discard')}
              title={t('invoicing.discard_title')}
            />
          ) : null}
        </div>
      </div>

      {/* An approver sent it back. The person who has to fix it reads why here. */}
      {isDraft && row.returnedReason ? (
        <div className={s.calloutReturned} role="note">
          <Undo2 aria-hidden="true" />
          <div>
            <strong>{t('invoicing.returned')}</strong>
            <p>{row.returnedReason}</p>
          </div>
        </div>
      ) : null}

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('invoicing.header')}>
              <Form action={updateInvoice}>
                <input name="id" type="hidden" value={row.id} />
                <input name="documentNo" type="hidden" value={row.documentNo} />
                <Grid>
                  <Field
                    defaultValue={row.customerName}
                    label={t('invoicing.customer')}
                    name="customerName"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Field
                    defaultValue={row.documentDate}
                    label={t('invoicing.document_date')}
                    name="documentDate"
                    type="date"
                />
                  <Select
                    defaultValue={row.currency}
                    label={t('invoicing.currency')}
                    name="currency"
                    options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
                    required
                  />
                  <Select
                    defaultValue={row.departmentCode}
                    hint={t('invoicing.department_hint')}
                    label={t('invoicing.department')}
                    name="departmentCode"
                    options={depts.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                    required
                  />
                  <Field
                    defaultValue={row.description}
                    label={t('invoicing.description')}
                    name="description"
                    type="textarea"
                    wide
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : (
            <Panel title={t('details')}>
              <ul className={s.profileFacts}>
                <li>
                  <span>{t('invoicing.customer')}</span>
                  <span>{row.customerName}</span>
                </li>
                <li>
                  <span>{t('invoicing.document_date')}</span>
                  <span>{formatBusinessDate(row.documentDate, locale as Locale)}</span>
                </li>
                <li>
                  <span>{t('invoicing.currency')}</span>
                  <span>{row.currency}</span>
                </li>
                {row.description ? (
                  <li>
                    <span>{t('invoicing.description')}</span>
                    <span>{row.description}</span>
                  </li>
                ) : null}
              </ul>
            </Panel>
          )}

          <Panel title={t('invoicing.about')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('invoicing.department')}</span>
                <span>{department ? `${department.code} · ${department.name}` : row.departmentCode}</span>
              </li>
              <li>
                <span>{t('invoicing.approver')}</span>
                <span>{managerName ?? t('departments.no_manager')}</span>
              </li>
              <li>
                <span>{column('branch_code')}</span>
                <span>{row.branchCode}</span>
              </li>
              {/* Requirement 10 — who created it, and when. */}
              <li>
                <span>{t('invoicing.raised_by')}</span>
                <span>{raiser?.displayName ?? '—'}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{when(row.createdAt)}</span>
              </li>
              <li>
                <span>{t('updated_at')}</span>
                <span>{when(row.updatedAt)}</span>
              </li>
            </ul>
          </Panel>

          <Attachments
            action={attachToInvoice}
            hidden={hidden}
            mayAttach={mayAttach && isDraft}
            objectId={row.id}
            objectType={invoicing.PERMISSION_OBJECT}
          />
        </div>

        <div className={s.profileStack}>
          <Panel flush title={t('invoicing.items')}>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t('invoicing.item')}</th>
                    <th className="numeric" scope="col">
                      {t('invoicing.quantity')}
                    </th>
                    <th className="numeric" scope="col">
                      {t('invoicing.unit_price')}
                    </th>
                    <th className="numeric" scope="col">
                      {t('invoicing.line_total')}
                    </th>
                    {mayEdit ? <th scope="col" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr>
                      <td className="muted" colSpan={mayEdit ? 6 : 5}>
                        {t('invoicing.no_items')}
                      </td>
                    </tr>
                  ) : (
                    lines.map((line) => (
                      <tr key={line.id}>
                        <td className={s.mono}>{line.lineNo}</td>
                        <td>{line.description}</td>
                        <td className="numeric">{formatQuantity(line.quantity, locale as Locale)}</td>
                        <td className="numeric">{money(line.unitPrice)}</td>
                        <td className="numeric">{money(line.lineTotal)}</td>
                        {mayEdit ? (
                          <td>
                            <ActionButton
                              action={removeInvoiceLine}
                              hidden={{ ...hidden, lineId: line.id }}
                              label={t('invoicing.remove_item')}
                              tone="secondary"
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={mayEdit ? 4 : 3} />
                    <td className={`numeric ${s.totalCell}`}>{t('invoicing.total')}</td>
                    <td className={`numeric ${s.totalCell}`}>{money(row.amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {mayEdit ? (
              <div className={s.lineForm}>
                <Form action={addInvoiceLine}>
                  <input name="id" type="hidden" value={row.id} />
                  <input name="documentNo" type="hidden" value={row.documentNo} />
                  <Grid>
                    <Field
                      id="line-item"
                      label={t('invoicing.item')}
                      name="description"
                      required
                      requiredLabel={t('required_hint')}
                      wide
                    />
                    <Field
                      defaultValue="1"
                      label={t('invoicing.quantity')}
                      min={0}
                      name="quantity"
                      required
                      requiredLabel={t('required_hint')}
                      step="any"
                      type="number"
                    />
                    <Field
                      label={t('invoicing.unit_price')}
                      min={0}
                      name="unitPrice"
                      required
                      requiredLabel={t('required_hint')}
                      step="0.01"
                      type="number"
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('invoicing.add_item')} />
                  </SubmitRow>
                </Form>
              </div>
            ) : null}
          </Panel>

          {mayDecide || mayCancel || mayReverse ? (
            <Panel title={t('invoicing.actions')}>
              {mayDecide ? (
                <ReasonForm
                  action={rejectInvoice}
                  hidden={hidden}
                  label={t('invoicing.reject')}
                  reasonLabel={t('invoicing.reject_reason')}
                />
              ) : null}
              {mayCancel ? (
                <ReasonForm
                  action={cancelInvoice}
                  hidden={hidden}
                  label={t('invoicing.cancel')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : null}
              {mayReverse ? (
                <ReasonForm
                  action={reverseInvoice}
                  hidden={hidden}
                  label={t('invoicing.reverse')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : null}
            </Panel>
          ) : null}

          <Timeline
            emptyLabel={t('invoicing.no_approvals')}
            entries={trail}
            title={t('invoicing.approvals')}
          />

          <RecordHistory objectId={row.id} objectType={invoicing.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
