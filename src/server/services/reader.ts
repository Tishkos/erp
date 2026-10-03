/**
 * Which brain the application reads with.
 *
 * The WhatsApp bridge has chosen between the two transports since the CLI one
 * was added: `WA_BRAIN` names one, and with neither named a key means the API
 * and no key means the CLI. The invoice intake needs the same answer — it is
 * the same model doing a different job — so the choosing lives here rather
 * than twice.
 *
 * Returns null when no brain is usable, which is a thing a screen has to be
 * able to say: on a host with no CLI signed in and no key, reading a document
 * is simply not on offer, and that is better than an error nobody can act on.
 */
import type { AgentClient } from '../domain/whatsapp-agent';
import { cliAgentClient } from './whatsapp-cli-brain';
import { agentClientFor } from './whatsapp-router';

/** How hard the reader thinks. The same default as the bridge's. */
const EFFORT = process.env.WA_CLI_EFFORT?.trim() || 'high';

export async function readerFor(): Promise<AgentClient | null> {
  const wanted = (process.env.WA_BRAIN ?? '').trim().toLowerCase();
  const key = process.env.ANTHROPIC_API_KEY;

  if (wanted === 'cli' || (wanted !== 'api' && !key)) {
    return cliAgentClient({
      ...(process.env.WA_CLI_COMMAND ? { command: process.env.WA_CLI_COMMAND } : {}),
      // A document is longer than a question, and this is a one-shot read
      // rather than a conversation: it is given room.
      timeoutSeconds: Math.max(60, Number(process.env.WA_CLI_TIMEOUT_SECONDS ?? '240')),
      effort: EFFORT,
    });
  }

  return agentClientFor(key);
}

/** The model it reads with — the setting, overridden by the environment. */
export function readerModel(configured: string): string {
  return process.env.WA_AGENT_MODEL?.trim() || configured;
}
