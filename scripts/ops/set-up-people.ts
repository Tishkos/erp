/**
 * The company's people, and what each of them may do — by direction,
 * 2026-10-03.
 *
 *   npx tsx scripts/ops/set-up-people.ts            # say what it would do
 *   npx tsx scripts/ops/set-up-people.ts --apply    # do it, and print passwords
 *
 * The owner set the shape: Baban holds everything and approves everything;
 * everybody else works within a section and brings the things that commit the
 * company — a sale, a payment, a purchase invoice — to him.
 *
 * ── How "everything" is expressed ──────────────────────────────────────────
 * Baban is a **super user**, which is one column rather than a role with two
 * thousand grants in it: `can()` answers yes to every verb on every object for
 * a super user (`domain/permissions.ts`). It is also the only form of
 * "everything" that stays true as the ERP grows — a role listing today's 195
 * objects would be short of the 196th the day it arrived.
 *
 * What a flag cannot change is a maker-checker rule, because those compare the
 * raiser to the approver rather than asking what anybody may do: a payment
 * application still cannot be approved by whoever prepared it, an invoice
 * still cannot be posted by whoever raised it. So Baban approves everything
 * *somebody else* raised. Opening Stock is the exception and deliberately so —
 * the owner removed its second-pair-of-eyes rule on 2026-09-27 because the
 * company runs it with one person.
 *
 * ── Why sections and not objects ───────────────────────────────────────────
 * The owner describes access by section — "supply chain, asycuda and inventory
 * only" — and the menu already groups every permission object into exactly
 * those sections (`domain/menu.ts`, `MENU`). So the roles below are written in
 * sections and the objects are read from the menu.
 *
 * The first version of this file hand-listed the objects instead. Twenty-nine
 * of the hundred-and-seven names were wrong — `logistics_route` for `route`,
 * `crm` for seven crm objects, `stock_count` for nothing at all — and
 * `setGrants` refused them one failed run at a time. Reading the menu is both
 * exact and self-maintaining: a screen added to Supply Chain tomorrow is
 * Shene's tomorrow, without anybody remembering to come back here.
 *
 * ── Why a script and not the Users screen ──────────────────────────────────
 * Seven people, five roles and some thousands of grants, entered the same way
 * twice — once on a copy of production to be read and checked, once on
 * production — and re-runnable when somebody's section changes. Every verb it
 * uses is the service the screen uses, so nothing here is a shortcut past a
 * rule: `roles.create`, `roles.setGrants`, `users.create`, each audited.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db, withScope } from '../../src/server/db/client';
import { MENU } from '../../src/server/domain/menu';
import { loadPrincipal } from '../../src/server/services/authorization';
import * as roles from '../../src/server/services/roles';
import * as users from '../../src/server/services/users';
import type { PermissionVerb } from '../../src/server/domain/permissions';

const apply = process.argv.includes('--apply');

/**
 * Everything a person may do with the things in their section — except approve.
 *
 * `approve` is absent from every role here, by direction (2026-10-03): "he
 * cannot approve anything without baban ali this very important". Baban
 * approves, and his power is the super-user flag rather than a grant, so
 * taking the verb out of the roles takes it out of the company.
 *
 * `post` and `execute` stay, because posting a journal somebody already
 * approved is the accountant's work rather than a second approval. Where the
 * owner asked for the committing act itself to wait — a sale, money out, a
 * purchase invoice — the section is `RAISE_ONLY`, which has neither.
 */
const FULL: PermissionVerb[] = [
  'view',
  'create',
  'edit_draft',
  'submit',
  'post',
  'execute',
  'configure',
  'export',
  'print',
  'import',
  'reverse_cancel',
];

/** Work on it, hand it on — but do not be the one who commits it. */
const RAISE_ONLY: PermissionVerb[] = ['view', 'create', 'edit_draft', 'submit', 'export', 'print'];

/** Read it, and nothing else. */
const READ: PermissionVerb[] = ['view', 'export', 'print'];

/** The objects in a menu section, straight from the menu. */
function objectsOf(...sections: string[]): string[] {
  const wanted = new Set(sections);
  const objects = new Set<string>();
  for (const section of MENU) {
    if (!wanted.has(section.key)) continue;
    for (const item of section.items) objects.add(item.object);
  }
  const missing = sections.filter((key) => !MENU.some((section) => section.key === key));
  if (missing.length > 0) throw new Error(`no such menu section: ${missing.join(', ')}`);
  return [...objects];
}

/** Every section there is — for the people whose access is "all of it". */
const EVERY_SECTION = MENU.map((section) => section.key);

/**
 * The sections that hold what commits the company.
 *
 * These are the owner's three exceptions, named as sections rather than as
 * objects: a sale, money going out, and a purchase invoice. A director may
 * raise all of them and approve none.
 */
const SALES = ['sales', 'finance_ar', 'crm'];
const MONEY_OUT = ['treasury', 'money_transfer'];
const BUYING = ['payables'];

/*
 * The objects inside Payables that are money leaving, rather than buying.
 *
 * Payables is one menu section holding two different things: the purchase side
 * (orders, receipts, invoices) and the paying side (applications, payments,
 * advances). Granting the section in full to the supply chain therefore handed
 * Shene `post` on a supplier payment — she could have sent money with nobody
 * approving it, which is the opposite of what was asked (caught by reading the
 * grants back, 2026-10-03). Named here so no section grant can include them by
 * accident again.
 */
const PAYING = ['payment_application', 'supplier_payment', 'supplier_advance', 'ap_allocation'];

type Grant = { readonly object: string; readonly verb: PermissionVerb };

function grants(objects: readonly string[], verbs: readonly PermissionVerb[]): Grant[] {
  return objects.flatMap((object) => verbs.map((verb) => ({ object, verb })));
}

/**
 * The same object twice takes the *narrower* verb set.
 *
 * `business_partner` is in Sales and in Supply Chain; `ap_invoice` is in
 * Payables and in Payables/Suppliers. Where a person's sections overlap like
 * that, the restriction has to win, or "no sales invoice without my approval"
 * would be undone by the same object appearing in a section they hold in full.
 */
function restrict(wide: Grant[], narrow: Grant[]): Grant[] {
  const narrowed = new Set(narrow.map((g) => g.object));
  const narrowVerbs = new Set(narrow.map((g) => `${g.object}|${g.verb}`));
  const out = new Map<string, Grant>();
  for (const g of wide) {
    if (narrowed.has(g.object) && !narrowVerbs.has(`${g.object}|${g.verb}`)) continue;
    out.set(`${g.object}|${g.verb}`, g);
  }
  for (const g of narrow) out.set(`${g.object}|${g.verb}`, g);
  return [...out.values()];
}

const NEW_ROLES = [
  {
    code: 'director',
    name: 'Director',
    description:
      'Every section, and no approvals. A sale, money going out and a purchase invoice are raised for the CEO. Zahra.',
    grants: restrict(
      grants(objectsOf(...EVERY_SECTION), FULL),
      grants([...objectsOf(...SALES, ...MONEY_OUT, ...BUYING), ...PAYING], RAISE_ONLY),
    ),
  },
  {
    code: 'supply_chain_officer',
    name: 'Supply chain officer',
    description:
      'Supply chain, ASYCUDA, shipping and inventory, with no approvals. A purchase invoice is raised for the CEO. Nothing else. Shene and Diana.',
    grants: restrict(
      grants(
        objectsOf(
          'payables',
          'payables_suppliers',
          'payables_setup',
          'logistics_customs',
          'logistics_shipping',
          'logistics',
          'inventory',
        ),
        FULL,
      ),
      // The purchase invoice commits the company to pay; the payment objects
      // are the paying itself. Both are raised here and approved by the CEO.
      grants(['ap_invoice', ...PAYING], RAISE_ONLY),
    ),
  },
  {
    code: 'inventory_clerk',
    name: 'Inventory clerk',
    description: 'Inventory, with no approvals. Nothing else. Lara.',
    grants: grants(objectsOf('inventory'), FULL),
  },
  {
    code: 'sales_inventory_clerk',
    name: 'Sales and inventory clerk',
    description: 'Inventory, with no approvals. A sales invoice is raised for the CEO. Zhyar and Rawezh.',
    grants: restrict(
      grants(objectsOf('inventory'), FULL),
      grants(objectsOf(...SALES), RAISE_ONLY),
    ),
  },
  {
    code: 'accountant',
    name: 'Accountant',
    description:
      'Every section, and no approvals — a sale, money going out and a purchase invoice are raised for the CEO. Ali.',
    grants: restrict(
      grants(objectsOf(...EVERY_SECTION), FULL),
      grants([...objectsOf(...SALES, ...MONEY_OUT, ...BUYING), ...PAYING], RAISE_ONLY),
    ),
  },
  {
    code: 'sales_logistics_coordinator',
    name: 'Sales and logistics coordinator',
    description:
      'Sales, the import application and logistics — and nothing else. A sale and a purchase invoice are raised for the CEO. Manar.',
    grants: restrict(
      grants(
        objectsOf('sales', 'payables', 'payables_suppliers', 'logistics', 'logistics_customs', 'logistics_shipping'),
        FULL,
      ),
      /*
       * Narrowed only within her own sections.
       *
       * `restrict` adds its narrow grants as well as trimming the wide ones,
       * so handing it `objectsOf(...SALES)` here — which reaches into
       * finance_ar and crm — would quietly give her two sections she was not
       * given. Only objects she already holds are named.
       */
      grants([...objectsOf('sales'), 'ap_invoice', ...PAYING], RAISE_ONLY),
    ),
  },
  {
    code: 'developer',
    name: 'Developer',
    description:
      'The settings and the plumbing — health, parameters, interfaces, releases. No business data at all. Tishko.',
    grants: grants(
      [
        // The technical half of Administration.
        'system_health',
        'system_parameter',
        'number_series',
        'job',
        'whatsapp',
        // Integrations, in full: this is the developer's own section.
        ...objectsOf('integrations'),
      ],
      FULL,
    ),
  },
  {
    code: 'import_officer',
    name: 'Import officer',
    description:
      'The import application and its papers, in full; inventory to look at. Nothing else. For Maki, when their address is known.',
    grants: restrict(
      grants(objectsOf('payables', 'logistics_customs', 'logistics_shipping'), FULL),
      grants([...objectsOf('inventory'), ...PAYING], READ),
    ),
  },
] as const;

/**
 * The people.
 *
 * Baban is the super user; the flag is set rather than a role given, for the
 * reason in this file's header. Everybody else holds exactly one role, because
 * one person's access being one role is what makes it readable a year from now.
 */
const PEOPLE = [
  { email: 'qs@qs-groups.com', name: 'Baban Ali', roles: ['ceo'], superUser: true },
  { email: 'ali@qs-groups.com', name: 'Ali', roles: ['accountant'], superUser: false },
  { email: 'coo@qs-groups.com', name: 'Zahra', roles: ['director'], superUser: false },
  { email: 'shene@qs-groups.com', name: 'Shene', roles: ['supply_chain_officer'], superUser: false },
  { email: 'diana@qs-groups.com', name: 'Diana', roles: ['supply_chain_officer'], superUser: false },
  { email: 'lara@qs-groups.com', name: 'Lara', roles: ['inventory_clerk'], superUser: false },
  { email: 'zhyar@qs-groups.com', name: 'Zhyar', roles: ['sales_inventory_clerk'], superUser: false },
  { email: 'rawezh@qs-groups.com', name: 'Rawezh Jalil', roles: ['sales_inventory_clerk'], superUser: false },
  { email: 'info@qs-groups.com', name: 'Manar', roles: ['sales_logistics_coordinator'], superUser: false },
  /*
   * The developer. Settings and plumbing, and no business data — by direction,
   * 2026-10-03: "he is developer but cannot see anything".
   *
   * Deliberately not `app_user`, `role` or `permission`: whoever administers
   * those can grant themselves every section, so holding them would undo the
   * sentence that asked for this. Nor `audit_event`, which names documents and
   * their amounts, nor `legacy_import`, which is the books themselves.
   */
  { email: 'sabirtiishko@gmail.com', name: 'Tishko', roles: ['developer'], superUser: false },
] as const;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log(apply ? 'APPLY — this writes' : 'DRY RUN — nothing is written');
  console.log('');

  const found = await db.execute(sql`
    select u.id, u.email
      from app_user u
     where u.is_active and (u.is_super_user or exists (
             select 1 from user_role r where r.user_id = u.id and r.role_code = 'system_administrator'))
     order by u.is_super_user desc, u.email
     limit 1
  `);
  const actor = found.rows[0] as { id: string; email: string } | undefined;
  if (!actor) throw new Error('no active administrator to act as');
  console.log(`acting as ${actor.email}`);

  const branchRow = await db.execute(sql`select code from branch order by code limit 1`);
  const branchCode = (branchRow.rows[0] as { code: string } | undefined)?.code ?? 'HQ';

  const issued: { email: string; name: string; password: string }[] = [];

  await withScope({ userId: actor.id, branchCode, isSuperUser: true }, async (tx) => {
    await applyScope(tx, { userId: actor.id, branchCode, isSuperUser: true });
    const principal = await loadPrincipal(tx, actor.id);
    const ctx = { principal, branchCode };

    for (const role of NEW_ROLES) {
      const objects = new Set(role.grants.map((g) => g.object));
      const existing = await tx.execute(sql`select code from role where code = ${role.code}`);
      console.log(
        `role ${role.code.padEnd(22)} ${existing.rows.length === 0 ? 'create' : 'exists'} — ` +
          `${objects.size} objects, ${role.grants.length} grants`,
      );
      if (!apply) continue;
      if (existing.rows.length === 0) {
        await roles.create(tx, ctx, { code: role.code, name: role.name, description: role.description });
      }
      await roles.setGrants(tx, ctx, role.code, role.grants);
    }

    console.log('');
    for (const person of PEOPLE) {
      const existing = await tx.execute(
        sql`select id, is_super_user from app_user where lower(email) = ${person.email}`,
      );
      const row = existing.rows[0] as { id: string; is_super_user: boolean } | undefined;

      if (!row) {
        console.log(`user ${person.email.padEnd(26)} create — ${person.roles.join('+')}`);
        if (apply) {
          const made = await users.create(tx, ctx, {
            email: person.email,
            displayName: person.name,
            roleCodes: [...person.roles],
            branchCodes: [branchCode],
            defaultBranchCode: branchCode,
          });
          issued.push({ email: person.email, name: person.name, password: made.temporaryPassword });
          if (person.superUser) {
            await tx.execute(sql`update app_user set is_super_user = true where id = ${made.id}`);
          }
        }
        continue;
      }

      console.log(
        `user ${person.email.padEnd(26)} exists — roles set to ${person.roles.join('+')}` +
          (person.superUser ? ', super user' : ''),
      );
      if (!apply) continue;

      // Their roles become exactly the ones named here, so a re-run after
      // somebody's section changes leaves no older role behind.
      const held = await tx.execute(sql`select role_code from user_role where user_id = ${row.id}`);
      for (const r of held.rows as { role_code: string }[]) {
        if (!(person.roles as readonly string[]).includes(r.role_code)) {
          await users.setRole(tx, ctx, row.id, r.role_code, false, { quiet: true });
        }
      }
      for (const code of person.roles) await users.setRole(tx, ctx, row.id, code, true, { quiet: true });
      if (person.superUser !== row.is_super_user) {
        await tx.execute(sql`update app_user set is_super_user = ${person.superUser} where id = ${row.id}`);
      }
    }
  });

  if (issued.length > 0) {
    console.log('');
    console.log('  Temporary passwords — each must be changed at first sign-in.');
    console.log('  Printed once, stored nowhere.');
    console.log('');
    for (const one of issued) {
      console.log(`    ${one.name.padEnd(12)} ${one.email.padEnd(26)} ${one.password}`);
    }
    console.log('');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
