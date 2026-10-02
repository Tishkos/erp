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
import { detectLocale, digestDue, e164ToJid, jidToE164, words } from '../../src/server/domain/whatsapp';
import * as audit from '../../src/server/services/audit';
import * as runner from '../../src/server/services/notification-runner';
import * as wa from '../../src/server/services/whatsapp';
import { anthropicClient, modelRouter } from '../../src/server/services/whatsapp-router';

const POLL_SECONDS = Math.max(5, Number(process.env.WA_POLL_SECONDS ?? '20'));
const RESET = process.argv.includes('--reset-pairing');

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
    const jid = e164ToJid(to.e164);
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

function senderOf(message: WAMessage): string | null {
  const key = message.key;
  const jid = key.remoteJid ?? '';
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return null;
  return jidToE164(jidNormalizedUser(jid)) ?? jidToE164(key.remoteJidAlt ? jidNormalizedUser(key.remoteJidAlt) : undefined);
}

async function handleInbound(
  scope: RequestScope,
  send: wa.Transport,
  router: ((text: string, locale: 'ar' | 'en') => Promise<import('../../src/server/domain/whatsapp').Intent>) | undefined,
  message: WAMessage,
): Promise<void> {
  const e164 = senderOf(message);
  const text = textOf(message)?.trim();
  if (!e164 || !text) return;

  // 1. Who is this, and may they ask? Logged either way; silence otherwise.
  const { inboundId, sender, allowed } = await withScope(scope, async (tx) => {
    const sender = await wa.resolveNumber(tx, e164);
    const inboundId = await wa.recordInbound(tx, { e164, body: text, waMessageId: message.key.id ?? null, sender });
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

  // 2. The answer, as the asker, read-only.
  const settings = await withScope(scope, (tx) => wa.settings(tx));
  const locale = detectLocale(text);
  let reply: wa.Reply;
  try {
    reply = await wa.answer({ userId: sender.userId, text, settings, locale, ...(router ? { router } : {}) });
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

  // 3. Send, then record what was sent (W-R4).
  const outId = await withScope(scope, (tx) =>
    wa.recordOutbound(tx, {
      e164,
      body: reply.text,
      sender,
      attachment: reply.attachment ? { name: reply.attachment.fileName, type: reply.attachment.contentType, bytes: reply.attachment.body.length } : null,
      inReplyTo: inboundId,
      intent: reply.intent.kind,
      detail: reply.detail,
    }),
  );
  try {
    const { waMessageId } = await send({ e164 }, { text: reply.text, attachment: reply.attachment });
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
  log(`digest for ${day}: ${recipients.length} recipient(s)`);
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
  log(`router: patterns${router ? ` + ${routerModel}` : ' only (no ANTHROPIC_API_KEY)'}; poll every ${POLL_SECONDS}s`);

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
        handleInbound(scope, send, router, message).catch((e) => log(`inbound handling failed: ${e}`));
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
