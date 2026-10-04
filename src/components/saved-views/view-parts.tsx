import { getTranslations } from 'next-intl/server';
import { ActionButton, Hidden, Inline, LinkButton, Pill, Submit, admin as s } from '@/components/admin';
import { ConfirmButton } from '@/components/admin/confirm-button';
import type { RouteViewState } from '@/server/services/saved-views';
import {
  deleteView,
  duplicateView,
  pinView,
  renameView,
  setDefaultView,
} from '@/app/(app)/profile/views/actions';
import type { Described } from './describe';

/**
 * The pieces a view is drawn with, in the Views menu of a screen and on
 * /profile/views alike — one set of buttons, one set of words.
 *
 * Every button is a form posting to an action in `profile/views/actions.ts`; the
 * page comes back with "Saved." only after the service has written. A view of a
 * screen the person cannot open keeps its delete, rename and un-default/unpin
 * buttons and loses the ones that would use the screen (open, make default,
 * pin, duplicate).
 */

/** Default, On Home, Showing now, and — never silently — Unavailable. */
export async function ViewBadges({ view, active = false }: { readonly view: RouteViewState; readonly active?: boolean }) {
  const t = await getTranslations('savedViews');
  return (
    <Inline>
      {active ? <Pill label={t('showing')} on={true} /> : null}
      {view.isDefault ? <Pill label={t('default')} on={true} /> : null}
      {view.pinnedAt ? <Pill label={t('on_home')} on={null} /> : null}
      {!view.available && view.unavailable ? <Pill label={t(`unavailable_${view.unavailable}`)} on={false} /> : null}
    </Inline>
  );
}

/** What the view asks, in words; a note when the screen no longer accepts some of it. */
export async function ViewSummary({
  lines,
  view,
}: {
  readonly lines: readonly Described[];
  readonly view: RouteViewState;
}) {
  const t = await getTranslations('savedViews');
  const dropped = [...new Set(view.dropped.map((item) => (item.name === '*' ? t('dropped_all') : item.name)))];
  return (
    <>
      <span className="muted">
        {lines.length === 0 ? t('no_filters_set') : lines.map((line) => `${line.label}: ${line.value}`).join(' · ')}
      </span>
      {dropped.length > 0 ? (
        <p className={s.sectionHint} role="note">
          {t('dropped_note', { names: dropped.join(', ') })}
        </p>
      ) : null}
    </>
  );
}

/** The name, edited where it stands. */
export async function ViewRename({ view, returnTo }: { readonly view: RouteViewState; readonly returnTo: string }) {
  const t = await getTranslations('savedViews');
  return (
    <form action={renameView} className={s.inline}>
      <Hidden name="id" value={view.id} />
      <Hidden name="return_to" value={returnTo} />
      <input
        aria-label={`${t('rename')}: ${view.name}`}
        className={s.sapCellField}
        defaultValue={view.name}
        maxLength={80}
        name="name"
        required
      />
      <Submit label={t('rename')} small tone="secondary" />
    </form>
  );
}

/** Open, make default, pin, duplicate, delete. */
export async function ViewActions({
  view,
  returnTo,
  open = true,
}: {
  readonly view: RouteViewState;
  readonly returnTo: string;
  /** Offer "Open" — a screen's own menu offers it; the manage list opens a view from its name. */
  readonly open?: boolean;
}) {
  const [t, admin] = await Promise.all([getTranslations('savedViews'), getTranslations('admin')]);
  const copyName = t('copy_name', { name: view.name });
  return (
    <Inline>
      {open && view.href ? <LinkButton href={view.href} label={t('open')} small tone="primary" /> : null}
      {view.available || view.isDefault ? (
        <ActionButton
          action={setDefaultView}
          hidden={{ id: view.id, on: view.isDefault ? '0' : '1', return_to: returnTo }}
          label={view.isDefault ? t('clear_default') : t('set_default')}
        />
      ) : null}
      {view.available || view.pinnedAt ? (
        <ActionButton
          action={pinView}
          hidden={{ id: view.id, on: view.pinnedAt ? '0' : '1', return_to: returnTo }}
          label={view.pinnedAt ? t('unpin') : t('pin')}
        />
      ) : null}
      {view.available ? (
        <ActionButton
          action={duplicateView}
          hidden={{ id: view.id, copy_name: copyName, return_to: returnTo }}
          label={t('duplicate')}
        />
      ) : null}
      <ConfirmButton
        action={deleteView}
        body={t('delete_body', { name: view.name })}
        cancelLabel={admin('cancel')}
        confirmLabel={t('delete')}
        hidden={{ id: view.id, return_to: returnTo }}
        label={t('delete')}
        title={t('delete_title')}
      />
    </Inline>
  );
}
