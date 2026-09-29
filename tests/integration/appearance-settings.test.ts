import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_APPEARANCE } from '@/server/domain/appearance';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authorization from '@/server/services/authorization';
import * as userAppearance from '@/server/services/user-appearance';
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
     values ($1, $2, 'Appearance Settings Test', true)`,
    [userId, `${userId}@example.com`],
  );
  ctx = {
    branchCode: 'HQ',
    principal: await withScope(scope(), (tx) => authorization.loadPrincipal(tx, userId)),
  };
});

describe('per-user appearance settings', () => {
  it('defaults old and new users to Current without touching their palette', async () => {
    expect(await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).toEqual({
      settings: DEFAULT_USER_APPEARANCE,
      saved: false,
    });
  });

  it('persists all appearance controls to the signed-in user only', async () => {
    const chosen = {
      appearance: 'enterprise',
      density: 'compact',
      cornerStyle: 'sharp',
      contentWidth: 'wide',
      borderStyle: 'strong',
      shadow: 'subtle',
      componentSize: 'small',
    } as const;
    await withScope(scope(), (tx) => userAppearance.setMySettings(tx, ctx, chosen));
    expect(await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).toEqual({
      settings: chosen,
      saved: true,
    });
    expect((await ownerPool.query(
      'select ui_appearance, ui_density, ui_corner_style, ui_content_width, ui_border_style, ui_shadow, ui_component_size from app_user where id = $1',
      [userId],
    )).rows[0]).toEqual({
      ui_appearance: 'enterprise',
      ui_density: 'compact',
      ui_corner_style: 'sharp',
      ui_content_width: 'wide',
      ui_border_style: 'strong',
      ui_shadow: 'subtle',
      ui_component_size: 'small',
    });
  });

  it('keeps two users on independent appearance settings', async () => {
    const otherId = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name) values ($1, $2, 'Second Appearance User')`,
      [otherId, `${otherId}@example.com`],
    );
    await ownerPool.query(
      `insert into user_branch_scope (user_id, branch_code, is_default) values ($1, 'HQ', true)`,
      [otherId],
    );
    const otherScope = { userId: otherId, branchCode: 'HQ', isSuperUser: false };
    const otherCtx: ActorContext = {
      branchCode: 'HQ',
      principal: await withScope(otherScope, (tx) => authorization.loadPrincipal(tx, otherId)),
    };

    await withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, {
        ...DEFAULT_USER_APPEARANCE,
        appearance: 'studio',
        density: 'airy',
      }),
    );
    expect(await withScope(otherScope, (tx) => userAppearance.settingsFor(tx, otherId))).toEqual({
      settings: DEFAULT_USER_APPEARANCE,
      saved: false,
    });
    await withScope(otherScope, (tx) =>
      userAppearance.setMySettings(tx, otherCtx, DEFAULT_USER_APPEARANCE),
    );
    expect(await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).toEqual({
      settings: {
        ...DEFAULT_USER_APPEARANCE,
        appearance: 'studio',
        density: 'airy',
      },
      saved: true,
    });
  });

  it('refuses unknown settings without changing the saved values', async () => {
    await withScope(scope(), (tx) => userAppearance.setMySettings(tx, ctx, DEFAULT_USER_APPEARANCE));
    await expect(withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, appearance: 'neon' }),
    )).rejects.toThrow(/Unknown appearance/);
    expect(await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).toEqual({
      settings: DEFAULT_USER_APPEARANCE,
      saved: true,
    });
  });
});
