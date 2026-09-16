'use client';

import { useId, useState } from 'react';
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

export function PairedPicker({
  codeLabel,
  nameLabel,
  name,
  options,
  placeholder,
  required = false,
}: {
  readonly codeLabel: string;
  readonly nameLabel: string;
  /** The field the chosen id is submitted under. */
  readonly name: string;
  readonly options: readonly PairedOption[];
  readonly placeholder?: string | undefined;
  readonly required?: boolean;
}) {
  const codeList = useId();
  const nameList = useId();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');

  const chosen = options.find((option) => option.code === code && option.name === label);

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

  return (
    <>
      <div className={styles.sapField}>
        <span className={styles.sapLabel}>{codeLabel}</span>
        <input
          aria-label={codeLabel}
          autoComplete="off"
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

      <div className={styles.sapField}>
        <span className={styles.sapLabel}>{nameLabel}</span>
        <input
          aria-label={nameLabel}
          autoComplete="off"
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

      <input name={name} type="hidden" value={chosen?.value ?? ''} />
    </>
  );
}
