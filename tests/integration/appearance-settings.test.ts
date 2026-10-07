import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_COMPANY_DEFAULTS, DEFAULT_USER_APPEARANCE, LAYOUT_SETTING_NAMES } from '@/server/domain/appearance';
import * as company from '@/server/services/company';
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
      followsCompany: false,
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
      navigation: 'side',
      sidebar: 'icons',
      sidebarGroups: 'plain',
      sidebarColour: 'highlight',
      textSize: 'larger',
      header: 'static',
      motion: 'reduced',
      tableStripes: 'off',
    } as const;
    await withScope(scope(), (tx) => userAppearance.setMySettings(tx, ctx, chosen));
    expect(await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).toEqual({
      settings: chosen,
      saved: true,
      followsCompany: false,
    });
    expect((await ownerPool.query(
      `select ui_appearance, ui_density, ui_corner_style, ui_content_width, ui_border_style, ui_shadow, ui_component_size,
              ui_navigation, ui_sidebar, ui_sidebar_groups, ui_sidebar_colour, ui_text_size, ui_header, ui_motion, ui_table_stripes
         from app_user where id = $1`,
      [userId],
    )).rows[0]).toEqual({
      ui_appearance: 'enterprise',
      ui_density: 'compact',
      ui_corner_style: 'sharp',
      ui_content_width: 'wide',
      ui_border_style: 'strong',
      ui_shadow: 'subtle',
      ui_component_size: 'small',
      ui_navigation: 'side',
      ui_sidebar: 'icons',
      ui_sidebar_groups: 'plain',
      ui_sidebar_colour: 'highlight',
      ui_text_size: 'larger',
      ui_header: 'static',
      ui_motion: 'reduced',
      ui_table_stripes: 'off',
    });
  });

  it('does not mark an account unsaved because its navigation columns are still empty (0407)', async () => {
    // An account from before 0407: the seven layout columns written, the navigation ones NULL.
    await ownerPool.query(
      `update app_user set ui_appearance = 'modern', ui_density = 'compact', ui_corner_style = 'rounded',
         ui_content_width = 'wide', ui_border_style = 'subtle', ui_shadow = 'soft', ui_component_size = 'medium'
       where id = $1`,
      [userId],
    );
    const read = await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId));
    expect(read.saved).toBe(true);
    expect(read.settings).toMatchObject({ appearance: 'modern', navigation: 'top', sidebar: 'full', sidebarGroups: 'grouped', sidebarColour: 'default', textSize: 'default' });
  });

  it('keeps the stored navigation when a page from before 0407 saves only the layout', async () => {
    await withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, navigation: 'bottom', sidebar: 'icons', sidebarGroups: 'plain', sidebarColour: 'accent' }),
    );
    const layout = Object.fromEntries(LAYOUT_SETTING_NAMES.map((name) => [name, DEFAULT_USER_APPEARANCE[name]]));
    await withScope(scope(), (tx) => userAppearance.setMySettings(tx, ctx, { ...layout, density: 'airy' }));
    expect((await withScope(scope(), (tx) => userAppearance.settingsFor(tx, userId))).settings).toMatchObject({
      density: 'airy',
      navigation: 'bottom',
      sidebar: 'icons',
      sidebarGroups: 'plain',
      sidebarColour: 'accent',
    });
    const audit = await ownerPool.query(
      `select before_value, after_value from audit_event
        where action = 'user.appearance_settings_changed' and object_id = $1 order by occurred_at`,
      [userId],
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0].before_value).toMatchObject({ navigation: 'top' });
    expect(audit.rows[0].before_value).toMatchObject({ sidebarGroups: 'grouped', sidebarColour: 'default' });
    expect(audit.rows[0].after_value).toMatchObject({ navigation: 'bottom', sidebar: 'icons', sidebarGroups: 'plain', sidebarColour: 'accent' });
    expect(audit.rows[1].after_value).toMatchObject({ density: 'airy', navigation: 'bottom' });
  });

  it('refuses a navigation the database does not know', async () => {
    await expect(withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, navigation: 'left' }),
    )).rejects.toThrow(/Unknown navigation/);
    await expect(ownerPool.query(`update app_user set ui_navigation = 'left' where id = $1`, [userId]))
      .rejects.toThrow(/app_user_ui_navigation_known/);
    await expect(withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, sidebarGroups: 'nested' }),
    )).rejects.toThrow(/Unknown sidebarGroups/);
    await expect(ownerPool.query(`update app_user set ui_sidebar_groups = 'nested' where id = $1`, [userId]))
      .rejects.toThrow(/app_user_ui_sidebar_groups_known/);
    await expect(withScope(scope(), (tx) =>
      userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, sidebarColour: 'purple' }),
    )).rejects.toThrow(/Unknown sidebarColour/);
    await expect(ownerPool.query(`update app_user set ui_sidebar_colour = 'purple' where id = $1`, [userId]))
      .rejects.toThrow(/app_user_ui_sidebar_colour_known/);
  });

  it('recognises the camera\'s own session, and only that', async () => {
    const camera = randomUUID();
    const person = randomUUID();
    await ownerPool.query(
      `insert into auth_session (id, user_id, token, expires_at, user_agent) values
         ($1, $3, $4, now() + interval '3 minutes', $5), ($2, $3, $6, now() + interval '1 hour', 'Mozilla/5.0')`,
      [camera, person, userId, `t-${camera}`, userAppearance.CAMERA_SESSION_AGENT, `t-${person}`],
    );
    expect(await withScope(scope(), (tx) => userAppearance.isCameraSession(tx, camera))).toBe(true);
    expect(await withScope(scope(), (tx) => userAppearance.isCameraSession(tx, person))).toBe(false);
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
      followsCompany: false,
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
      followsCompany: false,
    });
  });

  describe("everyone's default (0419)", () => {
    const companyDefault = {
      ...BUILT_IN_COMPANY_DEFAULTS,
      palette: 'pearl',
      accent: 'blue',
      appearance: 'enterprise',
      density: 'airy',
      navigation: 'side',
      sidebarColour: 'highlight',
      textSize: 'smaller',
    } as const;
    const settingsOf = (value: typeof companyDefault) =>
      Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'palette' && name !== 'accent'));

    beforeEach(async () => {
      await ownerPool.query(`insert into company (code, legal_name) values ('QS', 'Test Company')`);
    });

    it('reaches a person who has not chosen — never one who has — and the reset puts the built-in back', async () => {
      // Three people: nothing stored; only the built-in values stored (what the first page used to write); a choice of their own.
      const [fresh, builtIn, chooser] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [fresh, builtIn, chooser]) {
        await ownerPool.query(`insert into app_user (id, email, display_name) values ($1, $2, 'Default test')`, [id, `${id}@example.com`]);
      }
      await ownerPool.query(
        `update app_user set ui_appearance = 'current', ui_density = 'comfortable', ui_corner_style = 'soft',
           ui_content_width = 'fluid', ui_border_style = 'standard', ui_shadow = 'soft', ui_component_size = 'medium',
           ui_navigation = 'top' where id = $1`,
        [builtIn],
      );
      await ownerPool.query(
        `update app_user set ui_appearance = 'studio', ui_density = 'compact', ui_corner_style = 'soft',
           ui_content_width = 'fluid', ui_border_style = 'standard', ui_shadow = 'soft', ui_component_size = 'medium',
           ui_palette = 'ocean', ui_accent = 'green' where id = $1`,
        [chooser],
      );
      const read = (id: string) => withScope(scope(), (tx) => userAppearance.settingsFor(tx, id));
      const colours = (id: string) => withScope(scope(), (tx) => company.appearanceFor(tx, id));

      await withScope(scope(), (tx) => userAppearance.setCompanyDefaults(tx, ctx, companyDefault));
      expect(await read(fresh)).toEqual({ settings: settingsOf(companyDefault), saved: false, followsCompany: true });
      expect(await read(builtIn)).toEqual({ settings: settingsOf(companyDefault), saved: true, followsCompany: true });
      expect(await colours(fresh)).toEqual({ palette: 'pearl', accent: 'blue' });
      // The chooser keeps every setting they chose; a column they never set takes the company's.
      const chosen = await read(chooser);
      expect(chosen.followsCompany).toBe(false);
      expect(chosen.settings).toMatchObject({ appearance: 'studio', density: 'compact', navigation: 'side', sidebarColour: 'highlight' });
      expect(await colours(chooser)).toEqual({ palette: 'ocean', accent: 'green' });

      // A follower who changes one thing has chosen: the rest is what they saw.
      await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1, 'HQ', true)`, [fresh]);
      const followerScope = { userId: fresh, branchCode: 'HQ', isSuperUser: false };
      const followerCtx: ActorContext = { branchCode: 'HQ', principal: await withScope(followerScope, (tx) => authorization.loadPrincipal(tx, fresh)) };
      await withScope(followerScope, (tx) => userAppearance.setMySettings(tx, followerCtx, { ...settingsOf(companyDefault), motion: 'reduced' }));
      expect((await read(fresh)).settings).toEqual({ ...settingsOf(companyDefault), motion: 'reduced' });

      await withScope(scope(), (tx) => userAppearance.resetCompanyDefaults(tx, ctx));
      expect(await read(builtIn)).toEqual({ settings: DEFAULT_USER_APPEARANCE, saved: true, followsCompany: false });
      expect(await colours(builtIn)).toEqual({ palette: 'sand', accent: 'gold' });
      expect((await read(fresh)).settings).toMatchObject({ navigation: 'side', motion: 'reduced' });

      const audit = await ownerPool.query(
        `select action, before_value, after_value from audit_event
          where action like 'company.appearance_defaults_%' order by occurred_at`,
      );
      expect(audit.rows.map((row) => row.action)).toEqual(['company.appearance_defaults_set', 'company.appearance_defaults_reset']);
      expect(audit.rows[0].before_value).toEqual({ defaults: null });
      expect(audit.rows[0].after_value).toEqual({ defaults: companyDefault });
      expect(audit.rows[1].before_value).toEqual({ defaults: companyDefault });
      expect(audit.rows[1].after_value).toEqual({ defaults: null });
    });

    it("makes the caller's own appearance everyone's default", async () => {
      await ownerPool.query(`update app_user set ui_palette = 'midnight', ui_accent = 'red' where id = $1`, [userId]);
      await withScope(scope(), (tx) => userAppearance.setMySettings(tx, ctx, { ...DEFAULT_USER_APPEARANCE, navigation: 'bottom', tableStripes: 'off' }));
      const made = await withScope(scope(), (tx) => userAppearance.makeMineCompanyDefault(tx, ctx));
      expect(made).toEqual({ ...DEFAULT_USER_APPEARANCE, navigation: 'bottom', tableStripes: 'off', palette: 'midnight', accent: 'red' });
      expect((await ownerPool.query('select ui_defaults from company')).rows[0].ui_defaults).toEqual(made);
    });

    it('asks configure on the company, and the database refuses an unknown key or value', async () => {
      const clerk = randomUUID();
      await ownerPool.query(`insert into app_user (id, email, display_name) values ($1, $2, 'No configure')`, [clerk, `${clerk}@example.com`]);
      await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1, 'HQ', true)`, [clerk]);
      const clerkScope = { userId: clerk, branchCode: 'HQ', isSuperUser: false };
      const clerkCtx: ActorContext = { branchCode: 'HQ', principal: await withScope(clerkScope, (tx) => authorization.loadPrincipal(tx, clerk)) };
      expect(userAppearance.mayConfigureCompanyDefaults(clerkCtx.principal)).toBe(false);
      expect(userAppearance.mayConfigureCompanyDefaults(ctx.principal)).toBe(true);
      await expect(withScope(clerkScope, (tx) => userAppearance.makeMineCompanyDefault(tx, clerkCtx))).rejects.toThrow();
      await expect(withScope(clerkScope, (tx) => userAppearance.resetCompanyDefaults(tx, clerkCtx))).rejects.toThrow();
      expect((await ownerPool.query('select ui_defaults from company')).rows[0].ui_defaults).toBeNull();

      await expect(withScope(scope(), (tx) => userAppearance.setCompanyDefaults(tx, ctx, { ...companyDefault, navigation: 'left' })))
        .rejects.toThrow(/Unknown navigation/);
      await expect(ownerPool.query(`update company set ui_defaults = '{"navigation": "left"}'`)).rejects.toThrow(/company_ui_defaults_known/);
      await expect(ownerPool.query(`update company set ui_defaults = '{"colour": "red"}'`)).rejects.toThrow(/company_ui_defaults_known/);
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
      followsCompany: false,
    });
  });
});
