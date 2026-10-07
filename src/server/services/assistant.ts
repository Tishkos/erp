/**
 * Noah in the application — the AI dock (2026-10-07, by direction: "we want
 * the agent continuously running on the server … make a dock in the right
 * bottom, AI … the AI agent that we have [on WhatsApp] in the website too").
 *
 * The same agent the WhatsApp group talks to, asked from a panel in the
 * bottom corner of every screen, as the signed-in person: `whatsapp.answer`
 * with `runAgentFor`, so the answer is read as them, in a transaction the
 * database holds read-only, with the same tools, guide, pictures and
 * instructions — and the same proposals. What differs is only the transport:
 *
 *   * **Who may ask** is the session. A WhatsApp number has to be on the
 *     allow-list because a phone is not a sign-in; here the person is signed
 *     in, so every active user may ask, and every answer is theirs alone.
 *   * **Actions** are offered to everybody here for the same reason: a
 *     proposal runs only after the person presses Yes, as that person,
 *     through the document's own service, which refuses what their grants do
 *     not allow — exactly as a WhatsApp contact with Actions on. The Yes is a
 *     button, not a word, so nothing is read into a sentence.
 *   * **Pictures and files** come back inline (base64) to the browser that
 *     asked, never to a group.
 *   * **The conversation** is the browser's: the last turns travel with each
 *     question (`history`) and nothing is written to `whatsapp_message`. The
 *     audit trail still gets `assistant.answered` per answer and the WhatsApp
 *     action rows per Yes (`whatsapp-do.auditDone`, `e164` = `web`).
 *
 * Proposals wait in memory per user for `CONFIRM_MINUTES`, as the bridge's
 * do: an intention for the next few minutes, lost on a restart, which is the
 * right thing for a forgotten proposal.
 */
import { CONFIRM_MINUTES, expired, type PendingAction } from '../domain/whatsapp-do';
import type { AskedPicture, PriorTurn } from '../domain/whatsapp-agent';
import type { BotLocale } from '../domain/whatsapp';
import { applyScope, db, withScope } from '../db/client';
import * as audit from './audit';
import { readerFor, readerModel } from './reader';
import * as wa from './whatsapp';
import { WEB_CHAT, runAgentFor } from './whatsapp-agent';
import * as doService from './whatsapp-do';
import { registerAllRecords } from '../records';

/** How many turns of the panel's conversation go with a question. */
export const HISTORY_TURNS = 12;
/** The longest question the panel sends. */
export const QUESTION_MAX = 4_000;

export interface AssistantPart {
  readonly text: string;
  /** A picture as a data URL the browser shows inline. */
  readonly image: { readonly fileName: string; readonly dataUrl: string; readonly caption: string } | null;
}

export interface AssistantProposal {
  readonly action: string;
  readonly documentNo: string;
  readonly sentence: string;
  readonly expiresAt: string;
}

export interface AssistantAnswer {
  readonly text: string;
  readonly locale: BotLocale;
  readonly parts: readonly AssistantPart[];
  /** A report the answer made: a PDF or a workbook, as a data URL to download. */
  readonly attachment: { readonly fileName: string; readonly contentType: string; readonly dataUrl: string } | null;
  /** What he proposes to do, waiting for Yes. */
  readonly proposal: AssistantProposal | null;
  readonly tools: readonly string[];
  readonly seconds: number;
}

export class AssistantUnavailable extends Error {
  readonly code = 'ASSISTANT_UNAVAILABLE';
  constructor(reason: string) {
    super(reason);
    this.name = 'AssistantUnavailable';
  }
}

/** The proposals waiting for a Yes, one per person — the bridge's own rule. */
const proposals = new Map<string, PendingAction>();

/** For tests: what waits for this person, if anything still stands. */
export function pendingFor(userId: string): PendingAction | null {
  const waiting = proposals.get(userId);
  if (!waiting) return null;
  if (expired(waiting)) {
    proposals.delete(userId);
    return null;
  }
  return waiting;
}

const dataUrl = (contentType: string, body: Buffer) => `data:${contentType};base64,${body.toString('base64')}`;

function proposalView(pending: PendingAction): AssistantProposal {
  return {
    action: pending.action,
    documentNo: pending.target.documentNo,
    sentence: pending.sentence,
    expiresAt: new Date(Date.parse(pending.proposedAt) + CONFIRM_MINUTES * 60_000).toISOString(),
  };
}

/**
 * One question from the panel, answered as this person. Throws
 * `AssistantUnavailable` when the host has no brain (no CLI signed in, no
 * key) — the panel says so instead of pretending.
 */
export async function ask(input: {
  readonly userId: string;
  readonly text: string;
  readonly history?: readonly PriorTurn[];
  readonly pictures?: readonly AskedPicture[];
  readonly locale?: BotLocale;
}): Promise<AssistantAnswer> {
  const question = input.text.trim().slice(0, QUESTION_MAX);
  if (!question) throw new AssistantUnavailable('empty question');
  registerAllRecords();

  const client = await readerFor();
  if (!client) {
    throw new AssistantUnavailable('no brain is usable on this host: the claude CLI is not signed in and there is no ANTHROPIC_API_KEY');
  }
  // The settings are the company's, read as the asker — the same read the invoice intake makes.
  const settings = await withScope({ userId: input.userId, branchCode: '', isSuperUser: false }, (tx) => wa.settings(tx));
  const history = (input.history ?? []).slice(-HISTORY_TURNS);
  const started = Date.now();

  // A new question drops the proposal before it: a yes belongs to the sentence it answers.
  proposals.delete(input.userId);

  const reply = await wa.answer({
    userId: input.userId,
    text: question,
    settings,
    ...(input.locale ? { locale: input.locale } : {}),
    history,
    agent: (ctx, asked, userName) =>
      runAgentFor({
        client,
        model: readerModel(settings.agentModel),
        ctx,
        question: asked,
        history,
        userName,
        chat: WEB_CHAT,
        ...(input.pictures && input.pictures.length > 0 ? { pictures: input.pictures } : {}),
        actions: {
          chat: WEB_CHAT,
          propose: (pending: PendingAction) => {
            proposals.set(input.userId, pending);
          },
        },
      }),
  });

  // The answer on the trail, as the bridge's `auditAnswer` writes it — without a message row to point at.
  await db.transaction(async (tx) => {
    await applyScope(tx, { userId: input.userId, branchCode: reply.readAs.branchCode, isSuperUser: false });
    await audit.record(tx, {
      actorUserId: input.userId,
      action: 'assistant.answered',
      objectType: 'assistant',
      objectId: input.userId,
      branchCode: reply.readAs.branchCode,
      outcome: 'success',
      after: {
        question: question.slice(0, 500),
        locale: reply.locale,
        tools: reply.detail.tools ?? [],
        rows: reply.detail.rows ?? null,
        attachment: reply.detail.attachment ?? null,
        pictures: reply.images.length,
        proposed: proposals.get(input.userId)?.action ?? null,
        readAt: reply.readAs.at.toISOString(),
      },
    });
  });

  const pending = pendingFor(input.userId);
  const tools = (reply.detail.tools as readonly string[] | undefined) ?? [];
  return {
    text: reply.text,
    locale: reply.locale,
    parts: reply.parts.map((part) => ({
      text: part.text,
      image: part.image ? { fileName: part.image.fileName, dataUrl: dataUrl(part.image.contentType, part.image.body), caption: part.image.caption ?? '' } : null,
    })),
    attachment: reply.attachment ? { fileName: reply.attachment.fileName, contentType: reply.attachment.contentType, dataUrl: dataUrl(reply.attachment.contentType, reply.attachment.body) } : null,
    proposal: pending ? proposalView(pending) : null,
    tools,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

/** The Yes button: the proposal waiting for this person runs, as them, once. */
export async function confirm(userId: string): Promise<{ readonly ok: boolean; readonly said: string }> {
  const waiting = pendingFor(userId);
  if (!waiting) return { ok: false, said: 'Nothing is waiting for a yes — ask again, and I will propose it afresh.' };
  proposals.delete(userId);
  const outcome = await doService.run({ userId, pending: waiting, e164: WEB_CHAT });
  return outcome.ok ? { ok: true, said: outcome.said } : { ok: false, said: outcome.reason };
}

/** The No button: the proposal is dropped and nothing happens. */
export function decline(userId: string): { readonly dropped: boolean } {
  const had = proposals.has(userId);
  proposals.delete(userId);
  return { dropped: had };
}
