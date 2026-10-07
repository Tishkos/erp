import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { ContainerRowsGrid } from '@/components/admin/container-rows-grid';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { SIZE_TYPES } from '@/server/domain/shipments';
import { isNotFoundError } from '@/server/not-found';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as customs from '@/server/services/customs-pd';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';
import { createBlAction } from '../actions';
import { IntentSelect } from '@/components/admin/intent-select';
import { IntentDateField } from '@/components/admin/intent-date-field';

export const dynamic = 'force-dynamic';

const LIST = '/payables/shipments';

/**
 * A bill of lading on a sheet of its own — by direction 2026-10-06 ("their
 * own sheet … not take us back to the import application").
 *
 * Opened from the import's page (`?import=`), the import is fixed and the
 * containers are the table: one row per container, the quantity of each model
 * still to ship divided or typed. Opened from the list, the import is chosen
 * here and the containers may be pasted as a list, as the list's window took
 * them. Either way the B/L opens on its own record when it is saved.
 */
export default async function NewBlPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute(LIST)) notFound();

  const [t, admin, page, locale, context, outcome, query] = await Promise.all([
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'create', shipments.BL_OBJECT)) {
    return <Denied object={page('shipments')} />;
  }
  const chosen = typeof query.import === 'string' ? query.import.trim() : '';
  const today = businessToday();

  const found = await withCurrentUser(async (tx) => {
    const ports = await shipments.ports(tx);
    if (!chosen) return { ports, imports: await customs.importChoices(tx), owner: null, models: [] };
    try {
      const owner = await payables.view(tx, chosen);
      return { ports, imports: [], owner, models: await shipments.modelsToShip(tx, owner.payable.id) };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { ports, imports, owner, models } = found;

  const labels = {
    containerNo: t('container_no'),
    sizeType: t('size_type'),
    sealNo: t('seal_no'),
    remove: t('remove_container'),
    left: t('grid_left'),
    typed: t('grid_typed'),
    divided: t('grid_divided'),
    tooMany: t('grid_too_many', { left: '{left}' }),
    notANumber: t('grid_not_a_number'),
    checkDigit: t('grid_check_digit', { digit: '{digit}' }),
  };

  const fields: DocumentField[] = [
    owner
      ? { label: t('import'), value: <ProfileLink code={owner.payable.payableNo} kind="import" /> }
      : {
          label: t('import'),
          control: true,
          value: (
            <IntentSelect aria-label={t('import')} defaultValue="" name="payable_id" required>
              <option value="" />
              {imports.map((row) => (
                <option key={row.id} value={row.id}>
                  {`${row.payableNo} · ${row.reference} · ${row.supplierName}`}
                </option>
              ))}
            </IntentSelect>
          ),
        },
    ...(owner
      ? [
          {
            label: t('supplier'),
            value: <ProfileLink code={owner.supplier?.code} dir="auto" kind="supplier" name={owner.supplier?.name ?? null} />,
          } satisfies DocumentField,
        ]
      : []),
    {
      label: t('bl_no'),
      control: true,
      value: <input aria-label={t('bl_no')} autoComplete="off" dir="ltr" name="bl_no" required type="text" />,
    },
    {
      label: t('bl_date'),
      control: true,
      value: <IntentDateField aria-label={t('bl_date')} defaultValue={today} name="bl_date" required />,
    },
    {
      label: t('eta'),
      control: true,
      value: (
        <>
          <IntentDateField aria-label={t('eta')} name="eta" required />
          <span className={s.sapEnteredNote}>{t('eta_hint')}</span>
        </>
      ),
    },
    { label: t('vessel'), control: true, value: <input aria-label={t('vessel')} dir="auto" name="vessel" type="text" /> },
    { label: t('voyage'), control: true, value: <input aria-label={t('voyage')} dir="ltr" name="voyage" type="text" /> },
    { label: t('shipping_line'), control: true, value: <input aria-label={t('shipping_line')} dir="auto" name="shipping_line" type="text" /> },
    { label: t('port_of_loading'), control: true, value: <input aria-label={t('port_of_loading')} dir="auto" name="port_of_loading" type="text" /> },
    {
      label: t('port_of_discharge'),
      control: true,
      value: (
        <IntentSelect aria-label={t('port_of_discharge')} defaultValue="" name="port_of_discharge">
          <option value="">—</option>
          {ports.map((port) => (
            <option key={port.code} value={port.code}>
              {port.name}
            </option>
          ))}
        </IntentSelect>
      ),
    },
    ...(owner
      ? []
      : [
          {
            label: t('size_type'),
            control: true,
            value: (
              <>
                <input aria-label={t('size_type')} dir="ltr" name="size_type" type="text" />
                <span className={s.sapEnteredNote}>{t('size_type_hint')}</span>
              </>
            ),
          } satisfies DocumentField,
          {
            label: t('spread_lines'),
            control: true,
            value: (
              <label>
                <input defaultChecked name="spread_lines" type="checkbox" value="1" /> {t('spread_lines')}
              </label>
            ),
          } satisfies DocumentField,
        ]),
  ];

  return (
    <AdminPage
      back={{ href: LIST, label: admin('back') }}
      tabs={<SectionTabs route={LIST} />}
      title={owner ? t('new_bl_for', { payableNo: owner.payable.payableNo }) : t('new_bl')}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      <form action={createBlAction}>
        {owner ? <input name="payable_no" type="hidden" value={owner.payable.payableNo} /> : null}
        <DocumentWindow
          actions={<Submit label={t('new_bl')} variant="document" />}
          documentType={page('shipments')}
          fields={fields}
          fieldsAfterLines={
            owner
              ? []
              : [
                  {
                    label: t('containers'),
                    control: true,
                    wide: true,
                    value: (
                      <>
                        <textarea aria-label={t('containers')} dir="ltr" name="containers" rows={4} />
                        <span className={s.sapEnteredNote}>{t('containers_hint')}</span>
                      </>
                    ),
                  },
                ]
          }
          id="bl-new"
          linesCount={owner ? models.length : undefined}
          linesTitle={t('containers_caption')}
          number=""
        >
          {owner ? (
            <ContainerRowsGrid
              labels={labels}
              models={models.map((model) => ({
                key: model.key,
                label: model.itemCode ?? model.description,
                unit: model.uomCode,
                left: model.left,
              }))}
              sizeTypes={SIZE_TYPES.map((type) => ({ code: type.code, label: `${type.code} (${type.iso})` }))}
            />
          ) : (
            <table aria-labelledby="bl-new-lines-heading" className={s.sapTable}>
              <tbody>
                <tr>
                  <td>{t('new_bl_note')}</td>
                </tr>
              </tbody>
            </table>
          )}
        </DocumentWindow>
      </form>
    </AdminPage>
  );
}
