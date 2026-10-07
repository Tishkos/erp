import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  Anchor,
  Calculator,
  Check,
  Container,
  Hourglass,
  PackageOpen,
  ShieldCheck,
  Ship,
  Stamp,
  TriangleAlert,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { admin as s } from '@/components/admin';
import { ProfileLink } from '@/components/admin/profile-link';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { visibleRoute } from '@/server/delivered';
import { GOODS_PLACES, type GoodsDocument, type GoodsPlace, type GoodsStep, type GoodsStepView } from '@/server/domain/import-goods-journey';
import type { GoodsJourney } from '@/server/services/import-goods-journey';

/**
 * The goods' journey — a stacked section under the import's header (2026-10-07,
 * by direction: "it should write somewhere that [the goods went] from On
 * Process to In Process, [and] others are pending — a new block, nicely with
 * icons"). A stepper, horizontal on a wide screen and vertical on a phone: a
 * check on what is done, the current step in the accent with a soft pulse
 * (none under reduced motion), what is still to come muted and saying
 * "Pending". Each done step says when and links the document that did it.
 * The steps are `services/import-goods-journey.journeyFor`'s, read from the
 * rows and the import's own log — this draws them and decides nothing.
 */
const ICON: Readonly<Record<GoodsStep, LucideIcon>> = {
  on_process: Hourglass,
  in_process: PackageOpen,
  bl: Anchor,
  containers: Container,
  customs: Stamp,
  clearance: ShieldCheck,
  landed_cost: Calculator,
  received: Warehouse,
};

function DocumentLink({ document, payableNo }: { readonly document: GoodsDocument; readonly payableNo: string }) {
  switch (document.kind) {
    case 'purchase_invoice':
      return <ProfileLink code={document.no} kind="purchase_invoice" />;
    case 'payment_application':
      return <ProfileLink code={document.no} kind="payment_application" />;
    case 'bl':
      return <ProfileLink code={document.no} kind="bl" />;
    case 'container':
      return <ProfileLink code={document.no} kind="container" qualifier={document.id ? { id: document.id } : {}} />;
    case 'pd':
      return <ProfileLink code={document.no} kind="pd" qualifier={document.year ? { year: document.year } : {}} />;
    case 'customs_declaration':
      return visibleRoute('/logistics/customs-declarations') ? (
        <Link className={s.sapLink} href={`/logistics/customs-declarations/${encodeURIComponent(document.no)}`}>
          <bdi dir="ltr">{document.no}</bdi>
        </Link>
      ) : (
        <bdi dir="ltr">{document.no}</bdi>
      );
    case 'landed_cost': {
      const sheet = visibleRoute('/logistics/landed-costs')
        ? `/logistics/landed-costs/${encodeURIComponent(payableNo)}`
        : `/payables/${encodeURIComponent(payableNo)}#landed-cost`;
      return (
        <Link className={s.sapLink} href={sheet}>
          <bdi dir="ltr">{payableNo}</bdi>
        </Link>
      );
    }
  }
}

export async function GoodsJourneySection({
  journey,
  payableNo,
  dueDate = null,
}: {
  readonly journey: GoodsJourney;
  readonly payableNo: string;
  /** The balance's due date once set (2026-10-07): said on the In Process step, where the SWIFT left the goods. */
  readonly dueDate?: string | null;
}) {
  if (journey.steps.length === 0) return null;
  const [t, bd, locale] = await Promise.all([getTranslations('admin.payables'), getTranslations('admin.balance_due'), getLocale()]);
  const done = journey.steps.filter((step) => step.state === 'done').length;
  const amount = journey.advance
    ? journey.advance.kind === 'percent'
      ? `${journey.advance.value}%`
      : formatMoney(journey.advance.value, journey.advance.currency, locale as Locale)
    : '';
  const phrase = (key: string, params: Readonly<Record<string, string | number>>) =>
    t.has(key) ? t(key, key === 'journey_on_process_amount' ? { ...params, amount } : params) : null;
  const stateLabel = (step: GoodsStepView) =>
    step.state === 'done' ? t('journey_done') : step.state === 'partial' ? t('journey_in_progress') : t('journey_pending');

  return (
    <section aria-labelledby="payable-journey-title" className={s.sapDoc} data-journey="" id="journey">
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="payable-journey-title">
          <span>{t('journey_title')}</span>
          <span className={s.sapTitleMeta}>{t('journey_meta', { done, total: journey.steps.length })}</span>
        </h2>
        <ol className="grid grid-cols-1 gap-0 px-4 py-4 md:auto-cols-fr md:grid-flow-col md:grid-cols-none md:gap-2" data-journey-steps="">
          {journey.steps.map((step, index) => {
            const Icon = ICON[step.step];
            const last = index === journey.steps.length - 1;
            const circle =
              step.state === 'done'
                ? 'border-success/40 bg-success-subtle text-success-subtle-fg'
                : step.current
                  ? 'border-primary bg-primary text-primary-fg shadow-sm'
                  : step.state === 'partial'
                    ? 'border-primary/40 bg-primary-subtle text-primary-subtle-fg'
                    : 'border-border bg-muted text-muted-fg';
            const detail = step.detail ? phrase(step.detail.key, step.detail.params) : null;
            return (
              <li
                aria-current={step.current ? 'step' : undefined}
                className="relative flex min-w-0 gap-3 pb-5 last:pb-0 md:flex-col md:items-center md:pb-0 md:text-center"
                data-state={step.state}
                data-step={step.step}
                key={step.step}
              >
                {/* The line to the next step: down the start side on a phone, across on a wide screen. */}
                {last ? null : (
                  <span
                    aria-hidden="true"
                    className={`absolute start-[1.125rem] top-10 bottom-0 w-px md:start-[calc(50%+1.5rem)] md:-end-[calc(50%-1rem)] md:top-[1.125rem] md:bottom-auto md:h-px md:w-auto ${
                      step.state === 'done' ? 'bg-success/50' : 'bg-border'
                    }`}
                  />
                )}
                <span className={`relative z-10 grid size-9 shrink-0 place-items-center rounded-full border ${circle}`}>
                  {step.current ? (
                    <span aria-hidden="true" className="absolute inset-0 rounded-full bg-primary/30 motion-safe:animate-ping" />
                  ) : null}
                  <Icon aria-hidden="true" className="relative size-4" />
                  {step.state === 'done' ? (
                    <span className="absolute -end-1 -bottom-1 grid size-4 place-items-center rounded-full bg-success text-success-fg ring-2 ring-[var(--ui-overlay)]">
                      <Check aria-hidden="true" className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere] md:items-center">
                  <span className={`text-sm font-medium ${step.current ? 'text-primary-subtle-fg' : step.state === 'pending' ? 'text-muted-fg' : 'text-fg'}`}>
                    {step.step === 'received' && step.place && step.place.length > 0
                      ? t('journey_step_received_into', { warehouse: step.place.join(', ') })
                      : t(`journey_step_${step.step}`)}
                  </span>
                  <span
                    className={`w-fit rounded-md px-1.5 py-0.5 text-xs font-medium ${
                      step.state === 'done'
                        ? 'bg-success-subtle text-success-subtle-fg'
                        : step.state === 'partial' || step.current
                          ? 'bg-primary-subtle text-primary-subtle-fg'
                          : 'bg-muted text-muted-fg'
                    }`}
                    data-journey-state=""
                  >
                    {stateLabel(step)}
                  </span>
                  {step.on || step.state === 'done' ? (
                    // A done step whose evidence carries no date says so — the page never invents one.
                    <span className="text-xs text-muted-fg tabular-nums" data-journey-date="">
                      {step.on ? <bdi dir="ltr">{formatBusinessDate(step.on, locale as Locale)}</bdi> : t('journey_no_date')}
                    </span>
                  ) : null}
                  {detail ? <span className="text-xs text-muted-fg">{detail}</span> : null}
                  {step.step === 'in_process' && dueDate ? (
                    <span className="text-xs text-muted-fg" data-journey-due="">
                      {bd('journey_due', { date: formatBusinessDate(dueDate, locale as Locale) })}
                    </span>
                  ) : null}
                  {step.document ? (
                    <span className="text-xs" data-journey-document="">
                      <DocumentLink document={step.document} payableNo={payableNo} />
                    </span>
                  ) : null}
                  {step.note ? (
                    <span className="mt-1 w-fit rounded-md bg-warning-subtle px-2 py-1 text-xs text-warning-subtle-fg md:text-center" data-journey-note="">
                      {phrase(step.note.key, step.note.params)}
                      {step.note.document ? (
                        <>
                          {' '}
                          <DocumentLink document={step.note.document} payableNo={payableNo} />
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
        <WhereNow now={journey.now} />
      </div>
    </section>
  );
}

/** Each place on the track, its icon and its tint. */
const PLACE_ICON: Readonly<Record<GoodsPlace, LucideIcon>> = {
  on_process: Hourglass,
  in_process: PackageOpen,
  on_board: Ship,
  at_port: Anchor,
  cleared: ShieldCheck,
  received: Warehouse,
  missing: TriangleAlert,
};

const PLACE_TONE: Readonly<Record<GoodsPlace, string>> = {
  on_process: 'bg-warning-subtle text-warning-subtle-fg',
  in_process: 'bg-info-subtle text-info-subtle-fg',
  on_board: 'bg-primary-subtle text-primary-subtle-fg',
  at_port: 'bg-primary-subtle text-primary-subtle-fg',
  cleared: 'bg-primary-subtle text-primary-subtle-fg',
  received: 'bg-success-subtle text-success-subtle-fg',
  missing: 'bg-danger-subtle text-danger-subtle-fg',
};

/**
 * Where the goods are now (2026-10-07, by direction: "I want to know the
 * current situation of the item, where is it — like tracking … in process, on
 * board, at port … sometimes some of the containers arrive and some are still
 * on board or processing"). One line for the whole import — one place, or the
 * places side by side when the containers are split — then every container on
 * its own track: In Process → On board → At port → Cleared → Received into
 * <warehouse>, the place it is in named with its date or its ETA. The places
 * are `domain/import-goods-journey.goodsWhereNow`'s, read from each
 * container's own status and dates.
 */
async function WhereNow({ now }: { readonly now: GoodsJourney['now'] }) {
  if (!now.place) return null;
  const [t, locale] = await Promise.all([getTranslations('admin.payables'), getLocale()]);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const placeName = (place: GoodsPlace, warehouses: readonly string[] = []) =>
    place === 'received' && warehouses.length > 0
      ? t('journey_now_place_received_into', { warehouse: warehouses.join(', ') })
      : t(`journey_now_place_${place}`);
  const track = GOODS_PLACES.filter((place) => place !== 'on_process' || now.containers.some((box) => box.place === 'on_process'));

  return (
    <div className="border-t border-border px-4 py-4" data-journey-now={now.place}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-fg">{t('journey_now_title')}</span>
        {now.counts.map((row) => {
          const Icon = PLACE_ICON[row.place];
          return (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${PLACE_TONE[row.place]}`}
              data-journey-place={row.place}
              key={row.place}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              <span>{placeName(row.place, row.warehouses)}</span>
              {row.count > 0 && now.place === 'split' ? (
                <span className="tabular-nums opacity-80">· {t('journey_now_count', { count: row.count })}</span>
              ) : null}
            </span>
          );
        })}
        {now.place === 'split' ? <span className="text-xs text-muted-fg">{t('journey_now_split')}</span> : null}
        {now.containers.length === 0 ? <span className="text-xs text-muted-fg">{t('journey_now_no_containers')}</span> : null}
      </div>

      {now.containers.length > 0 ? (
        <ul className="mt-3 grid gap-2" data-journey-containers="">
          {now.containers.map((box) => {
            const Icon = PLACE_ICON[box.place];
            return (
              <li
                className="grid grid-cols-1 items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-[var(--ui-overlay)] px-3 py-2 md:grid-cols-[minmax(9rem,auto)_minmax(0,1fr)_minmax(12rem,auto)]"
                data-container-place={box.place}
                key={box.id}
              >
                <span className="text-sm font-medium">
                  <ProfileLink code={box.containerNo} kind="container" qualifier={{ id: box.id }} />
                </span>
                {/* The container's own track: every place it has passed filled, the one it is in ringed. */}
                <span aria-hidden="true" className="flex min-w-0 items-center gap-1">
                  {track.map((place, index) => {
                    const at = GOODS_PLACES.indexOf(place);
                    const passed = at < box.reached;
                    const here = at === box.reached;
                    return (
                      <span className="flex min-w-0 flex-1 items-center gap-1" key={place}>
                        <span
                          className={`size-2.5 shrink-0 rounded-full ${
                            here
                              ? box.place === 'missing'
                                ? 'bg-danger ring-4 ring-danger/20'
                                : 'bg-primary ring-4 ring-primary/20'
                              : passed
                                ? 'bg-success'
                                : 'bg-border'
                          }`}
                          title={placeName(place)}
                        />
                        {index < track.length - 1 ? <span className={`h-px min-w-2 flex-1 ${passed ? 'bg-success/60' : 'bg-border'}`} /> : null}
                      </span>
                    );
                  })}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 md:justify-end">
                  <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${PLACE_TONE[box.place]}`}>
                    <Icon aria-hidden="true" className="size-3.5" />
                    {placeName(box.place, box.warehouse ? [box.warehouse] : [])}
                  </span>
                  {box.since ? (
                    <span className="text-xs text-muted-fg tabular-nums">
                      {t('journey_now_since', { date: day(box.since) })}
                    </span>
                  ) : box.eta && box.place !== 'received' ? (
                    <span className={`text-xs tabular-nums ${box.late ? 'font-medium text-danger-subtle-fg' : 'text-muted-fg'}`}>
                      {box.late ? t('journey_now_late', { date: day(box.eta) }) : t('journey_now_eta', { date: day(box.eta) })}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
