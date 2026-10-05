/**
 * The WhatsApp bridge — REQ-WA-001 §3, the "bridge" layer.
 *
 *   npm run whatsapp-bridge                 run (first time: scan the QR code it prints)
 *   npm run whatsapp-bridge -- --reset-pairing   forget the pairing and print a new QR
 *
 * A standalone worker beside the application, never inside it. It holds one
 * Baileys socket on the company's own number (W-R6), and does three things:
 *
 *   outbound   the `whatsapp` channel of the notification outbox — every
 *              `WA_POLL_SECONDS` it runs the delivery runner for its channel
 *              (HARDEN F1–F3), sending each pending delivery to the
 *              recipient's contact row and marking it sent / failed /
 *              suppressed
 *   inbound    a message from a number on the allow-list, from a user who
 *              holds the CEO role and whose contact allows queries, is
 *              answered by `services/whatsapp.answer` under that user's own
 *              scope in a read-only transaction (W-R1); everything else is
 *              logged and gets silence (W-R3). Every question and answer is
 *              in the message log and the audit trail (W-R4)
 *   housekeeping  a heartbeat the settings screen shows, the daily blanking
 *              of message bodies past retention (D-WA-8)
 *
 * Runs as the system operator for its own tables (contacts, log, outbox),
 * exactly as the payables sweep does; a question never runs as the operator.
 *
 * Configuration (environment, TECHSTACK A13): DATABASE_URL (the application
 * role), WA_POLL_SECONDS (20), ANTHROPIC_API_KEY (optional — without it the
 * phrase patterns alone route; with it the small router model fills the gaps),
 * WA_ROUTER_MODEL and WA_AGENT_MODEL override the two models in the settings
 * table, and WA_BRAIN (cli | api) which transport thinks; WA_CLI_EFFORT is how
 * hard it thinks (low … max, high by direction).
 */
import 'dotenv/config';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  initAuthCreds,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { AsyncLocalStorage } from 'node:async_hooks';
import qrcode from 'qrcode-terminal';
import { pool, withScope, type RequestScope } from '../../src/server/db/client';
import {
  checkingLine,
  detectLocale,
  digestDue,
  e164ToJid,
  helpText,
  isGroupJid,
  jidToE164,
  parseCommand,
  words,
} from '../../src/server/domain/whatsapp';
import * as audit from '../../src/server/services/audit';
import * as runner from '../../src/server/services/notification-runner';
import * as wa from '../../src/server/services/whatsapp';
import * as actions from '../../src/server/services/whatsapp-actions';
import { agentClientFor, anthropicClient, modelRouter } from '../../src/server/services/whatsapp-router';
import { runAgentFor, type AgentClient } from '../../src/server/services/whatsapp-agent';
import { cliAgentClient, cliReady } from '../../src/server/services/whatsapp-cli-brain';
import { AI_TRIGGER, isSelfChat, listensTo, maySendTo, triggerOf } from '../../src/server/domain/whatsapp';
import { nameOf } from '../../src/server/domain/whatsapp-names';
import { readTags, rosterForPrompt, rosterFrom, writeTags, type Member, type Participant } from '../../src/server/domain/whatsapp-people';
import type { AskedPicture } from '../../src/server/domain/whatsapp-agent';
import { knownNames, rememberNames } from '../../src/server/services/whatsapp-names';
import { questionForFiles, type SentFile } from '../../src/server/domain/whatsapp-files';
import { expired, isConfirmation, isRefusal, type PendingAction } from '../../src/server/domain/whatsapp-do';
import { extractSentFile } from '../../src/server/services/whatsapp-files';
import * as doService from '../../src/server/services/whatsapp-do';

const POLL_SECONDS = Math.max(5, Number(process.env.WA_POLL_SECONDS ?? '20'));
/**
 * How hard the brain thinks. High by direction (2026-10-02): the questions
 * are the company's own books, where a wrong figure costs more than a slow
 * answer. The CLI takes low, medium, high, xhigh and max.
 */
const effort = process.env.WA_CLI_EFFORT?.trim() || 'high';
/*
 * Which model answers.
 *
 * The settings table is the ordinary place for this — the WhatsApp screen
 * writes it — and the environment wins, the way it already does for the
 * router. It is how the brain can be moved on a running server before the
 * migration that changes the stored default has been deployed there.
 */
const AGENT_MODEL_OVERRIDE = process.env.WA_AGENT_MODEL?.trim() || null;
/*
 * Whether to answer messages typed on the bot's own phone.
 *
 * The bot's number is Tishko's handset: he pairs it, and he is the one who
 * wants to try Noah out. Everything from that handset arrives marked
 * `fromMe`, which the bridge skips — otherwise it would answer its own
 * answers forever — so testing from it was impossible.
 *
 * With this on, a `fromMe` message is answered unless the bridge itself sent
 * it, which it knows by the id it recorded when it did. Asked for as a
 * temporary thing for testing (2026-10-02), so it is a switch and not a
 * change: WA_ANSWER_SELF=off, or simply removed, puts it back.
 */
const ANSWER_SELF = (process.env.WA_ANSWER_SELF ?? '').trim().toLowerCase() === 'on';

/*
 * The owner's own "Message yourself" chat (2026-10-05, by direction: "can I
 * try on my own chat"). Off unless WA_SELF_CHAT=on: with it, a message the
 * owner writes to THEMSELVES that begins with the trigger is answered in that
 * chat. No other private chat is heard or written to (`isSelfChat`).
 */
const SELF_CHAT = (process.env.WA_SELF_CHAT ?? '').trim().toLowerCase() === 'on';
const RESET = process.argv.includes('--reset-pairing');
/** WA-5 — print the groups the bot is in, with their ids, and exit. */
const LIST_GROUPS = process.argv.includes('--list-groups');

const log = (line: string) => console.log(`[whatsapp-bridge] ${new Date().toISOString()} ${line}`);

/** Baileys wants a pino-shaped logger; the bridge keeps its own one-line log. */
const silent = {
  level: 'silent',
  child() {
    return silent;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj: unknown, msg?: string) {
    log(`baileys: ${msg ?? ''} ${typeof obj === 'object' ? JSON.stringify(obj).slice(0, 300) : String(obj)}`);
  },
};

// ---------------------------------------------------------------------------
// The pairing, kept in whatsapp_session
// ---------------------------------------------------------------------------

async function databaseAuthState(scope: RequestScope) {
  const read = async (key: string): Promise<unknown | null> => {
    const raw = await withScope(scope, (tx) => wa.sessionGet(tx, key));
    return raw === null ? null : JSON.parse(JSON.stringify(raw), BufferJSON.reviver);
  };
  const write = (key: string, value: unknown) => withScope(scope, (tx) => wa.sessionSet(tx, key, JSON.parse(JSON.stringify(value, BufferJSON.replacer))));
  const remove = (key: string) => withScope(scope, (tx) => wa.sessionDelete(tx, key));

  const creds = ((await read('creds')) as AuthenticationCreds | null) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = (await read(`${type}-${id}`)) as SignalDataTypeMap[T] | null;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
              }
              if (value) data[id] = value;
            }),
          );
          return data;
        },
        set: async (data: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const entries = data[category] ?? {};
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const key = `${category}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

// ---------------------------------------------------------------------------
// Sending, paced
// ---------------------------------------------------------------------------

const sentAt: number[] = [];

/*
 * The ids of messages this process has just sent.
 *
 * `sentByBridge` answers the same question from the log, which is the durable
 * answer and survives a restart — but the echo of a message can reach the
 * socket before the row recording its id has committed, and in that window
 * the bot would answer itself. This set is written the instant WhatsApp hands
 * the id back, so the window does not exist. It only matters while
 * WA_ANSWER_SELF is on; it costs nothing when it is off.
 */
const ownSends = new Set<string>();

function remember(id: string | null | undefined): void {
  if (!id) return;
  ownSends.add(id);
  // A few hundred is more than any echo arrives late by; past that, forget
  // the oldest half rather than grow for the life of the process.
  if (ownSends.size > 500) {
    for (const old of ownSends) {
      ownSends.delete(old);
      if (ownSends.size <= 250) break;
    }
  }
}

async function paced(perMinute: number): Promise<void> {
  const now = Date.now();
  while (sentAt.length && sentAt[0]! < now - 60_000) sentAt.shift();
  if (sentAt.length >= perMinute) {
    const wait = sentAt[0]! + 60_000 - now;
    log(`throttle: ${perMinute}/min reached, waiting ${Math.ceil(wait / 1000)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  const last = sentAt[sentAt.length - 1];
  if (last && Date.now() - last < 1000) await new Promise((r) => setTimeout(r, 1000 - (Date.now() - last)));
  sentAt.push(Date.now());
}

/**
 * Set while a message that began with the trigger is being answered, and at
 * no other time.
 *
 * By direction (2026-10-04): "shouldn't send any messages until called —
 * never ever unless !ai". Every outgoing message passes through the one
 * transport below, and in group-only mode it refuses to send unless it is
 * inside the handling of a called message — whichever part of the code asked:
 * a notification, a digest, a greeting somebody adds next year. The rule is
 * held where a message leaves, not at each place one might be written.
 */
const called = new AsyncLocalStorage<{ quoted: WAMessage | null; used: boolean; self?: boolean }>();

/**
 * The registered group's members, as people (`domain/whatsapp-people.ts`).
 *
 * Read from WhatsApp for that one group only, when somebody calls him there,
 * and kept for ten minutes: it is what turns "@159386907476204" into "@Ali"
 * on the way in and back into a real tag on the way out.
 */
let roster: { readonly at: number; readonly jid: string; readonly members: readonly Member[] } | null = null;
const ROSTER_MINUTES = 10;

/** A picture worth showing the model: past this it is described, not shown. */
const PICTURE_BYTES_CAP = 5 * 1024 * 1024;
const PICTURE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function transportFor(sock: () => WASocket | null, current: () => Awaited<ReturnType<typeof wa.settings>>): wa.Transport {
  return async (to, message) => {
    const socket = sock();
    if (!socket) throw new Error('the bridge is not connected to WhatsApp');
    if (current().groupOnly && !called.getStore()) {
      throw new Error('unasked: the bot speaks only when a message begins with !ai, and nothing called it');
    }
    // The last word on where the bot writes: in group-only mode, its group
    // and nowhere else, whichever part of the code asked (2026-10-04 — the
    // account it is linked to is a person's own).
    // …and, when the owner has switched it on, to the owner's own chat with
    // themselves — while answering a message that was written there.
    const own = jidToE164(jidNormalizedUser(socket.user?.id ?? ''));
    const toSelf = SELF_CHAT && !to.groupJid && Boolean(own) && to.e164 === own && called.getStore()?.self === true;
    if (!toSelf && !maySendTo(current(), to)) {
      throw new Error('group only: the bot writes to its one registered group and to no private chat');
    }
    await paced(current().throttlePerMinute);
    // WA-5 — a group id addresses the group; otherwise the person's number.
    const jid = to.groupJid && isGroupJid(to.groupJid) ? to.groupJid : e164ToJid(to.e164);
    // "@Ali" becomes a real tag: the digits WhatsApp wants in the text, and his
    // address beside it. A name that is nobody in the group is left as written.
    const tagged = to.groupJid && roster && roster.jid === to.groupJid ? writeTags(message.text, roster.members) : { text: message.text, mentions: [] as readonly string[] };
    const mentions = tagged.mentions.length > 0 ? { mentions: [...tagged.mentions] } : {};
    // The answer replies to the question it answers — once: in a busy group it
    // says which message it belongs to. A courtesy line does not take the place.
    const asked = called.getStore();
    const quoting = asked && asked.quoted && !asked.used && message.quote !== false ? { quoted: asked.quoted } : undefined;
    if (quoting && asked) asked.used = true;
    let sent: WAMessage | undefined;
    if (message.attachment?.format === 'image') {
      // A picture of a screen: shown in the chat itself, its caption under it.
      sent = await socket.sendMessage(jid, { image: message.attachment.body, mimetype: message.attachment.contentType, caption: tagged.text, ...mentions }, quoting);
    } else if (message.attachment) {
      sent = await socket.sendMessage(
        jid,
        { document: message.attachment.body, mimetype: message.attachment.contentType, fileName: message.attachment.fileName, caption: tagged.text, ...mentions },
        quoting,
      );
    } else {
      sent = await socket.sendMessage(jid, { text: tagged.text, ...mentions }, quoting);
    }
    remember(sent?.key?.id);
    return { waMessageId: sent?.key?.id ?? null };
  };
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

function textOf(message: WAMessage): string | null {
  const m = message.message;
  if (!m) return null;
  return m.conversation ?? m.extendedTextMessage?.text ?? m.ephemeralMessage?.message?.extendedTextMessage?.text ?? m.ephemeralMessage?.message?.conversation ?? null;
}

/** The biggest file worth pulling down: past this, say so rather than stall. */
const FILE_BYTES_CAP = 25 * 1024 * 1024;

/**
 * The files sent to each chat lately, newest first.
 *
 * In memory, and only the few most recent: a workbook somebody sent to a
 * group is their file, not the company's record. The message log keeps its
 * name, its type and its size — what was sent and by whom — without keeping
 * a copy of the contents, which is the same line the rest of the bridge
 * draws. A restart forgets them, as a person's desk does.
 */
const recentFiles = new Map<string, SentFile[]>();

/*
 * WA-8 — the proposal each person has outstanding, if any.
 *
 * One at a time, by design: with two live proposals a bare "yes" is
 * ambiguous, and an ambiguous yes must never pick one. A new proposal
 * replaces the old, which is what a conversation does anyway.
 *
 * In memory. Nothing has happened yet, so a restart that forgets a proposal
 * is behaving correctly — the right outcome for a forgotten intention is that
 * it does not happen. What does happen is audited when it does, and the
 * sentence and the yes are both in the message log regardless.
 */
const proposals = new Map<string, PendingAction>();

/** When each number that is not set up was last told so (see `handleInbound`). */
const toldNotSetUp = new Map<string, number>();

/**
 * Asks WhatsApp to put a file back on its servers.
 *
 * Media expires there, and the only way to fetch an old one is for the
 * connected socket to request it again. Held here because the handler that
 * downloads a file is not the one that owns the socket; null until connected,
 * and then a download of expired media simply fails with its own note.
 */
let reupload: ((message: WAMessage) => Promise<WAMessage>) | null = null;
const FILES_KEPT = 4;

function rememberFile(chat: string, file: SentFile): void {
  const kept = [file, ...(recentFiles.get(chat) ?? [])].slice(0, FILES_KEPT);
  recentFiles.set(chat, kept);
}

/**
 * The file on a message, if it carries one.
 *
 * WhatsApp wraps a document three or four ways depending on whether it had a
 * caption and whether the chat is ephemeral, so all of them are unwrapped
 * here. An image is reported as well, even though it cannot be read: the
 * honest "that is a photograph, send me the file" belongs to the answer, not
 * to silence.
 */
function fileOf(message: WAMessage): { readonly fileName: string; readonly mimetype: string; readonly caption: string } | null {
  const m = message.message;
  if (!m) return null;
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m;
  const document = inner.documentMessage ?? inner.documentWithCaptionMessage?.message?.documentMessage ?? null;
  if (document) {
    return {
      fileName: document.fileName ?? 'file',
      mimetype: document.mimetype ?? '',
      caption: document.caption ?? inner.documentWithCaptionMessage?.message?.documentMessage?.caption ?? '',
    };
  }
  const image = inner.imageMessage ?? null;
  if (image) return { fileName: 'photo.jpg', mimetype: image.mimetype ?? 'image/jpeg', caption: image.caption ?? '' };
  return null;
}

/**
 * Who spoke, and where.
 *
 * In a direct chat the address *is* the person. In a group the address is the
 * group and the person is the participant beside it — which is the whole of
 * WA-5's safety: a question still runs as a named human being, never as "the
 * group", so their own permissions and scope decide what comes back.
 */
function senderOf(message: WAMessage, ownE164: string | null): { readonly e164: string | null; readonly groupJid: string | null } {
  const key = message.key;
  const jid = key.remoteJid ?? '';
  if (jid === 'status@broadcast') return { e164: null, groupJid: null };
  const groupJid = isGroupJid(jid) ? jid : null;

  /*
   * Whose words these are.
   *
   * `fromMe` means they were typed on the handset the bridge is paired to,
   * and that handset's number is the author — nothing else about the message
   * says so. In a direct chat `remoteJid` is the OTHER party, so reading the
   * author off it credits a question to the person it was sent to, and the
   * answer would then be worked out under their permissions and their branch
   * scope rather than the asker's. Seen in the log on the day
   * WA_ANSWER_SELF was added: a message typed on the bot's phone was logged
   * as coming from the number it was sent to.
   */
  if (key.fromMe) return { e164: ownE164, groupJid };

  if (groupJid) {
    const participant = key.participant ?? key.participantAlt ?? message.participant ?? null;
    const e164 =
      jidToE164(participant ? jidNormalizedUser(participant) : undefined) ??
      jidToE164(key.participantAlt ? jidNormalizedUser(key.participantAlt) : undefined);
    return { e164, groupJid };
  }
  const e164 =
    jidToE164(jidNormalizedUser(jid)) ?? jidToE164(key.remoteJidAlt ? jidNormalizedUser(key.remoteJidAlt) : undefined);
  return { e164, groupJid: null };
}

/**
 * The names WhatsApp shows the bridge, kept as they are shown (2026-10-04, by
 * direction: "fetch them from their name in WhatsApp").
 *
 * A contact as Baileys hands it over, whatever shape this version gives it:
 * the number may be the id itself, or — where WhatsApp addresses the person by
 * a hidden id — beside it. `name` is what the linked phone saved the number
 * as; `notify` is what the person called themselves.
 */
function noteContacts(contacts: ReadonlyArray<unknown>): void {
  const seen: { e164: string; saved?: string | null; profile?: string | null }[] = [];
  for (const raw of contacts) {
    const contact = (raw ?? {}) as Record<string, unknown>;
    const e164 = [contact.id, contact.jid, contact.phoneNumber]
      .filter((value): value is string => typeof value === 'string' && value.includes('@'))
      .map((value) => jidToE164(jidNormalizedUser(value)))
      .find((value): value is string => Boolean(value));
    if (!e164) continue;
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    seen.push({ e164, saved: text(contact.name), profile: text(contact.notify) ?? text(contact.verifiedName) });
  }
  try {
    const learned = rememberNames(seen);
    if (learned > 0) log(`names: ${learned} learned from WhatsApp`);
  } catch (error) {
    log(`names: could not be kept — ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The message somebody replied to, when they replied to one: its words, its author, and itself. */
function quotedOf(message: WAMessage): { readonly text: string; readonly author: string | null; readonly id: string | null; readonly message: NonNullable<WAMessage['message']> } | null {
  const m = message.message;
  if (!m) return null;
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m;
  const context =
    inner.extendedTextMessage?.contextInfo ??
    inner.imageMessage?.contextInfo ??
    inner.documentMessage?.contextInfo ??
    inner.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ??
    null;
  const quoted = context?.quotedMessage;
  if (!quoted) return null;
  const said = textOf({ key: message.key, message: quoted } as WAMessage) ?? fileOf({ key: message.key, message: quoted } as WAMessage)?.caption ?? '';
  return { text: said.trim(), author: context?.participant ?? null, id: context?.stanzaId ?? null, message: quoted };
}

async function handleInbound(
  scope: RequestScope,
  send: wa.Transport,
  router: ((text: string, locale: 'ar' | 'en') => Promise<import('../../src/server/domain/whatsapp').Intent>) | undefined,
  message: WAMessage,
  agentClient: AgentClient | undefined,
  ownE164: string | null,
  members: (groupJid: string) => Promise<readonly Member[]>,
  selfChat = false,
): Promise<void> {
  const { e164, groupJid } = senderOf(message, ownE164);
  const sentFile = fileOf(message);
  const typed = (textOf(message) ?? sentFile?.caption ?? '').trim();
  if (!e164 || (!typed && !sentFile)) return;

  /*
   * The one group, and nothing else — first, before anything is read, logged
   * or remembered (2026-10-04, by direction: "never reply to personal
   * messages … it's private, just for one group").
   *
   * The bridge is linked to a person's own WhatsApp account, so this handler
   * is handed everything that account receives and everything its owner types:
   * private chats, family groups. With `group_only` on, a message that is not
   * in the registered group ends here — no log row, no line in the log file,
   * no name kept — and until a group is registered nothing is heard at all.
   */
  const settings = await withScope(scope, (tx) => wa.settings(tx));
  // The owner's own chat with themselves is the one private chat he hears —
  // decided by the caller from the message's own address, never from its words.
  if (!selfChat && !listensTo(settings, groupJid)) {
    // Only with `group_only` off can this be another group, and that much may
    // be said; a private message under `group_only` leaves no trace.
    if (!settings.groupOnly && groupJid) log(`inbound from ${e164} in ${groupJid}: ignored (not the registered group)`);
    return;
  }

  // Who WhatsApp says this is — kept only for a number on the expected list,
  // so somebody named for the group can be put to their user by name.
  if (!message.key.fromMe && message.pushName) {
    try {
      rememberNames([{ e164, profile: message.pushName }]);
    } catch {
      /* a name that cannot be kept is not a reason to drop the message */
    }
  }

  /*
   * The trigger — by direction, 2026-10-04: "the AI must ONLY respond when a
   * WhatsApp message explicitly starts with `!ai`".
   *
   * The group is where the company talks; he is not one of the people talking.
   * A message that does not BEGIN with the trigger ends here: not read, not
   * logged, not answered, nothing inferred from it — whatever it says and
   * whoever said it. So does one that begins with it and carries `!dontwrite`
   * or `!ignore`: nothing is run for it and nothing is sent. Never add a
   * handler that reads a group message before this line.
   */
  const trigger = triggerOf(typed);
  if (trigger.kind !== 'ask') return;
  // Who is in the group — only now that somebody has called him there. A tag
  // arrives as "@" and WhatsApp's own digits for the person; it is read as
  // their name, so he knows who was meant and the log says it in words.
  const people = groupJid ? await members(groupJid).catch(() => [] as readonly Member[]) : [];
  // From here on the message is what was asked, the trigger taken off.
  const text = readTags(trigger.text, people).text;
  // The message they replied to, if they replied to one: they pointed him at
  // it on purpose, so he is shown it — its words, and its picture or file.
  const quoted = quotedOf(message);
  const quotedFile = !sentFile && quoted ? fileOf({ key: message.key, message: quoted.message } as WAMessage) : null;
  const attached = sentFile ?? quotedFile;
  const source: WAMessage =
    sentFile || !quoted
      ? message
      : ({ key: { remoteJid: message.key.remoteJid, id: quoted.id, fromMe: false, ...(quoted.author ? { participant: quoted.author } : {}) }, message: quoted.message } as WAMessage);
  // What the log records as the message. A file sent without a word would
  // otherwise be an empty row, which reads as though nothing was said.
  const body = text || (sentFile ? `[${sentFile.fileName}]` : AI_TRIGGER);

  // Its own voice, heard back. Every answer the bridge sends is recorded with
  // the id WhatsApp gave it, so an id already in the log as outbound is the
  // bot listening to itself — the one thing that must never start a round.
  if (message.key.fromMe) {
    if (message.key.id && ownSends.has(message.key.id)) return;
    const mine = await withScope(scope, (tx) => wa.sentByBridge(tx, message.key.id ?? null));
    if (mine) return;
    log(`inbound from ${e164}: typed on the bot's own phone, answering it`);
  }

  // 1. Who is this, and may they ask? Logged either way; silence otherwise.
  const { inboundId, sender, allowed } = await withScope(scope, async (tx) => {
    const sender = await wa.resolveNumber(tx, e164);
    const inboundId = await wa.recordInbound(tx, { e164, body, waMessageId: message.key.id ?? null, sender, groupJid });
    const allowed = wa.mayAsk(sender);
    if (!allowed.ok) {
      await wa.finishInbound(tx, inboundId, { status: 'refused', intent: 'none', detail: { reason: allowed.reason } });
      await audit.record(tx, {
        actorUserId: sender?.userId ?? null,
        action: 'whatsapp.refused',
        objectType: 'whatsapp_message',
        objectId: inboundId.toString(),
        branchCode: null,
        outcome: 'denied',
        after: { e164, reason: allowed.reason, length: text.length },
      });
    }
    return { inboundId, sender, allowed };
  });
  if (!allowed.ok || !sender) {
    log(`inbound from ${e164}${message.pushName ? ` (${message.pushName})` : ''}: refused (${allowed.ok ? 'no sender' : allowed.reason})`);
    /*
     * They called him by name, in the company's own group, so silence would
     * read as a broken bot. One line saying why — never anything from the
     * books — and not again for six hours, so it cannot be made to chatter.
     */
    const last = toldNotSetUp.get(e164) ?? 0;
    if (groupJid && Date.now() - last > 6 * 60 * 60_000) {
      toldNotSetUp.set(e164, Date.now());
      const line =
        detectLocale(text) === 'ar'
          ? 'هذا الرقم غير مربوط بمستخدم في النظام بعد، لذلك لا أستطيع الإجابة. يضيفه مدير النظام من: الإعدادات ← الإدارة ← واتساب.'
          : 'This number is not linked to a user of the ERP yet, so I cannot answer it. An administrator adds it on Settings → Administration → WhatsApp.';
      await send({ e164, groupJid }, { text: line }).catch(() => {
        /* a courtesy that fails is not worth a retry */
      });
    }
    return;
  }

  const locale = detectLocale(text);

  // The trigger and nothing after it: say how it is used, once, in both languages.
  if (!text && !sentFile && !quoted) {
    await answerWith(scope, send, {
      sender,
      e164,
      groupJid,
      inboundId,
      text: `اكتب سؤالك بعد ${AI_TRIGGER} — مثلاً: ${AI_TRIGGER} شلون أضيف مورد جديد؟\nWrite your question after ${AI_TRIGGER} — for example: ${AI_TRIGGER} how do I add a supplier?`,
      intent: 'hint',
    });
    return;
  }

  /*
   * 2. WA-8 — a yes, to something he asked about.
   *
   * Read before anything else, and only a plain yes counts: a sentence that
   * merely contains the word is a new question. Anything that is not a yes
   * drops the proposal, because a person who answers something else has
   * moved on, and a stale intention must not sit there waiting for a later
   * "ok" that belonged to a different question entirely.
   */
  const waitingAction = proposals.get(sender.userId);
  if (waitingAction) {
    if (expired(waitingAction)) {
      proposals.delete(sender.userId);
      log(`inbound from ${e164}: a proposal for ${waitingAction.target.documentNo} had gone stale`);
    } else if (isConfirmation(text)) {
      proposals.delete(sender.userId);
      log(`inbound from ${e164}: confirmed ${waitingAction.action} on ${waitingAction.target.documentNo}`);
      const outcome = await doService.run({ userId: sender.userId, pending: waitingAction, e164 });
      const said = outcome.ok
        ? outcome.said
        : locale === 'ar'
          ? `ما تمت العملية. النظام رفضها: ${outcome.reason}`
          : `It did not go through — the system refused it: ${outcome.reason}`;
      await answerWith(scope, send, {
        sender,
        e164,
        groupJid,
        inboundId,
        text: said,
        intent: `action.${waitingAction.action}`,
        ...(outcome.ok ? {} : { status: 'refused' as const }),
      });
      return;
    } else if (isRefusal(text)) {
      proposals.delete(sender.userId);
      log(`inbound from ${e164}: declined ${waitingAction.action} on ${waitingAction.target.documentNo}`);
      await answerWith(scope, send, {
        sender,
        e164,
        groupJid,
        inboundId,
        text: locale === 'ar' ? 'تمام، ما سويت شي.' : 'Alright — I have left it alone.',
        intent: 'action.declined',
      });
      return;
    } else {
      proposals.delete(sender.userId);
      log(`inbound from ${e164}: a proposal for ${waitingAction.target.documentNo} was dropped (they said something else)`);
    }
  }

  // 3. WA-6 — a decision command, read by shape. The agent never sees these
  // and never decides anything: an approval is four locks, not a sentence.
  const command = parseCommand(text);
  if (command.kind !== 'none') {
    await handleCommand(scope, send, { sender, e164, groupJid, inboundId, locale, command });
    return;
  }

  // 4. The answer, as the asker, read-only. With a key the agent answers: it
  // reads the question itself and reaches for whichever tools it needs, with
  // the last few turns of this chat for context. The catalogue's phrases are
  // the fallback when there is no key.
  /*
   * WA-7 — a file sent to the group, read before the question is answered.
   *
   * Downloaded here and read into text, so that by the time Noah is asked
   * about it he already has it. Reading it is allowed to fail: the file comes
   * back with a note saying why, which is a perfectly good thing for a
   * colleague to say, and far better than an exception in the middle of a
   * conversation.
   */
  const chat = groupJid ?? e164;
  const pictures: AskedPicture[] = [];
  if (attached) {
    try {
      const buffer = (await downloadMediaMessage(
        source,
        'buffer',
        {},
        { logger: silent as never, reuploadRequest: reupload ?? (async (m: WAMessage) => m) },
      )) as Buffer;
      if (buffer.length > FILE_BYTES_CAP) {
        rememberFile(chat, {
          fileName: attached.fileName,
          kind: 'other',
          mimetype: attached.mimetype,
          bytes: buffer.length,
          caption: attached.caption,
          text: '',
          note: `this file is ${Math.round(buffer.length / 1_000_000)} MB, too large for me to read here`,
          sheets: [],
          at: new Date().toISOString(),
        });
      } else {
        // A picture is shown to him as a picture, beside the question.
        const type = attached.mimetype.split(';')[0]!.trim().toLowerCase();
        if (PICTURE_TYPES.includes(type) && buffer.length <= PICTURE_BYTES_CAP && pictures.length === 0) {
          pictures.push({ mediaType: type as AskedPicture['mediaType'], base64: buffer.toString('base64') });
        }
        const read = await extractSentFile({
          buffer,
          fileName: attached.fileName,
          mimetype: attached.mimetype,
          caption: attached.caption,
        });
        rememberFile(chat, read);
        log(
          `inbound from ${e164}: file ${read.fileName} (${read.kind}, ${read.bytes} bytes)${read.note ? ` — ${read.note}` : `, ${read.text.length} chars read`}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`inbound from ${e164}: file ${attached.fileName} could not be downloaded — ${detail}`);
      rememberFile(chat, {
        fileName: attached.fileName,
        kind: 'other',
        mimetype: attached.mimetype,
        bytes: 0,
        caption: attached.caption,
        text: '',
        note: `it could not be downloaded from WhatsApp (${detail.slice(0, 120)})`,
        sheets: [],
        at: new Date().toISOString(),
      });
    }
  }
  const files = recentFiles.get(chat) ?? [];
  // The question as a person would have put it: what they typed, with the
  // file named in it — or, for a file sent with no words, one written for
  // them, because somebody putting a workbook in the group means "look".
  let asked = attached && pictures.length === 0 ? questionForFiles(text, files.slice(0, 1)) : text;
  if (pictures.length > 0) {
    // A picture he can look at: no "its contents are in a tool" — it is in front of him.
    asked = `${text || 'Look at this picture: say what it shows and what should be done about it.'}\n\n[A picture is attached to this message${quotedFile ? ', from the message they replied to' : ''}: look at it and read exactly what is written in it.]`;
  }
  if (quoted && quoted.text) {
    const author = quoted.author ? people.find((member) => member.jids.includes(quoted.author!.replace(/:\d+@/, '@'))) : null;
    asked = `[They are replying to this message from ${author?.name ?? 'somebody in the group'}:\n«${readTags(quoted.text, people).text.slice(0, 2000)}»]\n\n${asked || 'Explain this.'}`;
  }

  const history = await withScope(scope, (tx) => wa.recentTurns(tx, { groupJid, e164 }));

  /*
   * While he reads: a word, not silence.
   *
   * By direction (2026-10-02). Only if the answer is actually slow — a
   * greeting or a one-line explanation comes straight back and saying "let
   * me check" about it would be theatre. Six seconds is the line between
   * answering and going to look.
   *
   * Not recorded as an answer: it carries no figure and no data from the
   * books, which is what W-R4 exists to keep a record of.
   */
  let checked = false;
  const checking = setTimeout(() => {
    checked = true;
    void send({ e164, ...(groupJid ? { groupJid } : {}) }, { text: checkingLine(locale), quote: false }).catch(() => {
      /* a courtesy that fails is not the answer failing */
    });
  }, 6_000);

  let reply: wa.Reply;
  try {
    reply = await wa.answer({
      userId: sender.userId,
      text: asked,
      settings,
      locale,
      ...(router ? { router } : {}),
      ...(agentClient
        ? {
            agent: (ctx, question, userName) =>
              runAgentFor({
                client: agentClient,
                model: AGENT_MODEL_OVERRIDE ?? settings.agentModel,
                ctx,
                question,
                history,
                userName,
                files,
                chat,
                ...(pictures.length > 0 ? { pictures } : {}),
                ...(people.length > 0 ? { people: rosterForPrompt(people, { e164 }) } : {}),
                // WA-8 — the capability IS the hook: a contact who may not
                // act is given nowhere to put a proposal, and the tool says
                // so rather than appearing to work.
                ...(sender.allowActions
                  ? {
                      actions: {
                        chat,
                        propose: (pending: PendingAction) => {
                          proposals.set(sender.userId, pending);
                        },
                      },
                    }
                  : {}),
              }),
          }
        : {}),
    });
  } catch (error) {
    clearTimeout(checking);
    const detail = error instanceof Error ? error.message : String(error);
    log(`inbound from ${e164}: failed — ${detail}`);
    await withScope(scope, (tx) => wa.finishInbound(tx, inboundId, { status: 'failed', intent: null, errorMessage: detail }));
    try {
      // Where the question was asked — the group, when it was asked there.
      await send({ e164, ...(groupJid ? { groupJid } : {}) }, { text: words(locale).error });
    } catch {
      /* the failure is on the record; the apology may fail too */
    }
    return;
  }

  clearTimeout(checking);

  // 4. Send, then record what was sent (W-R4). Asked in the group, answered
  // in the group — the attachment with it, so the PDF lands where the
  // question was asked.
  const outId = await withScope(scope, (tx) =>
    wa.recordOutbound(tx, {
      e164,
      groupJid,
      body: reply.text,
      sender,
      attachment: reply.attachment ? { name: reply.attachment.fileName, type: reply.attachment.contentType, bytes: reply.attachment.body.length } : null,
      inReplyTo: inboundId,
      intent: reply.intent.kind,
      detail: reply.detail,
    }),
  );
  try {
    let waMessageId: string | null = null;
    if (reply.images.length === 0) {
      ({ waMessageId } = await send({ e164, groupJid }, { text: reply.text, attachment: reply.attachment }));
    } else {
      /*
       * A walk-through: step, picture, step, picture — each picture sent with
       * the words of its own step under it, in the order he placed them. The
       * whole answer is the one row recorded above; each picture is a row of
       * its own. A picture that fails to send does not undo the answer; words
       * that fail do.
       */
      for (const part of reply.parts) {
        if (!part.image) {
          const sent = await send({ e164, groupJid }, { text: part.text });
          waMessageId ??= sent.waMessageId;
          continue;
        }
        const picture = part.image;
        const pictureId = await withScope(scope, (tx) =>
          wa.recordOutbound(tx, {
            e164,
            groupJid,
            body: part.text,
            sender,
            attachment: { name: picture.fileName, type: picture.contentType, bytes: picture.body.length },
            inReplyTo: inboundId,
            intent: 'picture',
          }),
        );
        try {
          const sent = await send({ e164, groupJid }, { text: part.text, attachment: picture });
          waMessageId ??= sent.waMessageId;
          await withScope(scope, (tx) => wa.markOutbound(tx, pictureId, { status: 'sent', waMessageId: sent.waMessageId }));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await withScope(scope, (tx) => wa.markOutbound(tx, pictureId, { status: 'failed', errorMessage: detail }));
          log(`inbound from ${e164}: picture ${picture.fileName} — send failed: ${detail}`);
          // The step's words still go, without their picture.
          const sent = await send({ e164, groupJid }, { text: part.text });
          waMessageId ??= sent.waMessageId;
        }
      }
      if (reply.attachment) {
        const sent = await send({ e164, groupJid }, { text: reply.attachment.fileName, attachment: reply.attachment });
        waMessageId ??= sent.waMessageId;
      }
    }
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'sent', waMessageId });
      await wa.finishInbound(tx, inboundId, { status: 'answered', intent: reply.intent.kind, detail: reply.detail });
      await wa.auditAnswer(tx, reply, { inboundId, question: text });
    });
    log(
      `inbound from ${e164}: ${reply.intent.kind} answered${reply.attachment ? ` + ${reply.attachment.fileName}` : ''}${reply.images.length > 0 ? ` + ${reply.images.length} picture(s)` : ''}${checked ? ' (said he was checking first)' : ''}`,
    );
    // What he did to get there, for whoever reads this log to improve him: the
    // look-ups in order with their time, and what a refused one said. Never
    // the question or the answer — those are in the message log, under its
    // own retention.
    const trace = (reply.detail.trace as ReadonlyArray<{ tool: string; ms: number; ok: boolean; said?: string }> | undefined) ?? [];
    if (trace.length > 0) {
      log(`inbound from ${e164}: ${trace.map((step) => `${step.tool} ${step.ok ? '' : 'REFUSED '}${Math.round(step.ms)}ms`).join(' → ')}`);
      for (const step of trace.filter((one) => !one.ok)) log(`inbound from ${e164}: ${step.tool} was refused — ${(step.said ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'failed', errorMessage: detail });
      await wa.finishInbound(tx, inboundId, { status: 'failed', intent: reply.intent.kind, errorMessage: detail });
    });
    log(`inbound from ${e164}: ${reply.intent.kind} — send failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// WA-6 — the decision commands
// ---------------------------------------------------------------------------

/**
 * `pending`, `approve`, `reject`, `confirm`.
 *
 * Everything here is deliberate and narrow. The reply goes back where the
 * command was given, the outcome is logged against the inbound message, and
 * nothing is decided until a code comes back from the same contact. A refusal
 * is a sentence the person can act on, not silence: they are allow-listed, so
 * telling them *why* costs nothing and saves a phone call.
 */
/**
 * Says something back, and keeps the record of having said it (W-R4).
 *
 * The record-send-mark dance is the same for every kind of answer, and the
 * failure half of it is the part worth having once: a message that failed to
 * send must leave the outbound row marked failed and the question marked
 * failed, or the log quietly claims an answer nobody received.
 */
async function answerWith(
  scope: RequestScope,
  send: wa.Transport,
  input: {
    readonly sender: wa.ResolvedSender;
    readonly e164: string;
    readonly groupJid: string | null;
    readonly inboundId: bigint;
    readonly text: string;
    readonly intent: string;
    readonly status?: 'answered' | 'refused';
  },
): Promise<void> {
  const { sender, e164, groupJid, inboundId, text, intent } = input;
  const outId = await withScope(scope, (tx) =>
    wa.recordOutbound(tx, { e164, groupJid, body: text, sender, inReplyTo: inboundId, intent }),
  );
  try {
    const { waMessageId } = await send({ e164, groupJid }, { text });
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'sent', waMessageId });
      await wa.finishInbound(tx, inboundId, { status: input.status ?? 'answered', intent });
    });
    log(`inbound from ${e164}: ${intent} ${input.status ?? 'answered'}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'failed', errorMessage: detail });
      await wa.finishInbound(tx, inboundId, { status: 'failed', intent, errorMessage: detail });
    });
    log(`inbound from ${e164}: ${intent} — send failed: ${detail}`);
  }
}

async function handleCommand(
  scope: RequestScope,
  send: wa.Transport,
  input: {
    sender: wa.ResolvedSender;
    e164: string;
    groupJid: string | null;
    inboundId: bigint;
    locale: 'ar' | 'en';
    command: Exclude<ReturnType<typeof parseCommand>, { kind: 'none' }>;
  },
): Promise<void> {
  const { sender, e164, groupJid, inboundId, locale, command } = input;
  const ar = locale === 'ar';
  const L = (en: string, arabic: string) => (ar ? arabic : en);

  let text: string;
  let status: 'answered' | 'refused' = 'answered';
  try {
    if (command.kind === 'pending') {
      const waiting = await actions.waitingFor(sender.userId);
      text =
        waiting.length === 0
          ? L('Nothing is waiting for your approval.', 'لا يوجد شيء بانتظار موافقتك.')
          : [
              L(`Waiting for you (${waiting.length}):`, `بانتظار موافقتك (${waiting.length}):`),
              ...waiting.slice(0, 15).map((row) => `• *${row.documentNumber}* — ${row.documentType} · ${row.submittedByName ?? ''}`),
              '',
              L(`Reply: ${AI_TRIGGER} approve <number>  ·  ${AI_TRIGGER} reject <number> <reason>`, `أرسل: ${AI_TRIGGER} موافقة <الرقم>  ·  ${AI_TRIGGER} رفض <الرقم> <السبب>`),
            ].join('\n');
    } else if (command.kind === 'confirm') {
      const done = await withScope(scope, (tx) => actions.confirm(tx, { sender, code: command.code }));
      if (!done.ok) {
        status = 'refused';
        text = L(`Refused: ${done.reason}`, `مرفوض: ${done.reason}`);
      } else {
        text =
          done.decision === 'approve'
            ? L(`Approved ${done.documentNo}.`, `تمت الموافقة على ${done.documentNo}.`)
            : L(`Rejected ${done.documentNo}.`, `تم رفض ${done.documentNo}.`);
      }
    } else {
      const asked = await withScope(scope, (tx) =>
        actions.request(tx, {
          sender,
          groupJid,
          decision: command.kind,
          documentNo: command.documentNo,
          reason: command.kind === 'reject' ? command.reason : null,
        }),
      );
      if (!asked.ok) {
        status = 'refused';
        text = L(`Refused: ${asked.reason}`, `مرفوض: ${asked.reason}`);
      } else {
        const what =
          command.kind === 'approve'
            ? L(`Approve *${asked.waiting.documentNumber}*?`, `الموافقة على *${asked.waiting.documentNumber}*؟`)
            : L(`Reject *${asked.waiting.documentNumber}*?`, `رفض *${asked.waiting.documentNumber}*؟`);
        text = [
          what,
          `${asked.waiting.documentType} · ${asked.waiting.submittedByName ?? ''}`,
          '',
          L(`Reply:  ${AI_TRIGGER} confirm ${asked.code}`, `أرسل:  ${AI_TRIGGER} تأكيد ${asked.code}`),
          L(`The code is good for ${actions.CODE_MINUTES} minutes.`, `الرمز صالح لمدة ${actions.CODE_MINUTES} دقيقة.`),
        ].join('\n');
      }
    }
  } catch (error) {
    status = 'refused';
    const why = error instanceof Error ? error.message : String(error);
    text = L(`Refused: ${why}`, `مرفوض: ${why}`);
  }

  const outId = await withScope(scope, (tx) =>
    wa.recordOutbound(tx, { e164, groupJid, body: text, sender, inReplyTo: inboundId, intent: `command.${command.kind}` }),
  );
  try {
    const { waMessageId } = await send({ e164, groupJid }, { text });
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'sent', waMessageId });
      await wa.finishInbound(tx, inboundId, { status, intent: `command.${command.kind}` });
    });
    log(`inbound from ${e164}: command.${command.kind} ${status}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'failed', errorMessage: detail });
      await wa.finishInbound(tx, inboundId, { status: 'failed', intent: `command.${command.kind}`, errorMessage: detail });
    });
    log(`inbound from ${e164}: command.${command.kind} — send failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// The morning digest (WA-4): today's summary to every opted-in CEO contact,
// once a day, at the digest hour or as soon after it as the bridge is up.
// ---------------------------------------------------------------------------

async function sendDigest(scope: RequestScope, send: wa.Transport, settings: Awaited<ReturnType<typeof wa.settings>>): Promise<void> {
  // In group-only mode nothing is said unasked, and a digest nobody asked for
  // is exactly that. "!ai today's summary" gives the same figures on request.
  if (settings.groupOnly) return;
  const lastSentDay = await withScope(scope, (tx) => wa.digestLastSentDay(tx));
  const { due, day } = digestDue({ digestHour: settings.digestHour, lastSentDay, at: new Date() });
  if (!due) return;
  // Marked first: a digest that fails to send is retried tomorrow, not every poll.
  await withScope(scope, (tx) => wa.markDigestSent(tx, day));
  const recipients = await withScope(scope, (tx) => wa.digestRecipients(tx));
  // Group only (2026-10-04): with `group_only` on, the digest is the group's
  // one copy and nobody is written to on their own.
  const groupOnly = settings.groupOnly;
  for (const recipient of groupOnly ? [] : recipients) {
    try {
      const reply = await wa.answer({ userId: recipient.userId, text: 'summary', settings, locale: settings.digestLocale });
      const outId = await withScope(scope, (tx) => wa.recordOutbound(tx, { e164: recipient.e164, body: reply.text, sender: recipient, intent: 'digest', detail: reply.detail }));
      try {
        const { waMessageId } = await send({ e164: recipient.e164 }, { text: reply.text });
        await withScope(scope, (tx) => wa.markOutbound(tx, outId, { status: 'sent', waMessageId }));
      } catch (error) {
        await withScope(scope, (tx) => wa.markOutbound(tx, outId, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) }));
      }
    } catch (error) {
      log(`digest for ${recipient.e164} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // WA-5 — and once to the group, written for whoever opens it there. The
  // figures are read as the first opted-in contact, so the digest is somebody's
  // own view of the books and not a wider one: a group reply must never show
  // more than the person it was computed for may see.
  if (settings.groupJid && settings.groupDigest && recipients.length > 0) {
    const author = recipients[0]!;
    try {
      const reply = await wa.answer({ userId: author.userId, text: 'summary', settings, locale: settings.digestLocale });
      const outId = await withScope(scope, (tx) =>
        wa.recordOutbound(tx, { e164: author.e164, groupJid: settings.groupJid, body: reply.text, sender: author, intent: 'digest.group', detail: reply.detail }),
      );
      try {
        const { waMessageId } = await send({ e164: author.e164, groupJid: settings.groupJid }, { text: reply.text });
        await withScope(scope, (tx) => wa.markOutbound(tx, outId, { status: 'sent', waMessageId }));
        log(`digest for ${day}: posted to the group`);
      } catch (error) {
        await withScope(scope, (tx) => wa.markOutbound(tx, outId, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) }));
      }
    } catch (error) {
      log(`group digest failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`digest for ${day}: ${recipients.length} recipient(s)`);
}

/**
 * `--list-groups` — every group the bot has been added to, with its id.
 *
 * The one step that cannot be done from the screen: WhatsApp does not tell
 * the ERP what groups exist until the bot is in them. Run this once after
 * adding the bot to the group, copy the id, and register it in
 * Administration → WhatsApp. Nothing is written by this.
 */
async function listGroups(socket: WASocket): Promise<void> {
  const all = await socket.groupFetchAllParticipating();
  // The account is a person's own, so its other groups are nobody's business
  // here: name the group (`--list-groups "ERP trial"`) and only it is shown.
  const wanted = (process.argv[process.argv.indexOf('--list-groups') + 1] ?? '').trim().toLowerCase();
  const named = wanted && !wanted.startsWith('--') ? wanted : '';
  const rows = Object.values(all).filter((group) => !named || (group.subject ?? '').toLowerCase().includes(named));
  if (named && rows.length === 0) {
    log(`no group whose name contains "${named}" (the account is in ${Object.keys(all).length} group(s))`);
    return;
  }
  if (rows.length === 0) {
    log('the bot is in no groups yet — add it to the group, then run this again');
    return;
  }
  log(`${rows.length} group(s):`);
  const book = knownNames();
  for (const group of rows) {
    console.log(`  ${group.id}   ${group.subject}   (${group.participants?.length ?? 0} members)`);
    for (const raw of group.participants ?? []) {
      const member = raw as unknown as Record<string, unknown>;
      const e164 = [member.id, member.phoneNumber, member.jid]
        .filter((value): value is string => typeof value === 'string' && value.includes('@'))
        .map((value) => jidToE164(jidNormalizedUser(value)))
        .find((value): value is string => Boolean(value));
      const shown = typeof member.notify === 'string' ? member.notify : typeof member.name === 'string' ? member.name : null;
      console.log(`      ${e164 ?? String(member.id ?? '?')}   ${(e164 ? nameOf(book, e164) : null) ?? shown ?? ''}`);
    }
  }
  console.log('\nRegister the one you want in Administration → WhatsApp → the group id field.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scope = await runner.systemScope();

  if (RESET) {
    const removed = await withScope(scope, async (tx) => {
      const rows = (await tx.execute(`delete from whatsapp_session returning key` as never)).rows;
      return rows.length;
    });
    log(`pairing reset: ${removed} session rows removed. Start the bridge and scan the new QR code.`);
    await pool.end();
    return;
  }

  let settings = await withScope(scope, (tx) => wa.settings(tx));
  const routerClient = await anthropicClient(process.env.ANTHROPIC_API_KEY);
  const routerModel = process.env.WA_ROUTER_MODEL?.trim() || settings.routerModel;
  const agentModel = AGENT_MODEL_OVERRIDE ?? settings.agentModel;
  const router = routerClient ? modelRouter(routerClient, routerModel) : undefined;
  /*
   * WA-3 — which brain, and is it there?
   *
   * Two transports, the same loop and the same nineteen tools behind both:
   *
   *   api  an ANTHROPIC_API_KEY, billed per token, no session limits;
   *   cli  `claude -p` on this host, spending the company's own Claude
   *        subscription — by direction, 2026-10-02.
   *
   * WA_BRAIN names one; with neither named, a key means the API and no key
   * means the CLI. A brain that is not ready is reported here, once, with
   * what to do about it — and the bridge carries on with the phrase patterns
   * rather than answering every question with an apology.
   */
  const wanted = (process.env.WA_BRAIN ?? '').trim().toLowerCase();
  const useCli = wanted === 'cli' || (wanted !== 'api' && !process.env.ANTHROPIC_API_KEY);
  let agent: AgentClient | null = null;
  if (useCli) {
    const cliOptions = {
      ...(process.env.WA_CLI_COMMAND ? { command: process.env.WA_CLI_COMMAND } : {}),
      // Opus thinking hard about three reports is not a ten-second errand.
      timeoutSeconds: Math.max(30, Number(process.env.WA_CLI_TIMEOUT_SECONDS ?? '240')),
      effort,
    };
    const ready = await cliReady(cliOptions);
    if (ready.ok) agent = cliAgentClient(cliOptions);
    else log(`brain: the claude CLI is not usable — ${ready.reason}`);
  } else {
    agent = await agentClientFor(process.env.ANTHROPIC_API_KEY);
  }
  log(
    `brain: ${
      agent
        ? `agent on ${agentModel} via ${useCli ? `the claude CLI (subscription, effort ${effort})` : 'the API'}`
        : router
          ? `router ${routerModel} only`
          : 'phrase patterns only'
    }; poll every ${POLL_SECONDS}s`,
  );

  let socket: WASocket | null = null;
  /**
   * Is the link to WhatsApp actually open? A socket exists from the first
   * attempt, paired or not — while it shows a QR code it is not a connection.
   * The minute's heartbeat used to say "connected" whenever a socket existed,
   * so the Bridge window read Connected on an install nobody had paired, and
   * the outbox was run against a socket that could send nothing (2026-10-04).
   */
  let linked = false;
  let stopping = false;
  const send = transportFor(() => socket, () => settings);
  wa.registerWhatsappSender(send);

  // The one group's members, read from WhatsApp when somebody calls him there.
  const members = async (groupJid: string): Promise<readonly Member[]> => {
    if (roster && roster.jid === groupJid && Date.now() - roster.at < ROSTER_MINUTES * 60_000) return roster.members;
    if (!socket || groupJid !== settings.groupJid) return roster?.jid === groupJid ? roster.members : [];
    const meta = await socket.groupMetadata(groupJid);
    const users = await withScope(scope, (tx) => wa.contactPeople(tx));
    const book = knownNames();
    const names = new Map<string, string>();
    for (const e164 of Object.keys(book)) {
      const name = nameOf(book, e164);
      if (name) names.set(e164, name);
    }
    roster = { at: Date.now(), jid: groupJid, members: rosterFrom((meta.participants ?? []) as unknown as Participant[], { users, names }) };
    return roster.members;
  };

  const heartbeat = (state: string) =>
    withScope(scope, (tx) => wa.heartbeat(tx, { state, me: socket?.user?.id ? jidToE164(jidNormalizedUser(socket.user.id)) : null })).catch((e) => log(`heartbeat failed: ${e}`));

  const connect = async (): Promise<void> => {
    const { state, saveCreds } = await databaseAuthState(scope);
    log(state.creds.me ? `pairing found for ${state.creds.me.id}; connecting…` : 'no pairing yet; connecting to get a QR code…');
    await heartbeat('connecting');
    const { version } = await Promise.race([
      fetchLatestBaileysVersion().catch(() => ({ version: undefined })),
      new Promise<{ version: undefined }>((resolve) => setTimeout(() => resolve({ version: undefined }), 8000)),
    ]);
    socket = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silent) },
      logger: silent,
      browser: Browsers.ubuntu('QS ERP'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    // WA-7 — only the connected socket can ask WhatsApp to put an expired
    // file back on its servers, and the handler that downloads one does not
    // own the socket.
    reupload = socket.updateMediaMessage.bind(socket);

    socket.ev.on('creds.update', () => {
      saveCreds().catch((e) => log(`saving credentials failed: ${e}`));
    });

    // The contact list comes with the link, and again whenever a name changes.
    socket.ev.on('contacts.upsert', (contacts) => noteContacts(contacts));
    socket.ev.on('contacts.update', (updates) => noteContacts(updates));
    socket.ev.on('messaging-history.set', (history) => noteContacts(history.contacts ?? []));

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        log('scan this QR code with the company phone (WhatsApp → Linked devices → Link a device):');
        qrcode.generate(qr, { small: true });
        linked = false;
        void heartbeat('waiting for QR scan');
      }
      if (connection === 'connecting') log('socket connecting…');
      if (connection === 'open') {
        log(`connected as ${socket?.user?.id ?? '?'}`);
        linked = true;
        void heartbeat('connected');
        // Nothing is said on connect (2026-10-04, by direction: he speaks only
        // when a message begins with the trigger). It used to post a greeting
        // here; a bridge that restarts is not news to the people in the group.
        // `--list-groups` is a question, not a service: it answers and leaves.
        if (LIST_GROUPS && socket) {
          const live = socket;
          void listGroups(live)
            .catch((error) => log(`listing groups failed: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => {
              // The socket first, then a breath for its last credentials
              // write, then the pool. Closing the pool while Baileys was
              // still saving produced "Cannot use a pool after calling end".
              stopping = true;
              try {
                live.end(undefined);
              } catch {
                /* already gone */
              }
              setTimeout(() => void pool.end().finally(() => process.exit(0)), 1500);
            });
        }
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        log(`connection closed (${code ?? 'no code'})${loggedOut ? ' — logged out; run with --reset-pairing and scan again' : ', reconnecting in 5s'}`);
        linked = false;
        void heartbeat(loggedOut ? 'logged out' : 'reconnecting');
        socket = null;
        if (!loggedOut && !stopping) setTimeout(() => connect().catch((e) => log(`reconnect failed: ${e}`)), 5000);
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        if (message.key.fromMe && !ANSWER_SELF) continue;
        const ownE164 = socket?.user?.id ? jidToE164(jidNormalizedUser(socket.user.id)) : null;
        // Inside `called` — `handleInbound` returns before it reads anything
        // unless the message begins with the trigger, so what it sends is
        // always an answer to somebody who called.
        const ownJids = [socket?.user?.id, (socket?.user as { lid?: string } | undefined)?.lid]
          .filter((value): value is string => typeof value === 'string' && value !== '')
          .map((value) => jidNormalizedUser(value));
        const selfChat = isSelfChat({ enabled: SELF_CHAT, fromMe: message.key.fromMe, remoteJid: message.key.remoteJid, ownJids });
        called
          .run({ quoted: message, used: false, self: selfChat }, () => handleInbound(scope, send, router, message, agent ?? undefined, ownE164, members, selfChat))
          .catch((e) => log(`inbound handling failed: ${e}`));
      }
    });
  };

  await connect();

  // The outbox: the whatsapp channel, every POLL_SECONDS while connected.
  let lastRedaction = 0;
  const tick = async () => {
    if (stopping) return;
    try {
      settings = await withScope(scope, (tx) => wa.settings(tx));
      if (socket && linked) {
        const result = await runner.runOnce(scope, { channels: ['whatsapp'] });
        const r = result.channels.whatsapp;
        if (result.dispatched || (r && (r.sent || r.failed || r.suppressed))) log(runner.describe(result));
      }
      if (socket && linked) await sendDigest(scope, send, settings);
      if (Date.now() - lastRedaction > 3_600_000) {
        lastRedaction = Date.now();
        const blanked = await withScope(scope, (tx) => wa.redactExpired(tx, settings.retentionDays));
        if (blanked) log(`retention: ${blanked} message bodies blanked after ${settings.retentionDays} days`);
      }
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const poll = setInterval(() => void tick(), POLL_SECONDS * 1000);
  const beat = setInterval(() => void heartbeat(linked ? 'connected' : socket ? 'waiting for QR scan' : 'disconnected'), 60_000);
  await tick();

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    clearInterval(beat);
    log('stopping');
    await heartbeat('stopped');
    try {
      socket?.end(undefined);
    } catch {
      /* already closed */
    }
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(2);
});
