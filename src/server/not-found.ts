/**
 * "Does not exist" versus "could not be read" — REQ-HARDEN-001 E1/E2.
 *
 * Every service that looks a record up by its number throws an error whose
 * `code` ends in `_NOT_FOUND` (`PayableNotFoundError`, `AdminNotFoundError`,
 * …). A page turns exactly that into its 404 and lets anything else — a
 * connection refused, a policy violation, a bug — reach the error boundary,
 * where it is logged with a reference and shown as what it is. A bare
 * `catch { notFound() }` made every failure look like a missing record.
 */
export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /_NOT_FOUND$/.test(code);
}

/** Runs a page's load; a missing record is null, anything else is thrown. */
export async function nullIfNotFound<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}
