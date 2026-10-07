'use client';

/**
 * The account menu's "Pop-up notifications" switch, kept in this browser —
 * beside the Sounds switch and kept the same way (`lib/sounds.ts`). On unless
 * the person turned it off; off still lets a refusal pop up
 * (`toast-rules.popupMode`). Noah's camera session never pops anything up.
 */
import { useSyncExternalStore } from 'react';
import { POPUPS_STORAGE_KEY, popupMode, type PopupMode } from '@/lib/toast-rules';

const listeners = new Set<() => void>();
let storedMemo: string | null | undefined;
let camera = false;

function stored(): string | null {
  if (storedMemo !== undefined) return storedMemo;
  try {
    storedMemo = window.localStorage.getItem(POPUPS_STORAGE_KEY);
  } catch {
    storedMemo = null;
  }
  return storedMemo;
}

/** The switch as the person sees it: on unless they turned it off. */
export function popupsOn(): boolean {
  return typeof window === 'undefined' ? true : stored() !== 'off';
}

export function setPopupsOn(on: boolean): void {
  storedMemo = on ? 'on' : 'off';
  try {
    window.localStorage.setItem(POPUPS_STORAGE_KEY, storedMemo);
  } catch {
    // A private window: the choice lasts as long as the page.
  }
  for (const listener of listeners) listener();
}

/** The switch's state for a component: on while the server renders. */
export function usePopupsOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    popupsOn,
    () => true,
  );
}

/** Noah's camera session: this page never pops anything up. */
export function silencePopupsForCamera(): void {
  camera = true;
}

/** What may pop up on this page now. */
export function currentPopupMode(): PopupMode {
  if (typeof window === 'undefined') return 'none';
  const nav = window.navigator;
  return popupMode({ stored: stored(), webdriver: Boolean(nav.webdriver), camera, userAgent: nav.userAgent ?? '' });
}
