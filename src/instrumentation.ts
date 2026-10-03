import type { Instrumentation } from 'next';

/**
 * REQ-IMPROVE-001 OP-5 — the one place every server error passes through.
 *
 * Next hands this every error a render, a route handler or a server action
 * raised, together with the request it came from. It is written through the
 * redacting logger as one JSON line carrying the request id nginx minted
 * (`X-Request-ID`) and React's error `digest` — the same two values the
 * error page shows the person as their reference, so a support question
 * ("it failed, reference 7f3c…") finds its line in `pm2 logs` or the log
 * file at once.
 *
 * `register` runs once at start-up and records which build came up, so the
 * log says which revision a line belongs to without anyone having to work it
 * out from timestamps against var/deploys.log.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Both modules are Node-only; the dynamic import keeps the edge bundle
  // (which also compiles this file) free of them.
  const { logger } = await import('./server/logging');
  const { buildId, nodeVersion, version } = await import('./server/services/system-health');
  logger.info('server started', {
    version: version(),
    build: buildId(),
    node: nodeVersion(),
    timezone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./server/logging');
  const digest = typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : null;
  const header = request.headers['x-request-id'];
  logger.error('request failed', {
    error,
    digest,
    requestId: Array.isArray(header) ? header[0] : (header ?? null),
    method: request.method,
    // The path without its query: a query can carry a search term, never a
    // secret by design, but a log line is read by more people than a screen.
    path: request.path.split('?')[0],
    routeType: context.routeType,
    routePath: context.routePath,
  });
};
