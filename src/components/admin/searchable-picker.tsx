'use client';

import { useId, useMemo, useState } from 'react';
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
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string | undefined;
  readonly required?: boolean | undefined;
  readonly placeholder?: string | undefined;
}) {
  const listId = useId();
  const inputId = useId();

  const initial = useMemo(
    () => options.find((option) => option.value === defaultValue)?.label ?? '',
    [options, defaultValue],
  );
  const [text, setText] = useState(initial);

  // Exact match only. "Smart" is not a customer; "SMART_ELECTRICO · Smart
  // Electrico" is, and until the text says so there is nothing to submit.
  const chosen = options.find((option) => option.label === text)?.value ?? '';

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
      <input
        autoComplete="off"
        className={styles.input}
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
    </div>
  );
}
