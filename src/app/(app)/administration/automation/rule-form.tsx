import { getTranslations } from 'next-intl/server';
import { Checkbox, Field, Grid, Select } from '@/components/admin';
import { SEVERITIES } from '@/server/domain/exceptions';
import { TASK_PRIORITIES } from '@/server/domain/tasks';
import { TEMPLATES, paramField, type ParamDef, type TemplateCode } from '@/server/domain/automation-templates';

/** What a parameter's choices are drawn from: the roles, the people and the sections the person may use. */
export interface Choices {
  readonly roles: readonly { code: string; name: string }[];
  readonly people: readonly { id: string; name: string }[];
  readonly sections: readonly { code: string; name: string }[];
}

type Values = Readonly<Record<string, string | number | boolean>>;

/**
 * The fields of one template's parameters — the only thing a person types to
 * build a rule. Drawn from the template's own list (`domain/automation-templates`),
 * so a new parameter is one entry there and a label here, and what the form
 * posts is what `parseParams` reads (`p_<name>`). The element ids carry a prefix
 * because a page holds one form per template and a name repeats across them.
 * The choices are read once by the page (the roles, the people, the sections).
 */
export async function RuleFields({
  template,
  values = {},
  idPrefix,
  choices,
}: {
  readonly template: TemplateCode;
  readonly values?: Values;
  readonly idPrefix: string;
  readonly choices: Choices;
}) {
  const [x, tasks, exceptions] = await Promise.all([getTranslations('admin.automation'), getTranslations('admin.tasks'), getTranslations('admin.exceptions')]);
  const def = TEMPLATES[template];
  const text = (name: string): string => (values[name] === undefined ? '' : String(values[name]));

  const one = (param: ParamDef) => {
    const name = paramField(param.name);
    const id = `${idPrefix}-${param.name}`;
    const label = x(`p_${param.name}`);
    const required = param.required && param.type !== 'flag';
    switch (param.type) {
      case 'flag':
        return <Checkbox defaultChecked={values[param.name] === true} key={param.name} label={label} name={name} />;
      case 'int':
        return (
          <Field
            defaultValue={text(param.name)}
            id={id}
            key={param.name}
            label={label}
            max={param.max}
            min={param.min}
            name={name}
            required={required}
            type="number"
          />
        );
      case 'money':
        return <Field defaultValue={text(param.name)} hint={x('p_hint_money')} id={id} key={param.name} label={label} name={name} required={required} />;
      case 'text':
        return <Field defaultValue={text(param.name)} id={id} key={param.name} label={label} name={name} required={required} wide />;
      case 'role':
        return (
          <Select
            defaultValue={text(param.name)}
            emptyLabel={x('p_choose')}
            id={id}
            key={param.name}
            label={label}
            name={name}
            options={choices.roles.map((r) => ({ value: r.code, label: r.name }))}
            required={required}
          />
        );
      case 'user':
        return (
          <Select
            defaultValue={text(param.name)}
            emptyLabel={x('p_choose')}
            id={id}
            key={param.name}
            label={label}
            name={name}
            options={choices.people.map((p) => ({ value: p.id, label: p.name }))}
            required={required}
          />
        );
      case 'department':
        return (
          <Select
            defaultValue={text(param.name)}
            emptyLabel={x('p_choose')}
            id={id}
            key={param.name}
            label={label}
            name={name}
            options={choices.sections.map((d) => ({ value: d.code, label: d.name }))}
            required={required}
          />
        );
      case 'priority':
        return (
          <Select
            defaultValue={text(param.name)}
            emptyLabel={x('p_choose')}
            id={id}
            key={param.name}
            label={label}
            name={name}
            options={TASK_PRIORITIES.map((value) => ({ value, label: tasks(`priority_${value}`) }))}
            required={required}
          />
        );
      case 'severity':
        return (
          <Select
            defaultValue={text(param.name)}
            emptyLabel={x('p_choose')}
            id={id}
            key={param.name}
            label={label}
            name={name}
            options={SEVERITIES.map((value) => ({ value, label: exceptions(`severity_${value}`) }))}
            required={required}
          />
        );
    }
  };

  const flags = def.params.filter((p) => p.type === 'flag');
  const plain = def.params.filter((p) => p.type !== 'flag' && !p.whenFlag && p.name !== 'note');
  const later = def.params.filter((p) => p.type !== 'flag' && p.whenFlag);
  const note = def.params.find((p) => p.name === 'note');
  return (
    <>
      {plain.length > 0 ? <Grid>{plain.map(one)}</Grid> : null}
      {flags.map(one)}
      {later.length > 0 ? <p className="muted">{x('p_hint_followUp')}</p> : null}
      {later.length > 0 ? <Grid>{later.map(one)}</Grid> : null}
      {note ? <Grid>{one(note)}</Grid> : null}
    </>
  );
}
