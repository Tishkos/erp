/**
 * The last-resort error page (`src/app/global-error.tsx`) replaces the root
 * layout, which owns the message provider, so it carries its own words
 * (`global-error-words.ts`). They are the catalogue's words all the same:
 * `states.global` in both locales is where a translator changes them, and
 * this holds the copy equal to it.
 */
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import { GLOBAL_ERROR_WORDS } from '@/components/states/global-error-words';
import { shapeOf } from '@/components/states/skeleton-shape';

describe('route states · the global error page', () => {
  it('says what the catalogue says, in both languages', () => {
    expect(GLOBAL_ERROR_WORDS.en).toEqual(en.states.global);
    expect(GLOBAL_ERROR_WORDS.ar).toEqual(ar.states.global);
  });
});

describe('route states · the skeleton takes the shape of the screen being opened', () => {
  it('draws Home and the dashboards as figures and charts', () => {
    expect(shapeOf('/', {})).toBe('home');
    expect(shapeOf('/hr/dashboard', {})).toBe('home');
  });

  it('draws a record or a new-document form as a document', () => {
    expect(shapeOf('/payables/invoices/API-HQ-2026-000001', { invoiceNo: 'API-HQ-2026-000001' })).toBe('document');
    expect(shapeOf('/payables/invoices/new', {})).toBe('document');
  });

  it('draws every other screen — the catch-all included — as a register', () => {
    expect(shapeOf('/payables/invoices', {})).toBe('register');
    expect(shapeOf('/master-data/price-lists', { screen: ['master-data', 'price-lists'] })).toBe('register');
  });
});
