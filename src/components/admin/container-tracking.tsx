'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Radio, Ship } from 'lucide-react';
import type { LiveTracking } from '@/server/services/container-tracking';

/**
 * Live tracking of one container (2026-10-21): asks `endpoint` when the page
 * opens and every `everyMs` while the tab is in front, and draws where the
 * line says the box is — the last thing that happened, the vessel, the line's
 * expected arrival beside ours, and every event it gave. Nothing it shows is
 * stored; a line that is not set up still gets its own public page as a link.
 */
export interface ContainerTrackingLabels {
  readonly title: string;
  readonly live: string;
  readonly asking: string;
  readonly open_on: string;
  readonly last_event: string;
  readonly on_vessel: string;
  readonly carrier_eta: string;
  readonly our_eta: string;
  readonly checked: string;
  readonly none: string;
  readonly not_configured: string;
  readonly unknown_carrier: string;
  readonly failed: string;
  readonly estimated: string;
  readonly planned: string;
  readonly events: Readonly<Record<string, string>>;
}

export function ContainerTracking({
  endpoint,
  labels,
  locale,
  ourEta,
  everyMs = 5 * 60_000,
}: {
  readonly endpoint: string;
  readonly labels: ContainerTrackingLabels;
  readonly locale: string;
  /** The ETA the company keeps, ISO date, to set beside the line's. */
  readonly ourEta: string | null;
  readonly everyMs?: number;
}) {
  const [data, setData] = useState<LiveTracking | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch(endpoint, { cache: 'no-store', headers: { 'X-Requested-With': 'qimah-tracking' } });
          if (!response.ok) throw new Error(String(response.status));
          const answer = (await response.json()) as LiveTracking;
          if (!stopped) {
            setData(answer);
            setFailed(false);
          }
        } catch {
          if (!stopped) setFailed(true);
        }
      }
      if (!stopped) timer = setTimeout(load, everyMs);
    };
    void load();
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [endpoint, everyMs]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad' }).format(new Date(iso));
  const date = (iso: string) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
  const kind = (code: string) => labels.events[code] ?? labels.events.other ?? code;
  const carrierName = data?.carrier?.name ?? '';

  const link = data?.publicUrl ? (
    <a className="inline-flex items-center gap-1 text-sm font-medium text-primary-subtle-fg underline-offset-2 hover:underline" data-tracking-link="" href={data.publicUrl} rel="noopener noreferrer" target="_blank">
      {labels.open_on.replace('{carrier}', carrierName)}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  ) : null;

  const newestFirst = data ? [...data.events].reverse() : [];
  const { last, expectedArrival, onVessel } = data?.summary ?? { last: null, expectedArrival: null, onVessel: null };

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-container-tracking="" data-tracking-state={data?.state ?? (failed ? 'failed' : 'loading')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Ship aria-hidden="true" className="size-4 text-muted-fg" />
          {carrierName || '—'}
        </span>
        {data?.state === 'live' ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-success-subtle px-2 py-0.5 text-xs font-medium text-success-subtle-fg">
            <Radio aria-hidden="true" className="size-3.5" />
            {labels.live}
          </span>
        ) : null}
        {data?.fetchedAt ? <span className="text-xs text-muted-fg">{labels.checked.replace('{time}', time(data.fetchedAt))}</span> : null}
        <span className="ms-auto">{link}</span>
      </div>

      {!data && !failed ? <p className="text-sm text-muted-fg">{labels.asking}</p> : null}
      {failed && !data ? <p className="text-sm text-muted-fg">{labels.failed}</p> : null}
      {data?.state === 'not_configured' ? <p className="text-sm text-muted-fg">{labels.not_configured.replace('{carrier}', carrierName)}</p> : null}
      {data?.state === 'unknown_carrier' ? <p className="text-sm text-muted-fg">{labels.unknown_carrier}</p> : null}
      {data?.state === 'failed' ? (
        <p className="text-sm text-muted-fg" title={data.problem ?? undefined}>
          {labels.failed}
        </p>
      ) : null}

      {data?.state === 'live' ? (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border p-2.5">
              <dt className="text-xs text-muted-fg">{labels.last_event}</dt>
              <dd className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">
                {last ? (
                  <>
                    {kind(last.kind)}
                    {last.place ? (
                      <>
                        {' · '}
                        <bdi dir="auto">{last.place}</bdi>
                      </>
                    ) : null}
                    <span className="block text-xs font-normal text-muted-fg">
                      <bdi dir="ltr">{time(last.at)}</bdi>
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <dt className="text-xs text-muted-fg">{labels.on_vessel}</dt>
              <dd className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">
                <bdi dir="auto">{onVessel ?? '—'}</bdi>
              </dd>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <dt className="text-xs text-muted-fg">{labels.carrier_eta}</dt>
              <dd className="mt-0.5 text-sm font-medium" data-carrier-eta="">
                {expectedArrival ? (
                  <>
                    <bdi dir="ltr">{date(expectedArrival.at)}</bdi>
                    {expectedArrival.place ? (
                      <>
                        {' · '}
                        <bdi dir="auto">{expectedArrival.place}</bdi>
                      </>
                    ) : null}
                  </>
                ) : (
                  '—'
                )}
                {ourEta ? (
                  <span className={`block text-xs font-normal ${expectedArrival && expectedArrival.at.slice(0, 10) > ourEta ? 'text-danger-subtle-fg' : 'text-muted-fg'}`}>
                    {labels.our_eta} <bdi dir="ltr">{date(ourEta)}</bdi>
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          {newestFirst.length === 0 ? (
            <p className="text-sm text-muted-fg">{labels.none}</p>
          ) : (
            <ol className="flex flex-col divide-y divide-border text-sm" data-tracking-events="">
              {newestFirst.map((event, index) => (
                <li className={`flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-4 ${event.certainty === 'actual' ? '' : 'text-muted-fg'}`} data-tracking-event={event.code} key={`${event.at}-${event.code}-${index}`}>
                  <span className="shrink-0 tabular-nums sm:w-44">
                    <bdi dir="ltr">{time(event.at)}</bdi>
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <strong className="font-medium">{kind(event.kind)}</strong>
                    {event.certainty !== 'actual' ? <span className="ms-1 rounded bg-muted px-1 text-xs">{event.certainty === 'estimated' ? labels.estimated : labels.planned}</span> : null}
                    {event.place ? (
                      <>
                        {' · '}
                        <bdi dir="auto">{event.place}</bdi>
                      </>
                    ) : null}
                    {event.vessel ? (
                      <span className="text-muted-fg">
                        {' · '}
                        <bdi dir="auto">{event.vessel}</bdi>
                        {event.voyage ? <bdi dir="ltr">{` ${event.voyage}`}</bdi> : null}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}
