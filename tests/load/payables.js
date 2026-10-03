/**
 * k6 — REQ-AP-001 A21: the Payables workbench at 10,000 payables / 200,000
 * events answers in under 1 s; the payable page in under 1.5 s.
 *
 * The volume is `scripts/load/seed-payables-volume.ts`, which prints the two
 * values this needs:
 *
 *   LOAD_BASE_URL=http://127.0.0.1:3100 LOAD_SESSION=… LOAD_PAYABLES=LD-…,LD-… \
 *     k6 run tests/load/payables.js                      # D5 normal: 20 users
 *   LOAD_PROFILE=peak k6 run tests/load/payables.js      # D5 peak: 50 users
 *
 * Each virtual user opens the workbench (first page, a later page, a search,
 * the stopped filter) and a payable record, as a person working the list
 * does — reading each page for 3 to 7 seconds before the next, so 20 users
 * ask about 4 pages a second and 50 about 10 (D5's 10–20 and ~50 requests a
 * second are integration traffic, not people). `LOAD_THINK=0` drops the
 * reading time and finds the server's ceiling instead. The thresholds are
 * A21's, per page, at the 95th percentile; a run that misses one exits
 * non-zero. The figures of each run are written in REQ-HARDEN-001 §3.I
 * (HD17).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.LOAD_BASE_URL || 'http://localhost:3000';
const PROFILE = __ENV.LOAD_PROFILE || 'normal';
const SESSION = __ENV.LOAD_SESSION;
const PAYABLES = (__ENV.LOAD_PAYABLES || '').split(',').filter(Boolean);
const THINK = __ENV.LOAD_THINK === '0' ? 0 : 1;

if (!SESSION) throw new Error('Set LOAD_SESSION (printed by scripts/load/seed-payables-volume.ts).');
if (PAYABLES.length === 0) throw new Error('Set LOAD_PAYABLES (printed by scripts/load/seed-payables-volume.ts).');

const PROFILES = {
  smoke: { vus: 1, duration: '15s' },
  // D5 — 20 concurrent users on a normal day.
  normal: {
    stages: [
      { duration: '20s', target: 20 },
      { duration: '2m', target: 20 },
      { duration: '10s', target: 0 },
    ],
  },
  // D5 — 50 at month-end.
  peak: {
    stages: [
      { duration: '20s', target: 20 },
      { duration: '20s', target: 50 },
      { duration: '2m', target: 50 },
      { duration: '10s', target: 0 },
    ],
  },
};

if (!PROFILES[PROFILE]) throw new Error(`Unknown LOAD_PROFILE "${PROFILE}" — expected one of: ${Object.keys(PROFILES).join(', ')}`);

export const options = {
  ...PROFILES[PROFILE],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // A21 — the workbench under 1 s, the payable page under 1.5 s.
    'http_req_duration{page:workbench}': ['p(95)<1000'],
    'http_req_duration{page:record}': ['p(95)<1500'],
  },
};

const params = (page) => ({
  headers: { Cookie: `erp_session=${SESSION}` },
  redirects: 0,
  tags: { page },
});

const ok = (res) =>
  check(res, {
    'answered 200': (r) => r.status === 200,
    // A redirect to /sign-in would be fast and wrong.
    'not the sign-in form': (r) => !String(r.body || '').includes('name="password"'),
  });

/** A person reads the page before opening the next: 3 to 7 seconds. */
const read = () => sleep(THINK * (3 + Math.random() * 4));

export default function () {
  const n = Math.floor(Math.random() * 1000);
  ok(http.get(`${BASE_URL}/payables`, params('workbench')));
  read();
  ok(http.get(`${BASE_URL}/payables?page=${2 + (n % 150)}`, params('workbench')));
  read();
  ok(http.get(`${BASE_URL}/payables?q=LOAD-PI-${n}`, params('workbench')));
  read();
  ok(http.get(`${BASE_URL}/payables?stopped=yes`, params('workbench')));
  read();
  ok(http.get(`${BASE_URL}/payables/${encodeURIComponent(PAYABLES[n % PAYABLES.length])}`, params('record')));
  read();
}
