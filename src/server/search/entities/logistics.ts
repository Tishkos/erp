/**
 * Imports and shipping: the import application, its B/L, its containers, the
 * PD and the customs declaration.
 *
 * Priority 60–79. The numbers here are typed by people, in whatever case they
 * were given (MSCU1234567, mscu1234567): they are matched twice — as a number
 * (the btree) and folded (the trigram index) — so either spelling finds them.
 */
import { sql } from 'drizzle-orm';
import { profileHref } from '../../domain/profiles';
import type { SearchTableType } from '../types';

/** The supplier of the import a B/L, container or PD belongs to — read through its payable. */
const supplierViaPayable = sql`left join payable py on py.id = t.payable_id left join business_partner p on p.id = py.supplier_id`;

export const payable: SearchTableType = {
  kind: 'table',
  key: 'payable',
  priority: 60,
  grant: { object: 'payable' },
  route: '/payables',
  table: 'payable',
  id: sql`t.id`,
  attachmentType: 'payable',
  // The import application, and the local purchase, service, rent and advance payables beside it.
  series: ['PAYABLE_IMPORT', 'PAYABLE_LOCAL_GOODS', 'PAYABLE_SERVICE', 'PAYABLE_RECURRING', 'PAYABLE_ADVANCE'],
  number: sql`t.payable_no`,
  text: [sql`t.supplier_reference`, sql`t.description`],
  partyKey: sql`t.supplier_id`,
  joins: sql`left join business_partner p on p.id = t.supplier_id`,
  title: sql`coalesce(nullif(t.description, ''), t.supplier_reference)`,
  status: sql`case when t.cancelled_at is not null then 'cancelled'
                   when t.closed_at is not null then 'closed'
                   else t.stage_code end`,
  date: sql`t.document_date`,
  recent: sql`t.document_date`,
  party: sql`p.legal_name`,
  amount: { value: sql`t.amount_txn`, currency: sql`t.currency` },
  href: (row) => profileHref('import', row.number),
};

export const billOfLading: SearchTableType = {
  kind: 'table',
  key: 'bill_of_lading',
  priority: 61,
  grant: { object: 'bill_of_lading' },
  route: '/payables/shipments',
  table: 'bill_of_lading',
  id: sql`t.id`,
  attachmentType: 'bill_of_lading',
  number: sql`t.bl_no`,
  text: [sql`t.bl_no`, sql`t.vessel`],
  joins: supplierViaPayable,
  title: sql`t.vessel`,
  status: sql`case when t.cancelled_at is not null then 'cancelled' end`,
  date: sql`t.bl_date`,
  recent: sql`t.bl_date`,
  party: sql`p.legal_name`,
  href: (row) => profileHref('bl', row.number),
};

export const shipmentContainer: SearchTableType = {
  kind: 'table',
  key: 'shipment_container',
  priority: 62,
  grant: { object: 'shipment_container' },
  route: '/payables/containers',
  table: 'shipment_container',
  id: sql`t.id`,
  attachmentType: 'shipment_container',
  number: sql`t.container_no`,
  text: [sql`t.container_no`, sql`t.seal_no`],
  joins: supplierViaPayable,
  title: sql`t.seal_no`,
  status: sql`case when t.cancelled_at is not null then 'cancelled' else t.status_code end`,
  date: sql`t.eta`,
  recent: sql`t.eta`,
  party: sql`p.legal_name`,
  extras: { containerId: sql`t.id` },
  href: (row) => profileHref('container', row.number, { id: row.extras.containerId ?? null }),
};

export const customsPd: SearchTableType = {
  kind: 'table',
  key: 'customs_pd',
  priority: 63,
  grant: { object: 'customs_pd' },
  route: '/payables/pd',
  table: 'customs_pd',
  id: sql`t.id`,
  attachmentType: 'customs_pd',
  number: sql`t.pd_no`,
  text: [sql`t.pd_no`],
  joins: supplierViaPayable,
  status: sql`t.status_code`,
  date: sql`t.registration_date`,
  recent: sql`t.registration_date`,
  party: sql`p.legal_name`,
  extras: { year: sql`t.registration_year` },
  href: (row) => profileHref('pd', row.number, { year: row.extras.year ? Number(row.extras.year) : null }),
};

export const customsDeclaration: SearchTableType = {
  kind: 'table',
  key: 'customs_declaration',
  priority: 64,
  grant: { object: 'customs_declaration' },
  route: '/logistics/customs-declarations',
  table: 'customs_declaration',
  id: sql`t.id`,
  attachmentType: 'customs_declaration',
  series: ['CUSTOMS_DECLARATION'],
  number: sql`t.declaration_no`,
  text: [sql`t.customs_ref`],
  joins: supplierViaPayable,
  title: sql`t.customs_ref`,
  status: sql`t.status`,
  date: sql`t.declaration_date`,
  recent: sql`t.declaration_date`,
  party: sql`p.legal_name`,
  amount: { value: sql`t.declared_value`, currency: sql`t.currency` },
  href: (row) => `/logistics/customs-declarations/${encodeURIComponent(row.number)}`,
};
