'use client';

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Download, Sparkles, SendHorizontal, Trash2, X } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import type { AssistantAnswer, AssistantProposal } from '@/server/services/assistant';
import { closeAssistant, toggleAssistant, useAssistant } from './assistant-store';

/**
 * The AI dock — Noah in the application (2026-10-07, by direction: "make a
 * dock in the right bottom, AI … the AI agent that we have [on WhatsApp] in
 * the website too; don't overlap with the chat dock").
 *
 * A round button in the bottom-end corner of every screen; pressing it opens a
 * panel above it where the signed-in person talks to the same agent the
 * WhatsApp group talks to — read as them, their grants, the same tools,
 * pictures and proposals. A proposal shows as a card with Yes and No: Yes runs
 * it as this person through the document's own service, which still refuses
 * what they may not do; No drops it. The conversation is this tab's
 * (`sessionStorage`), sent with each question so "and Erbil?" means something;
 * the server keeps nothing between questions (`services/assistant.ts`).
 *
 * The chat dock reads `useAssistant().open` and sits beside this, never under
 * it. On a phone the panel takes the whole screen.
 */

interface Turn {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly parts?: AssistantAnswer['parts'];
  readonly attachment?: AssistantAnswer['attachment'];
  readonly tone?: 'ok' | 'error';
}

interface Picture {
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  readonly base64: string;
  readonly name: string;
}

const STORE_KEY = 'erp-assistant-turns';
const KEEP = 40;
const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

const TOOL_BUTTON =
  'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-muted-fg transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const HEADER_BUTTON =
  'grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-fg transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';
const BUBBLE = 'max-w-[90%] rounded-2xl px-3 py-1.5 text-sm leading-snug [overflow-wrap:anywhere]';
const MINE = 'rounded-ee-md bg-primary text-primary-fg [&_a]:text-primary-fg [&_a]:underline [&_a]:underline-offset-2';
const THEIRS = 'rounded-es-md bg-secondary text-secondary-fg [&_a]:text-primary-subtle-fg [&_a]:underline [&_a]:underline-offset-2';

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

function readStored(): Turn[] {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function store(turns: readonly Turn[]) {
  try {
    // Pictures and files are not kept across a reload: they are large, and the answer's words are what matters.
    const slim = turns.slice(-KEEP).map((turn) => ({ ...turn, parts: turn.parts?.map((part) => ({ text: part.text, image: null })), attachment: null }));
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(slim));
  } catch {
    /* a full or disabled storage loses nothing but the memory of the conversation */
  }
}

const mint = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

/**
 * Noah writes as WhatsApp reads: *bold* between asterisks, links as bare
 * addresses, a line per step. Drawn here the same way: bold, a link that
 * opens in a new tab, a line break per line — and nothing else interpreted.
 */
function renderNoah(text: string): ReactNode {
  return text.split('\n').map((line, lineIndex) => {
    const out: ReactNode[] = [];
    let at = 0;
    const marks: { start: number; end: number; kind: 'url' | 'bold'; text: string }[] = [];
    for (const match of line.matchAll(URL_PATTERN)) {
      const trimmed = match[0].replace(/[.,;:!?)\]}»]+$/, '');
      marks.push({ start: match.index!, end: match.index! + trimmed.length, kind: 'url', text: trimmed });
    }
    for (const match of line.matchAll(/\*([^*\n]+)\*/g)) {
      const start = match.index!;
      if (marks.some((m) => start < m.end && start + match[0].length > m.start)) continue;
      marks.push({ start, end: start + match[0].length, kind: 'bold', text: match[1]! });
    }
    marks.sort((a, b) => a.start - b.start);
    marks.forEach((mark, i) => {
      if (mark.start > at) out.push(line.slice(at, mark.start));
      out.push(
        mark.kind === 'url' ? (
          <a href={mark.text} key={`u${i}`} rel="noopener noreferrer" target="_blank">
            {mark.text}
          </a>
        ) : (
          <strong key={`b${i}`}>{mark.text}</strong>
        ),
      );
      at = mark.end;
    });
    if (at < line.length) out.push(line.slice(at));
    return (
      <Fragment key={lineIndex}>
        {lineIndex > 0 ? <br /> : null}
        {out}
      </Fragment>
    );
  });
}

export function AssistantDock() {
  const t = useTranslations('assistant');
  const { open } = useAssistant();
  const phone = useIsPhone();

  return (
    <>
      {open ? <Panel phone={phone} /> : null}
      <button
        aria-expanded={open}
        aria-label={t('open')}
        className={cn(
          'fixed bottom-4 end-4 z-[46] grid size-12 cursor-pointer place-items-center rounded-full bg-primary text-primary-fg shadow-xl ring-2 ring-overlay transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none print:hidden',
          open && phone && 'hidden',
        )}
        data-assistant-dock=""
        onClick={toggleAssistant}
        title={t('open')}
        type="button"
      >
        <Sparkles aria-hidden="true" className="size-5" />
        <span className="sr-only">{t('open')}</span>
      </button>
    </>
  );
}

function Panel({ phone }: { readonly phone: boolean }) {
  const t = useTranslations('assistant');
  const locale = useLocale();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<AssistantProposal | null>(null);
  const [body, setBody] = useState('');
  const [pictures, setPictures] = useState<Picture[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // This tab's conversation, adopted after the first paint (never during a server render).
  useEffect(() => {
    setTurns(readStored());
    setLoaded(true);
    field.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (loaded) store(turns);
  }, [turns, loaded]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy, proposal]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 7 * 16)}px`;
  }, [body]);

  const push = (turn: Turn) => setTurns((prev) => [...prev, turn].slice(-KEEP));

  const post = async (payload: Record<string, unknown>) => {
    const response = await fetch('/assistant/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof json.error === 'string' ? json.error : 'failed';
      const detail = typeof json.detail === 'string' ? json.detail : '';
      throw new Error(code === 'unavailable' ? t('unavailable', { detail }) : code === 'signed_out' ? t('signed_out') : code === 'refused' ? detail || t('refused') : t('failed'));
    }
    return json;
  };

  const ask = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    const history = turns.filter((turn) => turn.tone !== 'error').slice(-12).map((turn) => ({ role: turn.role, text: turn.text }));
    push({ id: mint(), role: 'user', text: pictures.length > 0 ? `${text} 📎 ${pictures.map((p) => p.name).join(', ')}` : text });
    setBody('');
    const sent = pictures;
    setPictures([]);
    setProposal(null);
    setBusy(true);
    try {
      const answer = (await post({
        kind: 'ask',
        text,
        history,
        pictures: sent.map(({ mediaType, base64 }) => ({ mediaType, base64 })),
        locale: locale === 'ar' ? 'ar' : 'en',
      })) as unknown as AssistantAnswer;
      push({ id: mint(), role: 'assistant', text: answer.text, parts: answer.parts, attachment: answer.attachment });
      setProposal(answer.proposal);
    } catch (error) {
      push({ id: mint(), role: 'assistant', text: error instanceof Error ? error.message : t('failed'), tone: 'error' });
    } finally {
      setBusy(false);
      field.current?.focus({ preventScroll: true });
    }
  };

  const decide = async (kind: 'yes' | 'no') => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = (await post({ kind })) as { ok?: boolean; said?: string; dropped?: boolean };
      if (kind === 'yes') push({ id: mint(), role: 'assistant', text: outcome.said ?? '', tone: outcome.ok ? 'ok' : 'error' });
      else push({ id: mint(), role: 'assistant', text: t('declined'), tone: 'ok' });
    } catch (error) {
      push({ id: mint(), role: 'assistant', text: error instanceof Error ? error.message : t('failed'), tone: 'error' });
    } finally {
      setProposal(null);
      setBusy(false);
    }
  };

  const takePictures = (files: readonly File[]) => {
    for (const file of files.slice(0, 2 - pictures.length)) {
      const type = file.type.toLowerCase();
      if (!(PICTURE_TYPES as readonly string[]).includes(type) || file.size > 4_000_000) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? '');
        const base64 = url.slice(url.indexOf(',') + 1);
        setPictures((prev) => (prev.length >= 2 ? prev : [...prev, { mediaType: type as Picture['mediaType'], base64, name: file.name || t('pasted_picture') }]));
      };
      reader.readAsDataURL(file);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      takePictures(files);
    }
  };

  const clear = () => {
    setTurns([]);
    setProposal(null);
    try {
      window.sessionStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing to forget */
    }
  };

  return (
    <section
      aria-label={t('title')}
      className={cn(
        'fixed flex flex-col overflow-hidden bg-overlay text-overlay-fg shadow-2xl print:hidden',
        phone ? 'inset-0 z-[80] h-dvh w-full' : 'bottom-[4.75rem] end-4 z-[46] h-[34rem] max-h-[calc(100dvh-6.5rem)] w-[22.5rem] rounded-xl border border-border',
      )}
      data-assistant-panel=""
    >
      <header className="flex items-center gap-2 border-b border-border bg-overlay px-2.5 py-2">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-fg">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-semibold">{t('title')}</span>
          <span className="block truncate text-xs text-muted-fg">{busy ? t('thinking') : t('subtitle')}</span>
        </div>
        <button aria-label={t('clear')} className={HEADER_BUTTON} disabled={turns.length === 0 || busy} onClick={clear} title={t('clear')} type="button">
          <Trash2 aria-hidden="true" className="size-4" />
        </button>
        <button aria-label={t('close')} className={HEADER_BUTTON} onClick={closeAssistant} title={t('close')} type="button">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" ref={list}>
        {turns.length === 0 ? (
          <p className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-fg">
            <Sparkles aria-hidden="true" className="size-6 text-primary" />
            {t('empty')}
          </p>
        ) : (
          <ol aria-label={t('messages')} className="space-y-2">
            {turns.map((turn) => (
              <Bubble key={turn.id} turn={turn} />
            ))}
          </ol>
        )}
        {busy ? (
          <div aria-hidden="true" className="mt-2 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-2xl rounded-es-md bg-secondary px-3 py-2.5">
              {[0, 1, 2].map((i) => (
                <span className="size-1.5 animate-bounce rounded-full bg-muted-fg motion-reduce:animate-none" key={i} style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </span>
          </div>
        ) : null}
        {proposal && !busy ? (
          <div className="mt-3 rounded-xl border border-primary/40 bg-primary-subtle p-3 text-sm text-fg" data-assistant-proposal={proposal.action}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary-subtle-fg">{t('proposal_title')}</p>
            <p className="mb-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{proposal.sentence}</p>
            <div className="flex items-center gap-2">
              <button
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => decide('yes')}
                type="button"
              >
                <Check aria-hidden="true" className="size-4" />
                {t('yes')}
              </button>
              <button
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-overlay px-3 py-1.5 text-sm font-medium text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => decide('no')}
                type="button"
              >
                <X aria-hidden="true" className="size-4" />
                {t('no')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Not a result the page sounds for (`result-sounds.tsx`). */}
      <form className="border-t border-border p-2" data-no-result-sound="" onSubmit={ask}>
        {pictures.length > 0 ? (
          <ul className="mb-1.5 flex flex-wrap gap-1.5 px-1">
            {pictures.map((picture, index) => (
              <li className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pe-1 ps-2.5 text-xs" key={`${picture.name}-${index}`}>
                <bdi className="max-w-40 truncate" dir="auto">
                  {picture.name}
                </bdi>
                <button
                  aria-label={`${t('remove_picture')}: ${picture.name}`}
                  className="grid size-5 cursor-pointer place-items-center rounded-full text-muted-fg hover:bg-secondary hover:text-fg"
                  onClick={() => setPictures(pictures.filter((_, i) => i !== index))}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-0.5">
          <textarea
            aria-label={t('question')}
            className={cn(
              'max-h-28 min-h-9 min-w-0 flex-1 resize-none rounded-2xl border-0 bg-muted px-3.5 py-2 text-sm leading-5 text-fg shadow-none',
              'placeholder:text-muted-fg focus:outline-hidden focus:ring-2 focus:ring-ring/25',
            )}
            disabled={busy}
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
              if (event.key === 'Escape') closeAssistant();
            }}
            onPaste={onPaste}
            placeholder={t('placeholder')}
            ref={field}
            rows={1}
            value={body}
          />
          <button
            aria-label={t('send')}
            className={cn(TOOL_BUTTON, body.trim() && !busy ? 'text-primary hover:bg-primary-subtle hover:text-primary' : 'opacity-50')}
            disabled={!body.trim() || busy}
            title={t('send')}
            type="submit"
          >
            <SendHorizontal aria-hidden="true" className="size-4 rtl:-scale-x-100" />
          </button>
        </div>
        <p className="mt-1 px-2 text-[0.6875rem] text-muted-fg">{t('footnote')}</p>
      </form>
    </section>
  );
}

function Bubble({ turn }: { readonly turn: Turn }) {
  const t = useTranslations('assistant');
  const mine = turn.role === 'user';
  const parts = turn.parts && turn.parts.length > 0 ? turn.parts : [{ text: turn.text, image: null }];
  return (
    <li className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')} data-assistant-turn={turn.role}>
      {parts.map((part, index) => (
        <div className={cn('flex max-w-full flex-col gap-1', mine ? 'items-end' : 'items-start')} key={index}>
          {part.text.trim() ? (
            <div className={cn(BUBBLE, mine ? MINE : THEIRS, turn.tone === 'error' && 'border border-danger/40 bg-danger-subtle text-danger-subtle-fg')} dir="auto">
              {renderNoah(part.text)}
            </div>
          ) : null}
          {part.image ? (
            <a className="block max-w-[90%] overflow-hidden rounded-2xl border border-border" href={part.image.dataUrl} rel="noreferrer" target="_blank" title={part.image.caption || part.image.fileName}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={part.image.caption || part.image.fileName} className="block w-full bg-muted" src={part.image.dataUrl} />
            </a>
          ) : null}
        </div>
      ))}
      {turn.attachment ? (
        <a
          className="inline-flex max-w-[90%] items-center gap-2 rounded-xl border border-border bg-overlay px-2.5 py-1.5 text-xs text-fg no-underline hover:bg-muted"
          download={turn.attachment.fileName}
          href={turn.attachment.dataUrl}
        >
          <Download aria-hidden="true" className="size-4 shrink-0 text-muted-fg" />
          <bdi className="truncate" dir="auto">
            {turn.attachment.fileName}
          </bdi>
          <span className="sr-only">{t('download')}</span>
        </a>
      ) : null}
    </li>
  );
}
