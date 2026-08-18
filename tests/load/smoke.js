/**
 * k6 load harness — Phase 00.5 baseline, carrying D5's approved volumes.
 *
 * D5 (decided 2026-08-17) supplies the concurrency figures below: 20 normal
 * concurrent users, 50 at peak including month-end and reporting periods,
 * ~250,000 business documents a year growing to 1,000,000, and integration
 * throughput of 10–20 requests/second normal, ~50/second peak.
 *
 * D5 item 6 — acceptable response-time targets — is still open, and that is
 * the item this file cannot invent. The `thresholds` below are therefore
 * marked PROVISIONAL: they are engineering guesses, not approved criteria.
 * §25 acceptance criterion 3 is judged against the approved targets, so until
 * they arrive this harness can be *run* but its verdict cannot be *trusted*.
 *
 * Phase 20.4 replaces the provisional thresholds and adds the full month-end
 * scenario §25 requires: close activity, imports, background jobs and
 * simultaneous reporting.
 *
 *   npm run test:load                 # smoke — 1 user, proves the harness runs
 *   LOAD_PROFILE=normal npm run test:load
 *   LOAD_PROFILE=peak   npm run test:load
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://localhost:3000';
const PROFILE = __ENV.LOAD_PROFILE || 'smoke';

/** D5, decided 2026-08-17 — concurrent users. */
export const D5_CONCURRENCY = {
  normal: 20,
  peak: 50,
};

const PROFILES = {
  // Proves the harness and the target are alive. Not a load test.
  smoke: { vus: 1, duration: '10s' },

  // D5: 20 concurrent users is the normal working day.
  normal: {
    stages: [
      { duration: '30s', target: D5_CONCURRENCY.normal },
      { duration: '2m', target: D5_CONCURRENCY.normal },
      { duration: '30s', target: 0 },
    ],
  },

  // D5: 50 concurrent users — month-end, reporting periods, and the
  // approval backlog that follows them.
  peak: {
    stages: [
      { duration: '1m', target: D5_CONCURRENCY.normal },
      { duration: '1m', target: D5_CONCURRENCY.peak },
      { duration: '3m', target: D5_CONCURRENCY.peak },
      { duration: '1m', target: 0 },
    ],
  },
};

if (!PROFILES[PROFILE]) {
  throw new Error(
    `Unknown LOAD_PROFILE "${PROFILE}" — expected one of: ${Object.keys(PROFILES).join(', ')}`,
  );
}

export const options = {
  ...PROFILES[PROFILE],
  thresholds: {
    // Approved by D5: the system must not fail under its stated load.
    http_req_failed: ['rate<0.01'],

    // PROVISIONAL — D5 item 6 open. Replace with the approved 95th-percentile
    // targets for: opening a list, filtered search, opening a record, posting
    // a journal, and the Trial Balance. Do not treat a pass here as evidence.
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get(BASE_URL);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
