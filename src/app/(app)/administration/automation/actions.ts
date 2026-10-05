'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import { TEMPLATES, isTemplateCode, paramField } from '@/server/domain/automation-templates';
import * as automation from '@/server/services/automation';

const LIST = '/administration/automation';
const record = (ruleNo: string) => `${LIST}/${encodeURIComponent(ruleNo)}`;

/** The template's parameters from the form's own fields (`p_<name>`); a ticked flag is "on", an untouched one is nothing. */
function paramsOf(templateCode: string, form: FormData): Record<string, string | undefined> {
  if (!isTemplateCode(templateCode)) return {};
  const out: Record<string, string | undefined> = {};
  for (const def of TEMPLATES[templateCode].params) {
    out[def.name] = def.type === 'flag' ? (flag(form, paramField(def.name)) ? 'on' : '') : text(form, paramField(def.name));
  }
  return out;
}

/** A new rule from a template: born off, owned by whoever makes it. A refusal reopens the page with the sentence. */
export async function createRule(formData: FormData): Promise<void> {
  const templateCode = text(formData, 'template_code');
  await runAdminAndReturn(
    (tx, ctx) => automation.createFromTemplate(tx, ctx, { templateCode, name: text(formData, 'name'), params: paramsOf(templateCode, formData) }),
    (value) => (value ? record((value as { ruleNo: string }).ruleNo) : `${LIST}?template=${encodeURIComponent(templateCode)}`),
  );
}

/** Changing a rule is a new version, and the person who saves it becomes the owner. */
export async function changeRule(formData: FormData): Promise<void> {
  const ruleNo = text(formData, 'rule_no');
  const templateCode = text(formData, 'template_code');
  await runAdminAndReturn(
    (tx, ctx) => automation.change(tx, ctx, ruleNo, { name: text(formData, 'name'), params: paramsOf(templateCode, formData), note: text(formData, 'note') }),
    record(ruleNo),
  );
}

export async function enableRule(formData: FormData): Promise<void> {
  const ruleNo = text(formData, 'rule_no');
  await runAdminAndReturn((tx, ctx) => automation.enable(tx, ctx, ruleNo), record(ruleNo));
}

export async function disableRule(formData: FormData): Promise<void> {
  const ruleNo = text(formData, 'rule_no');
  await runAdminAndReturn((tx, ctx) => automation.disable(tx, ctx, ruleNo, text(formData, 'reason')), record(ruleNo));
}

/** The kill switch: every rule stops at once, with the reason in the audit trail. */
export async function switchAutomation(formData: FormData): Promise<void> {
  const on = text(formData, 'on') === '1';
  await runAdminAndReturn((tx, ctx) => automation.setSwitch(tx, ctx, on, text(formData, 'reason')), LIST);
}

export async function savePauseThreshold(formData: FormData): Promise<void> {
  const threshold = Number(text(formData, 'threshold'));
  await runAdminAndReturn((tx, ctx) => automation.setPauseThreshold(tx, ctx, threshold), LIST);
}
