import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { MAX_GOALS, RATINGS } from '@/server/domain/talent';
import { requireContext, withCurrentUser } from '@/server/session';
import * as performance from '@/server/services/performance';
import { assignReviewer, cancelReview, commentOnReview, completeReview, reopenReview, saveGoals, signOffReview } from '../actions';

/**
 * One performance review — REQ-HR-001 Stage HR-5. Copies the Purchase
 * Invoice page: the document window with its header fields and status chip,
 * its lines the goals — typed in their cells while it is a draft (titles,
 * targets and weights by HR or the reviewer, ratings by the reviewer only),
 * read-only after — the verbs at its foot; the audit log.
 */
export const dynamic = 'force-dynamic';

const REVIEW_TONE: Readonly<Record<string, string>> = { draft: 'draft', rated: 'submitted', signed_off: 'posted', cancelled: 'cancelled' };
/** Blank lines offered under a draft's goals, for new ones. */
const NEW_LINES = 2;

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ reviewNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/performance')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome, { reviewNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.performance'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const reviewNo = decodeURIComponent(rawNo);
  const { principal } = context;
  // Row security decides who sees it: HR by branch and grant, the person, the reviewer.
  const found = await withCurrentUser(async (tx) => {
    const detail = await performance.byNo(tx, reviewNo);
    if (!detail) return null;
    const hrEdits = detail.row.status === 'draft' && can(principal, 'edit_draft', performance.PERMISSION_OBJECT);
    return { detail, reviewers: hrEdits ? await performance.reviewers(tx) : [] };
  });
  if (!found) {
    if (!can(principal, 'view', performance.PERMISSION_OBJECT)) return <Denied object={page('performance')} />;
    notFound();
  }
  const { detail, reviewers } = found;
  const { row, person, goals } = detail;
  const me = principal.userId;
  const reviewer = row.reviewerUserId === me;
  const self = person.appUserId === me;
  const draft = row.status === 'draft';
  const rated = row.status === 'rated';
  const mayEditGoals = draft && (reviewer || can(principal, 'edit_draft', performance.PERMISSION_OBJECT));
  const mayComplete = draft && reviewer;
  const mayReopen = rated && (reviewer || can(principal, 'approve', performance.PERMISSION_OBJECT));
  const signOff = performance.signOffRefusal({ principal }, person, row);
  const mayComment = self && (rated || row.status === 'signed_off') && row.employeeComment === null;
  const mayReassign = draft && can(principal, 'edit_draft', performance.PERMISSION_OBJECT);
  const mayCancel = (draft || rated) && can(principal, 'approve', performance.PERMISSION_OBJECT);
  const tone = REVIEW_TONE[row.status] ?? 'draft';
  const statusLabel = (value: string) => (value === 'rated' || value === 'signed_off' ? x(`status_${value}`) : statusOf(value));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const name = locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn;
  const cycleName = locale === 'ar' && detail.cycleNameAr ? detail.cycleNameAr : detail.cycleName;
  const mayOpenPerson = can(principal, 'view', 'employee');
  const ratingLabel = (value: number | null) => (value ? `${value} · ${x(`rating_${value}`)}` : '—');

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.reviewNo}</bdi> },
    { label: column('status'), value: statusLabel(row.status), status: tone },
    {
      label: x('employee'),
      value: mayOpenPerson ? (
        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(person.employeeNo)}`}>
          <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
        </Link>
      ) : (
        <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
      ),
    },
    { label: x('cycle'), value: <bdi dir="auto">{`${row.cycleCode} · ${cycleName}`}</bdi> },
    { label: x('period'), value: <bdi dir="ltr">{`${day(detail.periodFrom)} – ${day(detail.periodTo)}`}</bdi> },
    { label: x('reviewer'), value: <bdi dir="auto">{detail.reviewerName ?? '—'}</bdi> },
    { label: x('overall'), value: <bdi dir="ltr">{row.overallRating ?? '—'}</bdi> },
    { label: x('created_by'), value: <bdi dir="auto">{when(detail.createdByName, row.createdAt)}</bdi> },
    ...(row.ratedAt ? [{ label: x('rated_at'), value: <bdi dir="auto">{when(detail.reviewerName, row.ratedAt)}</bdi> }] : []),
    ...(row.signedOffAt ? [{ label: x('signed_off_by'), value: <bdi dir="auto">{when(detail.signedOffByName, row.signedOffAt)}</bdi> }] : []),
    ...(row.signOffNote ? [{ label: x('sign_off_note'), value: <bdi dir="auto">{row.signOffNote}</bdi>, wide: true }] : []),
    ...(row.cancelledAt
      ? [
          { label: x('cancelled_by'), value: <bdi dir="auto">{when(detail.cancelledByName, row.cancelledAt)}</bdi> },
          { label: x('cancel_reason'), value: <bdi dir="auto">{row.cancelReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    ...(row.reviewerComment ? [{ label: x('reviewer_comment'), value: <bdi dir="auto">{row.reviewerComment}</bdi>, wide: true }] : []),
    ...(row.employeeComment
      ? [{ label: x('employee_comment'), value: <bdi dir="auto">{`${row.employeeComment} — ${formatTimestamp(new Date(row.employeeCommentedAt!).toISOString(), locale as Locale)}`}</bdi>, wide: true }]
      : []),
  ];

  const hidden = <input name="review_no" type="hidden" value={row.reviewNo} />;
  const blanks = Math.max(0, Math.min(NEW_LINES, MAX_GOALS - goals.length));
  const formRows = [...goals.map((g) => ({ goal: g })), ...Array.from({ length: blanks }, () => ({ goal: null }))];

  return (
    <AdminPage back={{ href: '/hr/performance', label: t('back') }} title={`${row.reviewNo} · ${name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {draft && self && !reviewer ? <p className={s.sapNote}>{x('being_written')}</p> : null}
      {mayEditGoals && detail.weight !== 100 ? <p className={s.sapNote}>{x('weight_short', { weight: detail.weight })}</p> : null}
      {rated && signOff === 'maker' && can(principal, 'approve', performance.PERMISSION_OBJECT) ? <p className={s.sapNote}>{x('maker_checker')}</p> : null}
      {detail.cycleStatus !== 'open' && (draft || rated) ? <p className={s.sapNote}>{x('cycle_not_open', { cycle: row.cycleCode })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayComplete ? (
              <NewRecordDialog buttonLabel={x('complete')} closeLabel={t('close')} title={x('complete_title', { no: row.reviewNo })}>
                <Form action={completeReview}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('complete_caption')}</p>
                  <Grid>
                    <Field label={x('reviewer_comment')} name="comment" type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('complete')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {signOff === null ? (
              <NewRecordDialog buttonLabel={x('sign_off')} closeLabel={t('close')} title={x('sign_off_title', { no: row.reviewNo })}>
                <Form action={signOffReview}>
                  {hidden}
                  <Grid>
                    <Field label={x('sign_off_note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('sign_off')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayComment ? (
              <NewRecordDialog buttonLabel={x('comment')} closeLabel={t('close')} title={x('comment_title', { no: row.reviewNo })}>
                <Form action={commentOnReview}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('comment_caption')}</p>
                  <Grid>
                    <Field label={x('employee_comment')} name="comment" required type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('comment')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayReassign ? (
              <NewRecordDialog buttonLabel={x('reassign')} closeLabel={t('close')} title={x('reassign_title', { no: row.reviewNo })}>
                <Form action={assignReviewer}>
                  {hidden}
                  <Grid>
                    <Select
                      defaultValue={row.reviewerUserId}
                      label={x('reviewer')}
                      name="reviewer_user_id"
                      options={reviewers.filter((u) => u.id !== person.appUserId).map((u) => ({ value: u.id, label: `${u.displayName} · ${u.email}` }))}
                      required
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayReopen ? (
              <form action={reopenReview}>
                {hidden}
                <input aria-label={x('reopen_reason')} name="reason" placeholder={x('reopen_reason')} required type="text" />
                <Submit label={x('reopen')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelReview}>
                {hidden}
                <input aria-label={x('cancel_reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={x('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('document_type')}
        fields={fields}
        id="review-document"
        linesCount={goals.length}
        linesTitle={x('goals_title')}
        number={row.reviewNo}
        totals={[
          { label: x('weight'), value: `${detail.weight}%` },
          { label: x('overall'), value: row.overallRating ?? '—' },
        ]}
      >
        {mayEditGoals ? (
          <Form action={saveGoals}>
            {hidden}
            <Hidden name="line_count" value={String(formRows.length)} />
            <div className={s.sapTableWrap}>
              <table aria-labelledby="review-document-lines-heading" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{x('goal')}</th>
                    <th scope="col">{x('target')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('weight')}
                    </th>
                    <th scope="col">{x('rating')}</th>
                    <th scope="col">{x('goal_comment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {formRows.map(({ goal }, i) => (
                    <tr key={goal ? goal.id : `new-${i}`}>
                      <td>
                        {goal ? <input name={`line_no_${i}`} type="hidden" value={goal.lineNo} /> : null}
                        <bdi dir="ltr">{goal ? goal.lineNo : '+'}</bdi>
                      </td>
                      <td>
                        <input aria-label={`${x('goal')} ${i + 1}`} className={s.sapCellField} defaultValue={goal?.title ?? ''} name={`title_${i}`} />
                      </td>
                      <td>
                        <input aria-label={`${x('target')} ${i + 1}`} className={s.sapCellField} defaultValue={goal?.target ?? ''} name={`target_${i}`} />
                      </td>
                      <td className={s.sapNum}>
                        <input aria-label={`${x('weight')} ${i + 1}`} className={s.sapCellField} defaultValue={goal ? String(goal.weight) : ''} inputMode="numeric" name={`weight_${i}`} />
                      </td>
                      <td>
                        {reviewer ? (
                          <select aria-label={`${x('rating')} ${i + 1}`} className={s.sapCellField} defaultValue={goal?.rating ? String(goal.rating) : ''} name={`rating_${i}`}>
                            <option value="">—</option>
                            {RATINGS.map((r) => (
                              <option key={r} value={String(r)}>
                                {`${r} · ${x(`rating_${r}`)}`}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ratingLabel(goal?.rating ?? null)
                        )}
                      </td>
                      <td>
                        {reviewer ? (
                          <input aria-label={`${x('goal_comment')} ${i + 1}`} className={s.sapCellField} defaultValue={goal?.comment ?? ''} name={`comment_${i}`} />
                        ) : (
                          <bdi dir="auto">{goal?.comment ?? '—'}</bdi>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.sapNote}>{reviewer ? x('goals_hint_reviewer') : x('goals_hint_hr')}</p>
            <SubmitRow>
              <Submit label={x('save_goals')} />
            </SubmitRow>
          </Form>
        ) : (
          <table aria-labelledby="review-document-lines-heading" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{x('goal')}</th>
                <th scope="col">{x('target')}</th>
                <th className={s.sapNum} scope="col">
                  {x('weight')}
                </th>
                <th scope="col">{x('rating')}</th>
                <th scope="col">{x('goal_comment')}</th>
              </tr>
            </thead>
            <tbody>
              {goals.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={6}>
                    {x('goals_none')}
                  </td>
                </tr>
              ) : null}
              {goals.map((goal) => (
                <tr key={goal.id}>
                  <td>
                    <bdi dir="ltr">{goal.lineNo}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{goal.title}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{goal.target ?? '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{`${goal.weight}%`}</bdi>
                  </td>
                  <td>{ratingLabel(goal.rating)}</td>
                  <td>
                    <bdi dir="auto">{goal.comment ?? '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DocumentWindow>

      <RecordHistory objectId={row.reviewNo} objectType={performance.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
