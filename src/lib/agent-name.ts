/** Env var the Claude CLI registers its cross-session messaging name from. */
export const AGENT_NAME_ENV = 'CLAUDE_CODE_SESSION_NAME';

const MAX_BASE_WORDS = 3;
const MAX_BASE_LENGTH = 32;
const SUFFIX_LENGTH = 4;
const BARE_ID_LENGTH = 8;
const PROMPT_EXCERPT_LENGTH = 2000;

/** Lowercase hyphenated slug of at most `maxWords` words, or null if nothing usable remains. */
export function slugifyAgentName(raw: string, maxWords = MAX_BASE_WORDS): string | null {
  const words = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, maxWords);
  const slug = words.join('-').slice(0, MAX_BASE_LENGTH).replace(/-+$/, '');
  return slug || null;
}

function sessionIdPrefix(sessionId: string, length: number): string {
  return sessionId.replace(/-/g, '').slice(0, length).toLowerCase();
}

/**
 * The full agent name: a generated base (or the repo name) plus a session-id
 * suffix, so sessions started from the same prompt still get distinct names.
 * With neither, just a session-id prefix.
 */
export function buildAgentName(
  base: string | null,
  sessionId: string,
  repoName: string | null
): string {
  const named = base ?? (repoName ? slugifyAgentName(repoName, Infinity) : null);
  return named
    ? `${named}-${sessionIdPrefix(sessionId, SUFFIX_LENGTH)}`
    : sessionIdPrefix(sessionId, BARE_ID_LENGTH);
}

export const AGENT_NAME_SYSTEM_PROMPT =
  'You name coding-agent sessions so other agents can address them in messages. ' +
  'Given what the session is about, reply with a short memorable name of 2-3 lowercase ' +
  'words separated by hyphens, describing the task (not the repository). ' +
  'Reply with the name only.';

export interface AgentNameContext {
  title: string;
  repoName: string | null;
  initialPrompt?: string;
}

export function buildAgentNameRequest({
  title,
  repoName,
  initialPrompt,
}: AgentNameContext): string {
  const lines = [`Session title: ${title}`, `Repository: ${repoName ?? '(none)'}`];
  const prompt = initialPrompt?.trim();
  if (prompt) {
    lines.push('', 'First prompt:', prompt.slice(0, PROMPT_EXCERPT_LENGTH));
  }
  return lines.join('\n');
}
