/**
 * Live container tracking (2026-10-21): the line a box travels with, the
 * line's own page for it, a DCSA Track & Trace answer read as events, and the
 * service that asks — only when configured, over https, remembered in memory
 * and never stored. No network: the line is a stand-in `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CARRIERS, TRACKING_KINDS, carrierOf, readDcsaEvents, summarise } from '@/server/domain/container-tracking';
import { configFor, forgetAll, liveTrackingFor } from '@/server/services/container-tracking';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

/** A DCSA v2.2 answer for one MSC box: loaded at Jebel Ali, departed, expected at Umm Qasr. */
const ANSWER = [
  {
    eventType: 'EQUIPMENT',
    eventClassifierCode: 'ACT',
    eventDateTime: '2026-10-15T08:30:00Z',
    equipmentEventTypeCode: 'LOAD',
    equipmentReference: 'MSCU1234565',
    emptyIndicatorCode: 'LADEN',
    transportCall: { location: { UNLocationCode: 'AEJEA', locationName: 'Jebel Ali' }, vessel: { vesselName: 'MSC AURORA' }, exportVoyageNumber: 'FA542E' },
  },
  {
    eventType: 'TRANSPORT',
    eventClassifierCode: 'ACT',
    eventDateTime: '2026-10-16T02:00:00Z',
    transportEventTypeCode: 'DEPA',
    transportCall: { location: { UNLocationCode: 'AEJEA', locationName: 'Jebel Ali' }, vessel: { vesselName: 'MSC AURORA' } },
  },
  // The same event twice, as lines sometimes send it.
  {
    eventType: 'TRANSPORT',
    eventClassifierCode: 'ACT',
    eventDateTime: '2026-10-16T02:00:00Z',
    transportEventTypeCode: 'DEPA',
    transportCall: { location: { UNLocationCode: 'AEJEA', locationName: 'Jebel Ali' }, vessel: { vesselName: 'MSC AURORA' } },
  },
  {
    eventType: 'TRANSPORT',
    eventClassifierCode: 'EST',
    eventDateTime: '2026-10-24T06:00:00Z',
    transportEventTypeCode: 'ARRI',
    transportCall: { location: { UNLocationCode: 'IQUQR', locationName: 'Umm Qasr' }, vessel: { vesselName: 'MSC AURORA' } },
  },
  // Paperwork says nothing about where the box is.
  { eventType: 'SHIPMENT', eventClassifierCode: 'ACT', eventDateTime: '2026-10-10T00:00:00Z', shipmentEventTypeCode: 'CONF' },
];

describe('CT1 · the line a container travels with', () => {
  it('is read from the box’s owner code, else from the B/L’s shipping line', () => {
    expect(carrierOf('MSCU1234565')?.code).toBe('MSC');
    expect(carrierOf('medu7654321')?.code).toBe('MSC');
    expect(carrierOf('MSKU0000000')?.code).toBe('MAERSK');
    expect(carrierOf('HLXU1111111')?.code).toBe('HAPAG');
    // A leased box names no line; its B/L does.
    expect(carrierOf('TGHU1234567')).toBeNull();
    expect(carrierOf('TGHU1234567', 'MSC Mediterranean Shipping Co.')?.code).toBe('MSC');
    expect(carrierOf('TGHU1234567', 'CMA CGM')?.code).toBe('CMA');
    // A word inside another is not the line ("comsco" is not COSCO, "zimbabwe" is not ZIM).
    expect(carrierOf('TGHU1234567', 'Zimbabwe Freight')).toBeNull();
  });

  it('every line has its own public page for the box, over https, and no owner code is claimed twice', () => {
    const prefixes = CARRIERS.flatMap((carrier) => carrier.prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const carrier of CARRIERS) {
      const url = new URL(carrier.page('MSCU1234565'));
      expect(url.protocol).toBe('https:');
      expect(url.toString()).toContain('MSCU1234565');
    }
  });
});

describe('CT2 · a DCSA answer read as events', () => {
  it('oldest first, once each, paperwork left out; actual, expected and planned told apart', () => {
    const events = readDcsaEvents(ANSWER);
    expect(events.map((event) => `${event.kind}/${event.certainty}/${event.locode}`)).toEqual(['loaded/actual/AEJEA', 'departed/actual/AEJEA', 'arrived/estimated/IQUQR']);
    expect(events[0]).toMatchObject({ place: 'Jebel Ali', vessel: 'MSC AURORA', voyage: 'FA542E', code: 'LOAD' });
    expect(readDcsaEvents({ events: ANSWER })).toHaveLength(3);
    expect(readDcsaEvents('nonsense')).toEqual([]);
    expect(readDcsaEvents([{ eventDateTime: 'not a date', equipmentEventTypeCode: 'LOAD' }])).toEqual([]);
  });

  it('the summary: what last happened, the vessel it is on, the line’s expected arrival still ahead', () => {
    const summary = summarise(readDcsaEvents(ANSWER), new Date('2026-10-20T00:00:00Z'));
    expect(summary.last?.kind).toBe('departed');
    expect(summary.onVessel).toBe('MSC AURORA');
    expect(summary.expectedArrival?.place).toBe('Umm Qasr');
    // Once the box is discharged it is on no vessel.
    const landed = summarise(
      readDcsaEvents([...ANSWER, { eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', eventDateTime: '2026-10-24T09:00:00Z', equipmentEventTypeCode: 'DISC', transportCall: { location: { locationName: 'Umm Qasr' } } }]),
      new Date('2026-10-25T00:00:00Z'),
    );
    expect(landed.onVessel).toBeNull();
    expect(landed.expectedArrival).toBeNull();
  });

  it('every kind of event has its words in both languages', () => {
    for (const catalogue of [en, ar]) {
      const tracking = (catalogue as unknown as { admin: { tracking: { event: Record<string, string> } } }).admin.tracking;
      for (const kind of TRACKING_KINDS) expect(tracking.event[kind], kind).toBeTruthy();
    }
  });
});

describe('CT3 · the service asks only when set up, and remembers in memory only', () => {
  const env = { TRACKING_MSC_URL: 'https://api.example-line.test/track/v2', TRACKING_MSC_KEY: 'k-123', NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
  beforeEach(() => forgetAll());

  it('without a key the line is not asked, and its public page is offered', async () => {
    const fetcher = vi.fn();
    const result = await liveTrackingFor('MSCU1234565', null, { env: {} as NodeJS.ProcessEnv, fetcher: fetcher as unknown as typeof fetch });
    expect(result).toMatchObject({ state: 'not_configured', carrier: { code: 'MSC' } });
    expect(result.publicUrl).toContain('msc.com');
    expect(fetcher).not.toHaveBeenCalled();
    expect((await liveTrackingFor('TGHU1234567', null, { env })).state).toBe('unknown_carrier');
  });

  it('the key travels over https only', () => {
    const msc = CARRIERS.find((carrier) => carrier.code === 'MSC')!;
    expect(configFor(msc, { ...env, TRACKING_MSC_URL: 'http://api.example-line.test' })).toBeNull();
    expect(configFor(msc, { ...env, TRACKING_MSC_URL: 'http://127.0.0.1:9000', NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toBeNull();
    expect(configFor(msc, env)).toMatchObject({ header: 'Ocp-Apim-Subscription-Key', path: '/events?equipmentReference={no}' });
  });

  it('asks the line with its key, reads the answer, and asks once for many lookers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(ANSWER), { status: 200, headers: { 'content-type': 'application/json' } }));
    const [a, b] = await Promise.all([
      liveTrackingFor('MSCU1234565', null, { env, fetcher: fetcher as unknown as typeof fetch }),
      liveTrackingFor('mscu1234565', null, { env, fetcher: fetcher as unknown as typeof fetch }),
    ]);
    expect(a.state).toBe('live');
    expect(b.events).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example-line.test/track/v2/events?equipmentReference=MSCU1234565');
    expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('k-123');
    // Remembered: the next look within minutes does not ask again.
    await liveTrackingFor('MSCU1234565', null, { env, fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a line that refuses or does not answer is a state, never an error', async () => {
    const refusing = vi.fn(async () => new Response('no', { status: 401 }));
    const result = await liveTrackingFor('MSCU1234565', null, { env, fetcher: refusing as unknown as typeof fetch });
    expect(result).toMatchObject({ state: 'failed', problem: 'MSC answered 401.' });
    forgetAll();
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await liveTrackingFor('MSCU1234565', null, { env, fetcher: unreachable as unknown as typeof fetch })).problem).toBe('MSC could not be reached.');
  });
});
