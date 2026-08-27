import { notFound } from 'next/navigation';
import { desc, eq, isNull } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { appUser, exchangeRate } from '@/server/db/schema';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as rates from '@/server/services/exchange-rates';
import { createCurrency, publishRate, setCurrencyActive } from './actions';

/**
 * The accounting rates.
 *
 * Phase 1 does not name this screen, and it cannot work without it: every
 * journal line is measured in the ledger currency and in USD, so no entry can
 * be recorded on a date with no rate in force. It is the same kind of
 * prerequisite as the accounting calendar.
 *
 * A rate is published, never edited. Correcting one supersedes it and leaves
 * the original readable, because a journal posted last month was measured at
 * last month's figure and must stay that way.
 */
export const dynamic = 'force-dynamic';

export default async function ExchangeRatesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/exchange-rates')) notFound();

  const [t, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', rates.PERMISSION_OBJECT)) {
    return <Denied object={page('currencies_rates')} />;
  }
  const mayPublish = can(principal, 'create', rates.PERMISSION_OBJECT);
  const today = new Date().toISOString().slice(0, 10);

  const { live, ledger, moneys } = await withCurrentUser(async (tx) => ({
    live: await tx
      .select({
        id: exchangeRate.id,
        currencyCode: exchangeRate.currencyCode,
        rateType: exchangeRate.rateType,
        iqdPerUnit: exchangeRate.iqdPerUnit,
        effectiveFrom: exchangeRate.effectiveFrom,
        source: exchangeRate.source,
        enteredBy: appUser.displayName,
      })
      .from(exchangeRate)
      .leftJoin(appUser, eq(appUser.id, exchangeRate.enteredBy))
      .where(isNull(exchangeRate.supersededAt))
      .orderBy(desc(exchangeRate.effectiveFrom), exchangeRate.currencyCode),
    ledger: await rates.ledgerCurrency(tx),
    moneys: await rates.currencies(tx),
  }));

  return (
    <AdminPage
      actions={
        mayPublish ? (
          <NewRecordDialog
            buttonLabel={t('rates.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('rates.new')}
          >
            <Form action={publishRate}>
              <Grid>
                <Select
                  defaultValue="USD"
                  label={t('rates.currency')}
                  name="currency"
                  options={moneys
                    .filter((c) => c.code !== ledger && c.isActive)
                    .map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))}
                  required
                />
                <Field
                  hint={t('rates.rate_hint', { ledger })}
                  label={t('rates.rate')}
                  min={0}
                  name="iqdPerUnit"
                  required
                  requiredLabel={t('required_hint')}
                  step="0.00000001"
                  type="number"
                />
                <Field
                  defaultValue={`${new Date().getFullYear()}-01-01`}
                  hint={t('rates.effective_hint')}
                  label={t('rates.effective_from')}
                  name="effectiveFrom"
                  type="date"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field
                  defaultValue="Central Bank of Iraq"
                  hint={t('rates.source_hint')}
                  label={t('rates.source')}
                  name="source"
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('rates.publish')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/exchange-rates" />}
      subtitle={t('rates.subtitle')}
      title={t('rates.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {/* The currency master — §4.3. A new code joins here, and from here it
          reaches every list that offers a currency: the rate dialog above,
          an account's restriction, a journal line. Retiring stops new lines
          and touches nothing already posted. */}
      <Panel flush title={t('rates.currencies_title')}>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('rates.currency')}</th>
                <th scope="col">{t('name')}</th>
                <th className="numeric" scope="col">{t('rates.decimals')}</th>
                <th scope="col">{t('rates.state')}</th>
                {mayPublish ? <th scope="col" /> : null}
              </tr>
            </thead>
            <tbody>
              {moneys.map((c) => (
                <tr key={c.code}>
                  <td className={s.mono}>{c.code}</td>
                  <td>{c.name}</td>
                  <td className="numeric">{c.decimals}</td>
                  <td>
                    <Pill
                      label={c.isActive ? t('active') : t('inactive')}
                      on={c.isActive}
                    />
                  </td>
                  {mayPublish ? (
                    <td>
                      {c.isLedger || c.code === 'USD' ? null : (
                        <ActionButton
                          action={setCurrencyActive}
                          hidden={{ code: c.code, active: c.isActive ? '0' : '1' }}
                          label={c.isActive ? t('rates.retire') : t('reactivate')}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {mayPublish ? (
          <div className={s.lineForm}>
            <Form action={createCurrency}>
              <Grid>
                <Field
                  hint={t('rates.code_hint')}
                  label={t('rates.new_currency_code')}
                  maxLength={3}
                  name="code"
                  pattern="[A-Za-z]{3}"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field
                  label={t('name')}
                  name="name"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field
                  defaultValue={2}
                  hint={t('rates.decimals_hint')}
                  label={t('rates.decimals')}
                  max={6}
                  min={0}
                  name="decimals"
                  type="number"
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('rates.add_currency')} />
              </SubmitRow>
            </Form>
          </div>
        ) : null}
      </Panel>

      {live.length === 0 ? (
        <Panel>
          <div className={s.emptyState}>
            <strong>{t('rates.none')}</strong>
            <p className="muted">{t('rates.none_detail', { date: formatBusinessDate(today, locale as Locale) })}</p>
          </div>
        </Panel>
      ) : (
        <Panel flush title={t('rates.in_force')}>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{t('rates.currency')}</th>
                  <th className="numeric" scope="col">
                    {t('rates.rate')}
                  </th>
                  <th scope="col">{t('rates.effective_from')}</th>
                  <th scope="col">{t('rates.source')}</th>
                  <th scope="col">{t('rates.entered_by')}</th>
                </tr>
              </thead>
              <tbody>
                {live.map((rate) => (
                  <tr key={rate.id}>
                    <td className={s.mono}>{rate.currencyCode}</td>
                    <td className="numeric">{Number(rate.iqdPerUnit).toLocaleString(locale)}</td>
                    <td>{formatBusinessDate(rate.effectiveFrom, locale as Locale)}</td>
                    <td>{rate.source ?? '—'}</td>
                    <td>{rate.enteredBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </AdminPage>
  );
}
