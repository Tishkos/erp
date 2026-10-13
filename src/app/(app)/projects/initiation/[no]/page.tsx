import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { readAttachments, type AttachmentsRead } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import {
  AWARD_STATUSES,
  BOQ_CATEGORIES,
  COMPLIANCE_RESPONSES,
  GUARANTEE_STATUSES,
  INITIATION_ACTIVITY_KINDS,
  INITIATION_FILE_SECTIONS,
  PROPOSAL_STATUSES,
  SITE_KINDS,
  SYSTEM_TYPES,
  boqStage,
  guideNumber,
  hasReached,
  initiationChip,
  sectionStage,
  sectionWritable,
  type InitiationFileSection,
  type InitiationSection,
  type InitiationStage,
} from '@domain/project-initiation';
import { businessDateOf, businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as initiation from '@/server/services/project-initiation';
import * as recordNotes from '@/server/services/record-notes';
import {
  addBoqLine,
  addComplianceLine,
  advanceInitiation,
  answerComplianceLine,
  convertInitiation,
  decideInitiationGo,
  logInitiationActivity,
  markInitiationLost,
  removeBoqLine,
  removeComplianceLine,
  saveInitiationSection,
} from '../actions';
import { InitiationPipeline } from '../pipeline';

/**
 * One Project Initiation — the company's Project Guide (2026-10-12). Copies the
 * Purchase Invoice page: the document window with the record's header, its
 * four doors, the bill of quantities as its lines and the next step at its
 * foot; then the workflow as a stepper, and one stacked section per stage the
 * record has reached — what the stage recorded, its own papers behind its own
 * paperclip, and its form behind *Edit* while the record is open. The stage's
 * gate is said in a note above the window, so nobody has to press *Next stage*
 * to find out what is missing.
 */
export const dynamic = 'force-dynamic';

const ROUTE = '/projects/initiation';

interface Box {
  readonly label: string;
  readonly value: ReactNode;
  readonly wide?: boolean;
}

/** A stage's facts in the document's own labelled boxes. */
function Boxes({ rows }: { readonly rows: readonly Box[] }) {
  return (
    <div className={s.sapFields}>
      {rows.map((row, index) => (
        <div className={row.wide ? `${s.sapField} ${s.sapWide}` : s.sapField} key={index}>
          <span className={s.sapLabel}>{row.label}</span>
          <span className={s.sapBox}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** One stage of the record: a stacked section in the supplier-statement manner. */
function StageSection({
  id,
  title,
  chip,
  chipLabel,
  doors,
  foot,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly chip: string;
  readonly chipLabel: string;
  readonly doors?: ReactNode;
  readonly foot?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={s.sapDoc} data-stage-section="" id={id}>
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id={`${id}-title`}>
          {/* The stage and where it stands, together at the start; its own doors at the end. */}
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{title}</span>
            <span className={`status status--${chip}`} data-status={chip}>
              {chipLabel}
            </span>
          </span>
          {doors ? <span className={s.sapTitleActions}>{doors}</span> : null}
        </h2>
        <div className={s.sapBody}>{children}</div>
        {foot ? (
          <div className={s.sapFoot}>
            <div className={s.sapFootActions}>{foot}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default async function ProjectInitiationRecordPage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: SearchParams }) {
  if (!visibleRoute(ROUTE)) notFound();
  const [t, x, page, column, locale, context, outcome, { no: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.project_initiation'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const initiationNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', initiation.PERMISSION_OBJECT)) {
    return <Denied object={page('project_initiation')} />;
  }
  const mayEdit = can(principal, 'edit_draft', initiation.PERMISSION_OBJECT);
  const mayApprove = can(principal, 'approve', initiation.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await initiation.viewByNo(tx, initiationNo);
      const files = await readAttachments(tx, initiation.DOCUMENT_TYPE, initiationNo);
      const sectionFiles = {} as Record<InitiationFileSection, AttachmentsRead>;
      for (const section of INITIATION_FILE_SECTIONS) sectionFiles[section] = await readAttachments(tx, section, initiationNo);
      const notes = await recordNotes.listNotes(tx, { object: initiation.DOCUMENT_TYPE, recordId: initiationNo });
      const pickers = mayEdit || mayApprove ? await initiation.pickers(tx) : null;
      const depts = mayApprove ? (await departments.listAll(tx)).filter((d) => d.active) : [];
      return { view, files, sectionFiles, notes, pickers, depts };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { view, files, sectionFiles, notes, pickers, depts } = found;
  const row = view.initiation;
  const { kind, stage, status } = view;
  const open = status === 'open';
  const today = businessToday();

  const money = (value: string | null) => (value ? formatMoney(value, 'IQD', locale as Locale) : '—');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const words = (value: string | null) => <bdi dir="auto">{value ?? '—'}</bdi>;
  const ltr = (value: string | null) => <bdi dir="ltr">{value ?? '—'}</bdi>;
  /** A code of a closed list, in the reader's language; the code itself only where no label exists. */
  const coded = (group: string, code: string | null) => (code ? (x.has(`${group}.${code}`) ? x(`${group}.${code}`) : code) : '—');
  /** A form's default as typed: the stored decimal without its trailing zeros (never through a float). */
  const plain = (value: string | null) => (value ? (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value) : '');
  const stageTitle = (at: InitiationStage) => `${guideNumber(at)} · ${x(`stage.${at}`)}`;
  const reached = (at: InitiationStage) => hasReached(kind, stage, at);
  const writable = (section: InitiationSection) => mayEdit && sectionWritable(kind, stage, status, section);
  const chipOf = (at: InitiationStage) => (status === 'converted' || at !== stage ? 'approved' : open ? 'submitted' : 'rejected');
  const chipLabelOf = (at: InitiationStage) => (status === 'converted' || at !== stage ? x('step_done') : open ? x('step_current') : x('step_stopped'));
  const hidden = (section: InitiationSection) => (
    <>
      <Hidden name="initiation_no" value={row.initiationNo} />
      <Hidden name="section" value={section} />
    </>
  );
  const paperclip = (section: InitiationFileSection) => (
    <RecordAttachmentsDoor files={sectionFiles[section]} mayAttach={mayEdit && open} object={section} recordId={row.initiationNo} />
  );
  const editDialog = (section: InitiationSection, fields: ReactNode) =>
    writable(section) ? (
      <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} quiet title={x('edit_title', { stage: x(`section.${section}`) })}>
        <Form action={saveInitiationSection}>
          {hidden(section)}
          {fields}
          <SubmitRow>
            <Submit label={t('save')} />
          </SubmitRow>
        </Form>
      </NewRecordDialog>
    ) : null;
  const customerChoices = (pickers?.customers ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }));
  const customerBox: Box = {
    label: x('customer_partner'),
    value: view.customer ? <ProfileLink code={view.customer.code} dir="auto" kind="customer" name={view.customer.name} /> : x('customer_partner_none'),
  };

  const gateOpen = view.missing.length === 0;
  const mayConvert = open && view.atContract && gateOpen && mayApprove && (row.createdBy !== principal.userId || principal.isSuperUser);
  const waitsForSecondPerson = open && view.atContract && gateOpen && row.createdBy === principal.userId && !principal.isSuperUser;
  const mayDecideGo = open && kind === 'tender' && stage === 'go_no_go' && mayApprove && row.goDecision !== 'go';
  const boqAt = boqStage(kind);

  const fields: DocumentField[] = [
    { label: x('number'), value: ltr(row.initiationNo) },
    { label: column('status'), value: coded('status', status), status: initiationChip(status) },
    { label: x('kind'), value: coded('kind_option', kind) },
    { label: x('stage_field'), value: <bdi dir="auto">{stageTitle(stage)}</bdi> },
    { label: x('title_field'), value: words(row.title), wide: true },
    { label: kind === 'tender' ? x('issuing_entity') : x('customer_name'), value: words(row.customerName) },
    customerBox,
    { label: x('owner'), value: words(view.people.owner) },
    { label: column('branch'), value: <ProfileLink code={row.branchCode} kind="branch" /> },
    { label: x('raised_by'), value: <bdi dir="auto">{`${view.people.createdBy ?? '—'} · ${day(businessDateOf(row.createdAt))}`}</bdi> },
    // A name and a day fit the box; the exact moment is in the history behind the clock.
    ...(row.boqApprovedAt ? [{ label: x('boq_approved_by'), value: <bdi dir="auto">{`${view.people.boqApprovedBy ?? '—'} · ${day(businessDateOf(row.boqApprovedAt))}`}</bdi> }] : []),
    ...(view.project
      ? [
          { label: x('converted_by'), value: <bdi dir="auto">{`${view.people.convertedBy ?? '—'} · ${row.convertedAt ? day(businessDateOf(row.convertedAt)) : '—'}`}</bdi> },
          { label: x('project'), value: <ProfileLink code={view.project.code} dir="auto" kind="project" name={view.project.name} />, wide: true },
        ]
      : []),
    ...(status === 'lost'
      ? [{ label: x('lost_reason'), value: <bdi dir="auto">{`${row.lostReason ?? ''} · ${view.people.lostBy ?? '—'} · ${when(row.lostAt)}`}</bdi>, status: 'rejected', wide: true }]
      : []),
  ];

  // ── The stage forms ──────────────────────────────────────────────────────
  const leadForm = (
    <>
      <Grid>
        <Field defaultValue={row.title} id="lead-title" label={x('title_field')} name="title" required wide />
        <Field defaultValue={row.customerName} id="lead-customer-name" label={x('customer_name')} name="customer_name" required wide />
        <Field defaultValue={row.customerPhone ?? ''} id="lead-customer-phone" label={x('customer_phone')} name="customer_phone" />
        <Field defaultValue={row.initialContactOn ?? today} id="lead-initial-contact" label={x('initial_contact_on')} name="initial_contact_on" type="date" />
        <Select
          defaultValue={row.leadSourceCode ?? ''}
          emptyLabel="—"
          id="lead-source"
          label={x('lead_source')}
          name="lead_source_code"
          options={(pickers?.leadSources ?? []).map((source) => ({ value: source.code, label: coded('lead_source_option', source.code) === source.code ? source.name : coded('lead_source_option', source.code) }))}
        />
        <Select defaultValue={row.partnerId ?? ''} emptyLabel={x('customer_partner_none')} id="lead-partner" label={x('customer_partner')} name="partner_id" options={customerChoices} />
      </Grid>
      <Field defaultValue={row.leadNote ?? ''} id="lead-note" label={x('lead_note')} name="lead_note" wide />
    </>
  );
  const preSalesForm = (
    <Grid>
      <Field defaultValue={row.siteLatitude ?? ''} hint={x('coordinate_hint')} id="pre-lat" label={x('site_latitude')} name="site_latitude" />
      <Field defaultValue={row.siteLongitude ?? ''} hint={x('coordinate_hint')} id="pre-long" label={x('site_longitude')} name="site_longitude" />
      <Field defaultValue={row.siteGovernorate ?? ''} id="pre-governorate" label={x('site_governorate')} name="site_governorate" />
      <Field defaultValue={row.siteArea ?? ''} id="pre-area" label={x('site_area')} name="site_area" />
      <Select defaultValue={row.siteKind ?? ''} emptyLabel="—" id="pre-site-kind" label={x('site_kind')} name="site_kind" options={SITE_KINDS.map((value) => ({ value, label: x(`site_kind_option.${value}`) }))} />
      <Select defaultValue={row.systemType ?? ''} emptyLabel="—" id="pre-system" label={x('system_type')} name="system_type" options={SYSTEM_TYPES.map((value) => ({ value, label: x(`system_type_option.${value}`) }))} />
      <Field defaultValue={row.contactName ?? ''} id="pre-contact-name" label={x('contact_name')} name="contact_name" />
      <Field defaultValue={row.contactJobTitle ?? ''} id="pre-contact-title" label={x('contact_job_title')} name="contact_job_title" />
      <Field defaultValue={row.contactPhone ?? ''} id="pre-contact-phone" label={x('contact_phone')} name="contact_phone" />
      <Field defaultValue={row.contactPhoneAlt ?? ''} id="pre-contact-phone-alt" label={x('contact_phone_alt')} name="contact_phone_alt" />
      <Field defaultValue={row.contactEmail ?? ''} id="pre-contact-email" label={x('contact_email')} name="contact_email" type="email" wide />
    </Grid>
  );
  const surveyForm = (
    <>
      <Grid>
        <Field defaultValue={row.surveyOn ?? ''} id="survey-on" label={x('survey_on')} name="survey_on" type="date" />
      </Grid>
      <Checkbox defaultChecked={row.siteVerified} label={x('site_verified')} name="site_verified" />
      <Field defaultValue={row.surveyNote ?? ''} id="survey-note" label={x('survey_note')} name="survey_note" wide />
    </>
  );
  const proposalForm = (
    <Grid>
      <Field defaultValue={row.proposalRef ?? ''} id="proposal-ref" label={x('proposal_ref')} name="proposal_ref" />
      <Field defaultValue={row.proposalOn ?? ''} id="proposal-on" label={x('proposal_on')} name="proposal_on" type="date" />
      <Field defaultValue={plain(row.proposalValueIqd)} id="proposal-value" label={x('proposal_value')} name="proposal_value_iqd" />
      <Select defaultValue={row.proposalStatus ?? 'draft'} id="proposal-status" label={x('proposal_status')} name="proposal_status" options={PROPOSAL_STATUSES.map((value) => ({ value, label: x(`proposal_status_option.${value}`) }))} />
    </Grid>
  );
  const tenderLeadForm = (
    <Grid>
      <Field defaultValue={row.title} id="tender-title" label={x('title_field')} name="title" required wide />
      <Field defaultValue={row.customerName} id="tender-owner" label={x('issuing_entity')} name="customer_name" required wide />
      <Field defaultValue={row.tenderRef ?? ''} id="tender-ref" label={x('tender_ref')} name="tender_ref" />
      <Field defaultValue={row.submissionDeadline ?? ''} id="tender-deadline" label={x('submission_deadline')} name="submission_deadline" type="date" />
      <Field defaultValue={row.tenderDocumentsUrl ?? ''} hint={x('tender_documents_url_hint')} id="tender-url" label={x('tender_documents_url')} name="tender_documents_url" wide />
      <Select defaultValue={row.partnerId ?? ''} emptyLabel={x('customer_partner_none')} id="tender-partner" label={x('customer_partner')} name="partner_id" options={customerChoices} />
    </Grid>
  );
  const goForm = (
    <>
      <Field defaultValue={row.qualificationRequirements ?? ''} id="go-requirements" label={x('qualification_requirements')} name="qualification_requirements" type="textarea" wide />
      <Grid>
        <Field defaultValue={plain(row.bidBondIqd)} hint={x('bid_bond_hint')} id="go-bond" label={x('bid_bond')} name="bid_bond_iqd" />
      </Grid>
    </>
  );
  const preBidForm = (
    <>
      <Grid>
        <Field defaultValue={row.siteVisitOn ?? ''} id="prebid-visit" label={x('site_visit_on')} name="site_visit_on" type="date" />
      </Grid>
      <Field defaultValue={row.siteVisitMinutes ?? ''} id="prebid-minutes" label={x('site_visit_minutes')} name="site_visit_minutes" type="textarea" wide />
      <Field defaultValue={row.clarifications ?? ''} id="prebid-clarifications" label={x('clarifications')} name="clarifications" type="textarea" wide />
    </>
  );
  const guaranteeStatusSelect = (id: string) => (
    <Select defaultValue={row.guaranteeStatus ?? ''} emptyLabel="—" id={id} label={x('guarantee_status')} name="guarantee_status" options={GUARANTEE_STATUSES.map((value) => ({ value, label: x(`guarantee_status_option.${value}`) }))} />
  );
  const biddingForm = (
    <Grid>
      <Field defaultValue={plain(row.bidPriceIqd)} id="bid-price" label={x('bid_price')} name="bid_price_iqd" />
      <Field defaultValue={row.guaranteeBank ?? ''} id="bid-guarantee-bank" label={x('guarantee_bank')} name="guarantee_bank" />
      <Field defaultValue={row.guaranteeNo ?? ''} id="bid-guarantee-no" label={x('guarantee_no')} name="guarantee_no" />
      <Field defaultValue={plain(row.guaranteeIqd)} id="bid-guarantee-amount" label={x('guarantee_amount')} name="guarantee_iqd" />
      <Field defaultValue={row.guaranteeExpiresOn ?? ''} id="bid-guarantee-expiry" label={x('guarantee_expires_on')} name="guarantee_expires_on" type="date" />
      {guaranteeStatusSelect('bid-guarantee-status')}
    </Grid>
  );
  const awardForm = (
    <Grid>
      <Field defaultValue={row.submittedOn ?? ''} id="award-submitted" label={x('submitted_on')} name="submitted_on" type="date" />
      <Field defaultValue={row.submissionRef ?? ''} id="award-submission-ref" label={x('submission_ref')} name="submission_ref" />
      <Select defaultValue={row.awardStatus ?? 'pending'} id="award-status" label={x('award_status')} name="award_status" options={AWARD_STATUSES.map((value) => ({ value, label: x(`award_status_option.${value}`) }))} />
      <Field defaultValue={row.awardedOn ?? ''} id="award-on" label={x('awarded_on')} name="awarded_on" type="date" />
      {guaranteeStatusSelect('award-guarantee-status')}
    </Grid>
  );
  const contractForm = (
    <>
      <Grid>
        <Field defaultValue={row.contractRef ?? ''} id="contract-ref" label={x('contract_ref')} name="contract_ref" />
        <Field defaultValue={row.contractSignedOn ?? ''} id="contract-signed" label={x('contract_signed_on')} name="contract_signed_on" type="date" />
        <Field defaultValue={plain(row.contractValueIqd ?? row.proposalValueIqd ?? row.bidPriceIqd)} id="contract-value" label={x('contract_value')} name="contract_value_iqd" />
        <Select defaultValue={row.partnerId ?? ''} emptyLabel={x('customer_partner_none')} hint={x('customer_partner_hint')} id="contract-partner" label={x('customer_partner')} name="partner_id" options={customerChoices} />
      </Grid>
      <Field defaultValue={row.paymentTerms ?? ''} id="contract-terms" label={x('payment_terms')} name="payment_terms" type="textarea" wide />
    </>
  );

  const contractSection = reached(sectionStage(kind, 'contract')!) ? (
    <StageSection
      chip={chipOf(sectionStage(kind, 'contract')!)}
      chipLabel={chipLabelOf(sectionStage(kind, 'contract')!)}
      doors={paperclip('initiation_contract')}
      foot={editDialog('contract', contractForm)}
      id="stage-contract"
      title={kind === 'direct_sales' ? stageTitle('contract') : x('section.contract')}
    >
      <Boxes
        rows={[
          { label: x('contract_ref'), value: ltr(row.contractRef) },
          { label: x('contract_signed_on'), value: ltr(day(row.contractSignedOn)) },
          { label: x('contract_value'), value: ltr(money(row.contractValueIqd)) },
          customerBox,
          { label: x('signed_contract_files'), value: ltr(String(view.facts.files.initiation_contract)) },
          { label: x('payment_terms'), value: words(row.paymentTerms), wide: true },
        ]}
      />
    </StageSection>
  ) : null;

  return (
    <AdminPage
      back={{ href: ROUTE, label: page('project_initiation') }}
      tabs={<SectionTabs route={ROUTE} />}
      title={`${row.initiationNo} · ${row.title}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {open && !gateOpen ? (
        <p className={`${s.sapNote} mb-4`} data-initiation-missing="">
          {x('missing_note', { stage: stageTitle(stage) })} {view.missing.map((code) => (x.has(`missing.${code}`) ? x(`missing.${code}`) : code)).join(' · ')}
        </p>
      ) : null}
      {waitsForSecondPerson ? <p className={`${s.sapNote} mb-4`}>{x('second_person_note')}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit && view.boqWritable ? (
              <NewRecordDialog buttonLabel={x('boq_add')} closeLabel={t('close')} title={x('boq_add')}>
                <Form action={addBoqLine}>
                  <Hidden name="initiation_no" value={row.initiationNo} />
                  <Grid>
                    <Select id="boq-category" label={x('boq_category')} name="category" options={BOQ_CATEGORIES.map((value) => ({ value, label: x(`boq_category_option.${value}`) }))} required />
                    <Select emptyLabel={x('boq_item_none')} id="boq-item" label={x('boq_item')} name="item_code" options={(pickers?.items ?? []).map((i) => ({ value: i.code, label: `${i.code} · ${i.name}` }))} />
                    <Field hint={x('boq_description_hint')} id="boq-description" label={column('description')} name="description" wide />
                    <Field id="boq-quantity" label={x('boq_quantity')} name="quantity" required />
                    <Field id="boq-unit" label={x('boq_unit')} name="unit" />
                    <Field id="boq-unit-cost" label={x('boq_unit_cost')} name="unit_cost_iqd" required />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {open && mayEdit && view.next && gateOpen ? (
              <form action={advanceInitiation}>
                <Hidden name="initiation_no" value={row.initiationNo} />
                <Submit label={x('advance_to', { stage: stageTitle(view.next) })} variant="document" />
              </form>
            ) : null}
            {mayDecideGo ? (
              <>
                <NewRecordDialog buttonLabel={x('decide_go')} closeLabel={t('close')} title={x('decide_go')}>
                  <Form action={decideInitiationGo}>
                    <Hidden name="initiation_no" value={row.initiationNo} />
                    <Hidden name="decision" value="go" />
                    <Field id="go-note" label={x('go_note')} name="note" wide />
                    <SubmitRow>
                      <Submit label={x('decide_go')} />
                    </SubmitRow>
                  </Form>
                </NewRecordDialog>
                <NewRecordDialog buttonLabel={x('decide_no_go')} closeLabel={t('close')} quiet title={x('decide_no_go')}>
                  <Form action={decideInitiationGo}>
                    <Hidden name="initiation_no" value={row.initiationNo} />
                    <Hidden name="decision" value="no_go" />
                    <Field id="no-go-note" label={x('no_go_reason')} name="note" required wide />
                    <SubmitRow>
                      <Submit label={x('decide_no_go')} tone="danger" />
                    </SubmitRow>
                  </Form>
                </NewRecordDialog>
              </>
            ) : null}
            {mayConvert ? (
              <NewRecordDialog buttonLabel={x('convert')} closeLabel={t('close')} title={x('convert_title', { number: row.initiationNo })}>
                <Form action={convertInitiation}>
                  <Hidden name="initiation_no" value={row.initiationNo} />
                  <Grid>
                    <Select defaultValue={row.ownerUserId} id="convert-manager" label={x('project_manager')} name="manager_user_id" options={(pickers?.people ?? []).map((p) => ({ value: p.id, label: p.name }))} required />
                    <Select emptyLabel="—" id="convert-department" label={x('department')} name="department_code" options={depts.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))} />
                    <Field defaultValue={row.contractSignedOn ?? today} id="convert-starts" label={x('baseline_starts_on')} name="baseline_starts_on" required type="date" />
                    <Field id="convert-ends" label={x('baseline_ends_on')} name="baseline_ends_on" required type="date" />
                    <Select
                      defaultValue="progress"
                      id="convert-billing"
                      label={x('billing_method')}
                      name="billing_method"
                      options={['milestone', 'progress', 'time_and_material', 'lump_sum'].map((value) => ({ value, label: x(`billing_method_option.${value}`) }))}
                    />
                    <Field defaultValue="0" id="convert-retention" label={x('retention_percent')} name="retention_percent" />
                    <Field defaultValue="0" id="convert-advance" label={x('advance_recovery_percent')} name="advance_recovery_percent" />
                    <Field hint={x('project_code_hint')} id="convert-code" label={x('project_code')} name="project_code" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('convert')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {open && mayEdit ? (
              <ReasonForm action={markInitiationLost} hidden={{ initiation_no: row.initiationNo }} label={x('mark_lost')} reasonLabel={x('lost_reason')} />
            ) : null}
            {view.project ? (
              <Link className="action" href={`/projects/${encodeURIComponent(view.project.code)}`}>
                {x('open_project')}
              </Link>
            ) : null}
          </>
        }
        documentType={page('project_initiation')}
        fields={fields}
        id="initiation-document"
        linesCount={view.boq.length}
        linesTitle={`${stageTitle(boqAt)} — ${x('boq_title')}`}
        number={row.initiationNo}
        titleActions={
          <>
            <ExportIcon exportKey="project_initiation" id={row.initiationNo} title={`${page('project_initiation')} ${row.initiationNo}`} />
            <RecordAttachmentsDoor files={files} mayAttach={mayEdit && open} object={initiation.DOCUMENT_TYPE} recordId={row.initiationNo} />
            <RecordNotesDoor notes={notes} object={initiation.DOCUMENT_TYPE} recordId={row.initiationNo} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={row.initiationNo} objectType={initiation.DOCUMENT_TYPE} />
            </HistoryButton>
          </>
        }
        totals={[
          { label: x('boq_category_option.material'), value: money(view.boqTotals.material) },
          { label: x('boq_category_option.shipping'), value: money(view.boqTotals.shipping) },
          { label: x('boq_category_option.installation'), value: money(view.boqTotals.installation) },
          { label: x('boq_total'), value: money(view.boqTotals.total) },
        ]}
      >
        <table aria-labelledby="initiation-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{x('boq_category')}</th>
              <th scope="col">{x('boq_item')}</th>
              <th scope="col">{column('description')}</th>
              <th className={s.sapNum} scope="col">
                {x('boq_quantity')}
              </th>
              <th scope="col">{x('boq_unit')}</th>
              <th className={s.sapNum} scope="col">
                {x('boq_unit_cost')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('boq_amount')}
              </th>
              {view.boqWritable && mayEdit ? <th scope="col">{t('actions')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {view.boq.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={view.boqWritable && mayEdit ? 9 : 8}>
                  {reached(boqAt) ? x('boq_none') : x('boq_not_yet', { stage: stageTitle(boqAt) })}
                </td>
              </tr>
            ) : null}
            {view.boq.map((line) => (
              <tr key={line.id}>
                <td>
                  <bdi dir="ltr">{line.lineNo}</bdi>
                </td>
                <td>{coded('boq_category_option', line.category)}</td>
                <td>{line.itemCode ? <ProfileLink code={line.itemCode} kind="item" /> : '—'}</td>
                <td>
                  <bdi dir="auto">{line.description}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{plain(line.quantity)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.unit ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitCostIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.amountIqd)}</bdi>
                </td>
                {view.boqWritable && mayEdit ? (
                  <td>
                    <form action={removeBoqLine}>
                      <Hidden name="initiation_no" value={row.initiationNo} />
                      <Hidden name="line_id" value={line.id} />
                      <Submit label={x('remove')} small tone="danger" />
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <InitiationPipeline lost={status === 'lost'} steps={view.steps} />

      {/* ── Workflow One — the Direct Sales process ─────────────────────── */}
      {kind === 'direct_sales' ? (
        <>
          <StageSection chip={chipOf('lead')} chipLabel={chipLabelOf('lead')} foot={editDialog('lead', leadForm)} id="stage-lead" title={stageTitle('lead')}>
            <Boxes
              rows={[
                { label: x('customer_name'), value: words(row.customerName) },
                { label: x('customer_phone'), value: ltr(row.customerPhone) },
                { label: x('initial_contact_on'), value: ltr(day(row.initialContactOn)) },
                { label: x('lead_source'), value: row.leadSourceCode ? (coded('lead_source_option', row.leadSourceCode) === row.leadSourceCode ? words(view.leadSource?.name ?? row.leadSourceCode) : coded('lead_source_option', row.leadSourceCode)) : '—' },
                customerBox,
                { label: x('lead_note'), value: words(row.leadNote), wide: true },
              ]}
            />
          </StageSection>

          {reached('pre_sales') ? (
            <StageSection
              chip={chipOf('pre_sales')}
              chipLabel={chipLabelOf('pre_sales')}
              doors={paperclip('initiation_customer_docs')}
              foot={editDialog('pre_sales', preSalesForm)}
              id="stage-pre_sales"
              title={stageTitle('pre_sales')}
            >
              <Boxes
                rows={[
                  { label: x('site_coordinates'), value: ltr(row.siteLatitude && row.siteLongitude ? `${row.siteLatitude}, ${row.siteLongitude}` : null) },
                  { label: x('site_governorate'), value: words(row.siteGovernorate) },
                  { label: x('site_area'), value: words(row.siteArea) },
                  { label: x('site_kind'), value: coded('site_kind_option', row.siteKind) },
                  { label: x('system_type'), value: coded('system_type_option', row.systemType) },
                  { label: x('contact_name'), value: words(row.contactName) },
                  { label: x('contact_job_title'), value: words(row.contactJobTitle) },
                  { label: x('contact_phone'), value: ltr([row.contactPhone, row.contactPhoneAlt].filter(Boolean).join(' · ') || null) },
                  { label: x('contact_email'), value: ltr(row.contactEmail) },
                  { label: x('customer_documents'), value: ltr(String(view.facts.files.initiation_customer_docs)) },
                ]}
              />
            </StageSection>
          ) : null}

          {reached('site_survey') ? (
            <StageSection
              chip={chipOf('site_survey')}
              chipLabel={chipLabelOf('site_survey')}
              doors={paperclip('initiation_design')}
              foot={editDialog('site_survey', surveyForm)}
              id="stage-site_survey"
              title={stageTitle('site_survey')}
            >
              <Boxes
                rows={[
                  { label: x('survey_on'), value: ltr(day(row.surveyOn)) },
                  { label: x('site_verified'), value: row.siteVerified ? t('yes') : t('no') },
                  { label: x('design_files'), value: ltr(String(view.facts.files.initiation_design)) },
                  { label: x('survey_note'), value: words(row.surveyNote), wide: true },
                ]}
              />
            </StageSection>
          ) : null}

          {reached('proposal') ? (
            <StageSection
              chip={chipOf('proposal')}
              chipLabel={chipLabelOf('proposal')}
              doors={
                <>
                  <ExportIcon exportKey="project_proposal" id={row.initiationNo} title={`${x('proposal_print')} ${row.initiationNo}`} />
                  {paperclip('initiation_proposal')}
                </>
              }
              foot={editDialog('proposal', proposalForm)}
              id="stage-proposal"
              title={stageTitle('proposal')}
            >
              <Boxes
                rows={[
                  { label: x('proposal_ref'), value: ltr(row.proposalRef) },
                  { label: x('proposal_on'), value: ltr(day(row.proposalOn)) },
                  { label: x('proposal_value'), value: ltr(money(row.proposalValueIqd)) },
                  { label: x('proposal_status'), value: coded('proposal_status_option', row.proposalStatus) },
                ]}
              />
            </StageSection>
          ) : null}

          {contractSection}
        </>
      ) : null}

      {/* ── Workflow Two — the Tender pipeline ──────────────────────────── */}
      {kind === 'tender' ? (
        <>
          <StageSection
            chip={chipOf('tender_lead')}
            chipLabel={chipLabelOf('tender_lead')}
            doors={paperclip('initiation_tender_docs')}
            foot={editDialog('tender_lead', tenderLeadForm)}
            id="stage-tender_lead"
            title={stageTitle('tender_lead')}
          >
            <Boxes
              rows={[
                { label: x('issuing_entity'), value: words(row.customerName) },
                { label: x('tender_ref'), value: ltr(row.tenderRef) },
                { label: x('submission_deadline'), value: ltr(day(row.submissionDeadline)) },
                customerBox,
                {
                  label: x('tender_documents_url'),
                  value: row.tenderDocumentsUrl ? (
                    <a className={s.sapLink} href={row.tenderDocumentsUrl} rel="noopener noreferrer" target="_blank">
                      <bdi dir="ltr">{row.tenderDocumentsUrl}</bdi>
                    </a>
                  ) : (
                    '—'
                  ),
                  wide: true,
                },
              ]}
            />
          </StageSection>

          {reached('go_no_go') ? (
            <StageSection chip={chipOf('go_no_go')} chipLabel={chipLabelOf('go_no_go')} foot={editDialog('go_no_go', goForm)} id="stage-go_no_go" title={stageTitle('go_no_go')}>
              <Boxes
                rows={[
                  { label: x('bid_bond'), value: ltr(money(row.bidBondIqd)) },
                  { label: x('go_decision'), value: row.goDecision ? coded('go_decision_option', row.goDecision) : x('go_decision_waiting') },
                  ...(row.goDecidedAt ? [{ label: x('go_decided_by'), value: <bdi dir="auto">{`${view.people.goDecidedBy ?? '—'} · ${when(row.goDecidedAt)}`}</bdi> }] : []),
                  ...(row.goNote ? [{ label: x('go_note'), value: words(row.goNote), wide: true }] : []),
                  { label: x('qualification_requirements'), value: words(row.qualificationRequirements), wide: true },
                ]}
              />
            </StageSection>
          ) : null}

          {reached('pre_bid') ? (
            <StageSection chip={chipOf('pre_bid')} chipLabel={chipLabelOf('pre_bid')} foot={editDialog('pre_bid', preBidForm)} id="stage-pre_bid" title={stageTitle('pre_bid')}>
              <Boxes
                rows={[
                  { label: x('site_visit_on'), value: ltr(day(row.siteVisitOn)) },
                  { label: x('site_visit_minutes'), value: words(row.siteVisitMinutes), wide: true },
                  { label: x('clarifications'), value: words(row.clarifications), wide: true },
                ]}
              />
            </StageSection>
          ) : null}

          {reached('tender_design') ? (
            <StageSection chip={chipOf('tender_design')} chipLabel={chipLabelOf('tender_design')} doors={paperclip('initiation_design')} id="stage-tender_design" title={stageTitle('tender_design')}>
              <Boxes
                rows={[
                  { label: x('design_files'), value: ltr(String(view.facts.files.initiation_design)) },
                  { label: x('boq_lines'), value: ltr(String(view.boq.length)) },
                  { label: x('boq_total'), value: ltr(money(view.boqTotals.total)) },
                ]}
              />
            </StageSection>
          ) : null}

          {reached('bidding') ? (
            <StageSection
              chip={chipOf('bidding')}
              chipLabel={chipLabelOf('bidding')}
              doors={paperclip('initiation_bid')}
              foot={
                <>
                  {editDialog('bidding', biddingForm)}
                  {mayEdit && view.complianceWritable ? (
                    <NewRecordDialog buttonLabel={x('compliance_add')} closeLabel={t('close')} title={x('compliance_add')}>
                      <Form action={addComplianceLine}>
                        <Hidden name="initiation_no" value={row.initiationNo} />
                        <Grid>
                          <Field id="compliance-clause" label={x('compliance_clause')} name="clause" />
                          <Select emptyLabel={x('compliance_unanswered')} id="compliance-response" label={x('compliance_response')} name="response" options={COMPLIANCE_RESPONSES.map((value) => ({ value, label: x(`compliance_response_option.${value}`) }))} />
                          <Field id="compliance-requirement" label={x('compliance_requirement')} name="requirement" required wide />
                          <Field id="compliance-remark" label={x('compliance_remark')} name="remark" wide />
                        </Grid>
                        <SubmitRow>
                          <Submit label={t('save')} />
                        </SubmitRow>
                      </Form>
                    </NewRecordDialog>
                  ) : null}
                </>
              }
              id="stage-bidding"
              title={stageTitle('bidding')}
            >
              <Boxes
                rows={[
                  { label: x('boq_total'), value: ltr(money(view.boqTotals.total)) },
                  { label: x('bid_price'), value: ltr(money(row.bidPriceIqd)) },
                  { label: x('bid_bond'), value: ltr(money(row.bidBondIqd)) },
                  { label: x('guarantee_bank'), value: words(row.guaranteeBank) },
                  { label: x('guarantee_no'), value: ltr(row.guaranteeNo) },
                  { label: x('guarantee_amount'), value: ltr(money(row.guaranteeIqd)) },
                  { label: x('guarantee_expires_on'), value: ltr(day(row.guaranteeExpiresOn)) },
                  { label: x('guarantee_status'), value: coded('guarantee_status_option', row.guaranteeStatus) },
                ]}
              />
              <div className={s.sapGridCaption} id="compliance">
                <strong>{x('compliance_title')}</strong>
                <span className={s.sapGridCount}>{view.compliance.length}</span>
              </div>
              <div className={s.sapTableWrap}>
                <table aria-labelledby="compliance" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">{x('compliance_clause')}</th>
                      <th scope="col">{x('compliance_requirement')}</th>
                      <th scope="col">{x('compliance_response')}</th>
                      <th scope="col">{x('compliance_remark')}</th>
                      {view.complianceWritable && mayEdit ? <th scope="col">{t('actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {view.compliance.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={view.complianceWritable && mayEdit ? 6 : 5}>
                          {x('compliance_none')}
                        </td>
                      </tr>
                    ) : null}
                    {view.compliance.map((line) => (
                      <tr key={line.id}>
                        <td>
                          <bdi dir="ltr">{line.lineNo}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{line.clause ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{line.requirement}</bdi>
                        </td>
                        <td>{line.response ? coded('compliance_response_option', line.response) : x('compliance_unanswered')}</td>
                        <td>
                          <bdi dir="auto">{line.remark ?? '—'}</bdi>
                        </td>
                        {view.complianceWritable && mayEdit ? (
                          <td>
                            <span className={s.sapFootActions}>
                              <NewRecordDialog buttonLabel={x('compliance_answer')} closeLabel={t('close')} quiet title={`${x('compliance_answer')} · ${line.lineNo}`}>
                                <Form action={answerComplianceLine}>
                                  <Hidden name="initiation_no" value={row.initiationNo} />
                                  <Hidden name="line_id" value={line.id} />
                                  <Grid>
                                    <Select
                                      defaultValue={line.response ?? ''}
                                      id={`answer-${line.lineNo}-response`}
                                      label={x('compliance_response')}
                                      name="response"
                                      options={COMPLIANCE_RESPONSES.map((value) => ({ value, label: x(`compliance_response_option.${value}`) }))}
                                      required
                                    />
                                    <Field defaultValue={line.remark ?? ''} id={`answer-${line.lineNo}-remark`} label={x('compliance_remark')} name="remark" wide />
                                  </Grid>
                                  <SubmitRow>
                                    <Submit label={t('save')} />
                                  </SubmitRow>
                                </Form>
                              </NewRecordDialog>
                              <form action={removeComplianceLine}>
                                <Hidden name="initiation_no" value={row.initiationNo} />
                                <Hidden name="line_id" value={line.id} />
                                <Submit label={x('remove')} small tone="danger" />
                              </form>
                            </span>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </StageSection>
          ) : null}

          {reached('award') ? (
            <StageSection chip={chipOf('award')} chipLabel={chipLabelOf('award')} foot={editDialog('award', awardForm)} id="stage-award" title={stageTitle('award')}>
              <Boxes
                rows={[
                  { label: x('submitted_on'), value: ltr(day(row.submittedOn)) },
                  { label: x('submission_ref'), value: ltr(row.submissionRef) },
                  { label: x('award_status'), value: coded('award_status_option', row.awardStatus) },
                  { label: x('awarded_on'), value: ltr(day(row.awardedOn)) },
                  { label: x('guarantee_status'), value: coded('guarantee_status_option', row.guaranteeStatus) },
                ]}
              />
            </StageSection>
          ) : null}

          {contractSection}
        </>
      ) : null}

      {/* ── Follow-up activities: what was done and said, newest first ───── */}
      <section aria-labelledby="initiation-activities-title" className={s.sapDoc} id="activities">
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="initiation-activities-title">
            <span>{x('activities_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: view.activities.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="initiation-activities-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{x('activity_kind')}</th>
                  <th scope="col">{x('stage_field')}</th>
                  <th scope="col">{x('activity_summary')}</th>
                  <th scope="col">{x('activity_next')}</th>
                  <th scope="col">{x('activity_by')}</th>
                </tr>
              </thead>
              <tbody>
                {view.activities.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {x('activities_none')}
                    </td>
                  </tr>
                ) : null}
                {view.activities.map((activity) => (
                  <tr key={activity.id}>
                    <td>
                      <bdi dir="ltr">{day(activity.happenedOn)}</bdi>
                    </td>
                    <td>{coded('activity_kind_option', activity.kind)}</td>
                    <td>
                      <bdi dir="auto">{coded('stage', activity.stage)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{activity.summary}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{activity.nextAction ? `${activity.nextAction}${activity.nextActionOn ? ` · ${day(activity.nextActionOn)}` : ''}` : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{activity.byName ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open && mayEdit ? (
            <div className={s.sapFoot}>
              <div className={s.sapFootActions}>
                <NewRecordDialog buttonLabel={x('activity_log')} closeLabel={t('close')} title={x('activity_log')}>
                  <Form action={logInitiationActivity}>
                    <Hidden name="initiation_no" value={row.initiationNo} />
                    <Grid>
                      <Select id="activity-kind" label={x('activity_kind')} name="kind" options={INITIATION_ACTIVITY_KINDS.map((value) => ({ value, label: x(`activity_kind_option.${value}`) }))} required />
                      <Field defaultValue={today} id="activity-on" label={column('date')} name="happened_on" required type="date" />
                      <Field id="activity-summary" label={x('activity_summary')} name="summary" required type="textarea" wide />
                      <Field id="activity-next" label={x('activity_next')} name="next_action" />
                      <Field id="activity-next-on" label={x('activity_next_on')} name="next_action_on" type="date" />
                    </Grid>
                    <SubmitRow>
                      <Submit label={t('save')} />
                    </SubmitRow>
                  </Form>
                </NewRecordDialog>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
