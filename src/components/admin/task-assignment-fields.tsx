'use client';

import { useState } from 'react';
import styles from './admin.module.css';

/**
 * The Task Center's section and assignee, as two fields that follow each
 * other: choosing a section re-draws the people list with exactly the people
 * the database says the asker may assign to in that section
 * (`app_task_eligible`, read by the page and passed in). Nothing is filtered
 * here that the server has not already filtered; the server and the trigger
 * refuse anything else.
 *
 * Drawn in the application's own field chrome (`styles.field`, `.label`,
 * `.select`, `.hint`), the same classes `Field` and `Select` use; it carries
 * no class of its own. Labels arrive as props, so no client message
 * namespace is needed.
 */
export interface AssignmentSection {
  readonly code: string;
  readonly name: string;
  readonly assignees: readonly { readonly id: string; readonly name: string; readonly via: string }[];
}

export function TaskAssignmentFields({
  sections,
  idPrefix,
  labels,
  defaultSection,
  defaultAssignee,
  assigneeOptional = false,
  lockSection = false,
}: {
  readonly sections: readonly AssignmentSection[];
  /** Makes the element ids unique when two forms share a page. */
  readonly idPrefix: string;
  readonly labels: {
    readonly section: string;
    readonly assignee: string;
    readonly none: string;
    readonly hint: string;
    readonly empty: string;
    readonly via: Readonly<Record<string, string>>;
  };
  readonly defaultSection?: string | undefined;
  readonly defaultAssignee?: string | undefined;
  /** A new task may stay a draft: the assignee is then optional. */
  readonly assigneeOptional?: boolean;
  /** A reassignment keeps the task's section. */
  readonly lockSection?: boolean;
}) {
  const [section, setSection] = useState(defaultSection && sections.some((s) => s.code === defaultSection) ? defaultSection : (sections[0]?.code ?? ''));
  const people = sections.find((s) => s.code === section)?.assignees ?? [];

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-section`}>
          {labels.section}
        </label>
        <select
          className={styles.select}
          disabled={lockSection}
          id={`${idPrefix}-section`}
          name={lockSection ? undefined : 'department_code'}
          onChange={(event) => setSection(event.target.value)}
          required
          value={section}
        >
          {sections.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        {lockSection ? <input name="department_code" type="hidden" value={section} /> : null}
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-assignee`}>
          {labels.assignee}
        </label>
        <select
          className={styles.select}
          defaultValue={people.some((p) => p.id === defaultAssignee) ? defaultAssignee : ''}
          id={`${idPrefix}-assignee`}
          key={section}
          name="assignee_id"
          required={!assigneeOptional}
        >
          {assigneeOptional || people.length === 0 ? <option value="">{people.length === 0 ? labels.empty : labels.none}</option> : <option value="">—</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {labels.via[p.via] ?? p.via}
            </option>
          ))}
        </select>
        <span className={styles.hint}>{labels.hint}</span>
      </div>
    </>
  );
}
