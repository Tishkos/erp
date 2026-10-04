import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Field, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import type { Locale } from '@/i18n/config';
import { saveView } from '@/app/(app)/profile/views/actions';
import { MAX_ROUTE_VIEWS, type SavedViewsState } from '@/server/services/saved-views';
import { describeView } from './describe';
import { ViewActions, ViewBadges, ViewRename, ViewSummary } from './view-parts';
import { ViewsDialog } from './views-dialog';

/**
 * "Views" — the person's saved filters for this screen.
 *
 *   <ListToolbar …><SavedViewsMenu state={saved} /></ListToolbar>
 *
 * (a report with no toolbar puts it in `AdminPage`'s `actions`). It draws what
 * `savedViewsFor` returned and nothing else: the form that keeps the filters
 * on screen under a name, and a row for each view already kept, with the same
 * buttons the Saved Views list has. Opening a view only sends the person to
 * the screen with the filters in the address — the screen then runs its own
 * query, as them, which is why a view can never show more than they may see.
 */
export async function SavedViewsMenu({ state }: { readonly state: SavedViewsState | null }) {
  if (!state) return null;
  const [t, admin, locale] = await Promise.all([getTranslations('savedViews'), getTranslations('admin'), getLocale()]);
  const here = await describeView(state.routeKey, state.current.params, {}, locale as Locale);
  const full = state.used >= MAX_ROUTE_VIEWS;
  const hasDefault = state.views.some((view) => view.isDefault && view.available);
  const rows = await Promise.all(
    state.views.map(async (view) => ({
      view,
      lines: await describeView(view.routeKey, view.params, view.rules, locale as Locale),
    })),
  );

  return (
    <ViewsDialog closeLabel={admin('close')} count={state.used} label={t('menu_label')} title={t('menu_title')}>
      <h3 className={s.sectionHint}>{t('save_heading')}</h3>
      {full ? (
        <p className={s.sapNote} role="status">
          {t('errors.limit_views', { views: MAX_ROUTE_VIEWS })}
        </p>
      ) : (
        <Form action={saveView}>
          <Hidden name="route_key" value={state.routeKey} />
          <Hidden name="return_to" value={state.current.returnTo} />
          <p className={s.sectionHint}>
            {here.length === 0
              ? t('saving_nothing')
              : t('saving', { filters: here.map((line) => `${line.label}: ${line.value}`).join(' · ') })}
          </p>
          <Grid>
            <Field
              id="saved-view-name"
              label={t('name')}
              maxLength={80}
              name="name"
              placeholder={t('name_placeholder')}
              required
              requiredLabel={admin('required_hint')}
            />
            {state.slots.map((slot) => (
              <Select
                defaultValue="keep"
                key={slot.id}
                label={t(`slots.${slot.id}`)}
                name={`rule_${slot.id}`}
                options={[
                  { value: 'keep', label: t('keep_dates') },
                  ...slot.rules.map((rule) => ({ value: rule, label: t(`rules.${slot.kind}.${rule}`) })),
                ]}
              />
            ))}
          </Grid>
          <p className={s.hint}>{t('save_hint')}</p>
          <SubmitRow>
            <Submit label={t('save')} />
          </SubmitRow>
        </Form>
      )}

      <h3 className={s.sectionHint}>{t('mine_heading')}</h3>
      {rows.length === 0 ? (
        <p className={s.sectionHint}>{t('none_on_screen')}</p>
      ) : (
        <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
          <table className={`${s.sapTable} ${s.sapRegisterTable}`}>
            <thead>
              <tr>
                <th scope="col">{t('view')}</th>
                <th scope="col">{t('filters')}</th>
                <th scope="col">{admin('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ view, lines }) => (
                <tr key={view.id}>
                  <td>
                    <ViewRename returnTo={state.current.returnTo} view={view} />
                    <ViewBadges active={view.active} view={view} />
                  </td>
                  <td>
                    <ViewSummary lines={lines} view={view} />
                  </td>
                  <td>
                    <ViewActions returnTo={state.current.returnTo} view={view} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SubmitRow>
        {hasDefault ? (
          <Link className={`${s.button} ${s.small}`} href={`${state.route}?sv=none`}>
            {t('without_view')}
          </Link>
        ) : null}
        <Link className={`${s.button} ${s.small}`} href="/profile/views">
          {t('manage')}
        </Link>
      </SubmitRow>
    </ViewsDialog>
  );
}
