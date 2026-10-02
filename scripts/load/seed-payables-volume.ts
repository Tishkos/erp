/**
 * REQ-AP-001 A21 / REQ-HARDEN-001 I3 (HD17) — the volume the payables load
 * run is measured at: 10,000 import payables and 200,000 status-log events.
 *
 *   LOAD_DATABASE_URL=postgres://erp_owner:…@127.0.0.1:5432/erp_load \
 *     npx tsx scripts/load/seed-payables-volume.ts [--payables 10000] [--events-per 20] [--user admin@example.com]
 *
 * Writes straight into `payable` and `payable_event` with set-based inserts
 * (the payables' own life cycles are covered by their suites; A21 is about
 * the reads at volume), spread over the active suppliers, the branches and
 * every import stage, the events over every lane and the year so far. Then
 * it issues one session for the named user and prints the cookie and a
 * sample of payable numbers for `tests/load/payables.js`.
 *
 * The connection string is never taken from `.env`: a seed against the wrong
 * database is the mistake this refuses, as it refuses while `var/LIVE` exists.
 * Run it on a database made for the purpose (`docs/RUNBOOK-host-build.md`
 * › Load run); its rows are prefixed `LD-` and are not documents anybody
 * should keep.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { refuseOnLive } from '../lib/live-guard';

refuseOnLive('seed the A21 load volume');

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return (at > 0 ? process.argv[at + 1] : undefined) ?? fallback;
}

const url = process.env.LOAD_DATABASE_URL;
if (!url) {
  console.error('Set LOAD_DATABASE_URL to the owner connection of the load database. `.env` is not read on purpose.');
  process.exit(1);
}
const PAYABLES = Number(option('payables', '10000'));
const EVENTS_PER = Number(option('events-per', '20'));
const EMAIL = option('user', 'admin@example.com');

async function main() {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const name = (await client.query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? '';
    if (/^erp$|live|prod/i.test(name)) throw new Error(`Refusing to seed load volume into "${name}" — make a database for the run.`);

    const user = (await client.query<{ id: string }>('select id from app_user where lower(email) = lower($1)', [EMAIL])).rows[0];
    if (!user) throw new Error(`No user ${EMAIL} in ${name}.`);

    const started = Date.now();
    await client.query('begin');
    // Set-based: every payable from one statement, its events from another.
    const payables = await client.query(
      `with supplier as (
         select id, row_number() over (order by code) - 1 as n, count(*) over () as total
           from business_partner where is_supplier and active
       ),
       place as (
         select code, row_number() over (order by code) - 1 as n, count(*) over () as total
           from branch where active
       ),
       stage as (
         select code, row_number() over (order by sequence) - 1 as n, count(*) over () as total
           from payable_stage where payable_type_code = 'import'
       )
       insert into payable (payable_no, payable_type_code, supplier_reference, supplier_reference_key, supplier_id, branch_code,
                            currency, amount_txn, amount_iqd, quantity, document_date, description, stage_code, stage_since,
                            on_hold, source, created_by, created_at, updated_at)
       select 'LD-' || place.code || '-2026-' || lpad(g::text, 6, '0'),
              'import',
              'LOAD-PI-' || g, 'LOADPI' || g,
              supplier.id, place.code,
              'USD', (1000 + (g % 97) * 250)::numeric, ((1000 + (g % 97) * 250) * 1310)::numeric, (10 + g % 400)::numeric,
              date '2026-01-01' + (g % 270),
              'A21 load payable ' || g,
              stage.code,
              timestamptz '2026-01-01 08:00+03' + make_interval(days => g % 270),
              (g % 23 = 0), 'erp', $1, now(), now()
         from generate_series(1, $2::int) as g
         join supplier on supplier.n = g % supplier.total
         join place on place.n = g % place.total
         join stage on stage.n = g % stage.total
       on conflict do nothing
       returning id`,
      [user.id, PAYABLES],
    );
    const events = await client.query(
      `with code as (
         select code, lane_code, row_number() over (order by lane_code, code) - 1 as n, count(*) over () as total
           from payable_event_code
       ),
       target as (
         select id, row_number() over (order by payable_no) as k from payable where payable_no like 'LD-%'
       )
       insert into payable_event (payable_id, occurred_at, recorded_at, lane_code, event_code, summary, actor_user_id)
       select target.id,
              timestamptz '2026-01-01 09:00+03' + make_interval(days => ((target.k + e) % 270)::int, mins => e),
              timestamptz '2026-01-01 09:00+03' + make_interval(days => ((target.k + e) % 270)::int, mins => e),
              code.lane_code, code.code,
              'A21 load event ' || e || ' on ' || target.k,
              $1
         from target
         cross join generate_series(1, $2::int) as e
         join code on code.n = (target.k * 7 + e) % code.total`,
      [user.id, EVENTS_PER],
    );
    await client.query('commit');
    await client.query('analyze payable');
    await client.query('analyze payable_event');

    const token = randomBytes(32).toString('base64url');
    await client.query(`insert into auth_session (id, user_id, token, expires_at, user_agent) values ($1, $2, $3, now() + interval '8 hours', 'k6 A21 load run')`, [
      randomUUID(),
      user.id,
      createHash('sha256').update(token).digest('hex'),
    ]);
    const sample = (await client.query<{ payable_no: string }>(`select payable_no from payable where payable_no like 'LD-%' order by payable_no desc limit 25`)).rows.map((row) => row.payable_no);
    const totals = (await client.query<{ payables: string; events: string }>(`select (select count(*) from payable) as payables, (select count(*) from payable_event) as events`)).rows[0] ?? {
      payables: '?',
      events: '?',
    };

    console.log(`Seeded ${payables.rowCount} payables and ${events.rowCount} events into ${name} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    console.log(`The database now holds ${totals.payables} payables and ${totals.events} events.`);
    console.log(`LOAD_SESSION=${token}`);
    console.log(`LOAD_PAYABLES=${sample.join(',')}`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
