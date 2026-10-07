'use client';

/**
 * The application's sounds (2026-10-06, by direction: "like facebook chat with
 * sounds … when invoicing a document can you add a sound … nice sounds … when
 * an error or unfilled something missing another sound please").
 *
 * Made with the Web Audio API — a few soft sine and triangle notes with a
 * quick fade, no audio files and no dependency:
 *
 *   message        a two-note "ding" rising — a message from somebody else
 *   sent           a short soft lift — one's own message went
 *   notification   a light three-note chime — the bell has something new
 *   success        a bright rising triad — saved, submitted, approved, posted
 *   error          two low notes falling — refused or failed
 *   missing        a double tap — a required field is empty
 *
 * When one may sound is `sound-rules.ts`: never before the person has pressed
 * or typed on the page (the browsers' autoplay rule, and ours), never in a
 * browser a program drives (the test suite, Noah's camera), never when the
 * person turned Sounds off in the account menu (kept in this browser), and —
 * for messages and notifications — never while they are Busy.
 */
import { useSyncExternalStore } from 'react';
import { silencedByBusy, soundAllowed, type SoundKind } from './sound-rules';

export type { SoundKind } from './sound-rules';

const STORAGE_KEY = 'erp-sounds';

interface Note {
  /** Frequency in Hz, and where it glides to. */
  readonly f: number;
  readonly to?: number;
  /** Start and length in seconds. */
  readonly at: number;
  readonly len: number;
  readonly gain: number;
  readonly wave: OscillatorType;
}

const TUNES: Readonly<Record<SoundKind, readonly Note[]>> = {
  message: [
    { f: 659.25, at: 0, len: 0.16, gain: 0.13, wave: 'sine' },
    { f: 987.77, at: 0.1, len: 0.3, gain: 0.11, wave: 'sine' },
  ],
  sent: [{ f: 587.33, to: 880, at: 0, len: 0.13, gain: 0.06, wave: 'sine' }],
  notification: [
    { f: 880, at: 0, len: 0.2, gain: 0.08, wave: 'sine' },
    { f: 1108.73, at: 0.09, len: 0.2, gain: 0.07, wave: 'sine' },
    { f: 1318.51, at: 0.18, len: 0.34, gain: 0.06, wave: 'sine' },
  ],
  success: [
    { f: 523.25, at: 0, len: 0.15, gain: 0.1, wave: 'triangle' },
    { f: 659.25, at: 0.08, len: 0.15, gain: 0.1, wave: 'triangle' },
    { f: 783.99, at: 0.16, len: 0.34, gain: 0.1, wave: 'triangle' },
  ],
  error: [
    { f: 329.63, at: 0, len: 0.17, gain: 0.13, wave: 'triangle' },
    { f: 246.94, at: 0.14, len: 0.32, gain: 0.13, wave: 'triangle' },
  ],
  missing: [
    { f: 622.25, at: 0, len: 0.09, gain: 0.09, wave: 'triangle' },
    { f: 622.25, at: 0.13, len: 0.11, gain: 0.07, wave: 'triangle' },
  ],
};

// ---------------------------------------------------------------------------
// The switch (account menu), kept in this browser
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let enabledMemo: boolean | null = null;

function readEnabled(): boolean {
  if (enabledMemo !== null) return enabledMemo;
  try {
    enabledMemo = window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    enabledMemo = true;
  }
  return enabledMemo;
}

export function soundsOn(): boolean {
  return typeof window === 'undefined' ? true : readEnabled();
}

export function setSoundsOn(on: boolean): void {
  enabledMemo = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // A private window: the choice lasts as long as the page.
  }
  for (const listener of listeners) listener();
  if (on) play('success');
}

/** The switch's state for a component: on while the server renders. */
export function useSoundsOn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    soundsOn,
    () => true,
  );
}

// ---------------------------------------------------------------------------
// When the page may sound
// ---------------------------------------------------------------------------

let activated = false;
let camera = false;
let quiet = false;
let audio: AudioContext | null = null;
let armed = false;

function context(): AudioContext | null {
  if (audio) return audio;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    audio = null;
  }
  return audio;
}

const onGesture = (): void => {
  activated = true;
  // The context is made (or woken) inside the gesture, which is when a browser allows it.
  const ctx = context();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
};

/** Listens for the person's first press or key, once per page. Safe to call again. */
export function armSounds(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  window.addEventListener('keydown', onGesture, { capture: true, passive: true });
}

/** Noah's camera session: this page never sounds. */
export function silenceForCamera(): void {
  camera = true;
}

/** Busy: message and notification sounds stop until the person is not. */
export function setQuiet(on: boolean): void {
  quiet = on;
}

function allowed(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
  return soundAllowed({
    enabled: readEnabled(),
    // Our own listener, or the browser's sticky activation for a press made before it was listening.
    activated: activated || Boolean(nav.userActivation?.hasBeenActive),
    webdriver: Boolean(nav.webdriver),
    userAgent: nav.userAgent ?? '',
    camera,
  });
}

/** Plays one of the six, if the page may sound now. Never throws. */
export function play(kind: SoundKind): void {
  try {
    if (!allowed()) return;
    if (quiet && silencedByBusy(kind)) return;
    const ctx = context();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const start = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    for (const note of TUNES[kind]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const t0 = start + note.at;
      const t1 = t0 + note.len;
      osc.type = note.wave;
      osc.frequency.setValueAtTime(note.f, t0);
      if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, t1);
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(note.gain, t0 + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(env);
      env.connect(master);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
  } catch {
    // A sound is a courtesy; nothing waits on it.
  }
}
