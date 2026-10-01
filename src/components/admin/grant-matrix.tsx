import { getTranslations } from 'next-intl/server';
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
    <form action={action} className={s.grantForm}>
      <input name="code" type="hidden" value={roleCode} />
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} name={k} type="hidden" value={v} />
      ))}
      {/* What this editor showed. The service replaces only these objects, so
          a grant whose screen is not on this page survives a save. */}
      {sections.flatMap((section) => section.rows.map((r) => r.object)).map((object) => (
        <input key={object} name="offered" type="hidden" value={object} />
      ))}
      <p className={s.sectionHint}>{t('roles.grants_hint')}</p>
      {sections.map((section) => (
        <details className={s.grantSection} key={section.key}>
          <summary className={s.grantSummary}>
            <span>{nav(section.key)}</span>
            <Pill label={`${section.granted} / ${section.rows.length}`} on={section.granted > 0 ? true : null} />
          </summary>
          <div className={s.matrixWrap}>
            <table className={`${s.matrix} ${s.grantTable}`}>
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
                    <th className={s.grantObject} scope="row">
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
