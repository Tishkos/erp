import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authorization from '@/server/services/authorization';
import * as company from '@/server/services/company';
import { PALETTES, assertPalette } from '@/server/domain/appearance';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let ctx: ActorContext;
let userId: string;
const scope = () => ({ userId, branchCode: 'HQ', isSuperUser: true });

beforeEach(async () => {
  await resetTestData();
  await seedBranch('HQ', 'Head Office');
  userId = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user)
     values ($1, $2, 'Appearance Test', true)`,
    [userId, `${userId}@example.com`],
  );
  await ownerPool.query(`insert into company (code, legal_name) values ('QS', 'Test Company')`);
  ctx = {
    branchCode: 'HQ',
    principal: await withScope(scope(), (tx) => authorization.loadPrincipal(tx, userId)),
  };
});

describe('appearance palettes', () => {
  it('always defaults an unconfigured user to Sand and Gold regardless of company appearance', async () => {
    for (const palette of PALETTES) {
      await withScope(scope(), (tx) => company.setAppearance(tx, ctx, { palette, accent: 'purple' }));
      expect(await withScope(scope(), (tx) => company.appearanceFor(tx, userId))).toEqual({
        palette: 'sand', accent: 'gold',
      });
    }
  });

  it('rejects the removed company option without changing personal preferences', async () => {
    await withScope(scope(), (tx) => company.setMyAppearance(tx, ctx, { palette: 'ocean', accent: 'blue' }));
    for (const input of [
      { palette: 'company', accent: 'gold' },
      { palette: 'sand', accent: 'company' },
    ]) {
      await expect(withScope(scope(), (tx) => company.setMyAppearance(tx, ctx, input))).rejects.toThrow();
      expect(await withScope(scope(), (tx) => company.appearanceFor(tx, userId))).toEqual({
        palette: 'ocean', accent: 'blue',
      });
    }
  });

  it.each(PALETTES)('persists %s as an independent user appearance', async (palette) => {
    await withScope(scope(), (tx) => company.setMyAppearance(tx, ctx, { palette, accent: 'blue' }));
    expect(await withScope(scope(), (tx) => company.appearanceFor(tx, userId))).toEqual({ palette, accent: 'blue' });
    expect((await ownerPool.query('select ui_palette from app_user where id = $1', [userId])).rows[0].ui_palette).toBe(palette);

    await withScope(scope(), (tx) => company.setAppearance(tx, ctx, { palette, accent: 'gold' }));
    expect(await withScope(scope(), (tx) => company.appearanceFor(tx, userId))).toEqual({ palette, accent: 'blue' });
    expect((await ownerPool.query('select ui_palette from app_user where id = $1', [userId])).rows[0].ui_palette).toBe(palette);
  });

  it('keeps two users on their own choices', async () => {
    const otherId = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name) values ($1, $2, 'Second User')`,
      [otherId, `${otherId}@example.com`],
    );
    const other = {
      branchCode: 'HQ',
      principal: await withScope({ userId: otherId, branchCode: 'HQ', isSuperUser: true }, (tx) =>
        authorization.loadPrincipal(tx, otherId),
      ),
    } satisfies ActorContext;

    await withScope(scope(), (tx) => company.setMyAppearance(tx, ctx, { palette: 'midnight', accent: 'purple' }));
    await withScope({ userId: otherId, branchCode: 'HQ', isSuperUser: true }, (tx) =>
      company.setMyAppearance(tx, other, { palette: 'sand', accent: 'gold' }),
    );

    expect(await withScope(scope(), (tx) => company.appearanceFor(tx, userId))).toEqual({
      palette: 'midnight',
      accent: 'purple',
    });
    expect(
      await withScope({ userId: otherId, branchCode: 'HQ', isSuperUser: true }, (tx) =>
        company.appearanceFor(tx, otherId),
      ),
    ).toEqual({ palette: 'sand', accent: 'gold' });
  });

  it('continues to accept all existing palettes and rejects unknown names', async () => {
    for (const palette of PALETTES) {
      expect(() => assertPalette(palette)).not.toThrow();
      await ownerPool.query('update company set ui_palette = $1', [palette]);
      await ownerPool.query('update app_user set ui_palette = $1 where id = $2', [palette, userId]);
    }
    expect(() => assertPalette('missing-palette')).toThrow();
    await expect(ownerPool.query("update company set ui_palette = 'missing-palette'")).rejects.toThrow(/company_ui_palette_known/);
    await expect(ownerPool.query("update app_user set ui_palette = 'missing-palette' where id = $1", [userId])).rejects.toThrow(/app_user_ui_palette_known/);
  });
});
