/**
 * Platform detectors — platform phase, Agent 7: the host's own health.
 *
 * `system-health.check` looks at the files and the disk of the machine the
 * sweep runs on (the newest backup, free space, the jobs' last exit), so what
 * this detector finds depends on where it runs. It is registered as host dependent;
 * the integration tests run the other detectors.
 */
import { EVIDENCE_ROW, type Finding, type Severity } from '../../domain/exceptions';
import * as health from '../system-health';
import type { DetectContext } from './shared';

/** A stop that means the books or the data are at risk now. */
const CRITICAL_STOPS = new Set(['backup_missing', 'backup_stale', 'period_missing', 'partition_horizon']);

const HEALTH_ROUTE = '/administration/backup-health';

export async function systemHealth(ctx: DetectContext): Promise<Finding[]> {
  const report = await health.check(ctx.tx, { now: ctx.now });
  return report.findings.map((finding) => {
    const job = finding.code === 'job_failed' ? /job "([^"]+)"/.exec(finding.message)?.[1] : undefined;
    const severity: Severity = finding.severity === 'stop' ? (CRITICAL_STOPS.has(finding.code) ? 'critical' : 'high') : 'medium';
    return {
      detector: 'platform.system_health',
      subject: job ? `${finding.code}:${job}` : finding.code,
      severity,
      facts: { healthCheck: finding.code, job: job ?? null, message: finding.message.slice(0, 400) },
      evidence: [EVIDENCE_ROW({ ref: finding.code, href: HEALTH_ROUTE, note: { code: 'health_message', params: { message: finding.message.slice(0, 400) } } })],
      record: { type: 'system', id: job ? `${finding.code}:${job}` : finding.code, label: finding.code, href: HEALTH_ROUTE },
      action: HEALTH_ROUTE,
      branchCode: null,
    };
  });
}
