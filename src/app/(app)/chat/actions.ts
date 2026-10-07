'use server';

import { runAdmin } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as chat from '@/server/services/chat';
import * as chatRead from '@/server/services/chat-read';
import { CHAT_MAX_FILES_PER_MESSAGE, isChosenStatus } from '@/server/domain/chat';

/**
 * What the chat screen does, one server action each.
 *
 * Every one runs `runAdmin`: the person's own transaction, their own scope,
 * the service's own checks (the grant, then membership, row by row) — an
 * action here adds nothing the service does not already refuse. They answer
 * with data rather than redirecting, because the screen stays where it is and
 * redraws from the next poll. A refusal is the service's own sentence.
 */

export interface ActionResult<T = void> {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly value?: T | undefined;
}

const done = <T>(outcome: { ok: boolean; value?: T | undefined; error?: string | undefined }): ActionResult<T> =>
  outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error };

const field = (form: FormData, name: string): string => String(form.get(name) ?? '');

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function sendAction(form: FormData): Promise<ActionResult<{ messageId: string; seq: number }>> {
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > CHAT_MAX_FILES_PER_MESSAGE) {
    return { ok: false, error: `At most ${CHAT_MAX_FILES_PER_MESSAGE} files go in one message.` };
  }
  const prepared = await Promise.all(files.map(async (f) => ({ name: f.name, content: Buffer.from(await f.arrayBuffer()) })));
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  const outcome = await runAdmin((tx, ctx) =>
    chat.sendMessage(tx, ctx, {
      conversationId: field(form, 'conversation_id'),
      body: field(form, 'body'),
      replyToId: field(form, 'reply_to') || null,
      clientId: field(form, 'client_id') || null,
      files: prepared,
    }),
  );
  return outcome.ok ? { ok: true, value: { messageId: outcome.value!.messageId, seq: outcome.value!.seq } } : { ok: false, error: outcome.error };
}

export async function retractAction(messageId: string, reason: string): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.retractMessage(tx, ctx, messageId, reason)));
}

export async function reactAction(messageId: string, reaction: string, on: boolean): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.react(tx, ctx, messageId, reaction, on)));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function openDirectAction(userId: string): Promise<ActionResult<{ id: string }>> {
  const outcome = await runAdmin((tx, ctx) => chat.openDirect(tx, ctx, userId));
  return outcome.ok ? { ok: true, value: { id: outcome.value!.conversationId } } : { ok: false, error: outcome.error };
}

export async function createGroupAction(title: string, memberIds: string[]): Promise<ActionResult<{ id: string }>> {
  const outcome = await runAdmin((tx, ctx) => chat.createGroup(tx, ctx, { title, memberIds }));
  return outcome.ok ? { ok: true, value: { id: outcome.value!.conversationId } } : { ok: false, error: outcome.error };
}

export interface RecordConversationArgs {
  readonly recordType: string;
  readonly recordId: string;
  readonly label?: string | null;
  readonly href?: string | null;
  readonly memberIds: string[];
  readonly title?: string | null;
}

export async function openRecordAction(args: RecordConversationArgs): Promise<ActionResult<{ id: string }>> {
  registerAllRecords();
  const outcome = await runAdmin((tx, ctx) => chat.openRecordConversation(tx, ctx, args));
  return outcome.ok ? { ok: true, value: { id: outcome.value!.conversationId } } : { ok: false, error: outcome.error };
}

export async function addMembersAction(conversationId: string, userIds: string[]): Promise<ActionResult> {
  registerAllRecords();
  return done(await runAdmin((tx, ctx) => chat.addMembers(tx, ctx, conversationId, userIds)));
}

export async function removeMemberAction(conversationId: string, userId: string): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.removeMember(tx, ctx, conversationId, userId)));
}

export async function leaveAction(conversationId: string): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.leaveConversation(tx, ctx, conversationId)));
}

export async function renameAction(conversationId: string, title: string): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.renameGroup(tx, ctx, conversationId, title)));
}

export async function muteAction(conversationId: string, muted: boolean): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.setMuted(tx, ctx, conversationId, muted)));
}

export async function busyAction(busy: boolean): Promise<ActionResult> {
  return done(await runAdmin((tx, ctx) => chat.setBusy(tx, ctx, busy)));
}

/** Available, Busy, Away or Appear offline — the account menu's choice. */
export async function statusAction(status: string): Promise<ActionResult> {
  if (!isChosenStatus(status)) return { ok: false, error: 'That is not a status.' };
  return done(await runAdmin((tx, ctx) => chat.setStatus(tx, ctx, status)));
}

// ---------------------------------------------------------------------------
// Reading more, finding things
// ---------------------------------------------------------------------------

export async function earlierAction(conversationId: string, beforeSeq: number): Promise<ActionResult<{ messages: chatRead.MessageView[]; hasMore: boolean }>> {
  return done(await runAdmin((tx, ctx) => chatRead.earlier(tx, ctx, conversationId, beforeSeq)));
}

export async function searchAction(query: string, conversationId: string | null): Promise<ActionResult<chatRead.SearchHit[]>> {
  return done(await runAdmin((tx, ctx) => chatRead.searchMessages(tx, ctx, query, { conversationId })));
}

export async function peopleAction(query: string): Promise<ActionResult<chatRead.PersonHit[]>> {
  return done(await runAdmin((tx, ctx) => chatRead.searchPeople(tx, ctx, query)));
}
