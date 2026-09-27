'use client';

import { useId, useMemo, useState } from 'react';
import { pickOne } from '@domain/pick';
import styles from './admin.module.css';

/**
 * A picker you can type into — the sponsor's *"searchable"*.
 *
 *   Header  ... Supplier Name (searchable).
 *   Header  ... Customer Code (searchable); Customer Name (searchable).
 *
 * A native `<select>` cannot be searched past its first letter, which is fine
 * for five departments and useless for four hundred customers. This is an
 * `<input list>` over a `<datalist>`: click it and the whole list drops down,
 * type and it narrows, and the browser does the filtering rather than a
 * component re-implementing it.
 *
 * The form still needs the id, not the text somebody typed, so a hidden input
 * carries it and is set only when the text matches an option exactly. A
 * half-typed name therefore submits nothing and the server refuses it, which is
 * the right way round: the alternative is guessing which customer was meant.
 *
 * Wears the same field chrome as `Field`, so it lines up with the inputs
 * beside it instead of being a differently-sized box.
 */
export function SearchablePicker({
  label,
  name,
  options,
  defaultValue,
  required,
  placeholder,
  bare = false,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string | undefined;
  readonly required?: boolean | undefined;
  readonly placeholder?: string | undefined;
  /**
   * Render the control alone, with no label or field wrapper.
   *
   * For a document window, which supplies both and styles the control itself —
   * the form chrome here would be a second, differently-sized box inside it.
   */
  readonly bare?: boolean;
}) {
  const listId = useId();
  const inputId = useId();

  const initial = useMemo(
    () => options.find((option) => option.value === defaultValue)?.label ?? '',
    [options, defaultValue],
  );
  const [text, setText] = useState(initial);

  /*
   * The one option the text names, or nothing.
   *
   * It used to be equality against the whole label, which meant a person had to
   * reproduce it character for character: typing the name when the label read
   * "CODE · Name", or editing a character after picking from the list, left
   * nothing to submit and the form was refused without saying why (reported on
   * the statement screens, 2026-09-27). A label typed in full still wins
   * outright; short of that, a phrase that can only be one option names it, and
   * anything still ambiguous submits nothing — which is the right way round when
   * the alternative is guessing which record was meant.
   */
  const chosen = pickOne(options, text, (option) => option.label)?.value ?? '';

  const control = (
    <>
      <input
        aria-label={bare ? label : undefined}
        autoComplete="off"
        {...(bare ? {} : { className: styles.input })}
        dir="auto"
        id={inputId}
        list={listId}
        onChange={(event) => setText(event.target.value)}
        {...(placeholder ? { placeholder } : {})}
        required={required ?? false}
        value={text}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.label} />
        ))}
      </datalist>
      <input name={name} type="hidden" value={chosen} />
    </>
  );

  if (bare) return control;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
        {required ? (
          <span aria-hidden="true" className={styles.required}>
            *
          </span>
        ) : null}
      </label>
      {control}
    </div>
  );
}
