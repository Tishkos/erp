import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@domain/business-date';
import type { ProfileKind } from '@domain/profiles';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';

/**
 * The two document registers — Customs Documents (REQ-LOG-001 item 11) and
 * Shipment Documents (item 17) — are one screen over `attachment`, each
 * listing the files on its own records. Read only, and no second document
 * system: a file is opened where the record's own paperclip opens it, and
 * the record is one click away. Q6: a paper is told by the record it hangs
 * on and its name.
 */
const KIND: Readonly<Record<string, ProfileKind>> = {
  customs_pd: 'pd',
  asycuda_run: 'asycuda_run',
  bill_of_lading: 'bl',
  shipment_container: 'container',
  payable: 'import',
};

export async function DocumentRegister({ searchParams, scope }: { readonly searchParams: SearchParams; readonly scope: views.DocumentScope }) {
  const route = scope === 'customs' ? '/logistics/customs-documents' : '/logistics/shipment-documents';
  const object = scope === 'customs' ? 'customs_pd' : 'bill_of_lading';
  const pageKey = scope === 'customs' ? 'customs_documents' : 'shipment_documents';
  if (!visibleRoute(route)) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', object)) {
    return <Denied object={page(pageKey)} />;
  }
  const params = await searchParams;
  const kinds = views.DOCUMENT_SCOPES[scope] as readonly string[];
  const kind = kinds.includes(String(params.kind)) ? String(params.kind) : '';

  const result = await withCurrentUser((tx) => views.documentsRegister(tx, scope, { search: outcome.q, page: outcome.page, objectType: kind || null }));
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', kind ? `kind=${kind}` : '', `page=${p}`].filter(Boolean).join('&');
  const when = (value: Date) => formatBusinessDate(businessDateOf(value), locale as Locale);
  const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route={route} />} subtitle={t(`${pageKey}_subtitle`)} title={page(pageKey)} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="document-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="document-list-title">
            <span>{page(pageKey)}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>
          <ListToolbar clearHref={route} clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: result.total })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')} />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={kind} emptyLabel={t('kind_all')} label={t('kind')} name="kind" options={kinds.map((key) => ({ value: key, label: t(`kind_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="document-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_file')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{t('col_record')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('col_uploaded')}</th>
                  <th scope="col">{t('by')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_size')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('no_documents')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <a className={s.sapLink} href={`/attachments/${row.id}`} rel="noreferrer" target="_blank">
                        <bdi dir="auto">{row.fileName}</bdi>
                      </a>
                      {row.version > 1 ? <div className="muted">v{row.version}</div> : null}
                    </td>
                    <td>{t(`kind_${row.objectType}`)}</td>
                    <td>
                      {row.objectType === 'customs_declaration' ? (
                        <a className={s.sapLink} href={`/logistics/customs-declarations/${encodeURIComponent(row.recordNo ?? '')}`}>
                          <bdi dir="ltr">{row.recordNo ?? '—'}</bdi>
                        </a>
                      ) : (
                        <ProfileLink
                          code={row.recordNo}
                          kind={KIND[row.objectType] ?? 'import'}
                          qualifier={row.objectType === 'customs_pd' ? { year: row.recordYear } : row.objectType === 'shipment_container' ? { id: row.objectId } : {}}
                        >
                          {row.recordNo ?? '—'}
                        </ProfileLink>
                      )}
                    </td>
                    <td>
                      <ProfileLink code={row.payableNo} kind="import">
                        {row.payableNo ?? '—'}
                      </ProfileLink>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{when(row.createdAt)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.uploadedBy ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{size(row.sizeBytes)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `${route}?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
