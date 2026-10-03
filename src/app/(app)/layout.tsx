import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { optionalContext, withCurrentUser } from '@/server/session';
import * as companyService from '@/server/services/company';
import * as userAppearance from '@/server/services/user-appearance';
import {
  DEFAULT_ACCENT,
  DEFAULT_PALETTE,
  DEFAULT_USER_APPEARANCE,
} from '@domain/appearance';

/**
 * The authenticated application — every screen except sign-in lives in this
 * route group.
 *
 * The shell is rendered here, once, rather than by each page. A layout
 * persists across navigations in the App Router: when the reader moves from
 * one screen to the next, the header, navigation and user menu stay mounted
 * and keep their state, and only the page segment below is replaced — first
 * by `loading.tsx`, then by the screen. Before this, each page drew its own
 * shell, so the whole chrome was torn down and redrawn on every click.
 *
 * Identity is still resolved on the server, deny by default: `AppShell` calls
 * `requireContext`, which sends a visitor without a session to the sign-in
 * form before any child renders.
 *
 * ── The palette ────────────────────────────────────────────────────────────
 * `data-palette` carries this user's saved choice, and every colour in the
 * application is read from the tokens it selects — the navigation and footer
 * as much as the screens inside them.
 *
 * It sits on this wrapper rather than on <html> for two reasons. Sign-in lives
 * outside this route group and is meant to keep its own look, and putting the
 * attribute here means a signed-out visitor never causes a database read for a
 * setting they will not see. Custom properties inherit, so one attribute here
 * dresses everything below it.
 *
 * It falls back rather than failing: an account with no saved preference gets
 * its own Sand and Gold defaults, not an unstyled system.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  // This user's saved look or the per-user default. optionalContext rather
  // than require: a signed-out visitor
  // is redirected by AppShell below, and must not be answered with a palette
  // read that throws first.
  const context = await optionalContext();
  const fallback = { palette: DEFAULT_PALETTE, accent: DEFAULT_ACCENT };
  const appearance = context
    ? await withCurrentUser(
        async (tx) => ({
          colors: await companyService.appearanceFor(tx, context.principal.userId),
          settings: await userAppearance.settingsFor(tx, context.principal.userId),
        }),
        // HD2 / HD4 — the shell dresses a restricted session too; the page decides.
        { allowRestricted: true },
      ).catch(() => ({
        colors: fallback,
        settings: { settings: DEFAULT_USER_APPEARANCE, saved: true },
      }))
    : { colors: fallback, settings: { settings: DEFAULT_USER_APPEARANCE, saved: true } };
  const { palette, accent } = appearance.colors;
  const { settings, saved } = appearance.settings;

  return (
    <div
      className="erp-root"
      data-accent={accent}
      data-appearance={settings.appearance}
      data-border-style={settings.borderStyle}
      data-component-size={settings.componentSize}
      data-density={settings.density}
      data-palette={palette}
      data-radius={settings.cornerStyle}
      data-shadow={settings.shadow}
      data-width={settings.contentWidth}
    >
      <AppShell initialAppearanceSettings={settings} appearanceSettingsSaved={saved}>
        {children}
      </AppShell>
    </div>
  );
}
