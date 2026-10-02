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
 * WA_ROUTER_MODEL overrides the model in the settings table.
 */
import 'dotenv/config';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
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
import qrcode from 'qrcode-terminal';
import { pool, withScope, type RequestScope } from '../../src/server/db/client';
import { detectLocale, digestDue, e164ToJid, helpText, isGroupJid, jidToE164, parseCommand, words } from '../../src/server/domain/whatsapp';
import * as audit from '../../src/server/services/audit';
import * as runner from '../../src/server/services/notification-runner';
import * as wa from '../../src/server/services/whatsapp';
import * as actions from '../../src/server/services/whatsapp-actions';
import { agentClientFor, anthropicClient, modelRouter } from '../../src/server/services/whatsapp-router';
import { runAgentFor, type AgentClient } from '../../src/server/services/whatsapp-agent';

const POLL_SECONDS = Math.max(5, Number(process.env.WA_POLL_SECONDS ?? '20'));
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

function transportFor(sock: () => WASocket | null, perMinute: () => number): wa.Transport {
  return async (to, message) => {
    const socket = sock();
    if (!socket) throw new Error('the bridge is not connected to WhatsApp');
    await paced(perMinute());
    // WA-5 — a group id addresses the group; otherwise the person's number.
    const jid = to.groupJid && isGroupJid(to.groupJid) ? to.groupJid : e164ToJid(to.e164);
    let sent: WAMessage | undefined;
    if (message.attachment) {
      sent = await socket.sendMessage(jid, {
        document: message.attachment.body,
        mimetype: message.attachment.contentType,
        fileName: message.attachment.fileName,
        caption: message.text,
      });
    } else {
      sent = await socket.sendMessage(jid, { text: message.text });
    }
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

/**
 * Who spoke, and where.
 *
 * In a direct chat the address *is* the person. In a group the address is the
 * group and the person is the participant beside it — which is the whole of
 * WA-5's safety: a question still runs as a named human being, never as "the
 * group", so their own permissions and scope decide what comes back.
 */
function senderOf(message: WAMessage): { readonly e164: string | null; readonly groupJid: string | null } {
  const key = message.key;
  const jid = key.remoteJid ?? '';
  if (jid === 'status@broadcast') return { e164: null, groupJid: null };
  if (isGroupJid(jid)) {
    const participant = key.participant ?? key.participantAlt ?? message.participant ?? null;
    const e164 =
      jidToE164(participant ? jidNormalizedUser(participant) : undefined) ??
      jidToE164(key.participantAlt ? jidNormalizedUser(key.participantAlt) : undefined);
    return { e164, groupJid: jid };
  }
  const e164 =
    jidToE164(jidNormalizedUser(jid)) ?? jidToE164(key.remoteJidAlt ? jidNormalizedUser(key.remoteJidAlt) : undefined);
  return { e164, groupJid: null };
}

async function handleInbound(
  scope: RequestScope,
  send: wa.Transport,
  router: ((text: string, locale: 'ar' | 'en') => Promise<import('../../src/server/domain/whatsapp').Intent>) | undefined,
  message: WAMessage,
  agentClient?: AgentClient,
): Promise<void> {
  const { e164, groupJid } = senderOf(message);
  const text = textOf(message)?.trim();
  if (!e164 || !text) return;

  // WA-5 — one group, and no other. An unregistered group, or any group but
  // the registered one, is silence: the same answer an unlisted number gets.
  // Read before anything is logged, so a stranger's group leaves no trail of
  // its own in the company's log.
  const settings = await withScope(scope, (tx) => wa.settings(tx));
  if (groupJid && !(wa.groupAllowed(settings, groupJid) && settings.groupQueries)) {
    log(`inbound from ${e164} in ${groupJid}: ignored (not the registered group)`);
    return;
  }
  // Questions belong in the group: an answer in a private chat is an answer
  // nobody else saw. Read, logged, and left — the group is the record.
  if (!groupJid && settings.groupJid && settings.groupOnly) {
    await withScope(scope, async (tx) => {
      const sender = await wa.resolveNumber(tx, e164);
      const id = await wa.recordInbound(tx, { e164, body: text, waMessageId: message.key.id ?? null, sender, groupJid: null });
      await wa.finishInbound(tx, id, { status: 'refused', intent: 'none', detail: { reason: 'direct messages are not answered; ask in the group' } });
    });
    log(`inbound from ${e164}: direct message ignored (questions belong in the group)`);
    return;
  }

  // 1. Who is this, and may they ask? Logged either way; silence otherwise.
  const { inboundId, sender, allowed } = await withScope(scope, async (tx) => {
    const sender = await wa.resolveNumber(tx, e164);
    const inboundId = await wa.recordInbound(tx, { e164, body: text, waMessageId: message.key.id ?? null, sender, groupJid });
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
    log(`inbound from ${e164}: refused (${allowed.ok ? 'no sender' : allowed.reason})`);
    return;
  }

  const locale = detectLocale(text);

  // 2. WA-6 — a decision command, read by shape. The agent never sees these
  // and never decides anything: an approval is four locks, not a sentence.
  const command = parseCommand(text);
  if (command.kind !== 'none') {
    await handleCommand(scope, send, { sender, e164, groupJid, inboundId, locale, command });
    return;
  }

  // 3. The answer, as the asker, read-only. With a key the agent answers: it
  // reads the question itself and reaches for whichever tools it needs, with
  // the last few turns of this chat for context. The catalogue's phrases are
  // the fallback when there is no key.
  const history = await withScope(scope, (tx) => wa.recentTurns(tx, { groupJid, e164 }));
  let reply: wa.Reply;
  try {
    reply = await wa.answer({
      userId: sender.userId,
      text,
      settings,
      locale,
      ...(router ? { router } : {}),
      ...(agentClient
        ? {
            agent: (ctx, question, userName) =>
              runAgentFor({ client: agentClient, model: settings.agentModel, ctx, question, history, userName }),
          }
        : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`inbound from ${e164}: failed — ${detail}`);
    await withScope(scope, (tx) => wa.finishInbound(tx, inboundId, { status: 'failed', intent: null, errorMessage: detail }));
    try {
      await send({ e164 }, { text: words(locale).error });
    } catch {
      /* the failure is on the record; the apology may fail too */
    }
    return;
  }

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
    const { waMessageId } = await send({ e164, groupJid }, { text: reply.text, attachment: reply.attachment });
    await withScope(scope, async (tx) => {
      await wa.markOutbound(tx, outId, { status: 'sent', waMessageId });
      await wa.finishInbound(tx, inboundId, { status: 'answered', intent: reply.intent.kind, detail: reply.detail });
      await wa.auditAnswer(tx, reply, { inboundId, question: text });
    });
    log(`inbound from ${e164}: ${reply.intent.kind} answered${reply.attachment ? ` + ${reply.attachment.fileName}` : ''}`);
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
              L('Reply: approve <number>  ·  reject <number> <reason>', 'أرسل: موافقة <الرقم>  ·  رفض <الرقم> <السبب>'),
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
          L(`Reply:  confirm ${asked.code}`, `أرسل:  تأكيد ${asked.code}`),
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
  const lastSentDay = await withScope(scope, (tx) => wa.digestLastSentDay(tx));
  const { due, day } = digestDue({ digestHour: settings.digestHour, lastSentDay, at: new Date() });
  if (!due) return;
  // Marked first: a digest that fails to send is retried tomorrow, not every poll.
  await withScope(scope, (tx) => wa.markDigestSent(tx, day));
  const recipients = await withScope(scope, (tx) => wa.digestRecipients(tx));
  for (const recipient of recipients) {
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

// ---------------------------------------------------------------------------
// The greeting on connect
// ---------------------------------------------------------------------------

/**
 * A reconnect is not news. Baileys drops and resumes a socket routinely — a
 * 515 on first pair, a network blink, a server restart — and a greeting on
 * every one of those would be the bot talking over the people in the group.
 * One greeting, then quiet for this long however many times it reconnects.
 */
const GREETING_QUIET_MS = 30 * 60_000;
let lastGreetingAt = 0;

/**
 * Says hello in the group when the bridge comes up, so the room can see the
 * bot is listening — and says what it can be asked, which is the only
 * onboarding anybody reads.
 */
async function greet(scope: RequestScope, send: wa.Transport, botE164: string | null): Promise<void> {
  const settings = await withScope(scope, (tx) => wa.settings(tx));
  if (!settings.groupJid) return;
  // The log's `e164` is a phone number by CHECK constraint, and a greeting is
  // the bot speaking: its own number is the honest answer. Without one (an
  // odd pairing) the words still go out and only the log row is skipped.
  if (Date.now() - lastGreetingAt < GREETING_QUIET_MS) return;
  lastGreetingAt = Date.now();

  const locale = settings.digestLocale;
  const hello =
    locale === 'ar'
      ? '👋 أهلاً، أنا بوت نظام قيمة السفينة. كيف أساعدك؟'
      : '👋 Hello — the QS ERP bot is connected. How can I help?';
  const text = `${hello}\n\n${helpText(locale)}`;

  try {
    const outId = botE164
      ? await withScope(scope, (tx) =>
          wa.recordOutbound(tx, { e164: botE164, groupJid: settings.groupJid, body: text, intent: 'greeting' }),
        )
      : null;
    const { waMessageId } = await send({ e164: botE164 ?? '', groupJid: settings.groupJid }, { text });
    if (outId !== null) await withScope(scope, (tx) => wa.markOutbound(tx, outId, { status: 'sent', waMessageId }));
    log('greeting posted to the group');
  } catch (error) {
    log(`greeting failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const rows = Object.values(all);
  if (rows.length === 0) {
    log('the bot is in no groups yet — add it to the group, then run this again');
    return;
  }
  log(`${rows.length} group(s):`);
  for (const group of rows) {
    console.log(`  ${group.id}   ${group.subject}   (${group.participants?.length ?? 0} members)`);
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
  const router = routerClient ? modelRouter(routerClient, routerModel) : undefined;
  // WA-3 — the agent, when there is a key. With it, a question is worked out
  // rather than matched; without it, the catalogue's phrases still answer.
  const agent = await agentClientFor(process.env.ANTHROPIC_API_KEY);
  log(
    `brain: ${agent ? `agent on ${settings.agentModel}` : router ? `router ${routerModel}` : 'phrase patterns only (no ANTHROPIC_API_KEY)'}; poll every ${POLL_SECONDS}s`,
  );

  let socket: WASocket | null = null;
  let stopping = false;
  const send = transportFor(() => socket, () => settings.throttlePerMinute);
  wa.registerWhatsappSender(send);

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

    socket.ev.on('creds.update', () => {
      saveCreds().catch((e) => log(`saving credentials failed: ${e}`));
    });

    socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        log('scan this QR code with the company phone (WhatsApp → Linked devices → Link a device):');
        qrcode.generate(qr, { small: true });
        void heartbeat('waiting for QR scan');
      }
      if (connection === 'connecting') log('socket connecting…');
      if (connection === 'open') {
        log(`connected as ${socket?.user?.id ?? '?'}`);
        void heartbeat('connected');
        if (!LIST_GROUPS) void greet(scope, send, jidToE164(jidNormalizedUser(socket?.user?.id ?? '')));
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
        void heartbeat(loggedOut ? 'logged out' : 'reconnecting');
        socket = null;
        if (!loggedOut && !stopping) setTimeout(() => connect().catch((e) => log(`reconnect failed: ${e}`)), 5000);
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        if (message.key.fromMe) continue;
        handleInbound(scope, send, router, message, agent ?? undefined).catch((e) => log(`inbound handling failed: ${e}`));
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
      if (socket) {
        const result = await runner.runOnce(scope, { channels: ['whatsapp'] });
        const r = result.channels.whatsapp;
        if (result.dispatched || (r && (r.sent || r.failed || r.suppressed))) log(runner.describe(result));
      }
      if (socket) await sendDigest(scope, send, settings);
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
  const beat = setInterval(() => void heartbeat(socket ? 'connected' : 'disconnected'), 60_000);
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
