/**
 * Document status machine and approval workflow — Phase 01.6 and 01.7.
 *
 * One status vocabulary (§24) and one approval engine (Appendix B) for every
 * document type in the system. §24 is explicit that modules must not build
 * their own: "Duplicating these mechanisms inside each module will create
 * inconsistent controls and expensive maintenance."
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DOCUMENT_STATUSES } from '../../domain/statuses';
import { APPROVER_KINDS, WORKFLOW_DECISIONS } from '../../domain/workflow';
import { appUser } from './platform';

export const documentStatus = pgEnum('document_status', DOCUMENT_STATUSES);
export const workflowDecisionKind = pgEnum('workflow_decision_kind', WORKFLOW_DECISIONS);
export const approverKind = pgEnum('approver_kind', APPROVER_KINDS);

/** The catalogue of Appendix B document types. Every workflow hangs off one. */
export const documentType = pgTable('document_type', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** Owning module, for the menu tree and for reporting. */
  module: text('module').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The allow-list. §3.2: "Each document type shall use only the states
 * applicable to its operational and accounting effect."
 *
 * A move absent from this table is refused — the machine fails closed, so a
 * document type whose configuration is incomplete cannot slip into a state
 * nobody designed for it.
 */
export const documentStatusTransition = pgTable(
  'document_status_transition',
  {
    documentTypeCode: text('document_type_code')
      .notNull()
      .references(() => documentType.code, { onDelete: 'cascade' }),
    fromStatus: documentStatus('from_status').notNull(),
    toStatus: documentStatus('to_status').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentTypeCode, t.fromStatus, t.toStatus] }),
    check('document_status_transition_not_self', sql`${t.fromStatus} <> ${t.toStatus}`),
  ],
);

/**
 * The fields a submission freezes — §24, 01.7 gate.
 *
 * *"Submission freezes controlled fields and starts the approval workflow."*
 *
 * Configuration rather than code: which fields carry the approval differs per
 * document type, and §28.1 makes that a business decision. An amount, a date, a
 * branch and an account are controlled because they are what the approver signs
 * off on; a description usually is not, because forcing a recall to fix a typo
 * teaches people to approve without reading.
 */
export const documentTypeControlledField = pgTable(
  'document_type_controlled_field',
  {
    documentTypeCode: text('document_type_code')
      .notNull()
      .references(() => documentType.code, { onDelete: 'cascade' }),
    /** Column name as the service sees it, e.g. 'posting_date'. */
    fieldName: text('field_name').notNull(),
    /** Why this field is controlled — shown to whoever configures it. */
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.documentTypeCode, t.fieldName] })],
);

/**
 * A versioned approval route.
 *
 * Versions are never edited in place. 01.7 gate: "Changing a workflow
 * definition does not alter the recorded history of in-flight or completed
 * instances" — an instance pins the definition it started under, so history
 * stays readable as what actually happened.
 */
export const workflowDefinition = pgTable(
  'workflow_definition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentTypeCode: text('document_type_code')
      .notNull()
      .references(() => documentType.code),
    version: integer('version').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('workflow_definition_version_uniq').on(t.documentTypeCode, t.version),
    // At most one active version per document type — enforced as a partial
    // unique index, so "which route applies?" has exactly one answer.
    uniqueIndex('workflow_definition_active_uniq')
      .on(t.documentTypeCode)
      .where(sql`${t.isActive}`),
  ],
);

export const workflowStep = pgTable(
  'workflow_step',
  {
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => workflowDefinition.id, { onDelete: 'cascade' }),
    sequence: smallint('sequence').notNull(),

    /**
     * Who this step is waiting for.
     *
     *   role               a named role, e.g. the Accounting Manager (§14.4)
     *   department_manager the manager of the **document's** department (§5.2)
     *
     * Two mechanisms because the blueprint has two: §14.4 routes a journal to
     * Finance by role, and §5.2 routes an operational document to whoever
     * manages the department it belongs to. Collapsing them would mean
     * inventing a role per department.
     */
    approverKind: approverKind('approver_kind').notNull().default('role'),
    /** The role that may decide, when the step waits for a role. */
    approverRole: text('approver_role').notNull(),
    /**
     * §5.2's direct-finalisation case. False wherever segregation of duties
     * applies — the raiser must not be the approver.
     */
    allowSelfApproval: boolean('allow_self_approval').notNull().default(false),
    /** §01.7 — escalation when nobody acts. Hours; null means no escalation. */
    escalateAfterHours: integer('escalate_after_hours'),
  },
  (t) => [
    primaryKey({ columns: [t.definitionId, t.sequence] }),
    check('workflow_step_sequence_positive', sql`${t.sequence} >= 1`),
  ],
);

/**
 * One document's journey through one route.
 *
 * A rejected document returns to draft and may be submitted again, so a
 * document can have several instances. `revision` distinguishes them and the
 * decision history of the earlier ones is kept, not overwritten.
 */
export const workflowInstance = pgTable(
  'workflow_instance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentTypeCode: text('document_type_code')
      .notNull()
      .references(() => documentType.code),
    documentId: text('document_id').notNull(),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => workflowDefinition.id),
    revision: integer('revision').notNull().default(1),
    /** Null once the route finished, was rejected, or was recalled. */
    currentStep: smallint('current_step'),
    isComplete: boolean('is_complete').notNull().default(false),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => appUser.id),

    /**
     * §5.2 — the department the **document** belongs to, which decides whose
     * manager approves it. Not the author's usual department: a user who
     * manages Finance and sells in Sales submits their Sales document to the
     * Sales manager, and a default would send it to the wrong person.
     */
    departmentCode: text('department_code'),
    /** The manager it went to, resolved at submission (§5.2). */
    assignedToUserId: uuid('assigned_to_user_id').references(() => appUser.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    branchCode: text('branch_code'),
  },
  (t) => [
    uniqueIndex('workflow_instance_revision_uniq').on(
      t.documentTypeCode,
      t.documentId,
      t.revision,
    ),
    index('workflow_instance_pending_idx').on(t.documentTypeCode, t.currentStep),
  ],
);

/**
 * Every decision taken, including the ones that went nowhere.
 *
 * Append-only: 01.7 gate — "The full decision history survives — approve,
 * reject, recall and delegate are all retrievable."
 */
export const workflowDecisionLog = pgTable(
  'workflow_decision',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => workflowInstance.id, { onDelete: 'cascade' }),
    stepSequence: smallint('step_sequence').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => appUser.id),
    decision: workflowDecisionKind('decision').notNull(),
    reason: text('reason'),
    /** Set when the decision was taken under delegation — both actors are kept. */
    onBehalfOf: uuid('on_behalf_of').references(() => appUser.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflow_decision_instance_idx').on(t.instanceId, t.decidedAt),
    // §5.4 — a rejection or a delegation without a stated reason is not a
    // record of a decision, it is a record that something happened.
    check(
      'workflow_decision_reason_present',
      sql`${t.decision} not in ('rejected','delegated') or coalesce(btrim(${t.reason}), '') <> ''`,
    ),
  ],
);
