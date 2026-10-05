import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { ChatWorkspace, type RecordIntent } from '@/components/chat/chat-workspace';
import { NewChatDialog, NewGroupDialog } from '@/components/chat/chat-people';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { BUSINESS_TIME_ZONE } from '@/server/domain/business-date';
import { isLocalHref, normaliseDraft } from '@/server/domain/chat';
import { visibleRoute } from '@/server/delivered';
import { registerAllRecords } from '@/server/records';
import * as chat from '@/server/services/chat';
import * as chatRead from '@/server/services/chat-read';
import { requireContext, withCurrentUser } from '@/server/session';
import type { SearchParams } from '@/components/admin/params';

/**
 * Chat — internal conversations between people, in the ERP (platform phase).
 *
 *   /chat                         the list, and nothing open
 *   /chat?c=<conversation>        that conversation open (a notice's link)
 *   /chat?c=<id>&draft=<text>     … with the box filled in, never sent
 *   /chat?record=<type>:<id>      "discuss this record": start (or find) a
 *                                 conversation about it — `&label=` and
 *                                 `&href=` say how it is called and where it opens
 *
 * The page copies the register-and-document pair (the journal workspace's
 * split: the list beside the open document) from existing classes only. It is
 * drawn once here with the person's own rows, and from then on the browser
 * asks `/chat/api/sync` every few seconds. What a person may read is the
 * database's decision (row-level security, `0310`); this file asks for nothing
 * the services would refuse.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default async function ChatPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/chat')) notFound();
  registerAllRecords();

  const [t, a, page, locale, context, params] = await Promise.all([
    getTranslations('chat'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!chat.mayUse(principal)) return <Denied object={page('chat')} />;
  const mayWrite = can(principal, 'create', chat.PERMISSION_OBJECT);

  const requested = one(params.c);
  const draft = normaliseDraft(one(params.draft));
  const recordParam = one(params.record);
  const separator = recordParam.indexOf(':');
  const recordType = separator > 0 ? recordParam.slice(0, separator) : '';
  const recordId = separator > 0 ? recordParam.slice(separator + 1) : '';
  const wantsRecord = mayWrite && /^[a-z][a-z0-9_]{1,63}$/.test(recordType) && recordId.length > 0 && recordId.length <= 200;

  const actor = { principal, branchCode: context.scope.branchCode };
  const { initial, record } = await withCurrentUser(async (tx) => {
    const view = await chatRead.initialView(tx, actor, UUID.test(requested) ? requested : null);
    let intent: RecordIntent | null = null;
    if (wantsRecord) {
      const accessible = await chat.mayOpenRecord(tx, actor, recordType, recordId);
      const href = one(params.href);
      intent = {
        type: recordType,
        id: recordId,
        accessible,
        // The name and the address come from the link; they are shown only to somebody who can open the record.
        label: accessible ? one(params.label).replace(/\s+/g, ' ').trim().slice(0, 80) || null : null,
        href: accessible && isLocalHref(href) ? href : null,
        existing: accessible ? await chatRead.recordConversationsFor(tx, actor, recordType, recordId) : [],
      };
    }
    return { initial: view, record: intent };
  });

  return (
    <AdminPage
      actions={
        mayWrite ? (
          <>
            <NewChatDialog />
            <NewGroupDialog />
          </>
        ) : null
      }
      back={{ href: '/', label: a('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/chat" />}
      title={t('title')}
      variant="sap"
    >
      <ChatWorkspace
        draft={initial.openId ? draft : ''}
        initial={initial}
        locale={locale}
        mayWrite={mayWrite}
        record={record}
        timeZone={BUSINESS_TIME_ZONE}
      />
    </AdminPage>
  );
}
