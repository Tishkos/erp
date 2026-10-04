/**
 * The import's journey on Home — platform phase, Agent 2.
 *
 *   Import Application → Shipping → B/L → Container → Customs → Clearance →
 *   Landed Cost → Receipt → Inventory
 *
 * Nine steps a person says out loud; the system's own stage computation is the
 * eight-stage rail in `payable_stage` (`payables.recomputeStage` /
 * `deriveStage`), which Home shows by name beside every import. The journey is
 * the same facts read from the other side: for each step, **one test over a
 * fact the logistics services already produced** — a B/L exists, a container
 * has left, a PD stands, a declaration cleared, a charge was booked, a
 * container was received, goods sit in a warehouse's cost layers. There is no
 * table that says "this stage is that stage": nothing here can drift from the
 * rail, because it never restates it.
 *
 * A step is *reached* when its evidence exists, independently of the others —
 * landed cost can only be locked after receipt, so the steps are not strictly
 * ordered in time and the count at each is "imports that have got there", not
 * a funnel that must shrink.
 *
 * **A step the viewer cannot read is not drawn.** The facts come from tables
 * under row security; a viewer without the grant would read zero rows, and
 * zero rows is not "nothing has happened". `stagesFor` therefore keeps only the
 * steps whose sources the person holds, so the picture never shows a fake zero.
 *
 * Pure: no database, no clock.
 */
import { can, type Principal } from './permissions';

export const JOURNEY_STAGES = [
  'application',
  'shipping',
  'bl',
  'container',
  'customs',
  'clearance',
  'landed_cost',
  'receipt',
  'inventory',
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** The objects whose `view` grant lets a person read the evidence for the step. All of them. */
export const STAGE_SOURCES: Readonly<Record<JourneyStage, readonly string[]>> = {
  application: ['payable'],
  shipping: ['bill_of_lading', 'shipment_container'],
  bl: ['bill_of_lading'],
  container: ['bill_of_lading', 'shipment_container'],
  customs: ['customs_pd'],
  clearance: ['bill_of_lading', 'customs_declaration', 'shipment_container'],
  landed_cost: ['landed_cost_register'],
  receipt: ['bill_of_lading', 'shipment_container'],
  inventory: ['landed_cost_register', 'inventory_movement'],
};

/** The steps this person can see evidence for, in journey order. */
export function stagesFor(principal: Principal): readonly JourneyStage[] {
  if (!principal.isActive) return [];
  return JOURNEY_STAGES.filter((stage) => STAGE_SOURCES[stage].every((object) => can(principal, 'view', object)));
}

/** What the logistics services know about one import. `null` = not read for this viewer. */
export interface ImportFacts {
  readonly payableNo: string;
  /** The rail's own persisted stage (`payable.stage_code`). */
  readonly stageCode: string;
  readonly blCount: number;
  readonly containerCount: number;
  readonly containersReceived: number;
  /** Some live container has left the port of loading. */
  readonly departed: boolean;
  /** Standing (not superseded) PD registrations. */
  readonly standingPds: number;
  readonly clearedDeclarations: number;
  /** Landed-cost charges booked (duties, freight, handling — not the purchase). */
  readonly liveCharges: number | null;
  /** Goods received into warehouse cost layers, a quantity string. */
  readonly receivedQty: string | null;
}

const positive = (quantity: string | null): boolean => {
  if (quantity === null) return false;
  const trimmed = quantity.trim();
  return trimmed !== '' && /[1-9]/.test(trimmed.replace(/^-/, '')) && !trimmed.startsWith('-');
};

/** Whether the evidence for the step exists. */
export function reached(stage: JourneyStage, facts: ImportFacts): boolean {
  switch (stage) {
    case 'application':
      return true;
    case 'shipping':
      return facts.departed;
    case 'bl':
      return facts.blCount > 0;
    case 'container':
      return facts.containerCount > 0;
    case 'customs':
      return facts.standingPds > 0;
    case 'clearance':
      // A received container has necessarily cleared customs.
      return facts.clearedDeclarations > 0 || facts.containersReceived > 0;
    case 'landed_cost':
      return (facts.liveCharges ?? 0) > 0;
    case 'receipt':
      return facts.containersReceived > 0;
    case 'inventory':
      return positive(facts.receivedQty);
  }
}

export interface JourneyStep {
  readonly stage: JourneyStage;
  readonly reached: boolean;
}

export function journeyOf(facts: ImportFacts, stages: readonly JourneyStage[]): JourneyStep[] {
  return stages.map((stage) => ({ stage, reached: reached(stage, facts) }));
}

/** The last step (in journey order) with evidence — where the import has got to. */
export function furthest(facts: ImportFacts, stages: readonly JourneyStage[]): JourneyStage | null {
  let found: JourneyStage | null = null;
  for (const stage of stages) if (reached(stage, facts)) found = stage;
  return found;
}

/** For each visible step, how many of the imports have reached it. */
export function countByStage(imports: readonly ImportFacts[], stages: readonly JourneyStage[]): { key: JourneyStage; count: number }[] {
  return stages.map((stage) => ({ key: stage, count: imports.filter((one) => reached(stage, one)).length }));
}
