'use server';

/**
 * WhatsApp settings — REQ-WA-001 §6. Contacts deactivate, never delete; a
 * setting is checked before it is stored; a rule's channel is a toggle.
 */
import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as whatsapp from '@/server/services/whatsapp';

const BACK = '/administration/whatsapp';

export async function saveContact(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      whatsapp.saveContact(tx, ctx, {
        userId: text(form, 'user_id'),
        e164: text(form, 'e164'),
        allowNotifications: flag(form, 'allow_notifications'),
        allowQueries: flag(form, 'allow_queries'),
        allowDigest: flag(form, 'allow_digest'),
      }),
    BACK,
  );
}

export async function setContactActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => whatsapp.setContactActive(tx, ctx, text(form, 'id'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

export async function saveSetting(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => whatsapp.saveSetting(tx, ctx, text(form, 'key'), text(form, 'value')), BACK);
}

export async function setRuleWhatsapp(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => whatsapp.setRuleWhatsapp(tx, ctx, text(form, 'code'), text(form, 'on') === '1'), BACK);
}

export async function clearPairing(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => whatsapp.sessionClear(tx, ctx, text(form, 'reason')), BACK);
}
