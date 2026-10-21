/**
 * Live container tracking (2026-10-21, by direction) — the half that asks.
 *
 * When somebody opens a container, its line is asked where the box is, in the
 * DCSA Track & Trace standard every large line publishes. The answer is kept
 * **in this process's memory only**, for `FRESH_MS`, so a page that refreshes
 * itself does not ask the line again each time — nothing is written to the
 * database, by direction ("without adding anything to the database").
 *
 * A line is asked only when its API is configured on the host, with the key
 * the line issued to the company (one per line, from its developer portal):
 *
 *   TRACKING_<CODE>_URL         the line's DCSA Track & Trace base address (https)
 *   TRACKING_<CODE>_KEY         the key it issued
 *   TRACKING_<CODE>_KEY_HEADER  the header the key travels in (default Ocp-Apim-Subscription-Key, MSC's)
 *   TRACKING_<CODE>_PATH        the query (default /events?equipmentReference={no})
 *
 * `<CODE>` is the line's code in `domain/container-tracking.CARRIERS` (MSC,
 * MAERSK, CMA, HAPAG …). Without one the screen still offers the line's own
 * public tracking page for the box, and says the live feed is not set up.
 */
import { carrierOf, readDcsaEvents, summarise, type Carrier, type TrackingEvent, type TrackingSummary } from '../domain/container-tracking';

/** How long an answer is reused: a line's events change in hours, not seconds. */
const FRESH_MS = 10 * 60_000;
/** A failed ask is not repeated at every refresh either. */
const FAILED_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_CACHED = 500;

export type TrackingState =
  /** The line answered; `events` is what it said. */
  | 'live'
  /** No API for this line on this host — the public page is the way. */
  | 'not_configured'
  /** The line is not known from the number or the B/L. */
  | 'unknown_carrier'
  /** The line was asked and did not answer usefully. */
  | 'failed';

export interface LiveTracking {
  readonly containerNo: string;
  readonly state: TrackingState;
  readonly carrier: { readonly code: string; readonly name: string } | null;
  /** The line's own public tracking page for this box. */
  readonly publicUrl: string | null;
  readonly events: readonly TrackingEvent[];
  readonly summary: TrackingSummary;
  /** When the line was asked (ISO); null when it was not. */
  readonly fetchedAt: string | null;
  /** Why it failed, in a short English sentence for the log and the tooltip. */
  readonly problem: string | null;
}

interface Config {
  readonly url: string;
  readonly key: string;
  readonly header: string;
  readonly path: string;
}

export function configFor(carrier: Carrier, env: NodeJS.ProcessEnv = process.env): Config | null {
  const url = env[`TRACKING_${carrier.code}_URL`]?.trim();
  const key = env[`TRACKING_${carrier.code}_KEY`]?.trim();
  if (!url || !key) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // The key is a secret: it goes over https only (a loopback stub may be http outside production).
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(loopback && env.NODE_ENV !== 'production')) return null;
  return {
    url: url.replace(/\/+$/, ''),
    key,
    header: env[`TRACKING_${carrier.code}_KEY_HEADER`]?.trim() || 'Ocp-Apim-Subscription-Key',
    path: env[`TRACKING_${carrier.code}_PATH`]?.trim() || '/events?equipmentReference={no}',
  };
}

const cache = new Map<string, { readonly until: number; readonly value: LiveTracking }>();
const inFlight = new Map<string, Promise<LiveTracking>>();

function remember(key: string, value: LiveTracking, forMs: number): LiveTracking {
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { until: Date.now() + forMs, value });
  return value;
}

/** Forgets every remembered answer — for the tests. */
export function forgetAll(): void {
  cache.clear();
  inFlight.clear();
}

async function ask(containerNo: string, carrier: Carrier, config: Config, fetcher: typeof fetch): Promise<LiveTracking> {
  const base = { containerNo, carrier: { code: carrier.code, name: carrier.name }, publicUrl: carrier.page(containerNo) };
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetcher(`${config.url}${config.path.replace('{no}', encodeURIComponent(containerNo))}`, {
      headers: { [config.header]: config.key, Accept: 'application/json', 'API-Version': '2' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ...base, state: 'failed', events: [], summary: summarise([]), fetchedAt, problem: `${carrier.name} answered ${response.status}.` };
    }
    const events = readDcsaEvents(await response.json());
    return { ...base, state: 'live', events, summary: summarise(events), fetchedAt, problem: null };
  } catch (error) {
    const problem = error instanceof Error && error.name === 'TimeoutError' ? `${carrier.name} did not answer within ${TIMEOUT_MS / 1000} seconds.` : `${carrier.name} could not be reached.`;
    return { ...base, state: 'failed', events: [], summary: summarise([]), fetchedAt, problem };
  }
}

/**
 * Where the box is now, as its line says — asked at most once per `FRESH_MS`
 * per box, never stored. Never throws: a line that cannot be asked is a state.
 */
export async function liveTrackingFor(
  containerNo: string,
  shippingLine: string | null,
  options: { readonly env?: NodeJS.ProcessEnv; readonly fetcher?: typeof fetch; readonly fresh?: boolean } = {},
): Promise<LiveTracking> {
  const no = containerNo.trim().toUpperCase();
  const carrier = carrierOf(no, shippingLine);
  if (!carrier) {
    return { containerNo: no, state: 'unknown_carrier', carrier: null, publicUrl: null, events: [], summary: summarise([]), fetchedAt: null, problem: null };
  }
  const config = configFor(carrier, options.env);
  if (!config) {
    return {
      containerNo: no,
      state: 'not_configured',
      carrier: { code: carrier.code, name: carrier.name },
      publicUrl: carrier.page(no),
      events: [],
      summary: summarise([]),
      fetchedAt: null,
      problem: null,
    };
  }
  const key = `${carrier.code}:${no}`;
  const kept = cache.get(key);
  if (kept && kept.until > Date.now() && !options.fresh) return kept.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = ask(no, carrier, config, options.fetcher ?? fetch)
    .then((value) => {
      if (value.state === 'failed') console.warn(`[tracking] ${no}: ${value.problem}`);
      return remember(key, value, value.state === 'live' ? FRESH_MS : FAILED_MS);
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}
