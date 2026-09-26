'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './admin.module.css';

/**
 * A code and a name that fill each other — the sponsor's header pair.
 *
 *   Block 4  Supplier Code; Supplier Name (searchable).
 *   Block 5  Customer Code (searchable); Customer Name (searchable).
 *
 * Two boxes, because the sponsor lists two: a person who knows the code types
 * the code, a person who knows the name types the name, and either one fills
 * the other. One combined `CODE · Name` control was fewer boxes and the wrong
 * ones — it asked somebody holding a supplier's code to read past the code to
 * find it.
 *
 * The form needs the id rather than either piece of text, so a hidden input
 * carries it and is set only when what was typed matches an option exactly. A
 * half-typed name therefore submits nothing and the server refuses it, which is
 * the right way round: the alternative is guessing who was meant.
 */
export interface PairedOption {
  readonly value: string;
  readonly code: string;
  readonly name: string;
}

/** What the picker fires on the form when its choice changes. */
export const PAIRED_CHOICE = 'paired-picker:choice';

export interface PairedChoice {
  /** The hidden field the id is submitted under. */
  readonly name: string;
  /** The chosen id, or '' while what is typed matches nothing. */
  readonly value: string;
}

export function PairedPicker({
  codeLabel,
  nameLabel,
  name,
  options,
  placeholder,
  required = false,
  plain = false,
}: {
  readonly codeLabel: string;
  readonly nameLabel: string;
  /** The field the chosen id is submitted under. */
  readonly name: string;
  readonly options: readonly PairedOption[];
  readonly placeholder?: string | undefined;
  readonly required?: boolean;
  /**
   * The application's own field chrome rather than the document window's.
   *
   * The two look different on purpose — a document is a form on paper, a
   * settings screen is not — and this control is used on both. Either way it
   * is drawn in the same chrome as the fields beside it.
   */
  readonly plain?: boolean;
}) {
  const codeList = useId();
  const nameList = useId();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');

  const chosen = options.find((option) => option.code === code && option.name === label);

  /*
   * The choice, said out loud for the rest of the document.
   *
   * The hidden input carries the id to the server, but setting a value in
   * React fires no event a sibling field could hear — so a header field that
   * depends on who was chosen (the due date, from the supplier's terms) would
   * never learn of it. The event goes out after the render that set the value,
   * so whoever listens reads the id that is actually on the form.
   */
  const picked = useRef<HTMLInputElement>(null);
  const chosenValue = chosen?.value ?? '';

  useEffect(() => {
    picked.current?.dispatchEvent(
      new CustomEvent(PAIRED_CHOICE, { bubbles: true, detail: { name, value: chosenValue } }),
    );
  }, [name, chosenValue]);

  const typeCode = (value: string) => {
    setCode(value);
    const match = options.find((option) => option.code === value);
    if (match) setLabel(match.name);
  };

  const typeName = (value: string) => {
    setLabel(value);
    const match = options.find((option) => option.name === value);
    if (match) setCode(match.code);
  };

  /*
   * `plain` asks for the application's own field chrome instead of the
   * document window's. It used to name `field` / `field__label` /
   * `field__input`, which are in no stylesheet — so on every screen that asked
   * for it the two boxes were drawn by the browser, unstyled, beside the
   * `Field` and `Select` controls that were not. These are the classes `Field`
   * itself uses, so the pair now matches the fields it stands among.
   */
  const field = plain ? styles.field : styles.sapField;
  const caption = plain ? styles.label : styles.sapLabel;
  const box = plain ? styles.input : undefined;

  return (
    <>
      <div className={field}>
        <span className={caption}>{codeLabel}</span>
        <input
          aria-label={codeLabel}
          autoComplete="off"
          {...(box ? { className: box } : {})}
          dir="ltr"
          list={codeList}
          onChange={(event) => typeCode(event.target.value)}
          required={required}
          value={code}
        />
        <datalist id={codeList}>
          {options.map((option) => (
            <option key={option.value} value={option.code} />
          ))}
        </datalist>
      </div>

      <div className={field}>
        <span className={caption}>{nameLabel}</span>
        <input
          aria-label={nameLabel}
          autoComplete="off"
          {...(box ? { className: box } : {})}
          dir="auto"
          list={nameList}
          onChange={(event) => typeName(event.target.value)}
          {...(placeholder ? { placeholder } : {})}
          required={required}
          value={label}
        />
        <datalist id={nameList}>
          {options.map((option) => (
            <option key={option.value} value={option.name} />
          ))}
        </datalist>
      </div>

      <input name={name} ref={picked} type="hidden" value={chosenValue} />
    </>
  );
}
