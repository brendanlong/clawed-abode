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
