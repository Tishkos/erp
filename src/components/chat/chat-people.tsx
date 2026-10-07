'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { createGroupAction, openDirectAction, peopleAction } from '@/app/(app)/chat/actions';
import type { PersonHit } from '@/server/services/chat-read';
import { ChatAvatar } from './chat-avatar';
import { open as openConversation } from './chat-store';

/**
 * Choosing colleagues: a search box over the people chat can reach, and the
 * rows it finds. One person (starts a direct conversation) or several (a
 * group, or the people to add) — the rows are the attachments list's own
 * (`fileList`, `fileIcon`, `fileBody`, `fileMeta`), the initials the user
 * register's `avatarSmall`.
 */
export function PeoplePicker({
  mode,
  exclude = [],
  chosen,
  onChoose,
}: {
  readonly mode: 'one' | 'many';
  readonly exclude?: readonly string[];
  readonly chosen?: readonly PersonHit[];
  readonly onChoose: (person: PersonHit) => void;
}) {
  const t = useTranslations('chat');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PersonHit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);

  // The dialog holding the picker is in the page from the start; people are looked up when it is opened.
  useEffect(() => {
    const dialog = root.current?.closest('dialog');
    if (!dialog) {
      setShown(true);
      return;
    }
    setShown(dialog.open);
    const watch = new MutationObserver(() => setShown(dialog.open));
    watch.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (!shown) return;
    let current = true;
    const wait = setTimeout(async () => {
      const result = await peopleAction(query).catch(() => null);
      if (!current) return;
      if (result?.ok && result.value) {
        setHits(result.value);
        setFailed(false);
      } else {
        setFailed(true);
      }
    }, query === '' ? 0 : 250);
    return () => {
      current = false;
      clearTimeout(wait);
    };
  }, [query, shown]);

  const picked = new Set((chosen ?? []).map((p) => p.userId));
  const visible = (hits ?? []).filter((p) => !exclude.includes(p.userId));

  return (
    <div className={s.form} ref={root}>
      <div className={s.field}>
        <label className={s.label} htmlFor={`${id}-q`}>
          {t('people_search')}
        </label>
        <input
          autoComplete="off"
          className={s.input}
          id={`${id}-q`}
          onChange={(event) => setQuery(event.target.value)}
          // Enter looks people up as it is typed; it must not send the form the picker sits in.
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          placeholder={t('people_search_placeholder')}
          type="search"
          value={query}
        />
      </div>
      {failed ? (
        <p className={s.hint} role="alert">
          {t('people_failed')}
        </p>
      ) : hits === null ? (
        <p className={s.hint}>{t('loading')}</p>
      ) : visible.length === 0 ? (
        <p className={s.hint}>{t('people_none')}</p>
      ) : (
        <ul className={s.fileList}>
          {visible.map((person) => (
            <li key={person.userId}>
              <ChatAvatar name={person.name} presence={person.presence} size="sm" />
              <span className={s.fileBody}>
                <strong>
                  <bdi dir="auto">{person.name}</bdi>
                </strong>
                <span className={s.fileMeta}>{person.email}</span>
              </span>
              <button
                aria-pressed={picked.has(person.userId)}
                className={`${s.button}${picked.has(person.userId) ? '' : ` ${s.primary}`}`}
                disabled={mode === 'many' && picked.has(person.userId)}
                onClick={(event) => {
                  onChoose(person);
                  if (mode === 'one') event.currentTarget.closest('dialog')?.close();
                }}
                type="button"
              >
                {mode === 'one' ? t('start_chat') : picked.has(person.userId) ? t('added') : t('add')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "New chat": pick a colleague; the conversation opens beside the list. */
export function NewChatDialog() {
  const t = useTranslations('chat');
  const [error, setError] = useState<string | null>(null);
  return (
    <NewRecordDialog buttonLabel={t('new_chat')} closeLabel={t('close')} title={t('new_chat_title')}>
      <PeoplePicker
        mode="one"
        onChoose={async (person) => {
          const result = await openDirectAction(person.userId);
          if (result.ok && result.value) {
            setError(null);
            openConversation(result.value.id);
          } else {
            setError(result.error ?? t('failed'));
          }
        }}
      />
      {error ? (
        <p className={s.hint} role="alert">
          {error}
        </p>
      ) : null}
    </NewRecordDialog>
  );
}

/** "New group": a name and the people in it. */
export function NewGroupDialog() {
  const t = useTranslations('chat');
  const [members, setMembers] = useState<PersonHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  return (
    <NewRecordDialog buttonLabel={t('new_group')} closeLabel={t('close')} title={t('new_group_title')}>
      <Form
        action={async (form) => {
          const result = await createGroupAction(String(form.get('title') ?? ''), members.map((m) => m.userId));
          if (result.ok && result.value) {
            setError(null);
            setMembers([]);
            openConversation(result.value.id);
            document.querySelector<HTMLDialogElement>('dialog[open]')?.close();
          } else {
            setError(result.error ?? t('failed'));
          }
        }}
      >
        <Grid>
          <Field label={t('group_name')} maxLength={80} name="title" required requiredLabel={t('required')} />
        </Grid>
        {members.length > 0 ? (
          <p className={s.hint}>
            {t('group_members', { count: members.length })}: {members.map((m) => m.name).join(', ')}
          </p>
        ) : null}
        <PeoplePicker
          chosen={members}
          mode="many"
          onChoose={(person) => setMembers((current) => (current.some((m) => m.userId === person.userId) ? current : [...current, person]))}
        />
        {error ? (
          <p className={s.hint} role="alert">
            {error}
          </p>
        ) : null}
        <SubmitRow>
          <Submit label={t('create_group')} />
        </SubmitRow>
      </Form>
    </NewRecordDialog>
  );
}

