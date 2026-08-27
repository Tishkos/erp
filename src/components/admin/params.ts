/** The outcome an administration action left in the query string. */
export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function outcomeOf(searchParams: SearchParams) {
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : null);
  return {
    saved: one('saved') === '1',
    error: one('error'),
    q: one('q') ?? '',
    page: Math.max(1, Number(one('page') ?? '1') || 1),
  };
}
