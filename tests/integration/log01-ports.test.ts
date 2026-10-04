/**
 * REQ-LOG-001 item 15 — ports and routes.
 *
 *   writer   `services/ports.ts` adds (code minted from PORT_CODE), renames,
 *            retires with a reason and brings back; never deletes; one name,
 *            one LOCODE; every change audited by code.
 *   routes   What the B/Ls say — loading → discharge, how often, what is on
 *            the way — read, never kept.
 *   profile  The port's page reads its B/Ls and inbound containers; the
 *            retired port is still named by its old B/Ls and refused by new ones.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { containerNo } from '../support/container-number';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ports from '@/server/services/ports';
import * as recordNotes from '@/server/services/record-notes';
import { profileHref } from '@/server/domain/profiles';
import { blWith, buildImportWorld, importOf, receive, scope, type ImportWorld } from './logistics-fixture';

let world: ImportWorld;

beforeEach(async () => {
  world = await buildImportWorld();
});

describe('writer · add, rename, retire, bring back', () => {
  it('mints the code, keeps names and LOCODEs unique, and writes every change', async () => {
    const made = await withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: 'Jebel Ali', locode: 'aejea' }));
    expect(made.code).toBe('PRT-0003');
    const { rows: [row] } = await ownerPool.query(`select name, locode, country, active from port where code = $1`, [made.code]);
    expect(row).toEqual({ name: 'Jebel Ali', locode: 'AEJEA', country: 'AE', active: true });

    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: 'jebel ali' })))).toMatch(/already Jebel Ali/);
    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: 'Dubai', locode: 'AEJEA' })))).toMatch(/already Jebel Ali/);
    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: 'Nowhere', locode: 'XX' })))).toMatch(/not a UN\/LOCODE/);
    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: 'Nowhere', locode: 'AEJEB', country: 'IQ' })))).toMatch(/is in AE, not IQ/);
    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.add(tx, world.clerk, { name: '   ' })))).toMatch(/Give the port its name/);

    await withScope(scope(world.manager), (tx) => ports.rename(tx, world.manager, made.code, { name: 'Jebel Ali (DP World)', locode: 'AEJEA', country: 'AE' }));
    expect(await rejection(withScope(scope(world.manager), (tx) => ports.deactivate(tx, world.manager, made.code, '')))).toMatch(/Say why/);
    await withScope(scope(world.manager), (tx) => ports.deactivate(tx, world.manager, made.code, 'Line no longer calls there'));
    expect(await rejection(withScope(scope(world.manager), (tx) => ports.deactivate(tx, world.manager, made.code, 'Again')))).toMatch(/already retired/);
    const retired = await withScope(scope(world.clerk), (tx) => ports.list(tx, { view: 'retired' }));
    expect(retired.map((port) => port.code)).toEqual([made.code]);
    await withScope(scope(world.manager), (tx) => ports.reactivate(tx, world.manager, made.code, 'Calls resumed'));
    expect((await withScope(scope(world.clerk), (tx) => ports.list(tx, { view: 'active' }))).map((port) => port.code)).toContain(made.code);

    const { rows: trail } = await ownerPool.query(
      `select action, reason from audit_event where object_type = 'port' and object_id = $1 and outcome = 'success' order by occurred_at, id`,
      [made.code],
    );
    expect(trail).toEqual([
      { action: 'port.created', reason: null },
      { action: 'port.updated', reason: null },
      { action: 'port.deactivated', reason: 'Line no longer calls there' },
      { action: 'port.reactivated', reason: 'Calls resumed' },
    ]);
    // A note on the port goes through the shared door, by its code.
    await withScope(scope(world.manager), (tx) => recordNotes.addNote(tx, world.manager, { object: 'port', recordId: made.code, body: 'Agent: Gulf Shipping.' }));
    expect((await withScope(scope(world.clerk), (tx) => recordNotes.listNotes(tx, { object: 'port', recordId: made.code }))).map((n) => n.body)).toEqual(['Agent: Gulf Shipping.']);
    expect(profileHref('port', made.code)).toBe(`/logistics/ports/${made.code}`);
  });

  it('has no delete: a port a B/L names cannot go, and the service offers nothing of the kind', async () => {
    const made = await importOf(world, '10');
    await blWith(world, made.payableId, [{ no: containerNo('MSCU', 620001), qty: '10' }], { portCode: 'PRT-0001' });
    expect(await rejection(ownerPool.query(`delete from port where code = 'PRT-0001'`))).toMatch(/foreign key|violates/i);
    expect(Object.keys(ports).filter((key) => /delete|remove/i.test(key))).toEqual([]);
  });
});

describe('routes and the profile · what the B/Ls say', () => {
  it('counts each loading → discharge route, and lists a port’s B/Ls and inbound containers', async () => {
    const first = await importOf(world, '100', { reference: 'R-1' });
    const second = await importOf(world, '50', { reference: 'R-2' });
    const bl1 = await blWith(world, first.payableId, [{ no: containerNo('MSCU', 610001), qty: '100' }], { portCode: 'PRT-0001' });
    const bl2 = await blWith(world, second.payableId, [{ no: containerNo('MSCU', 610002), qty: '50' }], { portCode: 'PRT-0002', eta: '2026-09-15' });
    await receive(world, bl1.containerIds[0]!);

    const routes = await withScope(scope(world.clerk), (tx) => ports.routesInUse(tx));
    expect(routes.map((r) => [r.portOfLoading, r.dischargeCode, r.bls, r.openContainers, r.shippingLines])).toEqual([
      ['Shanghai', 'PRT-0001', 1, 0, 'MSC'],
      ['Shanghai', 'PRT-0002', 1, 1, 'MSC'],
    ]);
    const aqaba = await withScope(scope(world.clerk), (tx) => ports.viewByCode(tx, 'prt-0002'));
    expect(aqaba.port).toMatchObject({ code: 'PRT-0002', name: 'Aqaba', blCount: 1, openContainers: 1, lastBlDate: '2026-07-20' });
    expect(aqaba.bls.map((bl) => [bl.blNo, bl.payableNo, bl.containers, bl.open])).toEqual([[bl2.blNo, expect.any(String), 1, 1]]);
    const inbound = await withScope(scope(world.clerk), (tx) => ports.inboundContainers(tx, 'PRT-0002'));
    expect(inbound.map((c) => [c.containerNo, c.statusCode, c.eta])).toEqual([[containerNo('MSCU', 610002), 'not_loaded', '2026-09-15']]);
    const list = await withScope(scope(world.clerk), (tx) => ports.list(tx));
    expect(list.map((p) => [p.code, p.blCount, p.openContainers])).toEqual([
      ['PRT-0002', 1, 1],
      ['PRT-0001', 1, 0],
    ]);
    expect(await rejection(withScope(scope(world.clerk), (tx) => ports.viewByCode(tx, 'PRT-9999')))).toMatch(/No port/);

    // Retired: the old B/L keeps naming it; a new B/L may not choose it.
    await withScope(scope(world.manager), (tx) => ports.deactivate(tx, world.manager, 'PRT-0002', 'Closed to our line'));
    expect((await withScope(scope(world.clerk), (tx) => ports.viewByCode(tx, 'PRT-0002'))).bls).toHaveLength(1);
    const shipments = await import('@/server/services/shipments');
    expect((await withScope(scope(world.clerk), (tx) => shipments.ports(tx))).map((p) => p.code)).toEqual(['PRT-0001']);
  });
});
