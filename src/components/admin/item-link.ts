/**
 * The items a refusal names by their page — `ItemNotLinkedError` (0408) says
 * where the supplier is linked: "Link SUP-00001 on the item's page
 * (/inventory/items/ITM-000003)". A screen that shows the refusal offers
 * those pages as links to whoever may link a supplier there.
 */
export function itemPagesIn(message: string | null | undefined): string[] {
  if (!message) return [];
  const found = new Set<string>();
  for (const match of message.matchAll(/\/inventory\/items\/([A-Za-z0-9._-]+)/g)) {
    found.add(match[1]!);
  }
  return [...found];
}
