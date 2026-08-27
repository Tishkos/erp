'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as series from '@/server/services/number-series';

const LIST = '/administration/numbering';
const record = (key: string) => `${LIST}/${encodeURIComponent(key)}`;

function input(formData: FormData) {
  return {
    prefix: text(formData, 'prefix'),
    pattern: text(formData, 'pattern'),
    padding: Number(text(formData, 'padding') || '6'),
    scopeBranch: flag(formData, 'scopeBranch'),
    scopeYear: flag(formData, 'scopeYear'),
  };
}

export async function createSeries(formData: FormData): Promise<void> {
  const key = text(formData, 'key').trim().toUpperCase();
  await runAdminAndReturn(
    (tx, ctx) => series.create(tx, ctx, { key, ...input(formData) }),
    (value) => (value ? record(key) : LIST),
  );
}

export async function updateSeries(formData: FormData): Promise<void> {
  const key = text(formData, 'key');
  await runAdminAndReturn((tx, ctx) => series.update(tx, ctx, key, input(formData)), record(key));
}

export async function setSeriesActive(formData: FormData): Promise<void> {
  const key = text(formData, 'key');
  await runAdminAndReturn(
    (tx, ctx) => series.setActive(tx, ctx, key, flag(formData, 'active')),
    record(key),
  );
}
