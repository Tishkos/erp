import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Handshake } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as partners from '@/server/services/partners';
import * as terms from '@/server/services/payment-terms';
import { setPartnerActive, setPartnerRole, updatePartnerRecord } from '../actions';

/**
 * One business partner — the record behind both the Customers and the
 * Suppliers screen (Phase 2 requirements 2 and 3).
 *
 * There is one record page because there is one record. §6: *"one record
 * serves CRM, Sales, Finance, Projects, Logistics and Money Transfer"*. The
 * roles are shown as what they are — two switches on one company — so that a
 * person who came here from Customers can see this is also a supplier rather
 * than discovering it later from a balance that will not net.
 */
export const dynamic = 'force-dynamic';

export default async function BusinessPartnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/customers') && !visibleRoute('/payables/suppliers')) notFound();

  const [t, page, column, locale, context, outcome, query, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', partners.PERMISSION_OBJECT)) {
    return <Denied object={page('md_business_partners')} />;
  }
  const mayEdit = can(principal, 'edit_draft', partners.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', partners.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      return {
        row: await partners.detail(tx, code),
        paymentTerms: mayEdit ? await terms.listActive(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, paymentTerms } = data;
  const routeRole: partners.PartnerRole =
    query.role === 'supplier' || (query.role !== 'customer' && !row.isCustomer && row.isSupplier)
      ? 'supplier'
      : 'customer';
  const listRoute = routeRole === 'customer' ? '/sales/customers' : '/payables/suppliers';

  return (
    <AdminPage
      actions={
        <>
          {/* The statement is one screen on each side, under Sales and under
              Purchasing. This opens it with the partner already chosen, on the
              side their own role puts them; one who is both is read as a
              customer, the same answer the Customers list gives. */}
          <Link
            className={s.backButton}
            href={`${
              routeRole === 'customer' ? '/sales/customer-statements' : '/payables/supplier-statements'
            }?code=${encodeURIComponent(code)}`}
          >
            {t('partners.statement')}
          </Link>
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{
        href: listRoute,
        label: t('back'),
      }}
      title={`${row.code} · ${row.legalName}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Handshake aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.legalName}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          {/* §6 — either role, or both, never neither. */}
          <Panel title={t('partners.roles')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('partners.role_customer')}</span>
                <span>
                  <Pill label={row.isCustomer ? t('yes') : t('no')} on={row.isCustomer} />
                  {mayEdit ? (
                    <>
                      {' '}
                      <ActionButton
                        action={setPartnerRole}
                        hidden={{
                          code: row.code,
                          role: 'customer',
                          ...(row.isCustomer ? {} : { held: '1' }),
                        }}
                        label={row.isCustomer ? t('partners.remove_role') : t('partners.grant_role')}
                      />
                    </>
                  ) : null}
                </span>
              </li>
              <li>
                <span>{t('partners.role_supplier')}</span>
                <span>
                  <Pill label={row.isSupplier ? t('yes') : t('no')} on={row.isSupplier} />
                  {mayEdit ? (
                    <>
                      {' '}
                      <ActionButton
                        action={setPartnerRole}
                        hidden={{
                          code: row.code,
                          role: 'supplier',
                          ...(row.isSupplier ? {} : { held: '1' }),
                        }}
                        label={row.isSupplier ? t('partners.remove_role') : t('partners.grant_role')}
                      />
                    </>
                  ) : null}
                </span>
              </li>
              {row.isSupplier ? (
                <li>
                  <span>{t('partners.items_supplied')}</span>
                  <span>
                    {row.itemCount === 0
                      ? t('none')
                      : t('partners.items_supplied_count', {
                          count: row.itemCount,
                          preferred: row.defaultForItems,
                        })}
                  </span>
                </li>
              ) : null}
            </ul>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{column('status')}</span>
                <span>{t(`partners.status_${row.status}`)}</span>
              </li>
              <li>
                <span>{t('partners.email')}</span>
                <span>{row.email ?? t('none')}</span>
              </li>
              <li>
                <span>{t('partners.phone')}</span>
                <span>{row.phone ?? t('none')}</span>
              </li>
              <li>
                <span>{t('partners.payment_terms')}</span>
                <span>
                  {row.paymentTermsCode ? (
                    <Link href={`/master-data/payment-terms/${encodeURIComponent(row.paymentTermsCode)}`}>
                      {row.paymentTermsCode}
                    </Link>
                  ) : (
                    t('none')
                  )}
                  {row.paymentTermsName ? ` · ${row.paymentTermsName}` : ''}
                </span>
              </li>
              <li>
                <span>{t('partners.address')}</span>
                <span>{row.address ?? t('none')}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('partners.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setPartnerActive}
                  hidden={{ code: row.code, returnRole: routeRole }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setPartnerActive}
                  hidden={{ code: row.code, active: '1', returnRole: routeRole }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updatePartnerRecord}>
                <input name="code" type="hidden" value={row.code} />
                <input name="returnRole" type="hidden" value={routeRole} />
                <Grid>
                  <Field
                    defaultValue={row.legalName}
                    label={t('partners.legal_name')}
                    name="legalName"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Field defaultValue={row.email} label={t('partners.email')} name="email" type="email" />
                  <Field defaultValue={row.phone} label={t('partners.phone')} name="phone" />
                  {/* Blocks 2 and 3 name four things: the name, the code, the
                      payment terms and the contact information. These three
                      are none of them, so they are off the screen — and
                      carried through a save, because the update replaces every
                      column and their absence would wipe what is stored. */}
                  <input name="tradeName" type="hidden" value={row.tradeName ?? ''} />
                  <input name="registrationNo" type="hidden" value={row.registrationNo ?? ''} />
                  <input name="taxIdentifier" type="hidden" value={row.taxIdentifier ?? ''} />
                  <Select
                    defaultValue={row.paymentTermsCode ?? ''}
                    emptyLabel={t('partners.no_terms')}
                    hint={t('partners.terms_hint')}
                    label={t('partners.payment_terms')}
                    name="paymentTermsCode"
                    options={paymentTerms.map((term) => ({
                      value: term.code,
                      label: `${term.code} · ${term.name}`,
                    }))}
                  />
                  {/* Blocks 2 and 3 ask for the name, the code, the payment
                      terms and the contact information. The credit figures are
                      none of them — carried through a save, not asked. */}
                  <input name="creditLimitIqd" type="hidden" value={row.creditLimitIqd ?? ''} />
                  <input name="creditTermsDays" type="hidden" value={row.creditTermsDays ?? ''} />
                  <Field
                    defaultValue={row.address}
                    label={t('partners.address')}
                    name="address"
                    type="textarea"
                    wide
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.id} objectType={partners.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
