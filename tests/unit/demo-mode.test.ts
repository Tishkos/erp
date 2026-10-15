/**
 * The demo instance (accounting.qs-groups.com): `ERP_DEMO=on` on a database that is
 * not the live books turns on a bare user name at sign-in, no second factor and a
 * fixed password for the demo's own accounts — and the flag is ignored on `erp`, so
 * a copied `.env` line can never switch the live system's second factor off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_DOMAIN, databaseNameOf, demoEnabled, demoSignInEmail, isDemoAccount } from '@/server/domain/demo';
import { demoMode } from '@/server/services/demo';

const DEMO_DB = 'postgres://erp_app:secret@127.0.0.1:5434/erp_demo';
const LIVE_DB = 'postgres://erp_app:secret@127.0.0.1:5434/erp';

describe('demo mode', () => {
  it('reads the database a connection string names', () => {
    expect(databaseNameOf(DEMO_DB)).toBe('erp_demo');
    expect(databaseNameOf(`${LIVE_DB}?sslmode=disable`)).toBe('erp');
    expect(databaseNameOf('postgres://erp_app:secret@127.0.0.1:5434/')).toBeNull();
    expect(databaseNameOf('not a url')).toBeNull();
    expect(databaseNameOf(undefined)).toBeNull();
  });

  it('is on only with the flag, on a database that is not the live books', () => {
    expect(demoEnabled({ ERP_DEMO: 'on', DATABASE_URL: DEMO_DB })).toBe(true);
    expect(demoEnabled({ ERP_DEMO: ' ON ', DATABASE_URL: DEMO_DB })).toBe(true);
    expect(demoEnabled({ ERP_DEMO: 'on', DATABASE_URL: LIVE_DB })).toBe(false);
    expect(demoEnabled({ ERP_DEMO: 'on', DATABASE_URL: 'postgres://erp_app:secret@127.0.0.1:5434/ERP' })).toBe(false);
    expect(demoEnabled({ ERP_DEMO: 'on' })).toBe(false);
    expect(demoEnabled({ ERP_DEMO: 'on', DATABASE_URL: 'garbage' })).toBe(false);
    expect(demoEnabled({ ERP_DEMO: 'yes', DATABASE_URL: DEMO_DB })).toBe(false);
    expect(demoEnabled({ DATABASE_URL: DEMO_DB })).toBe(false);
  });

  it('turns a bare user name into the demo account, and leaves an e-mail alone', () => {
    expect(demoSignInEmail('admin')).toBe(`admin@${DEMO_DOMAIN}`);
    expect(demoSignInEmail('  admin ')).toBe(`admin@${DEMO_DOMAIN}`);
    expect(demoSignInEmail('someone@qs-groups.com')).toBe('someone@qs-groups.com');
    expect(demoSignInEmail('   ')).toBe('');
  });

  it('knows the demo’s own accounts', () => {
    expect(isDemoAccount(`admin@${DEMO_DOMAIN}`)).toBe(true);
    expect(isDemoAccount(`Admin@${DEMO_DOMAIN.toUpperCase()}`)).toBe(true);
    expect(isDemoAccount('admin@qs-groups.com')).toBe(false);
    expect(isDemoAccount(`admin@x${DEMO_DOMAIN}`)).toBe(false);
  });

  describe('the process', () => {
    const original = { ERP_DEMO: process.env.ERP_DEMO, DATABASE_URL: process.env.DATABASE_URL };
    afterEach(() => {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it('follows the environment, and refuses the live books', () => {
      process.env.ERP_DEMO = 'on';
      process.env.DATABASE_URL = DEMO_DB;
      expect(demoMode()).toBe(true);
      process.env.DATABASE_URL = LIVE_DB;
      expect(demoMode()).toBe(false);
      delete process.env.ERP_DEMO;
      process.env.DATABASE_URL = DEMO_DB;
      expect(demoMode()).toBe(false);
    });
  });
});
