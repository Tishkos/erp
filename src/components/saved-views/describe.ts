import { getTranslations } from 'next-intl/server';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { viewableRoute } from '@domain/saved-view-routes';
import type { LabelSource, ParamSpec } from '@domain/saved-views';

/** One line of a view's summary: the filter and what it is set to. */
export interface Described {
  readonly label: string;
  readonly value: string;
}

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/**
 * A view's filters in words, in the person's language.
 *
 * Every word comes from a message the screen itself already shows its filter
 * with (`LabelSource` in the registry), so the summary says what the filter
 * says. A date kept as a rule reads as the rule ("This month"), not as the
 * dates it happens to be today; a value with no message falls back to the
 * value, which is a code the person typed or chose, never data.
 */
export async function describeView(
  routeKey: string,
  params: Readonly<Record<string, string>>,
  rules: Readonly<Record<string, string>>,
  locale: Locale,
): Promise<readonly Described[]> {
  const route = viewableRoute(routeKey);
  if (!route) return [];
  const own = await getTranslations('savedViews');
  const spaces = new Map<string, Translator>();
  const space = async (namespace: string) => {
    let found = spaces.get(namespace);
    if (!found) {
      found = await getTranslations(namespace);
      spaces.set(namespace, found);
    }
    return found;
  };

  const lines: Described[] = [];
  const covered = new Set<string>();

  // A slot kept as a rule is one line, however many parameters it fills.
  for (const slot of route.slots ?? []) {
    const rule = rules[slot.id];
    if (!rule) continue;
    const key = `rules.${slot.kind}.${rule}`;
    if (!own.has(key)) continue;
    lines.push({ label: own.has(`slots.${slot.id}`) ? own(`slots.${slot.id}`) : slot.id, value: own(key) });
    if (slot.kind === 'range') {
      covered.add(slot.from);
      covered.add(slot.to);
    } else {
      covered.add(slot.param);
    }
  }

  for (const [name, spec] of Object.entries(route.params)) {
    const value = params[name];
    if (value === undefined || covered.has(name)) continue;
    lines.push({
      label: own.has(`params.${name}`) ? own(`params.${name}`) : name,
      value: await valueText(spec, value, own, space, locale),
    });
  }
  return lines;
}

async function valueText(
  spec: ParamSpec,
  value: string,
  own: Translator,
  space: (namespace: string) => Promise<Translator>,
  locale: Locale,
): Promise<string> {
  switch (spec.kind) {
    case 'flag':
      return own('yes');
    case 'date':
      return formatBusinessDate(value, locale);
    case 'enum':
      return (await enumLabel(spec.labels, value, own, space)) ?? value;
    default:
      return value;
  }
}

async function enumLabel(
  source: LabelSource | undefined,
  value: string,
  own: Translator,
  space: (namespace: string) => Promise<Translator>,
): Promise<string | null> {
  if (!source) return null;
  if ('own' in source) {
    const key = `values.${source.own}.${value}`;
    return own.has(key) ? own(key) : null;
  }
  const t = await space(source.namespace);
  const key = source.map?.[value] ?? `${source.prefix ?? ''}${value}`;
  // Some of the screens' own labels carry a placeholder (`{days}`); the summary has no value for it.
  return t.has(key) ? t.raw(key).replace(/\s*\{[^}]*\}\s*/g, ' ').replace(/\s+/g, ' ').trim() : null;
}
