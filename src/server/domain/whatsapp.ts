/**
 * The WhatsApp bot's pure parts — REQ-WA-001 §4 (the router), W-R3 (numbers),
 * W-R7 (the footer). No database, no socket: what a message means, and what
 * a reply says, decided from text alone so it can be tested from text alone.
 *
 * Tier 1 of the brain. A question is matched against phrase patterns per
 * locale, exactly and deterministically; what the patterns do not catch goes
 * to the agent (tier 2) when one is configured, and otherwise to the help
 * text. The router never guesses a figure — it only names the service to ask.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Iraq, where the company is: a local 07xx number is read as +9647xx. */
const HOME_COUNTRY_CODE = '964';

/**
 * A number as a person types it — "+964 770 123 4567", "07701234567",
 * "00964…", "9647…" — to E.164, or null when it is not a number at all.
 */
export function normaliseE164(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, '').replace(/^‎|‏/g, '');
  if (!compact) return null;
  let digits: string;
  if (compact.startsWith('+')) digits = compact.slice(1);
  else if (compact.startsWith('00')) digits = compact.slice(2);
  else if (compact.startsWith('0') && compact.length === 11) digits = HOME_COUNTRY_CODE + compact.slice(1);
  else digits = compact;
  if (!/^[0-9]+$/.test(digits)) return null;
  const candidate = `+${digits}`;
  return E164.test(candidate) ? candidate : null;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}

/** WhatsApp addresses a phone number as digits@s.whatsapp.net. */
export function e164ToJid(e164: string): string {
  return `${e164.replace(/^\+/, '')}@s.whatsapp.net`;
}

/**
 * The number behind a JID, or null for an address that is not a phone number
 * (a group, a broadcast, a linked-device id). The bridge resolves a `@lid`
 * sender through the alternate key WhatsApp sends beside it.
 */
export function jidToE164(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const match = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match ? `+${match[1]}` : null;
}

/**
 * WA-6 — the decision commands, read by shape and never by meaning.
 *
 * The agent is not consulted here, and must not be: a sentence that *sounds
 * like* an approval is a sentence, and approving on the strength of one would
 * hand the company's approvals to whoever can get text in front of the bot.
 * These four forms are the only ones that reach the approval engine:
 *
 *   `approve PAYAPP-HQ-2026-000012`
 *   `reject PAYAPP-HQ-2026-000012 the price is wrong`
 *   `confirm 123456`
 *   `pending`                       — what is waiting for me
 *
 * Arabic equivalents are accepted for each, because the group speaks Arabic.
 */
export type Command =
  | { readonly kind: 'approve'; readonly documentNo: string }
  | { readonly kind: 'reject'; readonly documentNo: string; readonly reason: string }
  | { readonly kind: 'confirm'; readonly code: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'none' };

const APPROVE_WORDS = ['approve', 'approved', 'موافقة', 'موافق', 'اوافق', 'أوافق'];
const REJECT_WORDS = ['reject', 'rejected', 'refuse', 'رفض', 'ارفض', 'أرفض', 'مرفوض'];
const CONFIRM_WORDS = ['confirm', 'code', 'تأكيد', 'تاكيد', 'الرمز'];
const PENDING_WORDS = ['pending', 'inbox', 'waiting', 'المعلق', 'بالانتظار', 'قائمتي'];

export function parseCommand(text: string): Command {
  const trimmed = asciiDigits(text).trim().replace(/\s+/g, ' ');
  if (!trimmed) return { kind: 'none' };
  const [head, ...rest] = trimmed.split(' ');
  const word = (head ?? '').toLowerCase().replace(/[.,:!؟?]+$/, '');

  if (PENDING_WORDS.includes(word) && rest.length === 0) return { kind: 'pending' };

  if (CONFIRM_WORDS.includes(word)) {
    const code = (rest[0] ?? '').replace(/\D/g, '');
    return code.length === 6 ? { kind: 'confirm', code } : { kind: 'none' };
  }

  if (APPROVE_WORDS.includes(word)) {
    const documentNo = (rest[0] ?? '').trim();
    return documentNo ? { kind: 'approve', documentNo } : { kind: 'none' };
  }

  if (REJECT_WORDS.includes(word)) {
    const documentNo = (rest[0] ?? '').trim();
    const reason = rest.slice(1).join(' ').trim();
    return documentNo ? { kind: 'reject', documentNo, reason } : { kind: 'none' };
  }

  return { kind: 'none' };
}

/**
 * WA-5 — is this address a group rather than a person?
 *
 * WhatsApp spells a group `<creator>-<timestamp>@g.us` on older accounts and
 * `<digits>@g.us` on newer ones; both are matched, and nothing else is. The
 * bridge asks this before it reads a message and the settings screen asks it
 * before it stores an id, so one answer serves both.
 */
export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === 'string' && /^[0-9]+(-[0-9]+)?@g\.us$/.test(jid.trim());
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export type BotLocale = 'ar' | 'en';

export function detectLocale(text: string): BotLocale {
  return /[؀-ۿ]/.test(text) ? 'ar' : 'en';
}

/** Arabic-Indic and Persian digits to ASCII, so "٣ أيام" reads as 3 days. */
export function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) - (d < '۰' ? 0x0660 : 0x06f0)) % 10));
}

/**
 * A name as a person types it, for matching against a master-data name:
 * lower case, hamza/alef forms folded, taa marbuta to haa, tatweel and
 * diacritics dropped, "ال" and the word for warehouse removed, spaces
 * collapsed.
 */
const STOP_WORDS = new Set(['مخزن', 'مخازن', 'warehouse', 'store', 'stock', 'the', 'of']);

export function nameKey(text: string): string {
  return asciiDigits(text)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((word) => (word.startsWith('ال') && word.length > 3 ? word.slice(2) : word))
    .filter((word) => word && !STOP_WORDS.has(word))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Intents (§4)
// ---------------------------------------------------------------------------

export type Intent =
  | { readonly kind: 'help' }
  | { readonly kind: 'summary' }
  | { readonly kind: 'stock'; readonly warehouse: string }
  | { readonly kind: 'payable'; readonly no: string }
  | { readonly kind: 'application'; readonly no: string }
  | { readonly kind: 'swift'; readonly minDays: number }
  | { readonly kind: 'due' }
  | { readonly kind: 'stopped'; readonly needsReason: boolean }
  | { readonly kind: 'supplier'; readonly party: string }
  | { readonly kind: 'customer'; readonly party: string }
  /**
   * WA-3 — the agent answered, rather than one of the catalogue's phrases.
   * It is a label for the log, not a thing the router may choose: the agent
   * is reached by the bridge having a key, never by a word in a message.
   */
  | { readonly kind: 'agent' }
  | { readonly kind: 'none' };

export type IntentKind = Intent['kind'];

/** Every intent the router can name — the agent's tool whitelist is the same list (§5). */
export const INTENT_KINDS: readonly IntentKind[] = [
  'help',
  'summary',
  'stock',
  'payable',
  'application',
  'swift',
  'due',
  'stopped',
  'supplier',
  'customer',
  'none',
];

const PAYABLE_NO = /\b((?:IMP|PUR|SVC|RNT|ADV)-[A-Z0-9]+-\d{4}-\d{6})\b/i;
const APPLICATION_NO = /\b(PAYAPP-[A-Z0-9]+-\d{4}-\d{6})\b/i;

const clean = (s: string) => s.replace(/[؟?!.،,:;"'«»]+$/g, '').replace(/^[:\-–—]\s*/, '').trim();

/**
 * What the message asks. Patterns are tried in a fixed order — document
 * numbers first, because "status of IMP-HQ-2026-000004 stopped?" is a
 * question about one payable, not about every stopped one.
 */
export function route(input: string): Intent {
  const text = asciiDigits(input).trim();
  const lower = text.toLowerCase();
  if (!text) return { kind: 'none' };

  const application = APPLICATION_NO.exec(text);
  if (application) return { kind: 'application', no: application[1]!.toUpperCase() };
  const payable = PAYABLE_NO.exec(text);
  if (payable) return { kind: 'payable', no: payable[1]!.toUpperCase() };

  if (/^(help|\?|menu|commands|مساعده|مساعدة|الاوامر|الأوامر|قائمه|قائمة)$/i.test(lower)) return { kind: 'help' };

  if (/\bswift\b|سويفت|حواله|حوالة|حوالات/i.test(lower)) {
    const days = /(\d+)\s*(?:days?|d\b|يوم|ايام|أيام|اليوم)/i.exec(lower) ?? /(?:more than|over|above|اكثر من|أكثر من|فوق)\s*(\d+)/i.exec(lower);
    return { kind: 'swift', minDays: days ? Number(days[1]) : 0 };
  }

  if (/\b(stopped|on hold|holds?|blocked)\b|موقوف|متوقف|موقوفه|موقوفة|متوقفه|متوقفة|محجوز|الايقاف|الإيقاف/i.test(lower)) {
    const needsReason = /\b(no reason|without (a )?reason|needs? (a )?reason|reason)\b|بدون سبب|بلا سبب|يحتاج سبب|تحتاج سبب|سبب/i.test(lower);
    return { kind: 'stopped', needsReason };
  }

  if (/\b(due|falling due|payments? due|what is due|coming due)\b|مستحق|استحقاق|الاستحقاق|يستحق/i.test(lower)) {
    return { kind: 'due' };
  }

  const supplier =
    /^(?:supplier|vendor)\s+(?:balance|statement|account)\s+(?:of\s+|for\s+)?(.+)$/i.exec(text) ??
    /^(?:balance|statement|account)\s+(?:of\s+|for\s+)?(?:supplier|vendor)\s+(.+)$/i.exec(text) ??
    /^(?:what do we owe|how much do we owe|how much we owe)\s+(.+)$/i.exec(text) ??
    /^(?:رصيد|كشف حساب|كشف|حساب)\s+(?:ال)?مورد\s+(.+)$/.exec(text) ??
    /^(?:شكد|كم|شقد)\s+(?:نطلب|علينا|مديونين|ندين)\s*(?:ل|الى|إلى)?\s*(?:ال)?مورد\s+(.+)$/.exec(text);
  if (supplier) return { kind: 'supplier', party: clean(supplier[1]!) };

  const customer =
    /^(?:customer|client)\s+(?:balance|statement|account)\s+(?:of\s+|for\s+)?(.+)$/i.exec(text) ??
    /^(?:balance|statement|account)\s+(?:of\s+|for\s+)?(?:customer|client)\s+(.+)$/i.exec(text) ??
    /^(?:what does|how much does)\s+(.+?)\s+owe(?: us)?$/i.exec(text) ??
    /^(?:رصيد|كشف حساب|كشف|حساب)\s+(?:ال)?(?:زبون|عميل|عميلنا|زبونا)\s+(.+)$/.exec(text) ??
    /^(?:شكد|كم|شقد)\s+(?:علي|على|يطلب|مديون)\s*(?:ال)?(?:زبون|عميل)\s+(.+)$/.exec(text);
  if (customer) return { kind: 'customer', party: clean(customer[1]!) };

  const stock =
    /^(?:what(?:'s| is)?\s+(?:in|at)\s+|stock\s+(?:in|at|of)\s+|inventory\s+(?:in|at|of)\s+|quantity\s+(?:in|at)\s+)(?:the\s+)?(?:warehouse\s+)?(.+)$/i.exec(text) ??
    /^(?:warehouse|store)\s+(.+?)(?:\s+stock)?$/i.exec(text) ??
    /^(.+?)\s+(?:stock|inventory)$/i.exec(text) ??
    /^(?:شنو|شو|ماذا|ما|ايش|وش)\s+(?:موجود|عدنا|عندنا|اكو|يوجد|في|فيه)\s*(?:ب|في|بال|بمخزن|في مخزن|بالمخزن)?\s*(?:ال)?(?:مخزن\s+)?(.+)$/.exec(text) ??
    /^(?:المخزون|مخزون|البضاعه|البضاعة|بضاعه|بضاعة|الكميه|الكمية|كميه|كمية|الرصيد|رصيد)\s+(?:في|ب|بال|في مخزن|بمخزن|مخزن)?\s*(?:ال)?(?:مخزن\s+)?(.+)$/.exec(text) ??
    /^(?:مخزن|مخازن)\s+(.+)$/.exec(text);
  if (stock) {
    const warehouse = clean(stock[1]!);
    if (warehouse) return { kind: 'stock', warehouse };
  }

  if (/^(summary|today|status|overview|brief|digest|dashboard|ملخص|اليوم|الوضع|الحاله|الحالة|موجز|لوحه|لوحة|تقرير اليوم|ملخص اليوم)$/i.test(lower) ||
      /\b(today'?s|daily)\s+(summary|brief|digest|report)\b|ملخص اليوم|تقرير اليوم|وضع اليوم/i.test(lower)) {
    return { kind: 'summary' };
  }

  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// The words of a reply
// ---------------------------------------------------------------------------

const WORDS = {
  en: {
    help: [
      'I answer from the ERP, read-only. Ask me:',
      '• stock in warehouse <name or code>',
      '• status of <payable or PAYAPP number>',
      '• swift pending more than <N> days',
      '• payables due this week',
      '• stopped payables / needing a reason',
      '• supplier balance <name or code>',
      '• customer balance <name or code>',
      '• today\'s summary',
      'Arabic works too. Figures come with a PDF or XLSX when there are many rows.',
    ],
    unknown: 'I did not follow that one. Try asking it another way — a warehouse, a customer, a supplier, a document number, or what you want to know about the books.',
    footer: (at: string, branch: string, user: string) => `— QS ERP · as of ${at} · branch ${branch} · read as ${user}`,
    notAllowed: '',
    tooMany: (rows: number, cap: number) => `${rows} rows — more than the ${cap} this channel sends. Narrow the question or open the screen.`,
    rows: (n: number) => `${n} row${n === 1 ? '' : 's'}`,
    attached: (name: string) => `Attached: ${name}`,
    none: 'Nothing to show.',
    error: 'Something went wrong reading that. It has been logged; try again or open the screen.',
    choose: (what: string, options: readonly string[]) => [`More than one ${what} matches. Which one?`, ...options.map((o) => `• ${o}`)].join('\n'),
    noMatch: (what: string, options: readonly string[]) => [`No ${what} matches that.`, ...(options.length ? ['Try one of:', ...options.map((o) => `• ${o}`)] : [])].join('\n'),
  },
  ar: {
    help: [
      'أجيب من النظام، للقراءة فقط. اسألني:',
      '• مخزون مخزن <الاسم أو الرمز>',
      '• حالة <رقم المستحق أو PAYAPP>',
      '• سويفت معلق أكثر من <N> أيام',
      '• المستحقات هذا الأسبوع',
      '• المستحقات الموقوفة / بدون سبب',
      '• رصيد المورد <الاسم أو الرمز>',
      '• رصيد الزبون <الاسم أو الرمز>',
      '• ملخص اليوم',
      'الإنجليزية تعمل أيضاً. الأرقام تأتي مع PDF أو XLSX عندما تكثر السطور.',
    ],
    unknown: 'لم أفهم هذا تماماً. اسأل بطريقة أخرى — مخزن، زبون، مورّد، رقم مستند، أو ما تريد معرفته عن الحسابات.',
    footer: (at: string, branch: string, user: string) => `— QS ERP · كما في ${at} · الفرع ${branch} · قُرئ باسم ${user}`,
    notAllowed: '',
    tooMany: (rows: number, cap: number) => `${rows} سطر — أكثر من ${cap} التي ترسلها هذه القناة. ضيّق السؤال أو افتح الشاشة.`,
    rows: (n: number) => `${n} سطر`,
    attached: (name: string) => `مرفق: ${name}`,
    none: 'لا يوجد ما يُعرض.',
    error: 'حدث خطأ أثناء القراءة. سُجّل؛ حاول مرة أخرى أو افتح الشاشة.',
    choose: (what: string, options: readonly string[]) => [`أكثر من ${what} يطابق. أيّها؟`, ...options.map((o) => `• ${o}`)].join('\n'),
    noMatch: (what: string, options: readonly string[]) => [`لا يوجد ${what} يطابق ذلك.`, ...(options.length ? ['جرّب أحد هذه:', ...options.map((o) => `• ${o}`)] : [])].join('\n'),
  },
} as const;

export function words(locale: BotLocale) {
  return WORDS[locale];
}

export function helpText(locale: BotLocale): string {
  return WORDS[locale].help.join('\n');
}

/*
 * What a person says while they go and look.
 *
 * By direction (2026-10-02): a question that takes real work should not be
 * met with silence. Opus reading three reports takes the better part of a
 * minute, and a minute of nothing is how a bot behaves. So the group is told
 * — the way a colleague would say it, and not in the same words every time,
 * which is the whole complaint about bots.
 */
const CHECKING = {
  en: [
    "Give me a moment — I'll check it properly before I answer.",
    "Let me look it up, I'd rather give you the right figure than a quick one.",
    'One second, reading it now.',
    "I'll check the system first — I don't want to guess at it.",
    'Looking now. Bear with me.',
    'Let me go through it and come back to you with something solid.',
  ],
  ar: [
    'لحظة، أتأكد من النظام قبل ما أجاوبك.',
    'خلي أشوفه بالنظام حتى أعطيك الرقم الصحيح.',
    'ثانية واحدة، أقرأه هسه.',
    'أراجع النظام أول، ما أريد أخمّن.',
    'أتحقق هسه، لحظة وياي.',
    'خلي أراجعه زين وأرجعلك بجواب مضبوط.',
  ],
} as const;

/**
 * One of those lines, a different one each time.
 *
 * The counter walks the list rather than picking at random, so nobody in the
 * group hears the same sentence twice running — which is what made the old
 * bot sound like a bot.
 */
let checkingAt = 0;
export function checkingLine(locale: BotLocale): string {
  const list = CHECKING[locale];
  const line = list[checkingAt % list.length]!;
  checkingAt += 1;
  return line;
}

/*
 * What he says when he comes back on.
 *
 * The first version of this recited the phrases the bot understood, and the
 * sponsor's objection to it is the reason the agent exists at all: a list of
 * commands teaches people to type commands. It is one line now, in his own
 * voice, and a different line each time — a bridge that reconnects twice in
 * an evening should not post the same sentence twice.
 *
 * He names himself, because a room needs to know who has just arrived.
 */
const GREETINGS = {
  en: [
    "Noah here — I'm back on. Ask me anything about the system.",
    "Noah, back online. What do you need?",
    "I'm here. Anything you want to know about the books or the stock, just ask.",
    "Back up and listening — Noah.",
  ],
  ar: [
    'نوح هنا، رجعت أشتغل. اسألوني عن أي شيء بالنظام.',
    'نوح، رجعت. شتحتاجون؟',
    'آني موجود. أي شيء عن الحسابات أو المخازن، اسألوني.',
    'رجعت أشتغل وأسمعكم — نوح.',
  ],
} as const;

let greetingAt = 0;
export function greetingLine(locale: BotLocale): string {
  const list = GREETINGS[locale];
  const line = list[greetingAt % list.length]!;
  greetingAt += 1;
  return line;
}

/** W-R7 — every reply names when it was read, under which branch, as whom. */
export function footer(locale: BotLocale, input: { readonly at: Date; readonly branchCode: string; readonly userName: string }): string {
  const at = input.at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return WORDS[locale].footer(at, input.branchCode, input.userName);
}

/** A figure for a phone screen: thousands separated, no trailing zeros past two places. */
export function money(value: string | number | null | undefined, currency?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const text = n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency ? `${text} ${currency}` : text;
}

/** A quantity: up to three places, no trailing zeros. */
export function quantity(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/** Days between two ISO dates, for "pending N days". */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const to = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface BotSettings {
  readonly routerModel: string;
  readonly agentModel: string;
  /** Text answers up to this many rows; above it, always an attachment (D-WA-4). */
  readonly inlineRows: number;
  /** An export stops here and says so in its caption (D-WA-4). */
  readonly exportRowsCap: number;
  /** Outbound messages per minute, across every recipient (§3). */
  readonly throttlePerMinute: number;
  /** Message bodies are blanked after this many days (D-WA-8). */
  readonly retentionDays: number;
  /** The hour (00–23, business time) the daily digest goes out (WA-4). */
  readonly digestHour: number;
  /** The language the digest is written in. */
  readonly digestLocale: BotLocale;
  /**
   * WA-5 — the one group the bot works in, by its WhatsApp id.
   *
   * Empty means the bot is a direct-message bot only, as WA-1 to WA-4 built
   * it. Registered, it is *one* group and no other: a message from any other
   * group is silence, exactly as an unlisted number is (W-R3). Run
   * `npm run whatsapp-bridge -- --list-groups` to print the id to put here.
   */
  readonly groupJid: string;
  /** The group's name as WhatsApp reported it, for the screen to show. */
  readonly groupSubject: string;
  /** Questions asked in the group are answered there — W-R1 still decides who may ask. */
  readonly groupQueries: boolean;
  /** Notifications go to the group as well as to each allowed contact. */
  readonly groupNotifications: boolean;
  /** The morning digest is posted to the group. */
  readonly groupDigest: boolean;
  /**
   * Questions are answered in the group and nowhere else.
   *
   * On, because an answer in a private chat is an answer nobody else in the
   * company saw: the group is the record of what was asked and what the
   * system said. A direct message is read, logged and left unanswered, with
   * the same silence an unlisted number gets.
   */
  readonly groupOnly: boolean;
}

export const SETTING_KEYS = [
  'router_model',
  'agent_model',
  'inline_rows',
  'export_rows_cap',
  'throttle_per_minute',
  'retention_days',
  'digest_hour',
  'digest_locale',
  'group_jid',
  'group_subject',
  'group_queries',
  'group_notifications',
  'group_digest',
  'group_only',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const DEFAULT_SETTINGS: BotSettings = {
  routerModel: 'claude-haiku-4-5-20251001',
  agentModel: 'claude-opus-5-5',
  inlineRows: 15,
  exportRowsCap: 5000,
  throttlePerMinute: 60,
  retentionDays: 90,
  digestHour: 8,
  digestLocale: 'ar',
  groupJid: '',
  groupSubject: '',
  groupQueries: true,
  groupNotifications: true,
  groupDigest: true,
  groupOnly: true,
};

export class WhatsappValidationError extends Error {
  readonly code = 'WHATSAPP_VALIDATION';
  constructor(readonly field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = 'WhatsappValidationError';
  }
}

const bounded = (key: string, raw: string, min: number, max: number): number => {
  const n = Number(asciiDigits(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new WhatsappValidationError(key, `must be a whole number from ${min} to ${max}`);
  return n;
};

/** The rows of `whatsapp_setting` as typed settings; a missing key is its seed. */
export function settingsFrom(rows: ReadonlyArray<{ readonly key: string; readonly value: string }>): BotSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const str = (key: SettingKey, fallback: string) => (map.get(key) ?? fallback).trim() || fallback;
  const flag = (key: SettingKey, fallback: boolean) => {
    const raw = map.get(key)?.trim().toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    return raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
  };
  const num = (key: SettingKey, fallback: number, min: number, max: number) => {
    const raw = map.get(key);
    if (raw === undefined) return fallback;
    try {
      return bounded(key, raw, min, max);
    } catch {
      return fallback;
    }
  };
  return {
    routerModel: str('router_model', DEFAULT_SETTINGS.routerModel),
    agentModel: str('agent_model', DEFAULT_SETTINGS.agentModel),
    inlineRows: num('inline_rows', DEFAULT_SETTINGS.inlineRows, 1, 100),
    exportRowsCap: num('export_rows_cap', DEFAULT_SETTINGS.exportRowsCap, 100, 20_000),
    throttlePerMinute: num('throttle_per_minute', DEFAULT_SETTINGS.throttlePerMinute, 1, 600),
    retentionDays: num('retention_days', DEFAULT_SETTINGS.retentionDays, 7, 3650),
    digestHour: num('digest_hour', DEFAULT_SETTINGS.digestHour, 0, 23),
    digestLocale: str('digest_locale', DEFAULT_SETTINGS.digestLocale) === 'en' ? 'en' : 'ar',
    groupJid: (map.get('group_jid') ?? '').trim(),
    groupSubject: (map.get('group_subject') ?? '').trim(),
    groupQueries: flag('group_queries', DEFAULT_SETTINGS.groupQueries),
    groupNotifications: flag('group_notifications', DEFAULT_SETTINGS.groupNotifications),
    groupDigest: flag('group_digest', DEFAULT_SETTINGS.groupDigest),
    groupOnly: flag('group_only', DEFAULT_SETTINGS.groupOnly),
  };
}

/** A setting as typed on the screen — checked before it is stored. */
export function validateSetting(key: string, value: string): { readonly key: SettingKey; readonly value: string } {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new WhatsappValidationError('key', `'${key}' is not a setting`);
  const k = key as SettingKey;
  const raw = value.trim();
  switch (k) {
    case 'router_model':
    case 'agent_model':
      if (!/^[a-z0-9][a-z0-9.-]{2,80}$/i.test(raw)) throw new WhatsappValidationError(k, 'must be a model id such as claude-opus-5-5');
      return { key: k, value: raw };
    case 'inline_rows':
      return { key: k, value: String(bounded(k, raw, 1, 100)) };
    case 'export_rows_cap':
      return { key: k, value: String(bounded(k, raw, 100, 20_000)) };
    case 'throttle_per_minute':
      return { key: k, value: String(bounded(k, raw, 1, 600)) };
    case 'retention_days':
      return { key: k, value: String(bounded(k, raw, 7, 3650)) };
    case 'digest_hour':
      return { key: k, value: String(bounded(k, raw, 0, 23)).padStart(2, '0') };
    case 'digest_locale':
      if (raw !== 'ar' && raw !== 'en') throw new WhatsappValidationError(k, 'must be ar or en');
      return { key: k, value: raw };
    case 'group_jid':
      // Cleared, or one group id exactly as WhatsApp spells it.
      if (raw === '') return { key: k, value: '' };
      if (!isGroupJid(raw)) throw new WhatsappValidationError(k, 'must be a group id ending in @g.us');
      return { key: k, value: raw };
    case 'group_subject':
      return { key: k, value: raw.slice(0, 120) };
    case 'group_queries':
    case 'group_notifications':
    case 'group_digest':
    case 'group_only':
      return { key: k, value: raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes' ? 'on' : 'off' };
  }
}

// ---------------------------------------------------------------------------
// The morning digest (WA-4)
// ---------------------------------------------------------------------------

/** The business day and hour of an instant, in the company's zone. */
export function businessHour(at: Date, zone = 'Asia/Baghdad'): { readonly day: string; readonly hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * Whether the digest is owed now: the business day has reached the digest
 * hour and nothing was sent for that day yet. A bridge that was asleep at
 * eight sends when it wakes, once; never twice in a day.
 */
export function digestDue(input: { readonly digestHour: number; readonly lastSentDay: string | null; readonly at: Date; readonly zone?: string }): { readonly due: boolean; readonly day: string } {
  const { day, hour } = businessHour(input.at, input.zone);
  return { due: hour >= input.digestHour && input.lastSentDay !== day, day };
}
