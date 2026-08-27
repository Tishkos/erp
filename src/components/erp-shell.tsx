'use client';

import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
  KeyRound,
  LogOut,
  Mail,
  Menu,
  Palette,
  Settings,
  Truck,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MenuItem, MenuSection } from '@domain/menu';
import { routeFor } from '@domain/screens';
import mainLogo from '../../mainLogo.png';
import { GlobalSearch } from './global-search';

type ModuleKey =
  | 'dashboard'
  | 'accounting'
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

interface ErpShellProps {
  readonly brand: string;
  readonly branchCode: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly image: string | null;
  readonly roleCodes: readonly string[];
  readonly isSuperUser: boolean;
  readonly sections: readonly MenuSection[];
  /** Rendered after the main region, so it always ends the page. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

type Density = 'comfortable' | 'compact';
type Accent = 'blue' | 'indigo' | 'teal' | 'orange';
type Radius = 'soft' | 'rounded';
type ContentWidth = 'fluid' | 'contained';
type Theme = 'light' | 'dark';

interface AppearancePreferences {
  readonly theme: Theme;
  readonly density: Density;
  readonly accent: Accent;
  readonly radius: Radius;
  readonly width: ContentWidth;
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
      // Phase 0's invoice, then the master data the ledger will serve.
      'master_data',
      'sample_documenting',
      // Sales and Purchasing are the receivable and payable cycles — they
      // belong with the ledger, not with transport. Logistics keeps its own.
      'sales',
      'purchasing',
    ],
  },
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
  density: 'comfortable',
  accent: 'blue',
  radius: 'soft',
  width: 'fluid',
};

const APPEARANCE_OPTIONS = {
  theme: ['light', 'dark'],
  density: ['comfortable', 'compact'],
  accent: ['blue', 'indigo', 'teal', 'orange'],
  radius: ['soft', 'rounded'],
  width: ['fluid', 'contained'],
} as const satisfies {
  readonly [Name in PreferenceName]: readonly AppearancePreferences[Name][];
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
  attribute: `data-${PreferenceName}`,
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

function applyPreference(name: PreferenceName, value: PreferenceValue): void {
  const attribute = `data-${name}` as const;
  document.documentElement.setAttribute(attribute, value);
  try {
    window.localStorage.setItem(attribute, value);
  } catch {
    // The visual preference still applies when storage is unavailable.
  }
}

function PendingItem({ item }: { readonly item: MenuItem }) {
  const page = useTranslations('page');
  const phase = useTranslations('phase');

  return (
    <span
      className="erp-menu-item erp-menu-item--pending"
      title={phase('not_built')}
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
  const phase = useTranslations('phase');

  return (
    <div className="erp-module-contents">
      {module.sections.map((section) => (
        <section className="erp-module-section" key={section.key}>
          <h3 className="erp-module-section__title">{nav(section.key)}</h3>
          <ul className="erp-module-section__list">
            {section.items.map((item) => {
              // Every item in the approved tree has an address: the one its
              // module declared, or the one the screen catalogue derives. An
              // item still drawn over samples keeps its phase badge, so the
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
                    title={preview ? phase('not_built') : undefined}
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
  userId,
  displayName,
  email,
  image,
  roleCodes,
  isSuperUser,
  sections,
  footer,
  children,
}: ErpShellProps) {
  const shell = useTranslations('shell');
  const page = useTranslations('page');
  const phase = useTranslations('phase');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const modules = useMemo(() => groupSections(sections), [sections]);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMobileModules, setOpenMobileModules] = useState<readonly ModuleKey[]>([]);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [currentLocale, setCurrentLocale] = useState(locale === 'ar' ? 'ar' : 'en');
  const [appearance, setAppearance] = useState<AppearancePreferences>(DEFAULT_APPEARANCE);

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

  useLayoutEffect(() => {
    const stored: AppearancePreferences = {
      theme: readStoredPreference(
        'data-theme',
        APPEARANCE_OPTIONS.theme,
        DEFAULT_APPEARANCE.theme,
      ),
      density: readStoredPreference(
        'data-density',
        APPEARANCE_OPTIONS.density,
        DEFAULT_APPEARANCE.density,
      ),
      accent: readStoredPreference(
        'data-accent',
        APPEARANCE_OPTIONS.accent,
        DEFAULT_APPEARANCE.accent,
      ),
      radius: readStoredPreference(
        'data-radius',
        APPEARANCE_OPTIONS.radius,
        DEFAULT_APPEARANCE.radius,
      ),
      width: readStoredPreference('data-width', APPEARANCE_OPTIONS.width, DEFAULT_APPEARANCE.width),
    };

    setAppearance(stored);
    (Object.keys(stored) as PreferenceName[]).forEach((name) => {
      applyPreference(name, stored[name]);
    });
  }, []);

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

  const changeAppearance = (name: PreferenceName, value: PreferenceValue) => {
    setAppearance((current) => ({ ...current, [name]: value }) as AppearancePreferences);
    applyPreference(name, value);
  };

  const openAppearance = () => {
    setOpenPopover(null);
    setMobileOpen(false);
    setAppearanceOpen(true);
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
            <div className="erp-branch" title={branchCode}>
              <Building2 className="erp-branch__icon" aria-hidden="true" />
              <span className="erp-branch__content">
                <small className="erp-branch__label">{shell('branch')}</small>
                <strong className="erp-branch__value">{branchCode || '—'}</strong>
              </span>
            </div>

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
                    title={phase('not_built')}
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
            {notificationItem?.href ? (
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
              <Link className="erp-user-panel__item" href="/profile#password" onClick={closeNavigation}>
                <KeyRound aria-hidden="true" />
                <span>{shell('change_password')}</span>
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
              <div className="erp-branch">
                <Building2 className="erp-branch__icon" aria-hidden="true" />
                <span className="erp-branch__content">
                  <small className="erp-branch__label">{shell('branch')}</small>
                  <strong className="erp-branch__value">{branchCode || '—'}</strong>
                </span>
              </div>
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
              {(Object.keys(APPEARANCE_OPTIONS) as PreferenceName[])
                .filter((name) => name !== 'theme' && name !== 'accent')
                .map((name) => (
                <fieldset className="erp-preference" key={name}>
                  <legend className="erp-preference__legend">{shell(name)}</legend>
                  <div className={`erp-preference__options erp-preference__options--${name}`}>
                    {APPEARANCE_OPTIONS[name].map((value) => {
                      const selected = appearance[name] === value;
                      return (
                        <button
                          className="erp-preference__option"
                          type="button"
                          data-value={value}
                          data-selected={selected ? 'true' : 'false'}
                          aria-pressed={selected}
                          key={value}
                          onClick={() => changeAppearance(name, value)}
                        >
                          <span>{shell(value)}</span>
                          {selected ? <Check aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          </aside>
        </div>
      ) : null}

      <main className="shell__main erp-main">{children}</main>
      {footer}
    </div>
  );
}
