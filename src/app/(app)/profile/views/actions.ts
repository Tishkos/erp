'use server';

import { getTranslations } from 'next-intl/server';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { wayBack } from '@/server/return-path';
import { SavedViewInputError, type RawParams } from '@domain/saved-views';
import { viewableRoute } from '@domain/saved-view-routes';
import * as savedViews from '@/server/services/saved-views';

/**
 * The forms of the Views menu and of /profile/views.
 *
 * Every action runs the service as the caller and returns to the screen it was
 * pressed on (`return_to`, a path on this site — `wayBack` refuses anything
 * else) with `saved=1` only after the transaction has committed, or `error=`
 * with the refusal in the person's language. Nothing here decides who may do
 * what: a view is its owner's, the service reads only the caller's rows, and
 * the database holds the same line.
 */

/** A refusal in the person's language; anything the service did not name passes through. */
async function inLanguage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof savedViews.SavedViewError || error instanceof SavedViewInputError) {
      const t = await getTranslations('savedViews.errors');
      const key = error instanceof savedViews.SavedViewError ? error.code : error.reason;
      if (t.has(key)) {
        const name = /“([^”]+)”/.exec(error.message)?.[1] ?? '';
        throw new Error(t(key, { name, views: savedViews.MAX_ROUTE_VIEWS, pins: savedViews.MAX_PINNED_VIEWS }));
      }
    }
    throw error;
  }
}

/** The query of an address as the raw parameters a screen would have read. */
function paramsOf(address: string): RawParams {
  const query = address.includes('?') ? address.slice(address.indexOf('?') + 1) : '';
  const raw: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(query)) {
    if (!(name in raw)) raw[name] = value;
  }
  return raw;
}

/** Save the filters the screen is showing, under a name. */
export async function saveView(formData: FormData): Promise<void> {
  const back = await wayBack(text(formData, 'return_to'));
  const routeKey = text(formData, 'route_key');
  const rules: Record<string, string> = {};
  for (const slot of viewableRoute(routeKey)?.slots ?? []) {
    const chosen = text(formData, `rule_${slot.id}`);
    if (chosen && chosen !== 'keep') rules[slot.id] = chosen;
  }
  await runAdminAndReturn(
    (tx, ctx) =>
      inLanguage(() =>
        savedViews.createRouteView(tx, ctx, {
          routeKey,
          name: text(formData, 'name'),
          // Only the declared, well-formed parameters of this screen survive `storedFrom`.
          params: paramsOf(back),
          rules,
        }),
      ),
    back,
  );
}

export async function renameView(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => inLanguage(() => savedViews.renameRouteView(tx, ctx, text(formData, 'id'), text(formData, 'name'))),
    await wayBack(text(formData, 'return_to')),
  );
}

export async function duplicateView(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      inLanguage(() => savedViews.duplicateRouteView(tx, ctx, text(formData, 'id'), text(formData, 'copy_name') || undefined)),
    await wayBack(text(formData, 'return_to')),
  );
}

export async function deleteView(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => inLanguage(() => savedViews.deleteRouteView(tx, ctx, text(formData, 'id'))),
    await wayBack(text(formData, 'return_to')),
  );
}

/** `on=1` makes it the default of its screen; `on=0` stops it being. */
export async function setDefaultView(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => inLanguage(() => savedViews.setDefaultRouteView(tx, ctx, text(formData, 'id'), text(formData, 'on') === '1')),
    await wayBack(text(formData, 'return_to')),
  );
}

/** `on=1` pins it to Home; `on=0` takes it off. */
export async function pinView(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => inLanguage(() => savedViews.pinRouteView(tx, ctx, text(formData, 'id'), text(formData, 'on') === '1')),
    await wayBack(text(formData, 'return_to')),
  );
}
