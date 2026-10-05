/**
 * The Exception Center's registrations with the platform's record machinery —
 * platform phase, Agent 7. Called from `registerAllRecords`.
 *
 * An exception is a record a cloud file can be linked to and the target a
 * notification opens (the Notification Center resolves a subject through this
 * registry, in the reader's own scope). Its parent-access check for
 * attachments is in `attachments-runtime.ts`, its notes are a `TARGETS` entry
 * in `services/record-notes.ts`, and it is a record in Global Search
 * (`search/entities/exceptions.ts`).
 */
import { registerCloudLinkTarget } from '../services/cloud-link-targets';

export function registerExceptionRecords(): void {
  registerCloudLinkTarget({
    type: 'exception',
    object: 'exception',
    folderName: 'Exceptions',
    table: 'exception',
    idColumn: 'id',
    idKind: 'uuid',
    labelColumn: 'exception_no',
    branchColumn: 'branch_code',
    href: (label) => `/exceptions/${encodeURIComponent(label)}`,
  });
}
