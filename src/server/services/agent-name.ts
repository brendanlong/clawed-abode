import Anthropic from '@anthropic-ai/sdk';
import {
  AGENT_NAME_SYSTEM_PROMPT,
  buildAgentName,
  buildAgentNameRequest,
  slugifyAgentName,
  type AgentNameContext,
} from '@/lib/agent-name';
import { classifyClaudeCredential } from '@/lib/claude-credential';
import { createLogger, toError } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { extractRepoFullName } from '@/lib/utils';
import { sseEvents } from './events';
import { loadClaudeCredential } from './settings-merger';

const log = createLogger('agent-name');

const NAMING_MODEL = 'claude-haiku-4-5';
const NAMING_TIMEOUT_MS = 5_000;

const inFlight = new Map<string, Promise<string>>();

/**
 * The session's agent name, generating and storing it on first use. Concurrent
 * calls share one generation, so the creation-time call (which has the initial
 * prompt) is the one a racing query establishment waits for.
 */
export function resolveAgentName(sessionId: string, initialPrompt?: string): Promise<string> {
  const pending = inFlight.get(sessionId);
  if (pending) return pending;
  const run = loadOrCreateAgentName(sessionId, initialPrompt).finally(() =>
    inFlight.delete(sessionId)
  );
  inFlight.set(sessionId, run);
  return run;
}

async function loadOrCreateAgentName(sessionId: string, initialPrompt?: string): Promise<string> {
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { name: true, repoUrl: true, agentName: true },
  });
  if (session.agentName) return session.agentName;

  const repoName = session.repoUrl
    ? (extractRepoFullName(session.repoUrl).split('/').pop() ?? null)
    : null;
  const base = await generateAgentNameBase({ title: session.name, repoName, initialPrompt });
  const name = buildAgentName(base, sessionId, repoName);

  // First write wins, so the name never changes once any query has used it.
  const { count } = await prisma.session.updateMany({
    where: { id: sessionId, agentName: null },
    data: { agentName: name },
  });
  const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
  if (count > 0) sseEvents.emitSessionUpdate(sessionId, row);
  return row.agentName ?? name;
}

/** A slug from Haiku, or null (no credential, API failure, unusable reply) to fall back. */
async function generateAgentNameBase(context: AgentNameContext): Promise<string | null> {
  try {
    const credential = await loadClaudeCredential();
    if (!credential) return null;
    const client = new Anthropic({
      ...classifyClaudeCredential(credential),
      timeout: NAMING_TIMEOUT_MS,
      maxRetries: 0,
    });
    const response = await client.messages.create({
      model: NAMING_MODEL,
      max_tokens: 20,
      system: AGENT_NAME_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildAgentNameRequest(context) }],
    });
    const text = response.content.find((block) => block.type === 'text')?.text ?? '';
    return slugifyAgentName(text);
  } catch (error) {
    log.warn('Agent name generation failed; using fallback', { error: toError(error).message });
    return null;
  }
}
