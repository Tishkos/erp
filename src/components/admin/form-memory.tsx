'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import s from './admin.module.css';
import {
  FORM_MEMORY_PREFIX,
  type StoredForm,
  type StoredValues,
  draftsOf,
  isEmptyChange,
  memoryKey,
  readStored,
  shouldRestore,
} from '@/lib/form-memory';
import { setFieldValue, writeInputValue } from './intent-control-kit';

/**
 * A form that keeps what was typed (2026-10-15, by direction: "sometimes I
 * change the tabs and it removes everything — add local storage to keep the
 * values, and an option to make it multi-tab").
 *
 * Put inside a `<form>`. Every named field a person types into — text,
 * number, date, select, textarea, checkbox, radio — is written to this
 * browser's `localStorage` under the person and the record (`storageKey`) as
 * it changes, and put back when the form is drawn again: after moving to
 * another tab of the module and back, after the browser dropped a background
 * tab and reloaded it, and after a save the server refused (`?error=`). A
 * form whose save went through starts empty next time. Hidden fields (a
 * one-time `document_id`, the import's number), files and passwords are never
 * kept; a field marked `data-form-memory="off"` neither.
 *
 * Each record has its own entry, so several drafts live side by side — one
 * per import — and each browser tab keeps its own; `FormDrafts` lists them.
 * Nothing leaves the browser. A field whose kept value is no longer on offer
 * (an account taken out of use) keeps what the page gave it.
 */
export function FormMemory({
  owner,
  storageKey,
  title,
  href,
  labels,
}: {
  /** The signed-in person: one person's drafts are never shown to another on the same browser. */
  readonly owner: string;
  /** The form and the record, e.g. `payapp-new:IMP-HQ-2026-000014`. */
  readonly storageKey: string;
  /** What the drafts list calls this draft. */
  readonly title: string;
  /** Where the drafts list sends the person back to. */
  readonly href: string;
  readonly labels: { readonly restored: string; readonly discard: string };
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const initial = useRef<StoredValues | null>(null);
  const restoring = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const key = memoryKey(owner, storageKey);

  const formOf = () => anchor.current?.closest('form') ?? null;

  const save = useCallback(
    (submitted: boolean) => {
      const form = formOf();
      if (!form || restoring.current) return;
      const values = readForm(form);
      try {
        if (!submitted && initial.current && isEmptyChange(initial.current, values)) {
          localStorage.removeItem(key);
          return;
        }
        const entry: StoredForm = {
          v: 1,
          title,
          href,
          savedAt: new Date().toISOString(),
          submittedAt: submitted ? new Date().toISOString() : null,
          values,
        };
        localStorage.setItem(key, JSON.stringify(entry));
      } catch {
        // Storage full, blocked or private: the form works as it always did.
      }
    },
    [href, key, title],
  );

  const restore = useCallback(
    (entry: StoredForm) => {
      const form = formOf();
      if (!form) return;
      restoring.current = true;
      // A field that appears once another is filled (a grid's next row) is
      // reached on a later pass; nothing is written twice.
      const done = new Set<string>();
      let passes = 0;
      const pass = () => {
        passes += 1;
        const wrote = writeForm(form, entry.values, done);
        if (wrote > 0 && passes < 60) {
          window.setTimeout(pass, 0);
          return;
        }
        restoring.current = false;
        setRestoredAt(entry.savedAt);
      };
      pass();
    },
    [],
  );

  // Drawn: take the page's own values as the starting point, then put back what was typed.
  useEffect(() => {
    const form = formOf();
    if (!form) return;
    initial.current = readForm(form);
    const entry = readStored(key);
    if (entry) {
      const refused = new URLSearchParams(window.location.search).has('error');
      if (shouldRestore(entry, { refused, now: Date.now() })) restore(entry);
      else {
        try {
          localStorage.removeItem(key);
        } catch {
          /* nothing kept */
        }
      }
    }

    const onChange = () => {
      if (restoring.current) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(false), 300);
    };
    const onSubmit = () => {
      window.clearTimeout(timer.current);
      save(true);
    };
    // A refused save brings the page back with `?error=`; the form was reset to the page's values.
    const onReset = () => {
      window.setTimeout(() => {
        const again = readStored(key);
        if (again && new URLSearchParams(window.location.search).has('error')) restore(again);
      }, 0);
    };
    form.addEventListener('input', onChange);
    form.addEventListener('change', onChange);
    form.addEventListener('submit', onSubmit);
    form.addEventListener('reset', onReset);
    return () => {
      window.clearTimeout(timer.current);
      form.removeEventListener('input', onChange);
      form.removeEventListener('change', onChange);
      form.removeEventListener('submit', onSubmit);
      form.removeEventListener('reset', onReset);
    };
  }, [key, restore, save]);

  // A save the server refused came back with `?error=`: what was sent is a draft again, not a saved form —
  // so leaving and coming back later still finds it.
  const refused = useSearchParams()?.has('error') ?? false;
  useEffect(() => {
    if (!refused) return;
    const entry = readStored(key);
    if (!entry?.submittedAt) return;
    try {
      localStorage.setItem(key, JSON.stringify({ ...entry, submittedAt: null } satisfies StoredForm));
    } catch {
      /* nothing kept */
    }
  }, [key, refused]);

  const discard = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing kept */
    }
    const form = formOf();
    if (form && initial.current) {
      restoring.current = true;
      writeForm(form, initial.current, new Set());
      restoring.current = false;
    }
    setRestoredAt(null);
  };

  return (
    <span data-form-memory={storageKey} ref={anchor}>
      {restoredAt ? (
        <span className={`${s.sapEnteredNote} flex flex-wrap items-center gap-2`} role="status">
          {labels.restored.replace('{time}', new Date(restoredAt).toLocaleString())}
          <button className="action" onClick={discard} type="button">
            {labels.discard}
          </button>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The drafts a person has started on this browser for one kind of form —
 * every import's application in progress, side by side, each opened where it
 * was left. Drawn after the page loads (the server cannot see this browser's
 * storage); nothing while there is none.
 */
export function FormDrafts({
  owner,
  prefix,
  labels,
}: {
  readonly owner: string;
  /** The `storageKey`s' common start, e.g. `payapp-new:`. */
  readonly prefix: string;
  readonly labels: { readonly title: string; readonly open: string; readonly discard: string; readonly saved: string };
}) {
  const snapshot = useSyncExternalStore(subscribe, () => storageSnapshot(), () => '');
  const drafts = snapshot ? draftsOf(JSON.parse(snapshot) as [string, string][], memoryKey(owner, prefix), Date.now()) : [];
  if (drafts.length === 0) return null;

  const remove = (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing kept */
    }
    notify();
  };

  return (
    <section aria-labelledby="form-drafts-title" className={s.sapDoc} data-form-drafts={prefix}>
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="form-drafts-title">
          <span>{labels.title}</span>
          <span className={s.sapTitleMeta}>{drafts.length}</span>
        </h2>
        <div className={s.sapTableWrap}>
          <table aria-labelledby="form-drafts-title" className={s.sapTable}>
            <tbody>
              {drafts.map((draft) => (
                <tr key={draft.key}>
                  <td>
                    <a className={s.sapLink} href={draft.entry.href}>
                      <bdi dir="auto">{draft.entry.title}</bdi>
                    </a>
                  </td>
                  <td>
                    <span className="muted">
                      {labels.saved.replace('{time}', new Date(draft.entry.savedAt).toLocaleString())}
                    </span>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <a className="action" href={draft.entry.href}>
                        {labels.open}
                      </a>
                      <button className="action" onClick={() => remove(draft.key)} type="button">
                        {labels.discard}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page's fields, read and written
// ---------------------------------------------------------------------------

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SKIPPED = new Set(['hidden', 'file', 'password', 'submit', 'button', 'reset', 'image']);

function keptFields(form: HTMLFormElement): Field[] {
  const fields: Field[] = [];
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) continue;
    if (!element.name || element.dataset.formMemory === 'off') continue;
    if (element instanceof HTMLInputElement && SKIPPED.has(element.type)) continue;
    fields.push(element);
  }
  return fields;
}

function valueOf(field: Field): string {
  if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
    return field.checked ? `1:${field.value}` : '0';
  }
  if (field instanceof HTMLSelectElement && field.multiple) {
    return JSON.stringify(Array.from(field.selectedOptions).map((option) => option.value));
  }
  return field.value;
}

/** Each name's values in the order the page draws its fields. */
function readForm(form: HTMLFormElement): StoredValues {
  const values: Record<string, string[]> = {};
  for (const field of keptFields(form)) (values[field.name] ??= []).push(valueOf(field));
  return values;
}

/** Writes what differs; returns how many fields it changed (0 = nothing left to do). */
function writeForm(form: HTMLFormElement, values: StoredValues, done: Set<string>): number {
  const seen = new Map<string, number>();
  let wrote = 0;
  for (const field of keptFields(form)) {
    const position = seen.get(field.name) ?? 0;
    seen.set(field.name, position + 1);
    const id = `${field.name}#${position}`;
    if (done.has(id)) continue;
    const kept = values[field.name]?.[position];
    if (kept === undefined) continue;
    done.add(id);
    if (field.disabled || valueOf(field) === kept) continue;
    if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) {
      const checked = kept.startsWith('1:');
      setFieldValue(field, () => (field.checked = checked));
    } else if (field instanceof HTMLSelectElement) {
      if (field.multiple) {
        const chosen = new Set(JSON.parse(kept) as string[]);
        setFieldValue(field, () => Array.from(field.options).forEach((option) => (option.selected = chosen.has(option.value))));
      } else if (Array.from(field.options).some((option) => option.value === kept)) {
        setFieldValue(field, () => (field.value = kept));
      } else {
        // No longer on offer (an account taken out of use, another bank): the page's choice stands.
        continue;
      }
    } else if (field instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setFieldValue(field as unknown as HTMLInputElement, () => (setter ? setter.call(field, kept) : (field.value = kept)));
    } else {
      writeInputValue(field, kept);
    }
    wrote += 1;
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// The drafts list follows storage — this tab's changes and other tabs'
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(FORM_MEMORY_PREFIX)) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Every kept form as `[key, json]` pairs, as one string so an unchanged store is the same snapshot. */
function storageSnapshot(): string {
  try {
    const pairs: [string, string][] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(FORM_MEMORY_PREFIX)) pairs.push([key, localStorage.getItem(key) ?? '']);
    }
    pairs.sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify(pairs);
  } catch {
    return '';
  }
}
