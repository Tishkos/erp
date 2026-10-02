/**
 * Reading a supplier's invoice with the model, into a draft — REQ-AP-001.
 *
 * The CEO uploads what the factory sent; this turns it into a draft import
 * application with the goods filled in, the items matched where that is safe,
 * and everything else left empty and flagged for a person.
 *
 * Three steps, each honest about its own failure:
 *
 *   1. `services/document-text` turns the file into words. A scan says it is
 *      a scan; a format nobody can read is refused by name.
 *   2. The model reads those words under `EXTRACTION_RULES`, whose first rule
 *      is never to invent. It answers with one JSON object.
 *   3. `domain/invoice-draft` reads that answer, flags every gap, and matches
 *      each description to an item only where it plainly is that item.
 *
 * Nothing is created here. The draft is a proposal: the screen shows it, a
 * person corrects what is flagged, and raising the payable is their action
 * through the ordinary form. By direction (2026-10-03) the warehouse is left
 * empty — goods on an import are in process, not in a warehouse, and the
 * destination is chosen when the containers are received.
 */
import {
  allFlags,
  EXTRACTION_RULES,
  matchLines,
  NO_DRAFT,
  readDraft,
  type InvoiceDraft,
} from '../domain/invoice-draft';
import type { AgentClient } from '../domain/whatsapp-agent';
import { firstJsonObject } from './whatsapp-cli-brain';
import { extractDocumentText } from './document-text';

export interface CatalogueItem {
  readonly code: string;
  readonly name: string;
}

export interface DraftRequest {
  readonly fileName: string;
  readonly content: Buffer;
  /** The brain. The CLI client in production; a fake in the tests. */
  readonly client: AgentClient;
  readonly model: string;
  /**
   * The items a description may be matched to.
   *
   * Injected rather than read here: this module's work is a file and an
   * answer, and reaching for the database would drag the client into it and
   * make it untestable without one. The caller knows how to read items.
   */
  readonly catalogue: readonly CatalogueItem[];
}

export interface DraftOutcome {
  readonly draft: InvoiceDraft;
  /** What the file was, and what could not be read out of it. */
  readonly source: { readonly fileName: string; readonly kind: string; readonly note: string | null };
  /** Everything a person has to look at, in one list. */
  readonly flags: ReturnType<typeof allFlags>;
}

/**
 * One document, read into a draft.
 *
 * Never throws for a document it could not read: an unreadable file comes
 * back as an empty draft whose note says why, because the screen's job is to
 * tell a person what to do next and an exception tells them nothing.
 */
export async function draftFromDocument(input: DraftRequest): Promise<DraftOutcome> {
  const read = await extractDocumentText({ fileName: input.fileName, content: input.content });
  const source = { fileName: read.fileName, kind: read.kind, note: read.note };

  if (read.text.trim() === '') {
    return {
      draft: { ...NO_DRAFT, note: read.note ?? 'nothing could be read out of this file' },
      source,
      flags: [],
    };
  }

  const reply = await input.client.create({
    model: input.model,
    max_tokens: 4096,
    system: EXTRACTION_RULES,
    tools: [],
    messages: [
      {
        role: 'user',
        content: `THE DOCUMENT:\n\n${read.text}\n\nRead it into the JSON object described above, and nothing else.`,
      },
    ],
  });

  const said = reply.content
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  const answer = firstJsonObject(said);

  const draft = matchLines(readDraft(answer), input.catalogue);
  return {
    // What the reader said about the file survives into the draft, so a
    // partial read is visible rather than silently partial.
    draft: read.note && !draft.note ? { ...draft, note: read.note } : draft,
    source,
    flags: allFlags(draft),
  };
}
