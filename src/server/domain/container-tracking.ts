/**
 * Live container tracking (2026-10-21, by direction: "each container have
 * tracking based on realtime … like some of them MSC, we can track them online
 * … implement it in the website, realtime, automatically … without adding
 * anything to the database").
 *
 * The pure half: which carrier a container belongs to (the owner prefix of its
 * ISO 6346 number, else the B/L's shipping line), the carrier's own public
 * tracking page for it, and the reading of a carrier's answer in the DCSA
 * Track & Trace standard (v2.2) — the one MSC, Maersk, Hapag-Lloyd, CMA CGM and
 * the other DCSA lines publish — into one list of events. Nothing here fetches
 * and nothing is stored: `services/container-tracking.ts` asks the carrier
 * when somebody looks, and keeps the answer in memory for a few minutes.
 */

export interface Carrier {
  /** Our code for the line, also the suffix of its environment keys (`TRACKING_MSC_URL`). */
  readonly code: string;
  readonly name: string;
  /** The owner codes (the first four letters of the container number) the line's own boxes carry. */
  readonly prefixes: readonly string[];
  /** Words a B/L's shipping line is written with, lower case. */
  readonly names: readonly string[];
  /** The line's public tracking page for one container. */
  readonly page: (containerNo: string) => string;
}

const q = encodeURIComponent;

/**
 * The lines the company's imports arrive with, and the few others that are
 * common on the way to Iraq. A leased box (TGHU, TCNU, CAIU …) names no line,
 * so it is found by its B/L's shipping line instead.
 */
export const CARRIERS: readonly Carrier[] = [
  {
    code: 'MSC',
    name: 'MSC',
    prefixes: ['MSCU', 'MEDU', 'MSDU', 'MSMU', 'MSNU', 'MSBU', 'MSZU', 'GLDU'],
    names: ['msc', 'mediterranean shipping'],
    page: (no) => `https://www.msc.com/en/track-a-shipment?trackingNumber=${q(no)}`,
  },
  {
    code: 'MAERSK',
    name: 'Maersk',
    prefixes: ['MSKU', 'MAEU', 'MRKU', 'MRSU', 'MNBU', 'MCAU', 'MSWU', 'SUDU', 'MCPU'],
    names: ['maersk', 'hamburg sud', 'sealand'],
    page: (no) => `https://www.maersk.com/tracking/${q(no)}`,
  },
  {
    code: 'CMA',
    name: 'CMA CGM',
    prefixes: ['CMAU', 'CGMU', 'ECMU', 'APHU', 'APLU', 'APZU', 'ANNU'],
    names: ['cma', 'cgm', 'apl', 'anl'],
    page: (no) => `https://www.cma-cgm.com/ebusiness/tracking/search?SearchBy=Container&Reference=${q(no)}`,
  },
  {
    code: 'HAPAG',
    name: 'Hapag-Lloyd',
    prefixes: ['HLXU', 'HLBU', 'HAMU', 'UACU', 'HLCU'],
    names: ['hapag', 'hlag', 'uasc'],
    page: (no) => `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${q(no)}`,
  },
  {
    code: 'COSCO',
    name: 'COSCO / OOCL',
    prefixes: ['CSNU', 'CBHU', 'CCLU', 'CSLU', 'OOLU', 'OOCU'],
    names: ['cosco', 'oocl', 'orient overseas'],
    page: (no) => `https://elines.coscoshipping.com/ebusiness/cargoTracking?trackingType=CONTAINER&number=${q(no)}`,
  },
  {
    code: 'ONE',
    name: 'ONE',
    prefixes: ['ONEU', 'NYKU', 'MOLU', 'KKLU', 'KKFU'],
    names: ['ocean network express', 'one line', 'nyk', 'mitsui', 'k line'],
    page: (no) => `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?ctrack-field=${q(no)}&trakNoParam=${q(no)}`,
  },
  {
    code: 'EVERGREEN',
    name: 'Evergreen',
    prefixes: ['EGHU', 'EISU', 'EMCU', 'EGSU', 'UGMU'],
    names: ['evergreen'],
    page: (no) => `https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do?SEL=s_cntr&NO=${q(no)}`,
  },
  {
    code: 'ZIM',
    name: 'ZIM',
    prefixes: ['ZIMU', 'ZCSU', 'ZCLU', 'ZWFU'],
    names: ['zim'],
    page: (no) => `https://www.zim.com/tools/track-a-shipment?consnumber=${q(no)}`,
  },
  {
    code: 'YANGMING',
    name: 'Yang Ming',
    prefixes: ['YMLU', 'YMMU'],
    names: ['yang ming', 'yangming'],
    page: (no) => `https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx?str=${q(no)}`,
  },
  {
    code: 'HMM',
    name: 'HMM',
    prefixes: ['HDMU', 'HMMU'],
    names: ['hmm', 'hyundai merchant'],
    page: (no) => `https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do?numbers=${q(no)}`,
  },
];

/**
 * The line a container travels with: its own box's owner code first (an MSC
 * box is MSCU / MEDU …), else the B/L's shipping line as typed, else nobody.
 */
export function carrierOf(containerNo: string, shippingLine?: string | null): Carrier | null {
  const owner = containerNo.trim().toUpperCase().slice(0, 4);
  const byBox = CARRIERS.find((carrier) => carrier.prefixes.includes(owner));
  if (byBox) return byBox;
  const line = (shippingLine ?? '').toLowerCase();
  if (!line.trim()) return null;
  return CARRIERS.find((carrier) => carrier.names.some((name) => new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(line))) ?? null;
}

// ---------------------------------------------------------------------------
// The carrier's answer — DCSA Track & Trace v2.2 events
// ---------------------------------------------------------------------------

/** What happened, in words the screen can say in both languages (`admin.tracking.event.<kind>`). */
export const TRACKING_KINDS = [
  'empty_out',
  'gate_in',
  'loaded',
  'departed',
  'arrived',
  'discharged',
  'transshipped',
  'gate_out',
  'empty_returned',
  'customs',
  'other',
] as const;
export type TrackingKind = (typeof TRACKING_KINDS)[number];

/** Done, expected or only planned — DCSA's ACT / EST / PLN. */
export type TrackingCertainty = 'actual' | 'estimated' | 'planned';

export interface TrackingEvent {
  /** ISO time the carrier gave. */
  readonly at: string;
  readonly kind: TrackingKind;
  readonly certainty: TrackingCertainty;
  /** The place, as the carrier names it ("Umm Qasr", "Jebel Ali") with its UN/LOCODE where given. */
  readonly place: string | null;
  readonly locode: string | null;
  readonly vessel: string | null;
  readonly voyage: string | null;
  /** The carrier's own code for the event (LOAD, DISC, GTIN …), kept for whoever asks. */
  readonly code: string;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const EQUIPMENT_KIND: Readonly<Record<string, TrackingKind>> = {
  LOAD: 'loaded',
  DISC: 'discharged',
  GTIN: 'gate_in',
  GTOT: 'gate_out',
  STUF: 'gate_in',
  STRP: 'empty_returned',
  PICK: 'empty_out',
  DROP: 'empty_returned',
  INSP: 'customs',
  RSEA: 'customs',
  RMVD: 'other',
};

/** One DCSA event (equipment, transport or shipment) as an event of ours; null for one that says nothing about the box. */
export function readDcsaEvent(raw: unknown): TrackingEvent | null {
  const event = obj(raw);
  if (!event) return null;
  const at = str(event.eventDateTime) ?? str(event.eventCreatedDateTime);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  const classifier = str(event.eventClassifierCode);
  const certainty: TrackingCertainty = classifier === 'EST' ? 'estimated' : classifier === 'PLN' ? 'planned' : 'actual';

  let kind: TrackingKind = 'other';
  let code = str(event.eventType) ?? 'EVENT';
  const equipmentCode = str(event.equipmentEventTypeCode);
  const transportCode = str(event.transportEventTypeCode);
  if (equipmentCode) {
    code = equipmentCode;
    kind = EQUIPMENT_KIND[equipmentCode] ?? 'other';
    // An empty box picked up or brought back reads differently from a full one moving.
    if (equipmentCode === 'GTOT' && str(event.emptyIndicatorCode) === 'EMPTY') kind = 'empty_out';
    if (equipmentCode === 'GTIN' && str(event.emptyIndicatorCode) === 'EMPTY') kind = 'empty_returned';
  } else if (transportCode) {
    code = transportCode;
    kind = transportCode === 'DEPA' ? 'departed' : transportCode === 'ARRI' ? 'arrived' : 'other';
  } else if (str(event.shipmentEventTypeCode)) {
    // A booking's paperwork says nothing about where the box is.
    return null;
  }

  const call = obj(event.transportCall);
  const location = obj(call?.location) ?? obj(event.eventLocation);
  const vessel = obj(call?.vessel);
  const facility = obj(location?.facility) ?? obj(call?.facility);
  const locode = str(location?.UNLocationCode) ?? str(call?.UNLocationCode);
  const place = str(location?.locationName) ?? str(facility?.facilityName) ?? str(call?.facilityName) ?? locode;
  return {
    at: new Date(at).toISOString(),
    kind,
    certainty,
    place,
    locode,
    vessel: str(vessel?.vesselName),
    voyage: str(call?.exportVoyageNumber) ?? str(call?.carrierExportVoyageNumber) ?? str(call?.importVoyageNumber) ?? str(call?.carrierImportVoyageNumber),
    code,
  };
}

/** A carrier's whole answer — an array, or `{ events: [...] }` — oldest first, a repeated event once. */
export function readDcsaEvents(raw: unknown): TrackingEvent[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(obj(raw)?.events) ? (obj(raw)!.events as unknown[]) : [];
  const seen = new Set<string>();
  const out: TrackingEvent[] = [];
  for (const item of list) {
    const event = readDcsaEvent(item);
    if (!event) continue;
    const key = `${event.at}|${event.code}|${event.certainty}|${event.locode ?? event.place ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface TrackingSummary {
  /** The last thing that really happened to the box. */
  readonly last: TrackingEvent | null;
  /** The carrier's expected arrival at the last port it names, if one is still ahead. */
  readonly expectedArrival: TrackingEvent | null;
  /** The vessel it was last loaded on, while it has not been discharged since. */
  readonly onVessel: string | null;
}

export function summarise(events: readonly TrackingEvent[], now: Date = new Date()): TrackingSummary {
  const actual = events.filter((event) => event.certainty === 'actual' && Date.parse(event.at) <= now.getTime() + 60_000);
  const last = actual[actual.length - 1] ?? null;
  const ahead = events.filter((event) => event.certainty !== 'actual' && (event.kind === 'arrived' || event.kind === 'discharged') && Date.parse(event.at) > now.getTime());
  const expectedArrival = ahead[ahead.length - 1] ?? null;
  const lastLoad = [...actual].reverse().find((event) => event.kind === 'loaded' || event.kind === 'discharged' || event.kind === 'departed');
  return { last, expectedArrival, onVessel: lastLoad && lastLoad.kind !== 'discharged' ? lastLoad.vessel : null };
}
