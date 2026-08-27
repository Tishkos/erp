import Image from 'next/image';
import Link from 'next/link';
import {
  Activity,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  Landmark,
  Network,
  UserCheck,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import mainLogo from '../../mainLogo.png';
import styles from './dashboard-workspace.module.css';

/**
 * My Dashboard — Phase 0.
 *
 * Every figure on this screen is read from the database at request time:
 * the organisation structure, the people in it, what is waiting for the
 * signed-in person, and what changed lately. Nothing is sampled. The
 * financial widgets (revenue, cash, receivables) arrive with the modules that
 * produce those numbers — an honest empty space beats an invented one.
 */
export interface DashboardMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly hint: string;
  readonly href: string;
  readonly linkLabel: string;
  readonly tone: 'blue' | 'green' | 'orange' | 'purple' | 'red';
  readonly icon: 'branches' | 'departments' | 'users' | 'approvals' | 'activity';
}

export interface DashboardActivity {
  readonly id: string;
  readonly when: string;
  readonly action: string;
  readonly actor: string | null;
  readonly objectType: string;
  readonly objectId: string | null;
}

export interface DashboardLink {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

export interface DaySeries {
  /** Short day label, oldest first. */
  readonly labels: readonly string[];
  readonly values: readonly number[];
  readonly today: number;
  readonly last7: number;
  readonly last30: number;
  readonly total: number;
}

export interface Share {
  readonly label: string;
  readonly value: number;
}

export interface ManagerRow {
  readonly code: string;
  readonly name: string;
  readonly manager: string | null;
  readonly members: number;
}

export interface Phase0DashboardLabels {
  readonly welcome: string;
  readonly welcomeSubtitle: string;
  readonly company: string;
  readonly companyNotSet: string;
  readonly setupCompany: string;
  readonly quickActions: string;
  readonly noQuickActions: string;
  readonly companyLogoAlt: string;
  readonly currentBranch: string;
  readonly today: string;
  readonly recentActivity: string;
  readonly recentActivityHint: string;
  readonly noActivity: string;
  readonly viewAllActivity: string;
  readonly yourAccess: string;
  readonly yourAccessHint: string;
  readonly noReachablePages: string;
  readonly activityChart: string;
  readonly last14Days: string;
  readonly last7Days: string;
  readonly last30Days: string;
  readonly allTime: string;
  readonly usersByRole: string;
  readonly records: string;
  readonly departmentManagers: string;
  readonly noManager: string;
  readonly members: string;
  readonly openWorkspace: string;
}

const ICONS: Record<DashboardMetric['icon'], LucideIcon> = {
  branches: Building2,
  departments: Network,
  users: Users,
  approvals: ClipboardCheck,
  activity: Activity,
};

const PALETTE = ['#2f69ee', '#2899ec', '#53cdb7', '#ff6f72', '#ef7b2d', '#7e48eb', '#cbd3df'];

function linePoints(values: readonly number[], width = 720, height = 190, pad = 8) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: pad + i * step,
    y: height - pad - (v / max) * (height - pad * 2 - 12),
  }));
}

const attr = (points: readonly { x: number; y: number }[]) =>
  points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

export function Phase0Dashboard({
  locale,
  branchCode,
  dateLabel,
  companyName,
  companyHref,
  metrics,
  activity,
  links,
  series,
  usersByRole,
  records,
  managers,
  labels,
}: {
  readonly locale: string;
  readonly branchCode: string;
  readonly dateLabel: string;
  readonly companyName: string | null;
  readonly companyHref: string | null;
  readonly metrics: readonly DashboardMetric[];
  readonly activity: readonly DashboardActivity[];
  readonly links: readonly DashboardLink[];
  readonly series: DaySeries | null;
  readonly usersByRole: readonly Share[];
  readonly records: readonly (Share & { readonly href: string })[];
  readonly managers: readonly ManagerRow[];
  readonly labels: Phase0DashboardLabels;
}) {
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

  const points = series ? linePoints(series.values) : [];
  const maxValue = series ? Math.max(1, ...series.values) : 1;
  const scale = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(maxValue * f));

  const roleTotal = usersByRole.reduce((sum, s) => sum + s.value, 0) || 1;
  let cursor = 0;
  const stops = usersByRole.map((s, i) => {
    const from = cursor;
    cursor += (s.value / roleTotal) * 100;
    return `${PALETTE[i % PALETTE.length]} ${from.toFixed(1)}% ${cursor.toFixed(1)}%`;
  });
  const recordMax = Math.max(1, ...records.map((r) => r.value));

  return (
    <div className={styles.workspace}>
      <section className={styles.hero} style={{ paddingBlock: '1.6rem 2.4rem' }}>
        <div className={styles.heroCopy}>
          <p className={styles.heroEyebrow}>
            <span className={styles.liveDot} aria-hidden="true" />
            {companyName ?? labels.companyNotSet}
          </p>
          <h1>{labels.welcome}</h1>
          <p>{labels.welcomeSubtitle}</p>
          <div className={styles.contextRow} style={{ marginBlockStart: '1rem', rowGap: '0.6rem' }}>
            <span className={styles.contextPill}>
              <CalendarDays aria-hidden="true" />
              <span className={styles.contextLabel}>{labels.today}</span>
              <bdi dir="auto">{dateLabel}</bdi>
            </span>
            <span className={styles.contextPill}>
              <Building2 aria-hidden="true" />
              <span className={styles.contextLabel}>{labels.currentBranch}</span>
              <bdi dir="ltr">{branchCode || '—'}</bdi>
            </span>
            {companyName === null && companyHref ? (
              <Link
                className={styles.contextPill}
                href={companyHref}
                style={{
                  textDecoration: 'none',
                  color: 'var(--accent-contrast)',
                  background: 'var(--accent)',
                  borderColor: 'var(--accent)',
                }}
              >
                <Landmark aria-hidden="true" style={{ color: 'inherit', inlineSize: '1rem', blockSize: '1rem' }} />
                <span>{labels.setupCompany}</span>
              </Link>
            ) : null}
            <details className={styles.quickActions}>
              <summary>
                <Zap aria-hidden="true" />
                <span>{labels.quickActions}</span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <div className={styles.quickMenu}>
                {links.length > 0 ? (
                  links.slice(0, 12).map((link) => (
                    <Link href={link.href} key={link.key}>
                      {link.label}
                    </Link>
                  ))
                ) : (
                  <span>{labels.noQuickActions}</span>
                )}
              </div>
            </details>
          </div>

        </div>
        <div className={styles.heroBrand}>
          <span className={styles.brandGlow} aria-hidden="true" />
          <Image
            alt={labels.companyLogoAlt}
            className={styles.heroLogo}
            preload
            sizes="(max-width: 608px) 0px, 150px"
            src={mainLogo}
          />
        </div>
      </section>

      <section className={styles.metricsGrid}>
        {metrics.map((metric) => {
          const Icon = ICONS[metric.icon];
          return (
            <article className={`${styles.metricCard} ${styles[metric.tone]!}`} key={metric.key}>
              <div className={styles.metricContent}>
                <span className={styles.metricIcon}>
                  <Icon aria-hidden="true" />
                </span>
                <div className={styles.metricBody}>
                  <h2>{metric.label}</h2>
                  <p className={styles.metricValue}>
                    <strong>
                      <bdi dir="ltr">{number.format(metric.value)}</bdi>
                    </strong>
                  </p>
                  <p className={styles.metricSecondary}>{metric.hint}</p>
                </div>
              </div>
              <Link className={styles.inlineLink} href={metric.href}>
                {metric.linkLabel}
              </Link>
            </article>
          );
        })}
      </section>

      <section className={styles.analyticsGrid}>
        <article className={`${styles.panel} ${styles.revenuePanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.activityChart}</h2>
              <p>{labels.recentActivityHint}</p>
            </div>
            <span className={styles.periodPill}>{labels.last14Days}</span>
          </header>
          {series ? (
            <>
              <p className={styles.chartTotal}>
                <strong>
                  <bdi dir="ltr">{number.format(series.last7)}</bdi>
                </strong>
                <bdi dir="ltr">{labels.last7Days}</bdi>
              </p>
              <div className={styles.linePlot} role="img" aria-label={labels.activityChart}>
                <div className={styles.chartScale} aria-hidden="true">
                  {scale.map((v, i) => (
                    <span key={i}>{number.format(v)}</span>
                  ))}
                </div>
                <svg
                  aria-hidden="true"
                  className={styles.revenueChart}
                  focusable="false"
                  preserveAspectRatio="none"
                  viewBox="0 0 720 190"
                >
                  <defs>
                    <linearGradient id="dashboard-activity-area" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#2260ec" stopOpacity="0.24" />
                      <stop offset="100%" stopColor="#2260ec" stopOpacity="0.015" />
                    </linearGradient>
                  </defs>
                  {[38, 76, 114, 152].map((y) => (
                    <line className={styles.chartGridLine} key={y} x1="0" x2="720" y1={y} y2={y} />
                  ))}
                  <polygon
                    className={styles.revenueArea}
                    points={`${points[0]?.x ?? 8},190 ${attr(points)} ${points.at(-1)?.x ?? 712},190`}
                  />
                  <polyline className={styles.revenueLine} points={attr(points)} />
                  {points.map((p, i) => (
                    <circle className={styles.revenuePoint} cx={p.x} cy={p.y} key={i} r="3.2" />
                  ))}
                </svg>
                <div className={styles.monthAxis} aria-hidden="true">
                  {series.labels.map((l, i) => (
                    <span key={`${l}-${i}`}>{i % 2 === 1 ? l : ''}</span>
                  ))}
                </div>
              </div>
              <dl className={styles.summaryStrip}>
                <div>
                  <dt>{labels.today}</dt>
                  <dd>
                    <bdi dir="ltr">{number.format(series.today)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{labels.last7Days}</dt>
                  <dd>
                    <bdi dir="ltr">{number.format(series.last7)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{labels.last30Days}</dt>
                  <dd>
                    <bdi dir="ltr">{number.format(series.last30)}</bdi>
                  </dd>
                </div>
                <div>
                  <dt>{labels.allTime}</dt>
                  <dd>
                    <bdi dir="ltr">{number.format(series.total)}</bdi>
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="muted">{labels.noActivity}</p>
          )}
        </article>

        <article className={`${styles.panel} ${styles.expensePanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.usersByRole}</h2>
            </div>
            <span className={styles.periodPill}>{number.format(roleTotal)}</span>
          </header>
          <div className={styles.donutLayout}>
            <div
              aria-label={labels.usersByRole}
              className={styles.donut}
              role="img"
              style={{ background: `conic-gradient(${stops.join(', ')})` }}
            >
              <div>
                <strong>
                  <bdi dir="ltr">{number.format(roleTotal)}</bdi>
                </strong>
                <bdi dir="ltr">{labels.members}</bdi>
              </div>
            </div>
            <ul className={styles.legend}>
              {usersByRole.map((s, i) => (
                <li key={s.label}>
                  <span aria-hidden="true" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                  <p>
                    <strong>{s.label}</strong>
                    <small>
                      <bdi dir="ltr">
                        {number.format(s.value)} ({percent.format((s.value / roleTotal) * 100)}%)
                      </bdi>
                    </small>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className={`${styles.panel} ${styles.cashPanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.records}</h2>
            </div>
          </header>
          <ul className={styles.legend} style={{ gap: '0.7rem' }}>
            {records.map((r, i) => (
              <li key={r.label} style={{ display: 'grid', gap: '0.3rem' }}>
                <p style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Link className={styles.inlineLink} href={r.href} style={{ margin: 0 }}>
                    {r.label}
                  </Link>
                  <strong>
                    <bdi dir="ltr">{number.format(r.value)}</bdi>
                  </strong>
                </p>
                <span
                  aria-hidden="true"
                  style={{
                    display: 'block',
                    blockSize: '0.45rem',
                    inlineSize: '100%',
                    borderRadius: '999px',
                    background: 'var(--surface-muted)',
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      blockSize: '100%',
                      inlineSize: `${Math.max(4, (r.value / recordMax) * 100)}%`,
                      borderRadius: '999px',
                      background: PALETTE[i % PALETTE.length],
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className={styles.operationalGrid} style={{ alignItems: 'start' }}>
        <article className={styles.panel} style={{ blockSize: 'auto', maxBlockSize: 'none' }}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <Activity aria-hidden="true" />
              <div>
                <h2>{labels.recentActivity}</h2>
                <p>{labels.recentActivityHint}</p>
              </div>
            </div>
            <Link className={styles.inlineLink} href="/administration/audit">
              {labels.viewAllActivity}
            </Link>
          </header>
          {activity.length === 0 ? (
            <p className="muted">{labels.noActivity}</p>
          ) : (
            <ul className={styles.activityList}>
              {activity.map((entry) => (
                <li key={entry.id}>
                  <span className={styles.activityIcon}>
                    <Activity aria-hidden="true" />
                  </span>
                  <div style={{ minInlineSize: 0 }}>
                    <strong style={{ display: 'block', fontSize: '0.8rem' }}>
                      <bdi dir="ltr">{entry.action}</bdi>
                    </strong>
                    <span className="muted" style={{ display: 'block', fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.actor ? `${entry.actor} · ` : ''}
                      {entry.objectType} · {entry.when}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className={styles.panel} style={{ blockSize: 'auto', maxBlockSize: 'none' }}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <UserCheck aria-hidden="true" />
              <div>
                <h2>{labels.departmentManagers}</h2>
              </div>
            </div>
            <Link className={styles.inlineLink} href="/administration/managers">
              {labels.openWorkspace}
            </Link>
          </header>
          <ul className={styles.activityList}>
            {managers.map((m) => (
              <li key={m.code}>
                <span className={styles.activityIcon}>
                  <Network aria-hidden="true" />
                </span>
                <Link href={`/master-data/departments/${encodeURIComponent(m.code)}`}>
                  <strong style={{ display: 'block', fontSize: '0.8rem' }}>
                    {m.code} · {m.name}
                  </strong>
                  <span className="muted" style={{ fontSize: '0.7rem' }}>
                    {m.manager ?? labels.noManager} · {number.format(m.members)} {labels.members}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </article>

        <article className={styles.panel} style={{ blockSize: 'auto', maxBlockSize: 'none' }}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <Zap aria-hidden="true" />
              <div>
                <h2>{labels.yourAccess}</h2>
                <p>{labels.yourAccessHint}</p>
              </div>
            </div>
          </header>
          {links.length === 0 ? (
            <p className="muted">{labels.noReachablePages}</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {links.slice(0, 18).map((link) => (
                <Link
                  className={styles.contextPill}
                  href={link.href}
                  key={link.key}
                  style={{ textDecoration: 'none', fontSize: '0.74rem' }}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          )}
        </article>
      </section>
    </div>
  );
}
