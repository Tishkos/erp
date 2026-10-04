/**
 * The Task Center's registrations with the platform's record machinery —
 * platform phase, Agent 3. Called from `registerAllRecords`.
 *
 * A task can be the target of a QS Cloud Files link (Document Center), so the
 * paperclip and the file browser both reach it. Its parent-access check for
 * attachments is in `attachments-runtime.ts`, its notes are a `TARGETS` entry
 * in `services/record-notes.ts`, and it is a record in Global Search
 * (`search/entities/tasks.ts`).
 */
import { registerCloudLinkTarget } from '../services/cloud-link-targets';

export function registerTaskRecords(): void {
  registerCloudLinkTarget({
    type: 'task',
    object: 'task',
    folderName: 'Tasks',
    table: 'task',
    idColumn: 'id',
    idKind: 'uuid',
    labelColumn: 'task_no',
    branchColumn: 'branch_code',
    href: (label) => `/tasks/${encodeURIComponent(label)}`,
  });
}
