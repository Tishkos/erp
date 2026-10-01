'use client';

import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  Boxes,
  Building2,
  Calculator,
  Check,
  ChevronDown,
  Files,
  FolderKanban,
  Grid3X3,
  Handshake,
  Languages,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Palette,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MenuItem, MenuSection } from '@domain/menu';
import {
  APPEARANCE_PRESETS,
  APPEARANCE_PRESET_SETTINGS,
  BORDER_STYLES,
  COMPONENT_SIZES,
  CONTENT_WIDTHS,
  CORNER_STYLES,
  DEFAULT_USER_APPEARANCE,
  DENSITIES,
  SHADOW_STYLES,
  type AppearancePreset,
  type UserAppearanceSettings,
} from '@domain/appearance';
import { routeFor } from '@domain/screens';
import { saveMyAppearanceSettings } from '@/app/(app)/appearance-actions';
import { Button, Panel } from '@/components/ui';
import mainLogo from '../../mainLogo.png';
import { GlobalSearch } from './global-search';
import { switchBranch } from '@/app/(app)/actions';

type ModuleKey =
  | 'dashboard'
  | 'accounting'
  | 'sales'
  | 'purchasing'
  | 'logistics'
  | 'money_transfer'
  | 'crm'
  | 'projects'
  | 'inventory'
  | 'hr'
  | 'reports'
  | 'documents'
  | 'settings';

type UtilityPanel = 'launcher' | 'notifications' | 'messages' | 'user';
type OpenPopover = ModuleKey | UtilityPanel | null;

interface ModuleDefinition {
  readonly key: ModuleKey;
  readonly icon: LucideIcon;
  readonly sectionKeys: readonly string[];
}

interface ModuleGroup extends ModuleDefinition {
  readonly sections: readonly MenuSection[];
}

export interface ShellNotification {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
  readonly read: boolean;
}

interface ErpShellProps {
  readonly brand: string;
  readonly branchCode: string;
  readonly branchCodes: readonly string[];
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly image: string | null;
  readonly roleCodes: readonly string[];
  readonly isSuperUser: boolean;
  readonly sections: readonly MenuSection[];
  readonly initialAppearanceSettings: UserAppearanceSettings;
  readonly appearanceSettingsSaved: boolean;
  /**
   * The signed-in person's latest notifications, newest first — what the bell
   * shows. Block 8's status changes land here for the users selected to be
   * told.
   */
  readonly notifications?: readonly ShellNotification[];
  /** Rendered after the main region, so it always ends the page. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

type Accent = 'blue' | 'indigo' | 'teal' | 'orange';
type Theme = 'light' | 'dark';

interface AppearancePreferences {
  readonly theme: Theme;
  readonly accent: Accent;
  readonly appearance: UserAppearanceSettings['appearance'];
  readonly density: UserAppearanceSettings['density'];
  readonly cornerStyle: UserAppearanceSettings['cornerStyle'];
  readonly contentWidth: UserAppearanceSettings['contentWidth'];
  readonly borderStyle: UserAppearanceSettings['borderStyle'];
  readonly shadow: UserAppearanceSettings['shadow'];
  readonly componentSize: UserAppearanceSettings['componentSize'];
}

type PreferenceName = keyof AppearancePreferences;
type PreferenceValue = AppearancePreferences[PreferenceName];

const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  { key: 'dashboard', icon: LayoutDashboard, sectionKeys: ['home'] },
  {
    key: 'accounting',
    icon: Calculator,
    sectionKeys: [
      'finance_gl',
      'finance_ar',
      'finance_ap',
      'treasury',
      'fixed_assets',
      'budgeting',
      'investments',
      // And the reference data no single module owns — the chart, currencies,
      // branches, departments, cost centres, payment terms and methods.
      'master_data',
    ],
  },
  // Selling and buying are their own work, with their own screens and their
  // own people. They used to sit inside Accounting because they end in a
  // receivable and a payable — but that is where their *postings* go, not
  // where the work happens, and a salesperson opening Accounting to reach
  // Customers had to read past the general ledger to find them.
  { key: 'sales', icon: ShoppingCart, sectionKeys: ['sales'] },
  { key: 'purchasing', icon: ShoppingBag, sectionKeys: ['purchasing'] },
  { key: 'logistics', icon: Truck, sectionKeys: ['logistics'] },
  { key: 'money_transfer', icon: ArrowLeftRight, sectionKeys: ['money_transfer'] },
  { key: 'crm', icon: Handshake, sectionKeys: ['crm'] },
  { key: 'projects', icon: FolderKanban, sectionKeys: ['projects'] },
  { key: 'inventory', icon: Boxes, sectionKeys: ['inventory'] },
  { key: 'hr', icon: Users, sectionKeys: ['hr_payroll'] },
  { key: 'documents', icon: Files, sectionKeys: ['documents'] },
  { key: 'reports', icon: BarChart3, sectionKeys: ['reports'] },
  {
    key: 'settings',
    icon: Settings,
    sectionKeys: ['administration', 'integrations'],
  },
] as const;

const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'light',
  ...DEFAULT_USER_APPEARANCE,
  accent: 'blue',
};

const LEGACY_APPEARANCE_OPTIONS = {
  theme: ['light', 'dark'],
  accent: ['blue', 'indigo', 'teal', 'orange'],
} as const;

const SETTING_OPTIONS = {
  density: DENSITIES,
  cornerStyle: CORNER_STYLES,
  contentWidth: CONTENT_WIDTHS,
  borderStyle: BORDER_STYLES,
  shadow: SHADOW_STYLES,
  componentSize: COMPONENT_SIZES,
} as const satisfies {
  readonly [Name in Exclude<keyof UserAppearanceSettings, 'appearance'>]: readonly string[];
};

const ADVANCED_SETTING_NAMES = ['borderStyle', 'shadow', 'componentSize'] as const;
const BASIC_SETTING_NAMES = ['density', 'cornerStyle', 'contentWidth'] as const;

const PRESET_DESCRIPTIONS: Readonly<Record<AppearancePreset, string>> = {
  current: 'preset_current_description',
  standard: 'preset_standard_description',
  enterprise: 'preset_enterprise_description',
  minimal: 'preset_minimal_description',
  modern: 'preset_modern_description',
  command: 'preset_command_description',
  studio: 'preset_studio_description',
};

function groupSections(sections: readonly MenuSection[]): readonly ModuleGroup[] {
  const byKey = new Map(sections.map((section) => [section.key, section]));

  return MODULE_DEFINITIONS.map((definition) => ({
    ...definition,
    sections: definition.sectionKeys.flatMap((key) => {
      const section = byKey.get(key);
      return section ? [section] : [];
    }),
  })).filter((module) => module.sections.length > 0);
}

function isActiveHref(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function moduleIsActive(pathname: string, module: ModuleGroup): boolean {
  return module.sections.some((section) =>
    section.items.some((item) => item.href && isActiveHref(pathname, item.href)),
  );
}

function firstModuleHref(module: ModuleGroup): string | null {
  for (const section of module.sections) {
    const item = section.items.find(
      (candidate): candidate is MenuItem & { readonly href: string } => Boolean(candidate.href),
    );
    if (item) return item.href;
  }
  return null;
}

function readStoredPreference<T extends string>(
  attribute: `data-${string}`,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = window.localStorage.getItem(attribute);
    return value && allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The attribute each preference is written to — one table, used by the write
 * below and by every `readStoredPreference` call above.
 *
 * It was a conditional that special-cased `cornerStyle` and `contentWidth` and
 * fell through to `data-${name}` for the rest. An HTML attribute name is
 * case-insensitive, so `borderStyle` became `data-borderstyle` and
 * `componentSize` became `data-componentsize` — attributes no stylesheet
 * matches, while the server rendered the hyphenated ones and the read side
 * looked for those too. Border style and Component size therefore did nothing
 * at all, silently, and the panel showed the choice as taken (reported
 * 2026-09-29). The names now exist in exactly one place.
 */
const PREFERENCE_ATTRIBUTE = {
  theme: 'data-theme',
  accent: 'data-accent',
  appearance: 'data-appearance',
  density: 'data-density',
  cornerStyle: 'data-radius',
  contentWidth: 'data-width',
  borderStyle: 'data-border-style',
  shadow: 'data-shadow',
  componentSize: 'data-component-size',
} as const satisfies Record<PreferenceName, `data-${string}`>;

function applyPreference(name: PreferenceName, value: PreferenceValue): void {
  const attribute = PREFERENCE_ATTRIBUTE[name];
  const target = name === 'theme' || name === 'accent'
    ? document.documentElement
    : document.querySelector<HTMLElement>('.erp-root');
  target?.setAttribute(attribute, value);
  try {
    window.localStorage.setItem(attribute, value);
  } catch {
    // The visual preference still applies when storage is unavailable.
  }
}

function savedSettingsFrom(value: AppearancePreferences): UserAppearanceSettings {
  return {
    appearance: value.appearance,
    density: value.density,
    cornerStyle: value.cornerStyle,
    contentWidth: value.contentWidth,
    borderStyle: value.borderStyle,
    shadow: value.shadow,
    componentSize: value.componentSize,
  };
}

function PendingItem({ item }: { readonly item: MenuItem }) {
  const page = useTranslations('page');
  const pending = useTranslations('screen');

  return (
    <span
      className="erp-menu-item erp-menu-item--pending"
      title={pending('not_built')}
    >
      <span className="erp-menu-item__label">{page(item.key)}</span>
    </span>
  );
}

function ModuleContents({
  module,
  pathname,
  onNavigate,
}: {
  readonly module: ModuleGroup;
  readonly pathname: string;
  readonly onNavigate: () => void;
}) {
  const nav = useTranslations('nav');
  const page = useTranslations('page');
  const pending = useTranslations('screen');

  return (
    <div className="erp-module-contents">
      {module.sections.map((section) => (
        <section className="erp-module-section" key={section.key}>
          <h3 className="erp-module-section__title">{nav(section.key)}</h3>
          <ul className="erp-module-section__list">
            {section.items.map((item) => {
              // Every item in the approved tree has an address: the one its
              // module declared, or the one the screen catalogue derives. An
              // item that is not built yet keeps its pending badge, so the
              // tree says which pages are previews without refusing to open
              // them — which is what it used to do, for 176 of 218 items.
              const href = routeFor(item, section.key);
              const preview = item.href === null;
              return (
                <li className="erp-module-section__item" key={item.key}>
                  <Link
                    aria-current={isActiveHref(pathname, href) ? 'page' : undefined}
                    className={`erp-menu-item erp-menu-item--link${preview ? ' erp-menu-item--preview' : ''}`}
                    href={href}
                    onClick={onNavigate}
                    title={preview ? pending('not_built') : undefined}
                  >
                    <span className="erp-menu-item__label">{page(item.key)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ErpShell({
  brand,
  branchCode,
  branchCodes,
  userId,
  displayName,
  email,
  image,
  roleCodes,
  isSuperUser,
  sections,
  initialAppearanceSettings,
  appearanceSettingsSaved,
  notifications = [],
  footer,
  children,
}: ErpShellProps) {
  const shell = useTranslations('shell');
  const page = useTranslations('page');
  const pending = useTranslations('screen');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const modules = useMemo(() => groupSections(sections), [sections]);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMobileModules, setOpenMobileModules] = useState<readonly ModuleKey[]>([]);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [currentLocale, setCurrentLocale] = useState(locale === 'ar' ? 'ar' : 'en');
  const [appearance, setAppearance] = useState<AppearancePreferences>({
    ...DEFAULT_APPEARANCE,
    ...initialAppearanceSettings,
  });
  const [appearanceSaveState, setAppearanceSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    appearanceSettingsSaved ? 'saved' : 'idle',
  );

  const shortUserId = userId.slice(0, 8);
  const initials = displayName
    .split(/s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!)
    .join('')
    .toUpperCase() || shortUserId.slice(0, 2).toUpperCase();
  const roleLabel = isSuperUser
    ? shell('super_user')
    : roleCodes.length > 0
      ? roleCodes.join(' · ')
      : shell('no_role');
  const notificationItem = sections
    .flatMap((section) => section.items)
    .find((item) => item.key === 'notifications');

  const persistAppearanceSettings = async (settings: UserAppearanceSettings) => {
    setAppearanceSaveState('saving');
    try {
      const result = await saveMyAppearanceSettings(settings);
      setAppearanceSaveState(result.ok ? 'saved' : 'error');
    } catch {
      setAppearanceSaveState('error');
    }
  };

  useLayoutEffect(() => {
    // Existing choices lived in this browser. Adopt them once for this
    // account, then the database is authoritative across devices and logins.
    const settings: UserAppearanceSettings = appearanceSettingsSaved
      ? initialAppearanceSettings
      : {
          appearance: readStoredPreference('data-appearance', APPEARANCE_PRESETS, initialAppearanceSettings.appearance),
          density: readStoredPreference('data-density', DENSITIES, initialAppearanceSettings.density),
          cornerStyle: readStoredPreference('data-radius', CORNER_STYLES, initialAppearanceSettings.cornerStyle),
          contentWidth: readStoredPreference('data-width', CONTENT_WIDTHS, initialAppearanceSettings.contentWidth),
          borderStyle: readStoredPreference('data-border-style', BORDER_STYLES, initialAppearanceSettings.borderStyle),
          shadow: readStoredPreference('data-shadow', SHADOW_STYLES, initialAppearanceSettings.shadow),
          componentSize: readStoredPreference('data-component-size', COMPONENT_SIZES, initialAppearanceSettings.componentSize),
        };
    const stored: AppearancePreferences = {
      ...settings,
      theme: readStoredPreference('data-theme', LEGACY_APPEARANCE_OPTIONS.theme, DEFAULT_APPEARANCE.theme),
      accent: readStoredPreference('data-accent', LEGACY_APPEARANCE_OPTIONS.accent, DEFAULT_APPEARANCE.accent),
    };

    setAppearance(stored);
    (Object.keys(stored) as PreferenceName[]).forEach((name) => {
      applyPreference(name, stored[name]);
    });
    if (!appearanceSettingsSaved) {
      setAppearanceSaveState('saving');
      void saveMyAppearanceSettings(settings).then((result) => {
        setAppearanceSaveState(result.ok ? 'saved' : 'error');
      }).catch(() => setAppearanceSaveState('error'));
    }
  }, [appearanceSettingsSaved, initialAppearanceSettings]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenPopover(null);
      setMobileOpen(false);
      setAppearanceOpen(false);
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    setOpenPopover(null);
    setMobileOpen(false);
  }, [pathname]);

  const togglePopover = (panel: Exclude<OpenPopover, null>) => {
    setOpenPopover((current) => (current === panel ? null : panel));
  };

  const closeNavigation = () => {
    setOpenPopover(null);
    setMobileOpen(false);
  };

  const changeLocale = () => {
    const nextLocale = currentLocale === 'ar' ? 'en' : 'ar';
    document.cookie = `erp-locale=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.documentElement.lang = nextLocale;
    document.documentElement.dir = nextLocale === 'ar' ? 'rtl' : 'ltr';
    setCurrentLocale(nextLocale);
    setOpenPopover(null);
    setMobileOpen(false);
    // A full reload, not router.refresh(): every server component, the
    // message bundle and the document direction must change together.
    window.location.reload();
  };

  const changeAppearanceSetting = (name: keyof UserAppearanceSettings, value: string) => {
    const next = { ...appearance, [name]: value } as AppearancePreferences;
    setAppearance(next);
    applyPreference(name, value as PreferenceValue);
    void persistAppearanceSettings(savedSettingsFrom(next));
  };

  const chooseAppearancePreset = (preset: AppearancePreset) => {
    const next: AppearancePreferences = {
      ...appearance,
      appearance: preset,
      ...APPEARANCE_PRESET_SETTINGS[preset],
    };
    setAppearance(next);
    (Object.keys(savedSettingsFrom(next)) as (keyof UserAppearanceSettings)[]).forEach((name) => {
      applyPreference(name, next[name]);
    });
    void persistAppearanceSettings(savedSettingsFrom(next));
  };

  const openAppearance = () => {
    setOpenPopover(null);
    setMobileOpen(false);
    setAppearanceOpen(true);
  };

  // The branch control. One branch is a fact and is shown as one; more than
  // one is a choice, and the picker submits itself — the whole layout re-reads
  // under the new branch, which is the point of changing it.
  const branchControl = (
    <div className="erp-branch" title={branchCode}>
      <Building2 className="erp-branch__icon" aria-hidden="true" />
      <span className="erp-branch__content">
        <small className="erp-branch__label">{shell('branch')}</small>
        {branchCodes.length > 1 ? (
          <form action={switchBranch} className="erp-branch__form">
            <select
              aria-label={shell('branch')}
              className="erp-branch__select"
              defaultValue={branchCode}
              key={branchCode}
              name="branch"
              onChange={(event) => event.currentTarget.form?.requestSubmit()}
            >
              {branchCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </form>
        ) : (
          <strong className="erp-branch__value">{branchCode || '—'}</strong>
        )}
      </span>
    </div>
  );

  const renderAppearanceSetting = (name: keyof typeof SETTING_OPTIONS) => {
    const titleKey = {
      density: 'density',
      cornerStyle: 'radius',
      contentWidth: 'width',
      borderStyle: 'border_style',
      shadow: 'shadow_style',
      componentSize: 'component_size',
    }[name];
    const values = SETTING_OPTIONS[name];

    return (
      <fieldset className="erp-preference" key={name}>
        <legend className="erp-preference__legend">{shell(titleKey)}</legend>
        <div className={`erp-preference__options erp-preference__options--${name}`}>
          {values.map((value) => {
            const selected = appearance[name] === value;
            return (
              <button
                aria-pressed={selected}
                className="erp-preference__option"
                data-selected={selected ? 'true' : 'false'}
                data-value={value}
                key={value}
                onClick={() => changeAppearanceSetting(name, value)}
                type="button"
              >
                <span>{shell(value)}</span>
                {selected ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
  };

  return (
    <div className="erp-shell">
      <header className="erp-header">
        <div className="erp-header__bar">
          <div className="erp-header__identity">
            <button
              className="erp-icon-button erp-launcher-trigger"
              type="button"
              aria-label={shell('app_launcher')}
              aria-expanded={openPopover === 'launcher'}
              aria-controls="erp-launcher-panel"
              onClick={() => togglePopover('launcher')}
            >
              <Grid3X3 aria-hidden="true" />
            </button>

            <Link className="erp-brand" href="/" onClick={closeNavigation}>
              <Image
                className="erp-brand__logo"
                src={mainLogo}
                alt={shell('logo_alt')}
                preload
                sizes="48px"
              />
              <span className="erp-brand__wordmark">
                <strong>{shell('company_name')}</strong>
                <small>{shell('company_name_secondary')}</small>
              </span>
              {/* The product name is not shown: the lockup already says whose system this is. */}
              <span className="erp-brand__product" hidden>
                {brand}
              </span>
            </Link>

            <button
              className="erp-icon-button erp-mobile-trigger"
              type="button"
              aria-label={shell('open_menu')}
              aria-expanded={mobileOpen}
              aria-controls="erp-mobile-drawer"
              onClick={() => {
                setOpenPopover(null);
                setOpenMobileModules(
                  modules
                    .filter((module) => moduleIsActive(pathname, module))
                    .map((module) => module.key),
                );
                setMobileOpen(true);
              }}
            >
              <Menu aria-hidden="true" />
            </button>
          </div>

          <nav className="erp-nav" aria-label={shell('primary_navigation')}>
            <ul className="erp-nav__list">
              {modules.map((module) => {
                const Icon = module.icon;
                const panelId = `erp-module-${module.key}`;
                const isOpen = openPopover === module.key;

                return (
                  <li className="erp-nav__item" key={module.key}>
                    <button
                      className="erp-nav__trigger"
                      type="button"
                      data-active={moduleIsActive(pathname, module) ? 'true' : 'false'}
                      aria-current={moduleIsActive(pathname, module) ? 'page' : undefined}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      title={shell(`module.${module.key}`)}
                      onClick={() => togglePopover(module.key)}
                    >
                      <Icon className="erp-nav__icon" aria-hidden="true" />
                      <span className="erp-nav__label">{shell(`module.${module.key}`)}</span>
                      <ChevronDown className="erp-nav__chevron" aria-hidden="true" />
                    </button>

                    {isOpen ? (
                      <div className="erp-module-popover" id={panelId}>
                        <ModuleContents
                          module={module}
                          pathname={pathname}
                          onNavigate={closeNavigation}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="erp-header__utilities">
            {branchControl}

            <GlobalSearch sections={sections} />
            <button
              className="erp-icon-button"
              type="button"
              aria-label={shell('notifications')}
              aria-expanded={openPopover === 'notifications'}
              aria-controls="erp-notifications-panel"
              onClick={() => togglePopover('notifications')}
            >
              <Bell aria-hidden="true" />
            </button>

            <button
              className="erp-icon-button"
              type="button"
              aria-label={shell('messages')}
              aria-expanded={openPopover === 'messages'}
              aria-controls="erp-messages-panel"
              onClick={() => togglePopover('messages')}
            >
              <Mail aria-hidden="true" />
            </button>

            <button
              className="erp-icon-button erp-appearance-trigger"
              type="button"
              aria-label={shell('appearance')}
              aria-expanded={appearanceOpen}
              aria-controls="erp-appearance-drawer"
              onClick={openAppearance}
            >
              <Palette aria-hidden="true" />
            </button>

            <button
              className="erp-locale-toggle"
              type="button"
              aria-label={shell('language')}
              title={currentLocale === 'ar' ? shell('english') : shell('arabic')}
              onClick={changeLocale}
            >
              <Languages aria-hidden="true" />
              <span>{currentLocale === 'ar' ? 'EN' : 'ع'}</span>
            </button>

            <button
              className="erp-user-trigger"
              type="button"
              aria-label={shell('user_menu')}
              aria-expanded={openPopover === 'user'}
              aria-controls="erp-user-panel"
              onClick={() => togglePopover('user')}
            >
              <span className="erp-user-trigger__avatar" aria-hidden="true">
                {image ? <img alt="" src={image} /> : initials}
              </span>
              <span className="erp-user-trigger__identity">
                <strong className="erp-user-trigger__name">{displayName}</strong>
                <small className="erp-user-trigger__role" title={roleLabel}>
                  {roleLabel}
                </small>
              </span>
              <ChevronDown className="erp-user-trigger__chevron" aria-hidden="true" />
            </button>
          </div>
        </div>

        {openPopover ? (
          <div
            className="erp-popover-scrim"
            aria-hidden="true"
            onPointerDown={() => setOpenPopover(null)}
          />
        ) : null}

        {openPopover === 'launcher' ? (
          <section
            className="erp-utility-popover erp-launcher"
            id="erp-launcher-panel"
            aria-label={shell('app_launcher')}
          >
            <div className="erp-utility-popover__heading">
              <Grid3X3 aria-hidden="true" />
              <h2>{shell('app_launcher')}</h2>
            </div>
            <div className="erp-launcher__grid">
              {modules.map((module) => {
                const Icon = module.icon;
                const href = firstModuleHref(module);
                const content = (
                  <>
                    <Icon aria-hidden="true" />
                    <span>{shell(`module.${module.key}`)}</span>
                  </>
                );

                return href ? (
                  <Link
                    className="erp-launcher__item"
                    href={href}
                    key={module.key}
                    onClick={closeNavigation}
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    className="erp-launcher__item erp-launcher__item--pending"
                    title={pending('not_built')}
                    key={module.key}
                  >
                    {content}
                  </span>
                );
              })}
            </div>
          </section>
        ) : null}

        {openPopover === 'notifications' ? (
          <section
            className="erp-utility-popover erp-notifications"
            id="erp-notifications-panel"
            aria-label={shell('notifications')}
          >
            <div className="erp-utility-popover__heading">
              <Bell aria-hidden="true" />
              <h2>{shell('notifications')}</h2>
            </div>
            {notifications.length > 0 ? (
              <ul className="erp-notifications__list">
                {notifications.map((note) => (
                  <li key={note.id} className={note.read ? undefined : 'erp-notifications__unread'}>
                    <strong>
                      <bdi dir="auto">{note.subject}</bdi>
                    </strong>
                    <p>
                      <bdi dir="auto">{note.body}</bdi>
                    </p>
                    <time dateTime={note.createdAt}>{note.createdAt.slice(0, 16).replace('T', ' ')}</time>
                  </li>
                ))}
              </ul>
            ) : null}
            {notifications.length > 0 ? null : notificationItem?.href ? (
              <Link
                className="erp-utility-popover__link"
                href={notificationItem.href}
                onClick={closeNavigation}
              >
                {page(notificationItem.key)}
              </Link>
            ) : notificationItem ? (
              <PendingItem item={notificationItem} />
            ) : (
              <p className="erp-utility-popover__empty">{shell('notifications_empty')}</p>
            )}
          </section>
        ) : null}

        {openPopover === 'messages' ? (
          <section
            className="erp-utility-popover erp-messages"
            id="erp-messages-panel"
            aria-label={shell('messages')}
          >
            <div className="erp-utility-popover__heading">
              <Mail aria-hidden="true" />
              <h2>{shell('messages')}</h2>
            </div>
            <p className="erp-utility-popover__empty">{shell('messages_empty')}</p>
          </section>
        ) : null}

        {openPopover === 'user' ? (
          <section
            className="erp-utility-popover erp-user-panel"
            id="erp-user-panel"
            aria-label={shell('user_menu')}
          >
            <div className="erp-user-panel__profile">
              <span className="erp-user-panel__avatar" aria-hidden="true">
                {image ? <img alt="" src={image} /> : initials}
              </span>
              <div className="erp-user-panel__identity">
                <strong>{displayName}</strong>
                <span>{email}</span>
                <small title={roleLabel}>{roleLabel}</small>
              </div>
            </div>
            <nav className="erp-user-panel__menu" aria-label={shell('user_menu')}>
              <Link className="erp-user-panel__item" href="/profile" onClick={closeNavigation}>
                <UserCog aria-hidden="true" />
                <span>{shell('profile_settings')}</span>
              </Link>
              <button className="erp-user-panel__item" type="button" onClick={changeLocale}>
                <Languages aria-hidden="true" />
                <span>
                  {shell('language')}
                  <small>{currentLocale === 'ar' ? shell('english') : shell('arabic')}</small>
                </span>
              </button>
              <button className="erp-user-panel__item" type="button" onClick={openAppearance}>
                <Palette aria-hidden="true" />
                <span>{shell('appearance')}</span>
              </button>
            </nav>
            <form action="/sign-out" method="post" className="erp-user-panel__form">
              <button className="erp-user-panel__item erp-user-panel__item--danger" type="submit">
                <LogOut aria-hidden="true" />
                <span>{shell('sign_out')}</span>
              </button>
            </form>
          </section>
        ) : null}
      </header>

      {mobileOpen ? (
        <div className="erp-mobile-layer">
          <div
            className="erp-mobile-layer__scrim"
            aria-hidden="true"
            onPointerDown={() => setMobileOpen(false)}
          />
          <aside
            className="erp-mobile-drawer"
            id="erp-mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={shell('primary_navigation')}
          >
            <div className="erp-mobile-drawer__header">
              <Image
                className="erp-mobile-drawer__logo"
                src={mainLogo}
                alt={shell('logo_alt')}
                sizes="132px"
              />
              <button
                className="erp-icon-button"
                type="button"
                aria-label={shell('close')}
                onClick={() => setMobileOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="erp-mobile-drawer__context">
              {branchControl}
              <div className="erp-mobile-user">
                <strong>{shortUserId}</strong>
                <span title={roleLabel}>{roleLabel}</span>
              </div>
            </div>

            <nav className="erp-mobile-nav" aria-label={shell('primary_navigation')}>
              {modules.map((module) => {
                const Icon = module.icon;
                return (
                  <details
                    className="erp-mobile-module"
                    key={module.key}
                    open={openMobileModules.includes(module.key)}
                    onToggle={(event) => {
                      const isOpen = event.currentTarget.open;
                      setOpenMobileModules((current) => {
                        const containsModule = current.includes(module.key);
                        if (containsModule === isOpen) return current;
                        return isOpen
                          ? [...current, module.key]
                          : current.filter((key) => key !== module.key);
                      });
                    }}
                  >
                    <summary className="erp-mobile-module__summary">
                      <Icon aria-hidden="true" />
                      <span>{shell(`module.${module.key}`)}</span>
                      <ChevronDown aria-hidden="true" />
                    </summary>
                    <ModuleContents
                      module={module}
                      pathname={pathname}
                      onNavigate={closeNavigation}
                    />
                  </details>
                );
              })}
            </nav>

            <div className="erp-mobile-drawer__actions">
              <button
                className="erp-mobile-action"
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  setOpenPopover('notifications');
                }}
              >
                <Bell aria-hidden="true" />
                <span>{shell('notifications')}</span>
              </button>
              <button
                className="erp-mobile-action"
                type="button"
                onClick={() => {
                  setMobileOpen(false);
                  setOpenPopover('messages');
                }}
              >
                <Mail aria-hidden="true" />
                <span>{shell('messages')}</span>
              </button>
              <button className="erp-mobile-action" type="button" onClick={changeLocale}>
                <Languages aria-hidden="true" />
                <span>{currentLocale === 'ar' ? shell('english') : shell('arabic')}</span>
              </button>
              <button className="erp-mobile-action" type="button" onClick={openAppearance}>
                <Palette aria-hidden="true" />
                <span>{shell('appearance')}</span>
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {appearanceOpen ? (
        <div className="erp-appearance-layer">
          <div
            className="erp-appearance-layer__scrim"
            aria-hidden="true"
            onPointerDown={() => setAppearanceOpen(false)}
          />
          <aside
            className="erp-appearance-drawer"
            id="erp-appearance-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="erp-appearance-title"
          >
            <div className="erp-appearance-drawer__header">
              <div className="erp-appearance-drawer__heading">
                <Palette aria-hidden="true" />
                <div>
                  <small>{shell('customize')}</small>
                  <h2 id="erp-appearance-title">{shell('appearance')}</h2>
                </div>
              </div>
              <button
                className="erp-icon-button"
                type="button"
                aria-label={shell('close')}
                onClick={() => setAppearanceOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <div className="erp-appearance-drawer__body">
              <section aria-labelledby="erp-appearance-preset-title" className="erp-appearance-section">
                <div className="erp-appearance-section__heading">
                  <h3 id="erp-appearance-preset-title">{shell('interface_style')}</h3>
                  <p>{shell('interface_style_hint')}</p>
                </div>
                <div aria-label={shell('interface_style')} className="erp-appearance-cards" role="radiogroup">
                  {APPEARANCE_PRESETS.map((preset) => {
                    const selected = appearance.appearance === preset;
                    const settings = APPEARANCE_PRESET_SETTINGS[preset];
                    const selectWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        chooseAppearancePreset(preset);
                        return;
                      }
                      const direction =
                        event.key === 'ArrowRight' || event.key === 'ArrowDown'
                          ? 1
                          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                            ? -1
                            : 0;
                      if (!direction) return;
                      event.preventDefault();
                      const cards = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                      if (!cards?.length) return;
                      const currentIndex = Array.from(cards).indexOf(event.currentTarget);
                      const nextIndex = (currentIndex + direction + cards.length) % cards.length;
                      chooseAppearancePreset(APPEARANCE_PRESETS[nextIndex]!);
                      cards[nextIndex]?.focus();
                    };
                    return (
                      <div
                        aria-checked={selected}
                        className="erp-appearance-card"
                        key={preset}
                        onClick={() => chooseAppearancePreset(preset)}
                        onKeyDown={selectWithKeyboard}
                        role="radio"
                        tabIndex={selected ? 0 : -1}
                      >
                        <span className="erp-appearance-card__heading">
                          <strong>{shell(`preset_${preset}`)}</strong>
                          {selected ? <Check aria-hidden="true" /> : null}
                        </span>
                        <span className="erp-appearance-card__description">
                          {shell(PRESET_DESCRIPTIONS[preset])}
                        </span>
                        <span
                          aria-hidden="true"
                          className="erp-appearance-preview"
                          data-appearance={preset}
                          data-border-style={settings.borderStyle}
                          data-component-size={settings.componentSize}
                          data-density={settings.density}
                          data-radius={settings.cornerStyle}
                          data-shadow={settings.shadow}
                          data-width={settings.contentWidth}
                        >
                          <span className="erp-appearance-preview__bar">
                            <span />
                            <span />
                            <span />
                          </span>
                          <Panel>
                            <span className="erp-appearance-preview__title" />
                            <span className="erp-appearance-preview__lines">
                              <span />
                              <span />
                            </span>
                            <table className="erp-appearance-preview__table">
                              <tbody>
                                <tr><td /><td /></tr>
                                <tr><td /><td /></tr>
                              </tbody>
                            </table>
                            <Button disabled label={shell('preview_action')} tone="primary" />
                          </Panel>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section aria-labelledby="erp-appearance-controls-title" className="erp-appearance-section">
                <div className="erp-appearance-section__heading">
                  <h3 id="erp-appearance-controls-title">{shell('layout_settings')}</h3>
                </div>
                <div className="erp-appearance-settings-grid">
                  {BASIC_SETTING_NAMES.map(renderAppearanceSetting)}
                </div>
              </section>

              <details className="erp-advanced-appearance">
                <summary>{shell('advanced_appearance')}</summary>
                <div className="erp-appearance-settings-grid">
                  {ADVANCED_SETTING_NAMES.map(renderAppearanceSetting)}
                </div>
              </details>

              <p aria-live="polite" className="erp-appearance-save-state" role="status">
                {shell(`appearance_save_${appearanceSaveState}`)}
              </p>
            </div>
          </aside>
        </div>
      ) : null}

      <main className="shell__main erp-main">{children}</main>
      {footer}
    </div>
  );
}
