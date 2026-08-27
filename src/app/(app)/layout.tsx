import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

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
 */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
