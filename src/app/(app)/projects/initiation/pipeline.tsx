import { getTranslations } from 'next-intl/server';
import {
  Award,
  Calculator,
  Check,
  ClipboardList,
  DraftingCompass,
  FileSignature,
  FileText,
  Landmark,
  ListChecks,
  MapPinned,
  Scale,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { admin as s } from '@/components/admin';
import { guideNumber, type InitiationStage, type StageState } from '@/server/domain/project-initiation';

/**
 * The workflow of a Project Initiation — the guide's six stages of the chosen
 * road, drawn as the import's goods journey is (the same stepper: horizontal
 * on a wide screen, vertical on a phone; a check on what is done, the current
 * stage in the accent, what is still to come muted). It draws what
 * `domain/project-initiation.stageStates` says and decides nothing.
 */
const ICON: Readonly<Record<InitiationStage, LucideIcon>> = {
  lead: UserPlus,
  pre_sales: ClipboardList,
  site_survey: MapPinned,
  boq_costing: Calculator,
  proposal: FileText,
  contract: FileSignature,
  tender_lead: Landmark,
  go_no_go: Scale,
  pre_bid: Users,
  tender_design: DraftingCompass,
  bidding: ListChecks,
  award: Award,
};

export async function InitiationPipeline({
  steps,
  lost = false,
}: {
  readonly steps: readonly { readonly stage: InitiationStage; readonly state: StageState }[];
  /** A lost record stopped where it stands: its stage is drawn muted, not as the place work goes on. */
  readonly lost?: boolean;
}) {
  const t = await getTranslations('admin.project_initiation');
  const done = steps.filter((step) => step.state === 'done').length;

  return (
    <section aria-labelledby="initiation-pipeline-title" className={s.sapDoc} data-pipeline="" id="pipeline">
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="initiation-pipeline-title">
          <span>{t('pipeline_title')}</span>
          <span className={s.sapTitleMeta}>{t('pipeline_meta', { done, total: steps.length })}</span>
        </h2>
        <ol className="grid grid-cols-1 gap-0 px-4 py-4 md:auto-cols-fr md:grid-flow-col md:grid-cols-none md:gap-2" data-pipeline-steps="">
          {steps.map((step, index) => {
            const Icon = ICON[step.stage];
            const last = index === steps.length - 1;
            const current = step.state === 'current' && !lost;
            const circle =
              step.state === 'done'
                ? 'border-success/40 bg-success-subtle text-success-subtle-fg'
                : current
                  ? 'border-primary bg-primary text-primary-fg shadow-sm'
                  : 'border-border bg-muted text-muted-fg';
            const label = step.state === 'done' ? t('step_done') : step.state === 'current' ? (lost ? t('step_stopped') : t('step_current')) : t('step_pending');
            return (
              <li
                aria-current={current ? 'step' : undefined}
                className="relative flex min-w-0 gap-3 pb-5 last:pb-0 md:flex-col md:items-center md:pb-0 md:text-center"
                data-stage={step.stage}
                data-state={step.state}
                key={step.stage}
              >
                {/* The line to the next stage: down the start side on a phone, across on a wide screen. */}
                {last ? null : (
                  <span
                    aria-hidden="true"
                    className={`absolute start-[1.125rem] top-10 bottom-0 w-px md:start-[calc(50%+1.5rem)] md:-end-[calc(50%-1rem)] md:top-[1.125rem] md:bottom-auto md:h-px md:w-auto ${
                      step.state === 'done' ? 'bg-success/50' : 'bg-border'
                    }`}
                  />
                )}
                <span className={`relative z-10 grid size-9 shrink-0 place-items-center rounded-full border ${circle}`}>
                  <Icon aria-hidden="true" className="relative size-4" />
                  {step.state === 'done' ? (
                    <span className="absolute -end-1 -bottom-1 grid size-4 place-items-center rounded-full bg-success text-success-fg ring-2 ring-[var(--ui-overlay)]">
                      <Check aria-hidden="true" className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere] md:items-center">
                  <span className={`text-sm font-medium ${current ? 'text-primary-subtle-fg' : step.state === 'pending' ? 'text-muted-fg' : 'text-fg'}`}>
                    <bdi dir="ltr">{guideNumber(step.stage)}</bdi> · {t(`stage.${step.stage}`)}
                  </span>
                  <span
                    className={`w-fit rounded-md px-1.5 py-0.5 text-xs font-medium ${
                      step.state === 'done' ? 'bg-success-subtle text-success-subtle-fg' : current ? 'bg-primary-subtle text-primary-subtle-fg' : 'bg-muted text-muted-fg'
                    }`}
                    data-pipeline-state=""
                  >
                    {label}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
