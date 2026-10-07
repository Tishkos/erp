import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
// The palettes (`--w-*`) and so the Intent UI theme (`--ui-*`) live here: loaded once for
// every signed-in page, including those — a loading skeleton, a refusal — that import no
// screen component (the Intent UI redesign, 2026-10-06).
import '@/components/admin/admin.module.css';
import { TableLabels } from '@/components/admin/table-labels';
import { AssistantDock } from '@/components/assistant/assistant-dock';
import { ChatDock } from '@/components/chat/chat-dock';
import { ResultSounds } from '@/components/result-sounds';
import { Toasts } from '@/components/toasts/toast-region';
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
          camera: await userAppearance.isCameraSession(tx, context.sessionId),
        }),
        // HD2 / HD4 — the shell dresses a restricted session too; the page decides.
        { allowRestricted: true },
      ).catch(() => ({
        colors: fallback,
        settings: { settings: DEFAULT_USER_APPEARANCE, saved: true, followsCompany: false },
        camera: false,
      }))
    : { colors: fallback, settings: { settings: DEFAULT_USER_APPEARANCE, saved: true, followsCompany: false }, camera: false };
  const { palette, accent } = appearance.colors;
  // `followsCompany`: no appearance of their own and the company has a default — nothing is adopted on load (0419).
  const { saved, followsCompany } = appearance.settings;
  // Noah's camera pictures the top bar's menus — the only menus it may press
  // (`services/live-screenshot.ts` › MAY_PRESS) — so its own short-lived
  // session is drawn with the top bar, whatever navigation the person chose.
  const settings = appearance.camera
    ? { ...appearance.settings.settings, navigation: 'top' as const }
    : appearance.settings.settings;

  return (
    <div
      className="erp-root"
      data-accent={accent}
      data-appearance={settings.appearance}
      data-border-style={settings.borderStyle}
      data-component-size={settings.componentSize}
      data-density={settings.density}
      data-header={settings.header}
      data-motion={settings.motion}
      data-navigation={settings.navigation}
      data-palette={palette}
      data-radius={settings.cornerStyle}
      data-shadow={settings.shadow}
      data-side-colour={settings.sidebarColour}
      data-side-groups={settings.sidebarGroups}
      data-side-panel={settings.sidebar}
      data-table-stripes={settings.tableStripes}
      data-text-size={settings.textSize}
      data-width={settings.contentWidth}
    >
      <AppShell
        appearanceFollowsCompany={followsCompany}
        appearanceSettingsSaved={saved}
        initialAppearanceSettings={settings}
      >
        {children}
      </AppShell>
      <TableLabels />
      {/* The chat windows at the foot of every screen, and the sounds a form's result makes (2026-10-06). */}
      <ChatDock />
      {/* Noah in the bottom-end corner — the AI dock (2026-10-07); the chat dock sits beside it. Not drawn for the camera's own session. */}
      {appearance.camera ? null : <AssistantDock />}
      <ResultSounds camera={appearance.camera} />
      {/* The pop-up notifications in the corner: a form's result, a new notification, a new message (2026-10-07). */}
      <Toasts camera={appearance.camera} />
    </div>
  );
}
