/**
 * What an exception says, in a person's language — platform phase, Agent 7.
 *
 * A finding stores *facts* (the numbers and names it is made of), never a
 * sentence; the sentence is the message catalogue's, drawn here for whoever
 * reads it: the screen in the viewer's language, the sweep's stored English
 * snapshot, a notification. So an Arabic reader gets Arabic wording around
 * the same figures, and no screen prints "Error 123".
 *
 * Built without Next's request machinery, like `print/i18n`, so the sweep
 * (a script) and a test render the same text the page does.
 */
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import { detectorKey, type EvidenceRow, type ExceptionFacts } from '../domain/exceptions';
import { eventKey } from '../domain/posting-map';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '../../i18n/config';
import en from '../../../messages/en.json';
import ar from '../../../messages/ar.json';

const CATALOGUE: Readonly<Record<Locale, AbstractIntlMessages>> = {
  en: en as unknown as AbstractIntlMessages,
  ar: ar as unknown as AbstractIntlMessages,
};

type Translator = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

const translators = new Map<Locale, Translator>();

function translatorFor(locale: Locale): Translator {
  let t = translators.get(locale);
  if (!t) {
    t = createTranslator({ locale, messages: CATALOGUE[locale], timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad' }) as unknown as Translator;
    translators.set(locale, t);
  }
  return t;
}

/** `journal_entry` → "Journal entry": the last resort for a code with no label of its own. */
export function humanize(code: string): string {
  const words = code.replace(/[_.]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** Money, quantities and dates read by the suffix of their name; codes are put into words; the rest is shown as it is. */
export function formatFacts(facts: ExceptionFacts, locale: Locale): Record<string, string | number> {
  const t = translatorFor(locale);
  const labelled = (key: string, raw: string, fallback: string): string => (t.has(key) ? t(key) : fallback || raw);
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(facts)) {
    if (value === null || value === undefined || value === '') {
      out[name] = '';
    } else if (/Iqd$/.test(name)) {
      out[name] = formatMoney(String(value), 'IQD', locale);
    } else if (/Qty$/.test(name)) {
      out[name] = formatQuantity(String(value), locale);
    } else if (/Date$/.test(name) && typeof value === 'string') {
      out[name] = formatBusinessDate(value, locale);
    } else if (/Event$/.test(name)) {
      out[name] = labelled(`posting_map.event.${eventKey(String(value))}`, String(value), humanize(String(value)));
    } else if (/Role$/.test(name)) {
      out[name] = labelled(`posting_map.role.${String(value)}`, String(value), humanize(String(value)));
    } else if (/Kind$/.test(name)) {
      const own = `admin.exceptions.doc_kind.${String(value)}`;
      out[name] = labelled(t.has(own) ? own : `admin.audit.kinds.${String(value)}`, String(value), humanize(String(value)));
    } else if (/Detector$/.test(name)) {
      out[name] = labelled(`admin.exceptions.detector.${detectorKey(String(value))}.name`, String(value), humanize(String(value)));
    } else if (name === 'priority') {
      out[name] = labelled(`admin.tasks.priority_${String(value)}`, String(value), humanize(String(value)));
    } else if (/Check$/.test(name)) {
      const health = `admin.exceptions.health_check.${String(value)}`;
      out[name] = labelled(t.has(health) ? health : `admin.periods.check_${String(value)}`, String(value), humanize(String(value)));
    } else {
      out[name] = typeof value === 'number' ? value : String(value);
    }
  }
  return out;
}

/**
 * What the affected record is called, for a record that has no number of its own: a posting line is the document it belongs to,
 * the host's health check and a detector are named by their labels. Every other record's label is its own number.
 */
export function recordLabelFor(type: string, facts: ExceptionFacts, stored: string, locale: Locale): string {
  if (type !== 'posting_rule' && type !== 'system' && type !== 'detector') return stored;
  const shown = formatFacts(facts, locale);
  // The event is what the posting rule belongs to; the role it lacks is in the finding's title.
  if (type === 'posting_rule') return shown.postingEvent ? String(shown.postingEvent) : stored;
  if (type === 'system') return String(shown.healthCheck || stored);
  return String(shown.sourceDetector || stored);
}

export interface ExceptionText {
  readonly title: string;
  readonly explanation: string;
  /** The direct action's label ("Open Landed Cost"). */
  readonly action: string;
}

/** The wording of one finding in one language. A detector with no wording yet reads as its own name, never as nothing. */
export function render(locale: Locale, detector: string, facts: ExceptionFacts): ExceptionText {
  const t = translatorFor(locale);
  const base = `admin.exceptions.detector.${detectorKey(detector)}`;
  const values = formatFacts(facts, locale);
  const draw = (leaf: string, fallback: string): string => (t.has(`${base}.${leaf}`) ? t(`${base}.${leaf}`, values) : fallback);
  return {
    title: draw('title', humanize(detector)),
    explanation: draw('explanation', humanize(detector)),
    action: draw('action', humanize(detector)),
  };
}

/** What is wrong with one evidence row, as a short phrase. */
export function noteText(locale: Locale, note: EvidenceRow['note']): string {
  if (!note) return '';
  const t = translatorFor(locale);
  const key = `admin.exceptions.evidence_note.${note.code}`;
  if (!t.has(key)) return humanize(note.code);
  return t(key, formatFacts(note.params ?? {}, locale));
}

/** One of the page's own labels, for a notification's stored text. */
export function label(locale: Locale, key: string, values?: Record<string, string | number>): string {
  const t = translatorFor(locale);
  return t.has(key) ? t(key, values) : key;
}
