import { sanitize } from 'agent-sanitizer';
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createLogger, toError } from '@/lib/logger';
import { buildSanitizationInfo, type SanitizationInfo } from '@/lib/sanitization';

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
 * The library splits its human-readable findings into two severity tiers:
 * `warnings` (injection-shaped — something was hidden or removed) and `notes`
 * (reported but not alarming — usually content that was *preserved* and merely
 * described). We surface both as one list, because the tier a message lands in
 * doesn't line up with whether we report it at all: that decision keys off
 * `found`, which is severity-blind. Exfil-shaped URLs, for instance, emit an
 * `exfil-urls` category — so they get a badge and a log line — while their
 * explanation sits in `notes`. Keeping only `warnings` would badge those
 * findings with no text to explain them.
 *
 * Note-tier findings on text with no `found` category (a preserved `<script>`,
 * say) are still dropped: `buildSanitizationInfo` returns null for an empty
 * `found`, which is what keeps ordinary web pages from raising a badge.
 */
function collectMessages({ warnings, notes }: { warnings: string[]; notes: string[] }): string[] {
  return [...warnings, ...notes];
}

/**
 * Strip hidden-content injection vectors from untrusted text before it reaches
 * the model: payload-capable invisible Unicode, ANSI escapes, and
 * human-invisible HTML (comments / hidden elements). Data-exfil-shaped URLs and
 * look-alike (confusable) host names are *detected and reported* but
 * deliberately left in place by the library, so they surface as an advisory
 * finding rather than a rewrite.
 *
 * Defense-in-depth, not a hard boundary. The library documents that it never
 * throws, but this sits on the critical path of every message send, so we fail
 * open anyway: on any unexpected error the original text passes through rather
 * than blocking the user. `sanitizeFn` is injectable so the fail-open path is
 * testable without mocking the module.
 */
export async function sanitizeUntrustedInput(
  text: string,
  context: SanitizeContext,
  sanitizeFn: typeof sanitize = sanitize
): Promise<{ cleaned: string; info: SanitizationInfo | null }> {
  try {
    const result = await sanitizeFn(text, { html: true });
    const { cleaned, found } = result;
    const messages = collectMessages(result);
    const removed = cleaned !== text;
    if (found.length > 0) {
      log.warn('Detected hidden content in untrusted input', {
        ...context,
        found,
        messages,
        neutralized: removed,
      });
    }
    // `info` is surfaced on the persisted message so the UI can show which
    // findings applied to this prompt; `removed` distinguishes an actual rewrite
    // from advisory-only detection (exfil URLs are flagged but left in place).
    return { cleaned, info: buildSanitizationInfo(found, messages, removed) };
  } catch (err) {
    log.error('Sanitizing untrusted input failed; passing original text through', toError(err), {
      ...context,
    });
    return { cleaned: text, info: null };
  }
}

/** Accumulates findings across a deep walk of one tool response. */
interface SanitizeAccumulator {
  found: Set<string>;
  warnings: Set<string>;
  mutated: boolean;
}

/**
 * Recursively sanitize every string value inside an arbitrary JSON-ish value,
 * preserving structure. Tool results are tool-specific (a bare string, a Bash
 * `{ stdout, stderr, ... }` object, an array of `{ type: 'text', text }` blocks,
 * etc.), and the SDK only honors `updatedToolOutput` when it keeps the original
 * shape — so we replace string leaves in place rather than flattening. Object
 * keys are structural and left untouched. `warnings` (deduped) carry the
 * library's operator/agent-facing messages from both severity tiers (see
 * `collectMessages`), including the recovery pointer to a hex dump for stripped
 * bytes.
 */
async function sanitizeStringsDeep(value: unknown, acc: SanitizeAccumulator): Promise<unknown> {
  if (typeof value === 'string') {
    const result = await sanitize(value, { html: true });
    const { cleaned, found } = result;
    for (const category of found) acc.found.add(category);
    for (const message of collectMessages(result)) acc.warnings.add(message);
    if (cleaned !== value) acc.mutated = true;
    return cleaned;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => sanitizeStringsDeep(item, acc)));
  }
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, item]) => [key, await sanitizeStringsDeep(item, acc)] as const
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
 * set `changed`). `warnings` are surfaced to the agent so it can tell filtering
 * occurred and recover raw bytes if a task needs them.
 */
export async function sanitizeToolOutput(
  toolResponse: unknown,
  context: SanitizeContext
): Promise<{ output: unknown; changed: boolean; found: string[]; warnings: string[] }> {
  const acc: SanitizeAccumulator = {
    found: new Set<string>(),
    warnings: new Set<string>(),
    mutated: false,
  };
  const output = await sanitizeStringsDeep(toolResponse, acc);
  if (acc.found.size > 0) {
    log.warn('Detected hidden content in tool output', {
      ...context,
      found: [...acc.found],
      neutralized: acc.mutated,
    });
  }
  return { output, changed: acc.mutated, found: [...acc.found], warnings: [...acc.warnings] };
}

/**
 * Build the agent-facing note delivered alongside a sanitized tool result. The
 * library's `warnings` already include the recovery pointer (inspect raw bytes
 * with a hex dump — `xxd` / `od -c` — which survives sanitization), so the agent
 * can both tell that filtering occurred and work around it when a coding /
 * tokenization task genuinely needs the exact bytes.
 */
function buildSanitizationNote(warnings: string[]): string {
  const intro =
    'Hidden or invisible content was automatically removed from this tool output before you saw it; the visible text is intact.';
  return warnings.length > 0 ? `${intro} ${warnings.join(' ')}` : intro;
}

/**
 * `PostToolUse` hook handler wired into the session query (see `buildSdkOptions`
 * in sdk-options). Neutralizes hidden content in a tool result and returns the
 * SDK's `updatedToolOutput` substitution — but only when a string actually
 * changed, so a normal tool result passes through untouched (returns `{}`,
 * leaving the SDK to use the original output). Fails open: any error is logged
 * and `{}` returned, so sanitization can never break tool execution.
 */
export async function sanitizeToolOutputHook(
  input: HookInput,
  sessionId: string,
  onFindings?: (toolUseId: string, info: SanitizationInfo) => void
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PostToolUse') return {};
  try {
    const { output, changed, found, warnings } = await sanitizeToolOutput(input.tool_response, {
      sessionId,
      source: `tool:${input.tool_name}`,
    });
    // Report findings (even advisory-only exfil-URL detections that don't rewrite
    // text) so the caller can attach them to the persisted tool_result message and
    // the UI can surface a badge on it. Keyed by tool_use_id for correlation.
    const info = buildSanitizationInfo(found, warnings, changed);
    if (info && onFindings) onFindings(input.tool_use_id, info);
    if (!changed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: output,
        // Tell the agent filtering happened (and how to recover raw bytes), so a
        // legitimate task over invisible/tokenization-sensitive text isn't blind
        // to it. Only emitted when output actually changed.
        additionalContext: buildSanitizationNote(warnings),
      },
    };
  } catch (err) {
    log.warn(
      'Tool-output sanitization failed; passing original output through',
      { sessionId, tool: input.tool_name },
      toError(err)
    );
    return {};
  }
}
