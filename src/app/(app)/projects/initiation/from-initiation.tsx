import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { ProfileLink } from '@/components/admin/profile-link';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { businessDateOf } from '@/server/domain/business-date';
import type { InitiationView } from '@/server/services/project-initiation';

/**
 * What a project carries from the Project Initiation it was converted from —
 * the guide's conversion point (2026-10-12): "The Pre-Sales Form data,
 * drawings, and approved BOQ are transferred to the main project record". A
 * stacked section on the project's page: the form's facts, the files of every
 * section of the initiation, and the bill of quantities whose total became the
 * project's baseline budget. All of it is read from the initiation, where it
 * stays; nothing is copied, so the two can never differ.
 */
export interface InitiationFile {
  readonly section: string;
  readonly id: string;
  readonly fileName: string;
  readonly createdAt: Date;
}

export async function ProjectInitiationSection({ view, files }: { readonly view: InitiationView; readonly files: readonly InitiationFile[] }) {
  const [x, column, locale] = await Promise.all([getTranslations('admin.project_initiation'), getTranslations('column'), getLocale()]);
  const row = view.initiation;
  const money = (value: string | null) => (value ? formatMoney(value, 'IQD', locale as Locale) : '—');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const coded = (group: string, code: string | null) => (code ? (x.has(`${group}.${code}`) ? x(`${group}.${code}`) : code) : '—');
  const plain = (value: string) => (value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value);

  const boxes: { label: string; value: string; ltr?: boolean; wide?: boolean }[] = [
    { label: x('kind'), value: coded('kind_option', view.kind) },
    ...(view.kind === 'direct_sales'
      ? [
          { label: x('system_type'), value: coded('system_type_option', row.systemType) },
          { label: x('site_kind'), value: coded('site_kind_option', row.siteKind) },
          { label: x('site_governorate'), value: row.siteGovernorate ?? '—' },
          { label: x('site_area'), value: row.siteArea ?? '—' },
          { label: x('site_coordinates'), value: row.siteLatitude && row.siteLongitude ? `${row.siteLatitude}, ${row.siteLongitude}` : '—', ltr: true },
          { label: x('contact_name'), value: [row.contactName, row.contactJobTitle].filter(Boolean).join(' · ') || '—' },
          { label: x('contact_phone'), value: [row.contactPhone, row.contactPhoneAlt].filter(Boolean).join(' · ') || '—', ltr: true },
          { label: x('contact_email'), value: row.contactEmail ?? '—', ltr: true },
          { label: x('survey_on'), value: day(row.surveyOn), ltr: true },
          { label: x('proposal_ref'), value: row.proposalRef ?? '—', ltr: true },
        ]
      : [
          { label: x('issuing_entity'), value: row.customerName },
          { label: x('tender_ref'), value: row.tenderRef ?? '—', ltr: true },
          { label: x('submitted_on'), value: day(row.submittedOn), ltr: true },
          { label: x('awarded_on'), value: day(row.awardedOn), ltr: true },
          { label: x('bid_price'), value: money(row.bidPriceIqd), ltr: true },
          { label: x('guarantee_status'), value: coded('guarantee_status_option', row.guaranteeStatus) },
        ]),
    { label: x('contract_ref'), value: row.contractRef ?? '—', ltr: true },
    { label: x('contract_signed_on'), value: day(row.contractSignedOn), ltr: true },
    { label: x('boq_total'), value: money(view.boqTotals.total), ltr: true },
    { label: x('payment_terms'), value: row.paymentTerms ?? '—', wide: true },
  ];

  return (
    <section aria-labelledby="project-initiation-title" className={s.sapDoc} data-project-initiation="" id="initiation">
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="project-initiation-title">
          <span>
            {x('from_initiation')}{' '}
            <span className={s.sapTitleMeta}>
              <ProfileLink code={row.initiationNo} kind="project_initiation" />
            </span>
          </span>
          <span className={s.sapTitleMeta}>{x('from_initiation_meta')}</span>
        </h2>
        <div className={s.sapBody}>
          <div className={s.sapFields}>
            {boxes.map((box, index) => (
              <div className={box.wide ? `${s.sapField} ${s.sapWide}` : s.sapField} key={index}>
                <span className={s.sapLabel}>{box.label}</span>
                <span className={s.sapBox}>
                  <bdi dir={box.ltr ? 'ltr' : 'auto'}>{box.value}</bdi>
                </span>
              </div>
            ))}
          </div>

          <div className={s.sapGridCaption} id="project-initiation-files">
            <strong>{x('drawings')}</strong>
            <span className={s.sapGridCount}>{files.length}</span>
          </div>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-initiation-files" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('file_name')}</th>
                  <th scope="col">{x('file_section_label')}</th>
                  <th scope="col">{x('file_uploaded')}</th>
                </tr>
              </thead>
              <tbody>
                {files.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {x('drawings_none')}
                    </td>
                  </tr>
                ) : null}
                {files.map((file) => (
                  <tr key={file.id}>
                    <td>
                      {/* The download route asks the file's own parent — the initiation — whether this reader may have it. */}
                      <a className={s.sapLink} href={`/attachments/${file.id}`} rel="noreferrer" target="_blank">
                        <bdi dir="auto">{file.fileName}</bdi>
                      </a>
                    </td>
                    <td>{coded('file_section', file.section)}</td>
                    <td>
                      <bdi dir="ltr">{day(businessDateOf(file.createdAt))}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={s.sapGridCaption} id="project-initiation-boq">
            <strong>{x('boq_title')}</strong>
            <span className={s.sapGridCount}>{view.boq.length}</span>
          </div>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-initiation-boq" className={s.sapTable}>
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
                </tr>
              </thead>
              <tbody>
                {view.boq.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {x('boq_none')}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
