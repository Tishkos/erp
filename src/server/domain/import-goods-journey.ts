/**
 * The goods' journey on the import application's page — by direction 2026-10-07:
 *
 *   "after the payment application for a payable amount (percentage or amount
 *    in front) automatically nicely makes the payment, it should write
 *    somewhere that [the goods went] from On Process to In Process, [and]
 *    others are pending — a new block, nicely with icons".
 *
 * One stepper, in the order a person says it out loud:
 *
 *   On Process (Without SWIFT) → In Process → B/L → Containers → Customs (PD)
 *   → Clearance → Landed cost → Received into stock
 *
 * The first step is drawn only for an import whose invoice agreed an advance
 * AND whose goods the posting held (`ADVANCE_HELD` on its log, or goods still
 * in the hold) — an advance agreed before the hold existed never held anything,
 * and the page does not pretend it did. Without it, In Process is the first
 * step and means "the invoice posted".
 *
 * Every state is one test over a fact the engines already wrote — the log's
 * hold and release lines, the payment application's confirmation date, the
 * B/Ls, containers, PDs and declarations as `logistics-views` reads them, the
 * landed-cost charges and locks. Nothing here is a stage of its own: a step
 * whose evidence has no date says so (`on: null`) rather than guessing one.
 *
 * The steps are not strictly ordered in time (a PD may stand before the B/L),
 * so a later step can be done while an earlier one waits; the *current* step
 * is the first in order that is not done.
 *
 * Pure: no database, no clock.
 */

export const GOODS_STEPS = ['on_process', 'in_process', 'bl', 'containers', 'customs', 'clearance', 'landed_cost', 'received'] as const;
export type GoodsStep = (typeof GOODS_STEPS)[number];

/** Done, part-way (some containers in, charges booked but not locked), or not yet. */
export type GoodsStepState = 'done' | 'partial' | 'pending';

/** A document a step points at — drawn as the shared profile link. */
export interface GoodsDocument {
  readonly kind: 'purchase_invoice' | 'payment_application' | 'bl' | 'container' | 'pd' | 'customs_declaration' | 'landed_cost';
  readonly no: string;
  /** A PD's registration year, a container's id — what narrows its page. */
  readonly year?: number | null;
  readonly id?: string | null;
}

/** A sentence of the step, as a message key under `admin.payables` and its values. */
export interface GoodsPhrase {
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export interface GoodsStepView {
  readonly step: GoodsStep;
  readonly state: GoodsStepState;
  /** The first step in order that is not done — highlighted, with a soft pulse. */
  readonly current: boolean;
  /** The business date the step happened (YYYY-MM-DD); null when not done or not recorded. */
  readonly on: string | null;
  readonly document: GoodsDocument | null;
  readonly detail: GoodsPhrase | null;
  /** Under the step: what it waits for, and the document that will move it. */
  readonly note: (GoodsPhrase & { readonly document: GoodsDocument | null }) | null;
  /** The received step: the warehouses the goods went into, by name ("Received into Main Warehouse"). */
  readonly place?: readonly string[];
}

/** What the engines know about one import — every field read from rows or the import's own log. */
export interface GoodsJourneyFacts {
  /** The advance the import's invoice agreed (the first that agreed one), or null for none. */
  readonly advance: {
    readonly invoiceNo: string;
    readonly posted: boolean;
    readonly basis: 'percent' | 'amount';
    /** "20" for 20%, as stored. */
    readonly percent: string | null;
    /** The amount written, as stored, in `currency`. */
    readonly amount: string | null;
    readonly currency: string;
    /** The payment application raised for it at posting, if any. */
    readonly applicationNo: string | null;
  } | null;
  /** The business date of the posting's `ADVANCE_HELD` line; null when the log has none. */
  readonly heldOn: string | null;
  /** Whether goods of the import still sit in On Process (Without SWIFT) (`advance-hold.heldOf`). */
  readonly heldNow: boolean;
  /** The `ADVANCE_RELEASED` line: the application that released the goods and its confirmation date. */
  readonly released: { readonly applicationNo: string; readonly on: string | null } | null;
  /** The first posted import invoice and its posting's business date. */
  readonly posted: { readonly invoiceNo: string; readonly on: string | null } | null;
  /**
   * A migrated import (the sheet's, `source = 'sheet_import'`) that has no invoice in the ERP: nothing
   * posted it and nothing held it, so its payment applications say where its goods stand — as the
   * advance does for an import born here. `paid` is the first application the bank confirmed (its SWIFT
   * date); `waiting` is the application that stands while none is paid. Null or absent for every other import.
   */
  readonly legacy?: {
    readonly paid: { readonly applicationNo: string; readonly on: string | null } | null;
    readonly waiting: { readonly applicationNo: string } | null;
  } | null;
  /**
   * 0426 — the import is paid after the goods arrive, since this business day: nothing waits for a
   * SWIFT, so its goods are In Process from the start (or from that day, when they were held before).
   * Null or absent for every other import.
   */
  readonly payAfterArrival?: { readonly on: string | null } | null;
  /** Null when the viewer may not read B/Ls and containers. */
  readonly shipping: {
    readonly bls: readonly { readonly blNo: string; readonly blDate: string | null }[];
    readonly containers: readonly {
      readonly id: string;
      readonly containerNo: string;
      readonly customsClearedOn: string | null;
      readonly receivedOn: string | null;
      /** The container's own status (`container_status`: not_loaded, on_sea, at_port, customs_cleared, received, late, missing_damaged). */
      readonly statusCode?: string | null;
      readonly eta?: string | null;
      readonly arrivedPortOn?: string | null;
      /** Where its receipt took it, and that warehouse's name. */
      readonly warehouseCode?: string | null;
      readonly warehouseName?: string | null;
    }[];
    /** The business date of the log's first `CONTAINER_ADDED` (or `BL_ISSUED`) line. */
    readonly containersAddedOn: string | null;
  } | null;
  /** Null when the viewer may not read PDs. Standing PDs only (not replaced by a re-registration). */
  readonly customs: {
    readonly pds: readonly { readonly pdNo: string; readonly year: number | null; readonly statusName: string; readonly statusDate: string | null }[];
    /** Cleared declarations; null when the viewer may not read declarations. */
    readonly clearedDeclarations: readonly { readonly declarationNo: string; readonly statusDate: string | null }[] | null;
  } | null;
  /** Null when the viewer may not read the landed cost. */
  readonly landed: {
    readonly liveCharges: number;
    readonly locks: readonly { readonly sequence: number; readonly lockDate: string }[];
  } | null;
  readonly payableNo: string;
}

const earliest = (dates: readonly (string | null | undefined)[]): string | null =>
  dates.filter((day): day is string => Boolean(day)).sort()[0] ?? null;
const latest = (dates: readonly (string | null | undefined)[]): string | null =>
  dates.filter((day): day is string => Boolean(day)).sort().at(-1) ?? null;

/** Whether the import's goods were ever held for an advance — the first step is drawn only then. */
export function heldForAdvance(facts: GoodsJourneyFacts): boolean {
  if (!facts.advance) return false;
  // Agreed and not posted yet: the hold is what the posting will do — none for an import paid after arrival (0426).
  if (!facts.advance.posted) return !facts.payAfterArrival;
  return facts.heldNow || facts.heldOn !== null || facts.released !== null;
}

type Draft = Omit<GoodsStepView, 'current'>;

const step = (value: GoodsStep, state: GoodsStepState, rest: Partial<Omit<Draft, 'step' | 'state'>> = {}): Draft => ({
  step: value,
  state,
  on: rest.on ?? null,
  document: rest.document ?? null,
  detail: rest.detail ?? null,
  note: rest.note ?? null,
});

const phrase = (key: string, params: Readonly<Record<string, string | number>> = {}): GoodsPhrase => ({ key, params });

/** The payable amount as the invoice chose it: "20%" or the amount in its currency (the screen formats it). */
export function advanceAmountOf(advance: NonNullable<GoodsJourneyFacts['advance']>): { readonly kind: 'percent' | 'amount'; readonly value: string; readonly currency: string } {
  if (advance.basis === 'amount') return { kind: 'amount', value: advance.amount ?? '0', currency: advance.currency };
  // "20.0000" → "20", "12.5000" → "12.5": the column keeps four places, a person does not.
  const percent = (advance.percent ?? '0').replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1');
  return { kind: 'percent', value: percent, currency: advance.currency };
}

/** The steps, in order, with their states and the current one marked. */
export function goodsJourney(facts: GoodsJourneyFacts): GoodsStepView[] {
  const steps: Draft[] = [];
  const advance = facts.advance;

  // ── 1 · On Process (Without SWIFT) — only for an import held for its advance.
  if (advance && heldForAdvance(facts)) {
    const invoice: GoodsDocument = { kind: 'purchase_invoice', no: advance.invoiceNo };
    const application: GoodsDocument | null = advance.applicationNo ? { kind: 'payment_application', no: advance.applicationNo } : null;
    if (!advance.posted) {
      steps.push(step('on_process', 'pending', { document: invoice, detail: phrase('journey_on_process_unposted') }));
    } else {
      // Held at posting; done once the goods left the hold for In Process.
      const done = !facts.heldNow && (facts.released !== null || Boolean(facts.payAfterArrival));
      steps.push(
        step('on_process', done ? 'done' : 'partial', {
          on: facts.heldOn,
          document: invoice,
          detail: phrase('journey_on_process_amount'),
          note: facts.heldNow
            ? application
              ? { ...phrase('journey_held_note', { application: application.no }), document: application }
              : { ...phrase('journey_held_note_none'), document: null }
            : null,
        }),
      );
    }
    // ── 2 · In Process — the advance paid, the goods released; or released to be paid after arrival (0426).
    steps.push(
      facts.released
        ? step('in_process', 'done', {
            on: facts.released.on,
            document: { kind: 'payment_application', no: facts.released.applicationNo },
            detail: phrase('journey_released'),
          })
        : facts.payAfterArrival && !facts.heldNow
          ? step('in_process', 'done', { on: facts.payAfterArrival.on, detail: phrase('journey_pay_after_arrival') })
          : step('in_process', 'pending', { detail: phrase('journey_released_pending') }),
    );
  } else if (facts.legacy && !facts.posted) {
    // ── A migrated import has no invoice here: its payment applications stand for the advance.
    // Waiting for the SWIFT is On Process (Without SWIFT); the first SWIFT, or goods already on a
    // B/L, is In Process.
    const { paid, waiting } = facts.legacy;
    const shipped = (facts.shipping?.bls.length ?? 0) > 0;
    if (paid) {
      steps.push(
        step('in_process', 'done', { on: paid.on, document: { kind: 'payment_application', no: paid.applicationNo }, detail: phrase('journey_legacy_paid') }),
      );
    } else if (shipped) {
      steps.push(step('in_process', 'done', { detail: phrase('journey_legacy_shipped') }));
    } else if (facts.payAfterArrival) {
      // 0426 — nothing waits for a SWIFT: the goods are In Process and are paid for once they arrive.
      steps.push(step('in_process', 'done', { on: facts.payAfterArrival.on, detail: phrase('journey_pay_after_arrival') }));
    } else if (waiting) {
      steps.push(
        step('on_process', 'partial', { document: { kind: 'payment_application', no: waiting.applicationNo }, detail: phrase('journey_legacy_waiting') }),
        step('in_process', 'pending', { detail: phrase('journey_released_pending') }),
      );
    } else {
      steps.push(step('in_process', 'pending', { detail: phrase('journey_legacy_unpaid') }));
    }
  } else {
    // ── Without an advance, In Process is the first step: the invoice posted.
    steps.push(
      facts.posted
        ? step('in_process', 'done', {
            on: facts.posted.on,
            document: { kind: 'purchase_invoice', no: facts.posted.invoiceNo },
            detail: phrase('journey_invoice_posted'),
          })
        : step('in_process', 'pending', { detail: phrase('journey_invoice_unposted') }),
    );
  }

  // ── 3 · B/L and 4 · Containers — the shipping lane, as `logistics-views` reads it.
  if (facts.shipping) {
    const { bls, containers } = facts.shipping;
    const first = bls[0];
    steps.push(
      first
        ? step('bl', 'done', {
            on: earliest(bls.map((bl) => bl.blDate)),
            document: { kind: 'bl', no: first.blNo },
            detail: phrase('journey_bl', { count: bls.length }),
          })
        : step('bl', 'pending'),
    );
    const box = containers[0];
    steps.push(
      box
        ? step('containers', 'done', {
            on: facts.shipping.containersAddedOn,
            document: { kind: 'container', no: box.containerNo, id: box.id },
            detail: phrase('journey_containers', { count: containers.length }),
          })
        : step('containers', 'pending'),
    );
  }

  // ── 5 · Customs (PD) — a standing PD.
  if (facts.customs) {
    const pd = facts.customs.pds[0];
    steps.push(
      pd
        ? step('customs', 'done', {
            on: pd.statusDate,
            document: { kind: 'pd', no: pd.pdNo, year: pd.year },
            detail: phrase('journey_pd', { status: pd.statusName, count: facts.customs.pds.length }),
          })
        : step('customs', 'pending'),
    );
  }

  // ── 6 · Clearance — a declaration cleared, or containers cleared (a received container has cleared).
  if (facts.shipping || facts.customs?.clearedDeclarations) {
    const containers = facts.shipping?.containers ?? [];
    const declarations = facts.customs?.clearedDeclarations ?? [];
    const cleared = containers.filter((box) => box.customsClearedOn || box.receivedOn);
    const declaration = declarations[0];
    const clearedBox = cleared.find((box) => box.customsClearedOn) ?? cleared[0];
    const on = earliest([...declarations.map((one) => one.statusDate), ...containers.map((box) => box.customsClearedOn)]);
    const document: GoodsDocument | null = declaration
      ? { kind: 'customs_declaration', no: declaration.declarationNo }
      : clearedBox
        ? { kind: 'container', no: clearedBox.containerNo, id: clearedBox.id }
        : null;
    if (containers.length > 0 && cleared.length > 0) {
      const all = cleared.length === containers.length;
      steps.push(
        step('clearance', all ? 'done' : 'partial', { on, document, detail: phrase('journey_cleared', { cleared: cleared.length, total: containers.length }) }),
      );
    } else if (declaration) {
      steps.push(step('clearance', 'done', { on, document, detail: phrase('journey_declaration_cleared', { count: declarations.length }) }));
    } else {
      steps.push(step('clearance', 'pending'));
    }
  }

  // ── 7 · Landed cost — locked, or charges booked and waiting for the lock.
  if (facts.landed) {
    const lock = [...facts.landed.locks].sort((a, b) => a.sequence - b.sequence).at(-1);
    const document: GoodsDocument = { kind: 'landed_cost', no: facts.payableNo };
    steps.push(
      lock
        ? step('landed_cost', 'done', { on: lock.lockDate, document, detail: phrase('journey_landed_locked', { sequence: lock.sequence }) })
        : facts.landed.liveCharges > 0
          ? step('landed_cost', 'partial', { document, detail: phrase('journey_landed_charges', { count: facts.landed.liveCharges }) })
          : step('landed_cost', 'pending'),
    );
  }

  // ── 8 · Received into the warehouse — the container receipts, and the warehouses they went into, by name
  //    (by direction, 2026-10-07: "instead of received into stock, received into the warehouse name").
  if (facts.shipping) {
    const containers = facts.shipping.containers;
    const received = containers.filter((box) => box.receivedOn);
    const last = [...received].sort((a, b) => (a.receivedOn! < b.receivedOn! ? -1 : 1)).at(-1);
    const place = [...new Set(received.map((box) => box.warehouseName || box.warehouseCode).filter((name): name is string => Boolean(name)))];
    steps.push(
      last
        ? {
            ...step('received', received.length === containers.length ? 'done' : 'partial', {
              on: latest(received.map((box) => box.receivedOn)),
              document: { kind: 'container', no: last.containerNo, id: last.id },
              detail: phrase('journey_received', { received: received.length, total: containers.length }),
            }),
            place,
          }
        : step('received', 'pending'),
    );
  }

  const currentIndex = steps.findIndex((one) => one.state !== 'done');
  return steps.map((one, index) => ({ ...one, current: index === currentIndex }));
}

/*
 * Where the goods are now (2026-10-07, by direction: "I want to know the
 * current situation of the item, where is it — like tracking: in process, oh
 * it moved on board, oh it moved to port, based on updates … sometimes some of
 * the containers arrive and some are still on board or processing").
 *
 * Each container is where its own status and dates put it — the container's
 * page is what moves it (on the sea, at port, cleared, received) — and the
 * import is where its containers are: one place when they are all in it, the
 * places side by side when they are split. Before any container, the import
 * is where its invoice put the goods: held for the advance, or in process.
 */
export const GOODS_PLACES = ['on_process', 'in_process', 'on_board', 'at_port', 'cleared', 'received'] as const;
export type GoodsPlace = (typeof GOODS_PLACES)[number] | 'missing';

export interface ContainerWhere {
  readonly id: string;
  readonly containerNo: string;
  readonly place: GoodsPlace;
  /** The date it reached that place, when the container records one. */
  readonly since: string | null;
  readonly eta: string | null;
  /** Its status says the ETA passed. */
  readonly late: boolean;
  /** For a received container, the warehouse it went into. */
  readonly warehouse: string | null;
  /** How far along the track it is: the index in GOODS_PLACES (missing counts as received's place). */
  readonly reached: number;
}

export interface GoodsWhereNow {
  /** One place for the whole import, or `split`; null before the invoice posted. */
  readonly place: GoodsPlace | 'split' | null;
  /** The places in track order, with how many containers stand in each and, for received, the warehouses. */
  readonly counts: readonly { readonly place: GoodsPlace; readonly count: number; readonly warehouses: readonly string[] }[];
  readonly containers: readonly ContainerWhere[];
}

const RECEIVED_STATUSES = new Set(['received']);
const CLEARED_STATUSES = new Set(['customs_cleared']);
const AT_PORT_STATUSES = new Set(['at_port']);
const ON_BOARD_STATUSES = new Set(['on_sea', 'late']);

/** Where one container stands, by its own status and dates — the furthest either says. */
export function containerWhere(
  box: NonNullable<GoodsJourneyFacts['shipping']>['containers'][number],
  held: boolean,
): ContainerWhere {
  const status = box.statusCode ?? null;
  const base = {
    id: box.id,
    containerNo: box.containerNo,
    eta: box.eta ?? null,
    late: status === 'late',
    warehouse: null as string | null,
  };
  if (status === 'missing_damaged') return { ...base, place: 'missing', since: box.receivedOn, reached: GOODS_PLACES.indexOf('received') };
  if (box.receivedOn || (status && RECEIVED_STATUSES.has(status))) {
    return { ...base, place: 'received', since: box.receivedOn, warehouse: box.warehouseName || box.warehouseCode || null, reached: GOODS_PLACES.indexOf('received') };
  }
  if (box.customsClearedOn || (status && CLEARED_STATUSES.has(status))) {
    return { ...base, place: 'cleared', since: box.customsClearedOn, reached: GOODS_PLACES.indexOf('cleared') };
  }
  if (box.arrivedPortOn || (status && AT_PORT_STATUSES.has(status))) {
    return { ...base, place: 'at_port', since: box.arrivedPortOn ?? null, reached: GOODS_PLACES.indexOf('at_port') };
  }
  if (status && ON_BOARD_STATUSES.has(status)) return { ...base, place: 'on_board', since: null, reached: GOODS_PLACES.indexOf('on_board') };
  // Not loaded yet: still where the invoice put the goods.
  const place = held ? 'on_process' : 'in_process';
  return { ...base, place, since: null, reached: GOODS_PLACES.indexOf(place) };
}

/** Where the import's goods are now — by container, and as a whole. */
export function goodsWhereNow(facts: GoodsJourneyFacts): GoodsWhereNow {
  // A migrated import with no invoice here: waiting for its first SWIFT is the hold; a SWIFT is In Process.
  const legacy = facts.legacy && !facts.posted ? facts.legacy : null;
  const waitsForSwift = Boolean(
    legacy && legacy.waiting && !legacy.paid && !facts.payAfterArrival && (facts.shipping?.bls.length ?? 0) === 0,
  );
  const held = facts.heldNow || (facts.advance !== null && heldForAdvance(facts) && facts.released === null && facts.advance.posted) || waitsForSwift;
  const containers = (facts.shipping?.containers ?? []).map((box) => containerWhere(box, held));
  if (containers.length === 0) {
    const place: GoodsPlace | null = held
      ? 'on_process'
      : facts.posted || facts.released || legacy?.paid || (legacy && facts.payAfterArrival)
        ? 'in_process'
        : null;
    return { place, counts: place ? [{ place, count: 0, warehouses: [] }] : [], containers };
  }
  const order: GoodsPlace[] = [...GOODS_PLACES, 'missing'];
  const counts = order
    .map((place) => {
      const here = containers.filter((box) => box.place === place);
      return {
        place,
        count: here.length,
        warehouses: [...new Set(here.map((box) => box.warehouse).filter((name): name is string => Boolean(name)))],
      };
    })
    .filter((row) => row.count > 0);
  return { place: counts.length === 1 ? counts[0]!.place : 'split', counts, containers };
}
