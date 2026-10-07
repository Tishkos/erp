'use client';

/**
 * The AI dock's one piece of shared browser state: whether the panel is open.
 *
 * The chat dock reads it to keep out of the corner — the AI button owns the
 * bottom-end corner, and when its panel is open the chat windows move along
 * beside it (`roomFor`), so the two never overlap (2026-10-07, by direction:
 * "don't overlap with the chat dock"). Browser state only: never written
 * while rendering on the server, where one process serves everybody.
 */
import { useSyncExternalStore } from 'react';

interface AssistantState {
  readonly open: boolean;
}

let state: AssistantState = { open: false };
const listeners = new Set<() => void>();

function set(next: AssistantState) {
  state = next;
  for (const listener of listeners) listener();
}

export function openAssistant() {
  if (!state.open) set({ open: true });
}

export function closeAssistant() {
  if (state.open) set({ open: false });
}

export function toggleAssistant() {
  set({ open: !state.open });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const CLOSED: AssistantState = { open: false };

export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}

/** The AI button's width and the gap beside it. */
export const BUTTON_ROOM = '4.75rem';
/** The open panel's width with its gaps — what the chat dock gives up while it is open. */
export const PANEL_ROOM = '24.5rem';

/** The inline-end inset the chat dock sits at, so it never sits under the AI dock. */
export function roomFor(open: boolean): string {
  return open ? PANEL_ROOM : BUTTON_ROOM;
}
