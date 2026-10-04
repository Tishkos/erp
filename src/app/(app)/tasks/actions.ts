'use server';

import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { list, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { isTaskAction } from '@/server/domain/tasks';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as tasks from '@/server/services/tasks';

/**
 * The Task Center — one server action per thing a screen does. The service
 * holds every rule (the road, who takes each step, whom a task may be given
 * to); the database holds them again. Each action runs as the person, in a
 * transaction of their own, and goes back to the page with `saved` or `error`.
 */
const LIST = '/tasks';
const record = (taskNo: string) => `${LIST}/${encodeURIComponent(taskNo)}`;
/** Files taken with a new task. */
const MAX_FILES = 5;

export async function createTask(form: FormData): Promise<void> {
  // Where files go and who may read them back — registered before the first upload or link of a cold process.
  registerAllRecords();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_FILES) redirect(`${LIST}?error=${encodeURIComponent(`At most ${MAX_FILES} files go with a new task; add the rest on its page.`)}&new=1`);
  const prepared = await Promise.all(files.map(async (f) => ({ name: f.name, content: Buffer.from(await f.arrayBuffer()) })));
  const outcome = await runAdmin(async (tx, ctx) => {
    const made = await tasks.create(tx, ctx, {
      title: text(form, 'title'),
      description: text(form, 'description') || null,
      priority: text(form, 'priority') || null,
      dueDate: text(form, 'due_date') || null,
      departmentCode: text(form, 'department_code'),
      assigneeId: text(form, 'assignee_id') || null,
      relatedType: text(form, 'related_type') || null,
      relatedNo: text(form, 'related_no') || null,
      tags: text(form, 'tags') || null,
      watcherIds: list(form, 'watcher_ids'),
    });
    for (const file of prepared) {
      await attachments.upload(tx, ctx, { objectType: tasks.PERMISSION_OBJECT, objectId: made.id, fileName: file.name, content: file.content });
    }
    return made;
  });
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.taskNo)}?saved=1`);
}

/** What the task says: title, description, priority, deadline, tags, the record it is about. */
export async function updateTask(form: FormData): Promise<void> {
  registerAllRecords();
  const taskNo = text(form, 'task_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      tasks.amend(tx, ctx, taskNo, {
        title: text(form, 'title'),
        description: text(form, 'description') || null,
        priority: text(form, 'priority') || null,
        dueDate: text(form, 'due_date') || null,
        tags: text(form, 'tags') || null,
        relatedType: text(form, 'related_type') || null,
        relatedNo: text(form, 'related_no') || null,
      }),
    record(taskNo),
  );
}

/** One step along the road: the action is named by the form, the service checks it is the person's to take. */
export async function stepTask(form: FormData): Promise<void> {
  const taskNo = text(form, 'task_no');
  const action = text(form, 'action');
  if (!isTaskAction(action)) redirect(`${record(taskNo)}?error=${encodeURIComponent('That is not a step a task takes.')}`);
  await runAdminAndReturn(
    (tx, ctx) =>
      tasks.act(tx, ctx, taskNo, action, {
        reason: text(form, 'reason') || null,
        assigneeId: text(form, 'assignee_id') || null,
        departmentCode: text(form, 'department_code') || null,
      }),
    record(taskNo),
  );
}

export async function addWatcher(form: FormData): Promise<void> {
  const taskNo = text(form, 'task_no');
  const add = text(form, 'watcher_id');
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await tasks.byNo(tx, ctx, taskNo);
    if (!found) throw new tasks.TaskError(`No task '${taskNo}'.`);
    if (!add) throw new tasks.TaskError('Choose the person who should watch it.');
    await tasks.setWatchers(tx, ctx, taskNo, [...found.row.watcherIds, add]);
  }, record(taskNo));
}

export async function removeWatcher(form: FormData): Promise<void> {
  const taskNo = text(form, 'task_no');
  const drop = text(form, 'watcher_id');
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await tasks.byNo(tx, ctx, taskNo);
    if (!found) throw new tasks.TaskError(`No task '${taskNo}'.`);
    await tasks.setWatchers(tx, ctx, taskNo, found.row.watcherIds.filter((id) => id !== drop));
  }, record(taskNo));
}

/**
 * Reply in Chat: opens (or finds) the conversation about this task with the other
 * person on it, in the same transaction, and sends the asker there with a draft in
 * their own language. Nothing is sent: the draft waits in the box.
 */
export async function replyInChat(form: FormData): Promise<void> {
  registerAllRecords();
  const taskNo = text(form, 'task_no');
  const outcome = await runAdmin(async (tx, ctx) => {
    const found = await tasks.byNo(tx, ctx, taskNo);
    if (!found) throw new tasks.TaskError(`No task '${taskNo}'.`);
    const opened = await tasks.openChat(tx, ctx, taskNo);
    return { conversationId: opened.conversationId, title: found.row.title };
  });
  if (!outcome.ok) redirect(withQuery(record(taskNo), 'error', outcome.error ?? ''));
  const t = await getTranslations('admin.tasks');
  const draft = t('chat_draft', { taskNo, title: outcome.value!.title });
  redirect(`/chat?c=${encodeURIComponent(outcome.value!.conversationId)}&draft=${encodeURIComponent(draft)}`);
}
