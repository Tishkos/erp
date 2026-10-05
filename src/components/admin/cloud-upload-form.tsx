'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Upload } from 'lucide-react';
import styles from './admin.module.css';

/**
 * Sends files to QS Cloud Files through the ERP's own upload route.
 *
 * One request per file, the raw bytes as the body, so the browser can report
 * progress and a large file is never held whole by the server. A file is
 * shown as uploaded ONLY when the route answers 201 — which it does only
 * after the cloud has confirmed the file at the size sent. A failure says why
 * and offers to try again (safe: the route never replaces a file, so a repeat
 * after an unlucky half-success is refused, not doubled).
 *
 * The words are the page's (`labels`), already in the reader's language; the
 * placeholders `{name}`, `{percent}` and `{error}` are filled here.
 */
export interface CloudUploadLabels {
  readonly choose: string;
  readonly start: string;
  readonly retry: string;
  readonly waiting: string;
  readonly sending: string;
  readonly done: string;
  readonly failed: string;
  readonly hint: string;
  readonly network: string;
  readonly finished: string;
}

type State = 'waiting' | 'sending' | 'done' | 'failed';
interface Item {
  readonly id: number;
  readonly file: File;
  readonly state: State;
  readonly percent: number;
  readonly error: string | null;
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

export function CloudUploadForm({ endpoint, labels }: { readonly endpoint: string; readonly labels: CloudUploadLabels }) {
  const router = useRouter();
  const [items, setItems] = useState<readonly Item[]>([]);
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const patch = (id: number, change: Partial<Item>) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));

  function send(item: Item): Promise<boolean> {
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      const joiner = endpoint.includes('?') ? '&' : '?';
      request.open('POST', `${endpoint}${joiner}name=${encodeURIComponent(item.file.name)}`);
      request.setRequestHeader('X-Requested-With', 'qimah-documents');
      request.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) patch(item.id, { percent: Math.min(99, Math.round((event.loaded / event.total) * 100)) });
      };
      request.onerror = () => {
        patch(item.id, { state: 'failed', error: labels.network });
        resolve(false);
      };
      request.onload = () => {
        let answer: { ok?: boolean; error?: string } = {};
        try {
          answer = JSON.parse(request.responseText) as typeof answer;
        } catch {
          /* not ours: treated as a failure below */
        }
        if (request.status === 201 && answer.ok === true) {
          patch(item.id, { state: 'done', percent: 100, error: null });
          resolve(true);
        } else {
          patch(item.id, { state: 'failed', error: answer.error ?? labels.network });
          resolve(false);
        }
      };
      patch(item.id, { state: 'sending', percent: 0, error: null });
      request.send(item.file);
    });
  }

  async function run(queue: readonly Item[]) {
    setBusy(true);
    let any = false;
    for (const item of queue) {
      if (await send(item)) any = true;
    }
    setBusy(false);
    // What the cloud now holds is read again from the cloud, not assumed.
    if (any) router.refresh();
  }

  const pending = items.filter((item) => item.state === 'waiting');
  const failed = items.filter((item) => item.state === 'failed');

  return (
    <div className={styles.uploadForm}>
      <label className={styles.uploadPicker}>
        <Upload aria-hidden="true" />
        <span>{labels.choose}</span>
        <input
          disabled={busy}
          multiple
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            setItems((current) => [
              ...current.filter((item) => item.state !== 'waiting'),
              ...chosen.map((file) => ({ id: (counter.current += 1), file, state: 'waiting' as const, percent: 0, error: null })),
            ]);
            event.target.value = '';
          }}
          ref={input}
          type="file"
        />
      </label>

      {items.length > 0 ? (
        <ul aria-live="polite" className={styles.fileList} id={listId}>
          {items.map((item) => (
            <li key={item.id}>
              <span className={styles.fileIcon}>
                <FileText aria-hidden="true" />
              </span>
              <span className={styles.fileBody}>
                <bdi dir="auto">{item.file.name}</bdi>
                <span className={styles.fileMeta}>
                  {item.state === 'waiting' ? labels.waiting : null}
                  {item.state === 'sending' ? fill(labels.sending, { percent: item.percent }) : null}
                  {item.state === 'done' ? fill(labels.done, { name: item.file.name }) : null}
                  {item.state === 'failed' ? fill(labels.failed, { error: item.error ?? '' }) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.submitRow}>
        {pending.length > 0 ? (
          <button className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={() => void run(pending)} type="button">
            {labels.start}
          </button>
        ) : null}
        {failed.length > 0 ? (
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => {
              const again = failed.map((item) => ({ ...item, state: 'waiting' as const, error: null }));
              setItems((current) => current.map((item) => again.find((a) => a.id === item.id) ?? item));
              void run(again);
            }}
            type="button"
          >
            {labels.retry}
          </button>
        ) : null}
      </div>
      {items.length > 0 && !busy && pending.length === 0 && failed.length === 0 ? <p className={styles.uploadHint}>{labels.finished}</p> : null}
      <p className={styles.uploadHint}>{labels.hint}</p>
    </div>
  );
}
