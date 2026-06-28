import { sanitize } from 'agent-input-sanitizer';
import { createLogger } from '@/lib/logger';

const log = createLogger('input-sanitizer');

/**
 * Where a piece of untrusted text came from, for operator-facing logs.
 * `source` examples: 'user-message' (typed/pasted prompt), 'initial-prompt'
 * (session creation, may embed a GitHub issue body).
 */
export interface SanitizeContext {
  sessionId: string;
  source: string;
}

/**
 * Strip hidden-content injection vectors from untrusted text before it reaches
 * the model: payload-capable invisible Unicode, ANSI escapes, and
 * human-invisible HTML (comments / hidden elements). Data-exfil-shaped URLs are
 * *detected and reported* but deliberately left in place by the library, so
 * they surface only as a logged warning.
 *
 * Defense-in-depth, not a hard boundary (this host intentionally runs without a
 * sandbox/egress firewall — see DESIGN.md "claude-guard" integration notes).
 * Never throws: `agent-input-sanitizer` always returns a string and only
 * reports changes, so on any internal failure the original text passes through.
 */
export async function sanitizeUntrustedInput(
  text: string,
  context: SanitizeContext
): Promise<string> {
  const { cleaned, found, warnings } = await sanitize(text, { html: true });
  if (found.length > 0) {
    log.warn('Neutralized hidden content in untrusted input', {
      ...context,
      found,
      warnings,
    });
  }
  return cleaned;
}

/**
 * Recursively sanitize every string value inside an arbitrary JSON-ish value,
 * preserving structure. Tool results are tool-specific (a bare string, a Bash
 * `{ stdout, stderr, ... }` object, an array of `{ type: 'text', text }` blocks,
 * etc.), and the SDK only honors `updatedToolOutput` when it keeps the original
 * shape — so we replace string leaves in place rather than flattening. Object
 * keys are structural and left untouched.
 */
async function sanitizeStringsDeep(
  value: unknown,
  found: Set<string>,
  onMutate: () => void
): Promise<unknown> {
  if (typeof value === 'string') {
    const { cleaned, found: categories } = await sanitize(value, { html: true });
    for (const category of categories) found.add(category);
    if (cleaned !== value) onMutate();
    return cleaned;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => sanitizeStringsDeep(item, found, onMutate)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, item]) => [key, await sanitizeStringsDeep(item, found, onMutate)] as const
      )
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Sanitize a tool result before it is fed back to the model — the primary
 * hidden-content injection surface (web fetches, issue/PR bodies the agent
 * pulls, MCP responses, file/command output). Walks the whole `tool_response`,
 * neutralizing invisible Unicode / ANSI / hidden HTML in every string leaf while
 * keeping the structure intact.
 *
 * `changed` is true only when a string was actually rewritten; the caller uses
 * it to skip `updatedToolOutput` when nothing changed (exfil-URL detection is
 * advisory — it is logged via `found` but does not rewrite text, so it does not
 * set `changed`).
 */
export async function sanitizeToolOutput(
  toolResponse: unknown,
  context: SanitizeContext
): Promise<{ output: unknown; changed: boolean }> {
  const found = new Set<string>();
  let mutated = false;
  const output = await sanitizeStringsDeep(toolResponse, found, () => {
    mutated = true;
  });
  if (found.size > 0) {
    log.warn('Detected hidden content in tool output', {
      ...context,
      found: [...found],
      neutralized: mutated,
    });
  }
  return { output, changed: mutated };
}
