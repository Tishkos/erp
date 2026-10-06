import { getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { MENU } from '@domain/menu';
import { PERMISSION_VERBS } from '@domain/permissions';
import { routeFor, screenRoutes } from '@domain/screens';
import { visibleRoute } from '@/server/delivered';
import { Pill, Submit, SubmitRow, admin as s } from './index';

/**
 * The grant editor — Phase 0 requirement 5, "access can be assigned by
 * system section and permitted action".
 *
 * One role at a time. Rows are the system sections' objects (named by the
 * pages that use them), columns are the §5.3 verbs, a tick is a grant. The
 * form posts every ticked pair; the service replaces the role's grants with
 * exactly that set, so what is on screen is what is true.
 */
export async function GrantMatrix({
  roleCode,
  held,
  action,
  editable,
  hidden = {},
}: {
  readonly roleCode: string;
  readonly held: ReadonlySet<string>;
  readonly action: (formData: FormData) => Promise<void>;
  readonly editable: boolean;
  readonly hidden?: Readonly<Record<string, string>>;
}) {
  const [t, page, nav, verbs] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('nav'),
    getTranslations('action'),
  ]);

  // Only the delivered screens can be granted: a permission over a
  // section that does not exist yet would be a promise the system cannot keep.
  const sections = MENU.map((section) => {
    const objects = new Map<string, string[]>();
    for (const item of section.items) {
      const route = routeFor(item, section.key);
      if (!visibleRoute(route)) continue;
      // Five addresses appear twice in the tree (the audit trail is filed under
      // Documents as well as Administration). One address, one row: the
      // placement that owns the route is the one that lists it.
      if (screenRoutes().get(route)?.item.key !== item.key) continue;
      objects.set(item.object, [...(objects.get(item.object) ?? []), page(item.key)]);
    }
    const rows = [...objects.entries()].map(([object, pages]) => ({ object, pages }));
    const granted = rows.filter((r) => PERMISSION_VERBS.some((v) => held.has(`${r.object}:${v}`))).length;
    return { key: section.key, rows, granted };
  }).filter((section) => section.rows.length > 0);

  return (
    <form action={action} className={cn(s.grantForm, 'gap-2')}>
      <input name="code" type="hidden" value={roleCode} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} name={k} type="hidden" value={v} />
      ))}
      {/* What this editor showed. The service replaces only these objects, so
          a grant whose screen is not on this page survives a save.

          Once each: an object may be reached from two sections — a partner is
          a customer in Receivables and a supplier in Payables, an invoice is
          filed twice, a statement is under Accounting and under Reports — and
          the rows dedupe within a section but not across them. Twice over, it
          said the same thing to the service and gave React two children with
          one key (2026-10-04). */}
      {[...new Set(sections.flatMap((section) => section.rows.map((r) => r.object)))].map((object) => (
        <input key={object} name="offered" type="hidden" value={object} />
      ))}
      <p className={s.sectionHint}>{t('roles.grants_hint')}</p>
      {/* Each system section is an Intent disclosure card: the chevron, the name, the count; open, the verbs as a register. */}
      {sections.map((section) => (
        <details
          className={cn(s.grantSection, 'group overflow-hidden rounded-xl border border-border bg-overlay shadow-xs')}
          key={section.key}
        >
          <summary
            className={cn(
              s.grantSummary,
              'flex cursor-pointer list-none items-center gap-2.5 rounded-none bg-transparent px-4 py-2.5 text-start text-sm font-medium text-fg before:hidden hover:bg-muted/60 group-open:border-b group-open:border-border [&::-webkit-details-marker]:hidden',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-fg transition-transform group-open:rotate-90 rtl:-scale-x-100 rtl:group-open:-rotate-90"
            />
            <span className="min-w-0 flex-1">{nav(section.key)}</span>
            <Pill label={`${section.granted} / ${section.rows.length}`} on={section.granted > 0 ? true : null} />
          </summary>
          <div className={s.matrixWrap}>
            <table
              className={cn(
                s.matrix,
                s.grantTable,
                'text-sm [&_td]:border-border [&_th]:border-border [&_thead_th]:bg-muted [&_thead_th]:py-2 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:normal-case [&_thead_th]:tracking-normal [&_thead_th]:text-muted-fg [&_tbody_tr:hover]:bg-muted/60 [&_tbody_tr:last-child>*]:border-b-0 [&_tbody_tr:nth-child(2n)]:bg-transparent',
              )}
            >
              <thead>
                <tr>
                  <th scope="col">{t('roles.section')}</th>
                  {PERMISSION_VERBS.map((verb) => (
                    <th key={verb} scope="col" title={verbs(verb)}>
                      {verbs(verb)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((r) => (
                  <tr key={r.object}>
                    <th className={cn(s.grantObject, 'font-medium text-fg [&>code]:text-muted-fg')} scope="row">
                      <span>{r.pages.join(' · ')}</span>
                      <code>{r.object}</code>
                    </th>
                    {PERMISSION_VERBS.map((verb) => (
                      <td key={verb}>
                        <label className={s.grantCell}>
                          <input
                            aria-label={`${r.object} ${verbs(verb)}`}
                            defaultChecked={held.has(`${r.object}:${verb}`)}
                            disabled={!editable}
                            name="grant"
                            type="checkbox"
                            value={`${r.object}:${verb}`}
                          />
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {editable ? (
        <SubmitRow>
          <Submit label={t('roles.save_grants')} />
        </SubmitRow>
      ) : null}
    </form>
  );
}
