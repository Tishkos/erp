import { getTranslations } from 'next-intl/server';
import { House, MapPinOff } from 'lucide-react';
// The palettes' `--w-*` tokens, which the Intent theme reads: a missing page
// may be the first thing a session draws, before any screen has loaded them.
import '@/components/admin/admin.module.css';
import { EmptyState, EmptyStatePage } from '@/components/admin/empty-state';
import { BackButton } from '@/components/states/back-button';

/**
 * An address that is not in the approved tree.
 *
 * The catch-all serves every menu item, so reaching this page means the URL was
 * typed or followed from somewhere stale. It says which of the two things went
 * wrong — the page does not exist, as opposed to *you may not see it*, which is
 * the refusal in `Denied` — because telling a reader "not found" when they mean
 * "not allowed" sends them to the wrong person for help.
 *
 * It is drawn inside the shell (the catch-all is under the application's
 * layout), so the header and navigation stay; the ways on are Home and the
 * page the stale link was followed from.
 *
 * Drawn as Intent UI's empty state (`EmptyState`, 2026-10-06). `stateCard` on
 * the card is what the theme-readability spec and Noah's camera look for.
 */
export default async function NotFound() {
  const [t, s] = await Promise.all([getTranslations('error'), getTranslations('states')]);

  return (
    <EmptyStatePage>
      <EmptyState
        action={{ href: '/', label: t('not_found_action'), icon: House }}
        actions={<BackButton label={s('go_back')} />}
        className="stateCard"
        description={t('not_found_body')}
        headingLevel={1}
        icon={MapPinOff}
        role="alert"
        title={t('not_found_title')}
      />
    </EmptyStatePage>
  );
}
