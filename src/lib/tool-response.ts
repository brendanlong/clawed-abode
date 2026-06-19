/**
 * Pure helpers for responding to interactive tool calls (AskUserQuestion /
 * ExitPlanMode).
 *
 * A response can be delivered two ways (decided by the server, see
 * `submitToolResponse` in the claude router):
 *
 * 1. **Live**: a `query()` is still parked in its `canUseTool` callback, so the
 *    parked promise is resolved and the same turn continues.
 * 2. **Fallback**: the query has ended (completed, stopped, or the server
 *    restarted), so the dangling `tool_use` can never be resolved. Instead we
 *    persist a synthetic `tool_result` (so the UI pairs the block and stops
 *    showing answer controls) and resume the session with a new turn built from
 *    {@link formatToolResponsePrompt}.
 *
 * These functions are pure so the formatting/serialization is unit-testable
 * without the SDK or the database.
 */

import type { UserContent } from './claude-messages';

/** A user's response to a parked interactive tool call. */
export type ToolResponse =
  | { kind: 'questions'; answers: Record<string, string> }
  | { kind: 'plan'; approve: boolean; feedback?: string };

/**
 * Short human-readable summary stored as the synthetic `tool_result` content on
 * the fallback path. The AskUserQuestion display matches this against option
 * labels to highlight what was chosen, so for questions it is the answer values
 * joined by `, `.
 */
export function summarizeToolResponse(response: ToolResponse): string {
  if (response.kind === 'questions') {
    const values = Object.values(response.answers).filter((v) => v.trim().length > 0);
    return values.length > 0 ? values.join(', ') : 'No selection';
  }

  if (response.approve) {
    return 'Plan approved';
  }
  const feedback = response.feedback?.trim();
  return feedback ? `Changes requested: ${feedback}` : 'Changes requested';
}

/**
 * Build the prompt sent as a new turn when the original tool call is gone.
 * Phrased as if the user is replying, so the resumed conversation reads
 * naturally.
 */
export function formatToolResponsePrompt(response: ToolResponse): string {
  if (response.kind === 'questions') {
    const lines = Object.entries(response.answers)
      .filter(([, answer]) => answer.trim().length > 0)
      .map(([question, answer]) => `**${question}**\n${answer.trim()}`);

    if (lines.length === 0) {
      return 'I have no answer to your questions; please use your best judgment.';
    }
    return `Here are my answers to your questions:\n\n${lines.join('\n\n')}`;
  }

  const feedback = response.feedback?.trim();
  if (response.approve) {
    const base = 'I approve this plan. Please go ahead and implement it.';
    return feedback ? `${base}\n\nAdditional notes:\n${feedback}` : base;
  }
  return feedback
    ? `Please revise the plan before implementing it. ${feedback}`
    : "I'd like you to revise the plan before implementing it.";
}

/**
 * Build a synthetic `user`/`tool_result` message that pairs a dangling
 * `tool_use` block. Matches {@link UserContent} so it parses and pairs exactly
 * like a real SDK tool result in the message list.
 */
export function buildSyntheticToolResultContent(params: {
  sessionId: string;
  toolUseId: string;
  uuid: string;
  text: string;
}): UserContent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: params.toolUseId,
          content: params.text,
          is_error: false,
        },
      ],
    },
    session_id: params.sessionId,
    uuid: params.uuid,
  };
}
