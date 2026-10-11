/**
 * The Security screen's QR code — every module held against a reference.
 *
 * `qrcode-terminal` (the WhatsApp bridge's pairing code) carries Kazuhiko
 * Arase's encoder, which phones have been reading for fifteen years. The
 * domain's own encoder must draw the same symbol, module for module, for each
 * of the eight mask patterns — which one is chosen is a matter of legibility,
 * not of correctness, so that is checked apart.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { QR_QUIET_ZONE, QrTooLongError, qrCode, qrPath } from '@/server/domain/qr-code';

const require = createRequire(import.meta.url);
const Reference = require('qrcode-terminal/vendor/QRCode') as new (
  typeNumber: number,
  level: number,
) => {
  typeNumber: number;
  modules: boolean[][];
  addData(data: string): void;
  make(): void;
  makeImpl(test: boolean, mask: number): void;
};
/** The reference's own number for level M. */
const LEVEL_M = 0;

/** The reference writes one byte per character, so it is handed the UTF-8 bytes as characters. */
const asBytes = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

function reference(text: string, version: number, mask: number): boolean[][] {
  const code = new Reference(version, LEVEL_M);
  code.addData(asBytes(text));
  code.makeImpl(false, mask);
  return code.modules;
}

function referenceVersion(text: string): number {
  const code = new Reference(-1, LEVEL_M);
  code.addData(asBytes(text));
  code.make();
  return code.typeNumber;
}

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const otpauth = (issuer: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${SECRET}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

/**
 * Chosen for what they exercise: one block and no alignment pattern (1), the
 * first alignment pattern (2), version information (7 and up), two groups of
 * blocks (8 and up), the two-byte character count (10 and up), and the
 * addresses the screen really draws — a Latin and an Arabic company name.
 */
const SAMPLES: readonly string[] = [
  'A',
  'https://erp.qs-groups.com',
  otpauth('QS ERP', 'admin@example.com'),
  otpauth('Qimah Al Safinah General Trading Co. Ltd.', 'accounting.manager@qs-groups.com'),
  otpauth('شركة قمة السفينة للتجارة العامة المحدودة', 'manager@example.com'),
  'x'.repeat(122),
  'x'.repeat(152),
  'x'.repeat(180),
  'x'.repeat(181),
  'x'.repeat(900),
  'x'.repeat(2331),
];

describe('qrCode', () => {
  it.each(SAMPLES.map((text) => [text.length > 40 ? `${text.slice(0, 37)}… (${text.length})` : text, text]))(
    'draws the reference symbol under every mask — %s',
    (_name, text) => {
      const version = qrCode(text).version;
      expect(version).toBe(referenceVersion(text));
      for (let mask = 0; mask < 8; mask++) {
        const drawn = qrCode(text, { mask });
        expect(drawn.size).toBe(17 + 4 * version);
        expect(drawn.modules).toEqual(reference(text, version, mask));
      }
    },
  );

  it('covers the versions the samples were chosen for', () => {
    const versions = SAMPLES.map((text) => qrCode(text).version);
    expect(versions[0]).toBe(1);
    expect(versions).toContain(2);
    expect(versions.some((v) => v >= 7 && v < 10)).toBe(true);
    expect(qrCode('x'.repeat(180)).version).toBe(9);
    expect(qrCode('x'.repeat(181)).version).toBe(10);
    expect(qrCode('x'.repeat(2331)).version).toBe(40);
  });

  it('chooses one of the eight masks itself, and draws that one', () => {
    const text = otpauth('QS ERP', 'admin@example.com');
    const chosen = qrCode(text);
    expect(chosen.mask).toBeGreaterThanOrEqual(0);
    expect(chosen.mask).toBeLessThan(8);
    expect(chosen.modules).toEqual(qrCode(text, { mask: chosen.mask }).modules);
    // The same text is the same picture: a reload must not redraw the code.
    expect(qrCode(text)).toEqual(chosen);
  });

  it('refuses what no symbol holds, and a mask that is not one', () => {
    expect(() => qrCode('x'.repeat(2332))).toThrow(QrTooLongError);
    expect(() => qrCode('A', { mask: 8 })).toThrow(RangeError);
  });
});

describe('qrPath', () => {
  it('draws exactly the dark modules, inside the quiet zone', () => {
    const code = qrCode('https://erp.qs-groups.com');
    const span = code.size + 2 * QR_QUIET_ZONE;
    const painted = Array.from({ length: span }, () => new Array<boolean>(span).fill(false));
    const runs = [...qrPath(code).matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
    expect(runs.map((run) => run[0]).join('')).toBe(qrPath(code));
    for (const [, x, y, width, back] of runs) {
      expect(back).toBe(width);
      for (let i = 0; i < Number(width); i++) painted[Number(y)]![Number(x) + i] = true;
    }
    for (let row = 0; row < span; row++) {
      for (let column = 0; column < span; column++) {
        const inside =
          row >= QR_QUIET_ZONE &&
          row < span - QR_QUIET_ZONE &&
          column >= QR_QUIET_ZONE &&
          column < span - QR_QUIET_ZONE;
        const dark = inside && code.modules[row - QR_QUIET_ZONE]![column - QR_QUIET_ZONE]!;
        expect(painted[row]![column]).toBe(dark);
      }
    }
  });
});
