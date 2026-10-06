'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut, UserMinus } from 'lucide-react';
import { Field, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import {
  addMembersAction,
  leaveAction,
  removeMemberAction,
  renameAction,
} from '@/app/(app)/chat/actions';
import type { PersonHit, ThreadView } from '@/server/services/chat-read';
import { open as openConversation, pollNow } from './chat-store';
import { PeoplePicker } from './chat-people';
import { PresencePill } from './chat-presence';
import { AVATAR_CLASS, initials } from './format';

/**
 * What a conversation is made of: who is in it, and — for a group's owner —
 * the doors to rename it, add people and take people out. Anyone in a group
 * may leave it. The service decides every one of these again; the buttons
 * only hide what would be refused.
 */
export function ConversationInfo({
  thread,
  meId,
  locale,
  timeZone,
}: {
  readonly thread: ThreadView;
  readonly meId: string;
  readonly locale: string;
  readonly timeZone: string;
}) {
  const t = useTranslations('chat');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<PersonHit[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const owner = thread.kind === 'group' && thread.role === 'owner';
  const now = new Date();

  const run = async (work: () => Promise<{ ok: boolean; error?: string | undefined }>, after?: () => void) => {
    const result = await work();
    if (result.ok) {
      setError(null);
      pollNow();
      after?.();
    } else {
      setError(result.error ?? t('failed'));
    }
  };

  return (
    <div className={s.form}>
      {error ? (
        <p className={s.hint} role="alert">
          {error}
        </p>
      ) : null}

      <ul className={s.fileList}>
        {thread.members.map((member) => (
          <li key={member.userId}>
            <span className={`${s.avatarSmall} ${AVATAR_CLASS} size-8 text-xs`}>{initials(member.name)}</span>
            <span className={s.fileBody}>
              <strong>
                <bdi dir="auto">{member.userId === meId ? `${member.name} (${t('you')})` : member.name}</bdi>
              </strong>
              <span className={s.fileMeta}>
                {thread.kind === 'group' && member.role === 'owner' ? `${t('owner')} · ` : ''}
                <PresencePill locale={locale} now={now} person={member} timeZone={timeZone} />
              </span>
            </span>
            {owner && member.userId !== meId ? (
              <button
                aria-label={`${t('remove')}: ${member.name}`}
                className={s.sapIconButton}
                onClick={() => run(() => removeMemberAction(thread.id, member.userId))}
                title={t('remove')}
                type="button"
              >
                <UserMinus aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {owner ? (
        <>
          <Form
            action={async (form) => {
              await run(() => renameAction(thread.id, String(form.get('title') ?? '')));
            }}
          >
            <Grid>
              <Field defaultValue={thread.title ?? ''} id={`rename-${thread.id}`} label={t('group_name')} maxLength={80} name="title" required requiredLabel={t('required')} />
            </Grid>
            <SubmitRow>
              <Submit label={t('rename')} />
            </SubmitRow>
          </Form>

          <Form
            action={async () => {
              if (adding.length === 0) return;
              await run(
                () => addMembersAction(thread.id, adding.map((p) => p.userId)),
                () => setAdding([]),
              );
            }}
          >
            {adding.length > 0 ? (
              <p className={s.hint}>{adding.map((p) => p.name).join(', ')}</p>
            ) : null}
            <PeoplePicker
              chosen={adding}
              exclude={thread.members.map((m) => m.userId)}
              mode="many"
              onChoose={(person) => setAdding((current) => (current.some((p) => p.userId === person.userId) ? current : [...current, person]))}
            />
            <SubmitRow>
              <Submit label={t('add_people')} />
            </SubmitRow>
          </Form>
        </>
      ) : null}

      {thread.kind === 'group' ? (
        confirmLeave ? (
          <div className={s.sapNote} role="alert">
            <p>{t('leave_confirm')}</p>
            <button
              className={`${s.button} ${s.danger}`}
              onClick={() =>
                run(
                  () => leaveAction(thread.id),
                  () => {
                    openConversation(null);
                    setConfirmLeave(false);
                  },
                )
              }
              type="button"
            >
              <LogOut aria-hidden="true" />
              <span>{t('leave_yes')}</span>
            </button>{' '}
            <button className={s.button} onClick={() => setConfirmLeave(false)} type="button">
              {t('cancel')}
            </button>
          </div>
        ) : (
          <div>
            <button className={`${s.button} ${s.danger}`} onClick={() => setConfirmLeave(true)} type="button">
              <LogOut aria-hidden="true" />
              <span>{t('leave')}</span>
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}
