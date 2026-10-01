import { getTranslations } from 'next-intl/server';
import { Field, Form, Hidden, Select, SubmitRow, Submit } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { stopFollowUp } from '@/app/(app)/payables/actions';

/**
 * Stop / follow-up — REQ-AP-001 §21.12, the red band made a form.
 *
 * Opened from any payables list or record by anyone who may edit the
 * payable. Everything typed becomes a row of the hold's append-only thread
 * and an event in the status log; nothing here can be edited afterwards.
 */
export interface StopDialogOption {
  readonly value: string;
  readonly label: string;
}

export async function StopDialog({
  payableNo,
  back,
  lanes,
  reasons,
  owners,
  defaultLane,
}: {
  readonly payableNo: string;
  readonly back: string;
  readonly lanes: readonly StopDialogOption[];
  readonly reasons: readonly StopDialogOption[];
  readonly owners: readonly StopDialogOption[];
  readonly defaultLane?: string;
}) {
  const t = await getTranslations('admin.payables');

  return (
    <NewRecordDialog buttonLabel={t('stop')} closeLabel={t('close')} title={t('stop_title')}>
      <Form action={stopFollowUp}>
        <Hidden name="payable_no" value={payableNo} />
        <Hidden name="back" value={back} />
        <Select
          defaultValue={defaultLane ?? lanes[0]?.value ?? ''}
          label={t('lane')}
          name="lane"
          options={lanes.map((lane) => ({ value: lane.value, label: lane.label }))}
          required
        />
        <Select
          label={t('reason')}
          name="reason_code"
          options={reasons.map((reason) => ({ value: reason.value, label: reason.label }))}
          required
        />
        <Field hint={t('detail_hint')} label={t('detail')} name="detail" />
        <Select
          label={t('owner')}
          name="owner"
          options={owners.map((owner) => ({ value: owner.value, label: owner.label }))}
          required
        />
        <Field label={t('started_on')} name="started_on" type="date" />
        <Field label={t('next_action')} name="next_action" required />
        <Field label={t('next_action_due')} name="next_action_due" required type="date" />
        <SubmitRow>
          <Submit label={t('stop_save')} />
        </SubmitRow>
      </Form>
    </NewRecordDialog>
  );
}
