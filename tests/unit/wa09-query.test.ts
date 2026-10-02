/**
 * REQ-WA-001 WA-9 — the query he writes himself.
 *
 * The real guarantee is the read-only transaction: PostgreSQL refuses a write
 * from that path before any policy is consulted, and row-level security shows
 * only the asker's own rows. What is tested here is the layer above it — the
 * one that gives a better refusal than the database would, and the two things
 * the database would NOT stop:
 *
 *   * `set_config`, which inside the transaction could rewrite app.user_id and
 *     so read as somebody else. It is a SELECT, and read-only would allow it.
 *   * `select *` on a table with a password column, which is a perfectly
 *     legal read. The column is blanked on the way out instead.
 */
import { describe, expect, it } from 'vitest';
import { cellText, checkQuery, isSecretColumn, rowsToText } from '@/server/domain/whatsapp-sql';

describe('WA-9 · what may be asked', () => {
  it('allows one plain SELECT', () => {
    const checked = checkQuery('select code, phone from business_partner where code = \'1048\'');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.sql).toContain('business_partner');
  });

  it('allows WITH … SELECT, and strips a trailing semicolon', () => {
    const checked = checkQuery('with recent as (select * from ar_invoice limit 5) select * from recent;');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.sql.endsWith(';')).toBe(false);
  });

  it('refuses anything that writes, however it is dressed', () => {
    for (const bad of [
      'insert into app_user (email) values (\'x\')',
      'update business_partner set phone = \'1\'',
      'delete from ar_invoice',
      'drop table payable',
      'with x as (insert into item (code) values (\'y\') returning *) select * from x',
      'grant select on business_partner to public',
    ]) {
      const checked = checkQuery(bad);
      expect(checked.ok, bad).toBe(false);
    }
  });

  it('refuses a second statement, and comments that could hide one', () => {
    expect(checkQuery('select 1; select 2').ok).toBe(false);
    expect(checkQuery('select 1 -- and something else').ok).toBe(false);
    expect(checkQuery('select 1 /* hidden */').ok).toBe(false);
  });

  it('refuses set_config, which read-only would happily allow', () => {
    // The one that matters most: it is a SELECT, it writes nothing, and it
    // could change whose rows the rest of the transaction can see.
    const checked = checkQuery("select set_config('app.user_id', 'somebody-else', true)");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain('set_config');
  });

  it('refuses the bot\'s own pairing, the server\'s files and other databases', () => {
    for (const bad of [
      'select * from whatsapp_session',
      'select * from "whatsapp_session"',
      'select pg_read_file(\'/opt/qs-erp-next/.env\')',
      'select * from pg_authid',
      'select * from dblink(\'dbname=other\', \'select 1\') as t(x int)',
    ]) {
      expect(checkQuery(bad).ok, bad).toBe(false);
    }
  });

  it('refuses something that is not a query at all', () => {
    expect(checkQuery('').ok).toBe(false);
    expect(checkQuery('   ').ok).toBe(false);
    expect(checkQuery('show tables').ok).toBe(false);
    expect(checkQuery(`select ${'x'.repeat(5_000)}`).ok).toBe(false);
  });
});

describe('WA-9 · what comes back', () => {
  it('blanks a column that looks like a secret, whatever was asked for', () => {
    // `select *` on a table of users is a legal read, and the database will
    // hand over the hash. It does not leave this function.
    const text = rowsToText([{ email: 'a@b.c', password_hash: '$2b$10$realhash', api_key: 'sk-live-x' }]);
    expect(text).toContain('a@b.c');
    expect(text).not.toContain('$2b$10$realhash');
    expect(text).not.toContain('sk-live-x');
    expect(text).toContain('«not shown»');
    expect(text).toContain('looks like a secret');
  });

  it('knows which names are secrets', () => {
    for (const name of ['password', 'password_hash', 'api_key', 'refresh_token', 'client_secret', 'private_key']) {
      expect(isSecretColumn(name), name).toBe(true);
    }
    for (const name of ['code', 'phone', 'legal_name', 'balance_iqd']) {
      expect(isSecretColumn(name), name).toBe(false);
    }
  });

  it('says when it showed only part of the rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ n: i }));
    const text = rowsToText(rows, { rowCap: 10 });
    expect(text).toContain('showing 10 of 50 row(s)');
  });

  it('keeps Arabic, names a null, and flattens a cell that would break the table', () => {
    const text = rowsToText([{ name: 'مخزن النجف', note: 'line one\nline two', missing: null }]);
    expect(text).toContain('مخزن النجف');
    expect(text).toContain('line one ⏎ line two');
    expect(text).toContain('∅');
  });

  it('says so plainly when there is nothing', () => {
    expect(rowsToText([])).toBe('No rows.');
  });

  it('cuts a cell that is a whole document', () => {
    expect(cellText('y'.repeat(1_000)).length).toBeLessThan(400);
  });
});
